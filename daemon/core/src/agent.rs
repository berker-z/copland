//! One agent's loop: poll its unread inbox, and for a task that needs it,
//! start a run, claim the task, launch the runtime, finish the run.
//!
//! Runs go on their own (RunCtx::work), so an agent can have several at once
//! (COPL-82), up to its `max_runs`. Only coding tasks run side by side, each in
//! its own worktree; anything else shares the agent's `workdir`, one at a time.
//! A task is never in two runs from one loop. The loop hears each run's end
//! (Done) and remembers it in the wake guard, as before.
//!
//! Messages (COPL-107), about a task or not (COPL-127), get a run of their
//! own in `workdir`, one at a time, for those no run has had yet and no run
//! holds. It claims each before it launches (COPL-124) and is given only
//! those it got, so no message is handled twice. A run on a task never sees
//! a message. What arrives while a run is going waits for the next one.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use anyhow::{Result, anyhow};
use tokio::sync::{Notify, watch};
use tokio::task::{Id, JoinError, JoinHandle, JoinSet};
use tracing::Instrument;

use crate::api::{Api, ApiError, Ending, InboxItem, Me};
use crate::config::AgentConfig;
use crate::guard::{Check, Identity, Message, Plan, Refused, Wake, WakeGuard, add_ready, plan, refused};
use crate::live::{self, FALLBACK_POLL, Heard, Link};
use crate::runner::{self, Brief, Ended, Exit, Launch, MESSAGES};
use crate::sandbox;
use crate::state::{AgentState, DaemonState, Phase, RunSummary};
use crate::workspace::{self, Workspace};

const PAGE: u32 = 100;
/// More unread than this is read on a later poll.
const MAX_PAGES: usize = 10;

pub struct Paths {
    pub state_dir: PathBuf,
    pub runtime_dir: PathBuf,
}

/// A token the daemon cannot work with however often it asks: read-only, or a run's own secret.
#[derive(Debug)]
pub struct Unusable(pub String);

impl std::fmt::Display for Unusable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Unusable {}

/// Who the agent's token is, from the server, refusing one the daemon can't use: a read-only
/// token can't start runs or claim anything, and a run's secret can't start another run.
/// What `--check` and each agent's loop ask first.
pub async fn whoami(api: &Api, agent: &AgentConfig) -> Result<Me> {
    let me = api
        .me(&agent.token)
        .await
        .map_err(|e| anyhow!("asking who the token is: {e}"))?;
    if let Some(access) = &me.access {
        if access.scope == "read" {
            return Err(Unusable(format!(
                "the token for @{} is read-only; the daemon needs a read and write token to start runs and claim tasks. Make one on the agent's page in settings",
                me.user.handle
            ))
            .into());
        }
        if access.run_id.is_some() {
            return Err(Unusable(format!(
                "the token for {} is a run's secret (cplr_…), not an API token; give the daemon the agent's own token (cpl_…)",
                agent.handle
            ))
            .into());
        }
    }
    Ok(me)
}

/// What an agent's loop should be running, as a reload says: its binding (none once removed) and
/// the poll interval, and a generation that moves on with every change.
#[derive(Debug, Clone)]
pub struct Wanted {
    pub generation: u64,
    pub agent: Option<AgentConfig>,
    pub poll: Duration,
}

/// Whether a reload has changed or removed the agent: the generation of its wanted binding has
/// moved on from the one this loop was started with. Looked at between polls and before a run
/// only, and never handed to a runtime, so a run in progress always finishes first.
/// A run to stop by hand: the agent's slot and the run's short id. `RunStopper` sets it, and the
/// loop whose run it is stops its runtime (SIGTERM to the group) and finishes the run as cancelled.
pub type StopRequest = Option<(u64, String)>;

/// Resolves once `rx` asks for this slot's run `run` to stop (never, once the daemon is gone).
async fn stop_requested(mut rx: watch::Receiver<StopRequest>, slot: u64, run: String) {
    loop {
        if rx
            .borrow_and_update()
            .as_ref()
            .is_some_and(|(s, r)| *s == slot && *r == run)
        {
            return;
        }
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

pub struct Retire {
    pub rx: watch::Receiver<Wanted>,
    pub generation: u64,
}

impl Retire {
    fn now(&self) -> bool {
        self.rx.borrow().generation != self.generation
    }
}

pub struct AgentLoop {
    slot: u64,
    agent: AgentConfig,
    api: Api,
    poll: Duration,
    paths: Arc<Paths>,
    state: watch::Sender<DaemonState>,
    shutdown: watch::Receiver<bool>,
    retire: Retire,
    /// Runs stopped by hand.
    stop_run: watch::Receiver<StopRequest>,
    /// Who the token is, once the server has said.
    me: Option<Identity>,
    guard: WakeGuard,
    /// Task-less items already logged, so each is said once.
    noted: std::collections::HashSet<String>,
    /// The tasks with a run going, by id; a message run is under `MESSAGES`.
    inflight: HashMap<String, Inflight>,
    /// When the last sweep for closed tasks' worktrees was, if there has been one.
    swept: Option<tokio::time::Instant>,
    /// Which task each spawned run is for, by its join id, for a run that panics.
    spawned: HashMap<Id, String>,
    /// What this machine lacks to start the agent's runs, as of the last poll.
    missing: Missing,
    /// Which backend's program was found where, and what its `probe` said there: run once per
    /// backend and place, not every poll.
    probed: Option<(&'static str, PathBuf, Option<String>)>,
}

/// A run going on a task.
struct Inflight {
    key: String,
    /// It uses `workdir`, not a worktree.
    workdir: bool,
    /// The inbox items it was started for.
    items: Vec<String>,
}

/// How often an agent with a `code_command` sweeps the worktrees of closed tasks, after the once
/// when its loop starts. A task closed by a merge or by hand gets no run that would remove its own.
const SWEEP_EVERY: Duration = Duration::from_secs(5 * 60);

/// What the sweep learned of a worktree's task from Copland.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lookup {
    Open,
    Closed,
    /// A 404: deleted, or on a board the agent isn't on, which the server doesn't tell apart.
    NotFound,
    /// Any other refusal.
    Refused,
}

/// Whether the sweep removes a task's worktree: the task is closed, or gone from a board the agent
/// is on (it reads every task there, so a 404 can only mean gone). Never while one of the agent's
/// runs is on it; a 404 from a board it isn't on, or any other refusal, leaves it alone.
fn removable(key: &str, lookup: Lookup, boards: &[String], running: &[&str]) -> bool {
    if running.iter().any(|k| k.eq_ignore_ascii_case(key)) {
        return false;
    }
    match lookup {
        Lookup::Closed => true,
        Lookup::NotFound => key
            .split_once('-')
            .is_some_and(|(board, _)| boards.iter().any(|b| b.eq_ignore_ascii_case(board))),
        Lookup::Open | Lookup::Refused => false,
    }
}

/// What the live socket has heard since the loop last looked. Flags rather than counts: one poll
/// answers any number of messages, so a poll clears what came before it (`clear`), and what
/// comes while it runs (or during a run) is kept for the next wait.
#[derive(Default)]
struct Wakes {
    notify: Notify,
    inbox: AtomicBool,
    board: AtomicBool,
}

impl Wakes {
    fn heard(&self, inbox: bool, board: bool) {
        if inbox {
            self.inbox.store(true, Ordering::SeqCst);
        }
        if board {
            self.board.store(true, Ordering::SeqCst);
        }
        if inbox || board {
            self.notify.notify_one();
        }
    }

    /// About to poll: whatever was heard until now, this poll sees.
    fn clear(&self) {
        self.inbox.store(false, Ordering::SeqCst);
        self.board.store(false, Ordering::SeqCst);
    }

    /// Whether what was heard is worth a poll: inbox always, board only when `board` is wanted.
    fn due(&self, board: bool) -> bool {
        self.inbox() || (board && self.board.load(Ordering::SeqCst))
    }

    /// Whether the inbox changed, which is worth a poll at once.
    fn inbox(&self) -> bool {
        self.inbox.load(Ordering::SeqCst)
    }
}

/// A board change is only a maybe (the guard waits on a task or a claim there), and a busy
/// board sends many, so the polls they wake are at least this far apart. The inbox wakes at once.
const BOARD_SPACING: Duration = Duration::from_secs(5);

/// The agent's live socket while its loop runs; dropping it closes the socket.
struct Live {
    wakes: Arc<Wakes>,
    link: watch::Receiver<Link>,
    task: JoinHandle<()>,
}

impl Drop for Live {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl AgentLoop {
    /// `guard` is what an earlier loop for the same agent remembered (see `run`).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        slot: u64,
        agent: AgentConfig,
        poll: Duration,
        paths: Arc<Paths>,
        state: watch::Sender<DaemonState>,
        shutdown: watch::Receiver<bool>,
        retire: Retire,
        stop_run: watch::Receiver<StopRequest>,
        guard: WakeGuard,
    ) -> Result<Self> {
        let api = Api::new(&agent.url)?;
        Ok(Self {
            slot,
            agent,
            api,
            poll,
            paths,
            state,
            shutdown,
            retire,
            stop_run,
            me: None,
            guard,
            noted: Default::default(),
            inflight: HashMap::new(),
            swept: None,
            spawned: HashMap::new(),
            missing: Missing::default(),
            probed: None,
        })
    }

    fn update(&self, f: impl FnOnce(&mut AgentState)) {
        let slot = self.slot;
        self.state
            .send_if_modified(|s| match s.agents.iter_mut().find(|a| a.slot == slot) {
                Some(a) => {
                    f(a);
                    true
                }
                None => false,
            });
    }

    fn ctx(&self) -> RunCtx {
        RunCtx {
            slot: self.slot,
            agent: self.agent.clone(),
            api: self.api.clone(),
            paths: self.paths.clone(),
            state: self.state.clone(),
            shutdown: self.shutdown.clone(),
            stop_run: self.stop_run.clone(),
        }
    }

    /// A run is over: it no longer holds its task, and the guard remembers what it saw.
    fn done(&mut self, ended: Result<(Id, Done), JoinError>) {
        match ended {
            Ok((id, d)) => {
                self.spawned.remove(&id);
                self.inflight.remove(&d.wake.task_id);
                if d.wake.task_id == MESSAGES {
                    self.guard.remember_messages(&d.claimed);
                } else if let Some((updated, held)) = d.remember {
                    self.guard.remember(&d.wake, updated, held);
                }
                if let Some(e) = d.error {
                    tracing::warn!("{e}");
                    self.update(|s| s.last_error = Some(e));
                }
            }
            Err(e) => {
                if let Some(task) = self.spawned.remove(&e.id()) {
                    self.inflight.remove(&task);
                }
                tracing::error!("a run ended without saying how: {e}");
            }
        }
    }

    /// Shutting down, or this loop's binding has been replaced: start nothing new.
    fn stopping(&self) -> bool {
        *self.shutdown.borrow() || self.retire.now()
    }

    /// Poll until shutdown or a reload retires it. Gives back what the wake guard remembers, so
    /// the loop that takes over the agent after a reload doesn't relaunch on items already seen.
    pub async fn run(mut self) -> WakeGuard {
        let live = self.listen();
        /* The same failure every poll (server down) is said once, until it changes. */
        let mut last_error: Option<String> = None;
        let mut runs: JoinSet<Done> = JoinSet::new();
        while !self.stopping() {
            while let Some(ended) = runs.try_join_next_with_id() {
                self.done(ended);
            }
            live.wakes.clear();
            match self.tick(&mut runs).await {
                Ok(()) => {
                    if last_error.take().is_some() {
                        tracing::info!("working again");
                    }
                    /* A good poll clears what went wrong, but not what the machine lacks. */
                    let lacking = self.missing.message();
                    self.update(|s| s.last_error = lacking);
                    if self.agent.code_command.is_some() && self.swept.is_none_or(|t| t.elapsed() >= SWEEP_EVERY) {
                        self.swept = Some(tokio::time::Instant::now());
                        if let Err(e) = self.sweep().await {
                            tracing::warn!("sweeping closed tasks' worktrees: {e:#}");
                        }
                    }
                }
                Err(e) => {
                    let message = format!("{e:#}");
                    if e.downcast_ref::<Unusable>().is_some() {
                        /* Asking again won't change the token: this agent stops, the others go on. */
                        tracing::error!("{message}; not watching this agent");
                        self.update(|s| s.last_error = Some(message));
                        break;
                    }
                    if last_error.as_deref() == Some(message.as_str()) {
                        tracing::debug!("{message}");
                    } else {
                        tracing::warn!("{message}");
                    }
                    self.update(|s| s.last_error = Some(message.clone()));
                    last_error = Some(message);
                }
            }
            if self.stopping() {
                break;
            }
            /* A run that ends wakes the wait, so the next poll comes at once: the inbox has likely moved on. */
            if let Some(ended) = self.wait(&live, &mut runs).await {
                self.done(ended);
            }
        }
        /* Runs going finish under this binding, as one always did; only then does it hand over or stop. */
        if !runs.is_empty() {
            tracing::info!("waiting for {} run(s) to finish", runs.len());
        }
        while let Some(ended) = runs.join_next_with_id().await {
            self.done(ended);
        }
        if self.retire.now() && !*self.shutdown.borrow() {
            /* The daemon starts whatever replaces it; the agent isn't stopped, so the window doesn't say so. */
            tracing::info!("handing over after a reload");
        } else {
            self.update(|s| s.phase = Phase::Stopped);
            tracing::info!("stopped");
        }
        self.guard
    }

    /// Open the agent's live socket for as long as the returned value lives. Its state goes into
    /// the daemon's; an "inbox" topic (or a reconnect, after which anything may have changed)
    /// wakes the loop, and a "board" one does when the guard is waiting on a task to change or
    /// on another run's claim to go, both of which come as board changes.
    fn listen(&self) -> Live {
        let wakes = Arc::new(Wakes::default());
        let (link_tx, link) = watch::channel(Link::Connecting);
        let (base, token) = (self.agent.url.clone(), self.agent.token.clone());
        let (state, slot) = (self.state.clone(), self.slot);
        let heard = wakes.clone();
        let task = tokio::spawn(
            async move {
                live::listen(
                    &base,
                    &token,
                    |topic| topic == "inbox" || topic == "board",
                    move |l| {
                        link_tx.send_replace(l);
                        state.send_if_modified(|s| match s.agents.iter_mut().find(|a| a.slot == slot) {
                            Some(a) if a.live != l => {
                                a.live = l;
                                true
                            }
                            _ => false,
                        });
                    },
                    move |h| match h {
                        Heard::Resync => heard.heard(true, false),
                        Heard::Topics(topics) => heard.heard(topics.contains("inbox"), topics.contains("board")),
                    },
                )
                .await
            }
            .in_current_span(),
        );
        Live { wakes, link, task }
    }

    /// Between polls: until the poll is due (seldom while the socket is up, at `poll_interval`
    /// while it is down), the socket says there is something, a run ends (given back), or the
    /// loop should stop.
    async fn wait(&self, live: &Live, runs: &mut JoinSet<Done>) -> Option<Result<(Id, Done), JoinError>> {
        let mut shutdown = self.shutdown.clone();
        let mut retire = self.retire.rx.clone();
        let generation = self.retire.generation;
        let mut link = live.link.clone();
        let since = tokio::time::Instant::now();
        /* A board change can make work ready (a dependency closed, a lead assigned itself a task,
        COPL-86) or wake a task the guard remembers, so it is always worth a poll, spaced out. */
        let board = true;
        /* Set once a board change is heard: when the poll it asks for is due. */
        let mut board_due: Option<tokio::time::Instant> = None;
        loop {
            let connected = *link.borrow_and_update() == Link::Connected;
            let every = if connected {
                FALLBACK_POLL.max(self.poll)
            } else {
                self.poll
            };
            tokio::select! {
                ended = runs.join_next_with_id(), if !runs.is_empty() => return ended,
                _ = tokio::time::sleep_until(since + every) => return None,
                _ = async { let _ = shutdown.wait_for(|stop| *stop).await; } => return None,
                _ = async { let _ = retire.wait_for(|w| w.generation != generation).await; } => return None,
                _ = async { tokio::time::sleep_until(board_due.expect("guarded")).await }, if board_due.is_some() => {
                    tracing::debug!("woken by the live socket (a board change)");
                    return None;
                }
                _ = live.wakes.notify.notified() => {
                    if live.wakes.inbox() {
                        tracing::debug!("woken by the live socket");
                        return None;
                    }
                    if board_due.is_none() && live.wakes.due(board) {
                        board_due = Some((since + BOARD_SPACING).max(tokio::time::Instant::now()));
                    }
                }
                changed = link.changed() => {
                    if changed.is_err() {
                        /* The listener is gone (it never ends by itself): poll on the clock. */
                        tokio::time::sleep_until(since + self.poll).await;
                        return None;
                    }
                    /* Down: a message may have been lost on the way, so look now, then poll on the clock. */
                    if *link.borrow() == Link::Reconnecting && connected {
                        return None;
                    }
                }
            }
        }
    }

    /// Remove the worktrees under `code_dir` whose tasks are closed or gone (see `removable`). Agents
    /// share `code_dir`, so this sees other agents' worktrees too, and two sweeps may meet the same one.
    async fn sweep(&self) -> Result<()> {
        let code_dir = &self.agent.code_dir;
        let found = workspace::worktrees(code_dir);
        if found.is_empty() {
            return Ok(());
        }
        let boards: Vec<String> = self
            .api
            .boards(&self.agent.token)
            .await
            .map_err(|e| anyhow!("listing boards: {e}"))?
            .into_iter()
            .map(|b| b.key)
            .collect();
        let running: Vec<&str> = self.inflight.values().map(|r| r.key.as_str()).collect();
        for (key, repo) in found {
            let lookup = match self.api.task(&self.agent.token, &key).await {
                Ok(t) if t.completed_at.is_some() => Lookup::Closed,
                Ok(_) => Lookup::Open,
                Err(e) if e.status() == Some(404) => Lookup::NotFound,
                Err(e) if e.is_refusal() => Lookup::Refused,
                Err(e) => return Err(anyhow!("reading {key}: {e}")),
            };
            if !removable(&key, lookup, &boards, &running) {
                continue;
            }
            let why = if lookup == Lookup::Closed { "closed" } else { "gone" };
            match workspace::remove(code_dir, &repo, &key).await {
                Ok(true) => tracing::info!(task = %key, "task {why}; its worktree is removed"),
                Ok(false) => {}
                Err(e) => tracing::warn!(task = %key, "removing its worktree: {e:#}"),
            }
        }
        Ok(())
    }

    /// Who the token is, from the server. The config's handle is only a label.
    async fn identity(&mut self) -> Result<Identity> {
        if let Some(me) = &self.me {
            return Ok(me.clone());
        }
        let me = whoami(&self.api, &self.agent).await?;
        if me.user.kind != "agent" {
            tracing::warn!(
                "the token for {} acts as @{}, a person, not an agent; it works, but runs will be the person's",
                self.agent.handle,
                me.user.handle
            );
        }
        if !me.user.handle.eq_ignore_ascii_case(&self.agent.handle) {
            tracing::warn!(
                "config says @{} but the token is @{}; going by the token",
                self.agent.handle,
                me.user.handle
            );
        }
        tracing::info!(url = %self.agent.url, "watching @{}'s inbox", me.user.handle);
        let identity = Identity {
            id: me.user.id,
            handle: me.user.handle,
        };
        let (handle, id) = (identity.handle.clone(), identity.id.clone());
        self.update(|s| {
            s.handle = handle;
            s.user_id = Some(id);
            s.phase = Phase::Idle;
        });
        self.me = Some(identity.clone());
        Ok(identity)
    }

    /// Everything unread, a page at a time.
    async fn unread(&self) -> Result<(u64, Vec<InboxItem>)> {
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        let mut total = 0;
        for _ in 0..MAX_PAGES {
            let page = self
                .api
                .inbox_unread(&self.agent.token, PAGE, cursor.as_deref())
                .await
                .map_err(|e| anyhow!("reading the inbox: {e}"))?;
            total = page.unread;
            items.extend(page.items);
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok((total, items))
    }

    /// Whether the sandbox works where it is found (COPL-140): what the agent's line says when it
    /// doesn't, None when it does or isn't found (which `Missing` says). Tried once per place it
    /// is found, which in effect is once at startup: after fixing what it said, restart.
    fn probe(&mut self) -> Option<String> {
        let backend = sandbox::of(&self.agent);
        let at = runner::locate(backend.program())?;
        if self
            .probed
            .as_ref()
            .is_none_or(|(name, p, _)| *name != backend.name() || *p != at)
        {
            let said = backend.probe().err().map(|e| backend.broken(&e));
            self.probed = Some((backend.name(), at, said));
        }
        self.probed.as_ref().and_then(|(_, _, said)| said.clone())
    }

    /// One poll. True when a run was launched (or tried), so the caller looks again at once.
    /// One poll: start a run for each task that needs one, as far as `max_runs` and the workdir allow.
    async fn tick(&mut self, runs: &mut JoinSet<Done>) -> Result<()> {
        let mut missing = Missing::of(&self.agent, runner::found);
        if missing.coding {
            missing.broken = self.probe();
        }
        if missing != self.missing {
            match missing.message() {
                Some(m) => tracing::warn!("{m}"),
                /* Where the sandbox is, so a Nix build shows it uses its own bwrap (COPL-137). */
                None => {
                    let backend = sandbox::of(&self.agent);
                    match runner::locate(backend.program()).filter(|_| missing.coding) {
                        Some(at) => tracing::info!(
                            "every program its runs need is found, {} at {} (the {} sandbox, for runtime {})",
                            runner::program(&[backend.program().to_string()]),
                            at.display(),
                            backend.name(),
                            self.agent.runtime.name()
                        ),
                        None => tracing::info!("every program its runs need is found"),
                    }
                }
            }
            self.missing = missing;
        }
        let me = self.identity().await?;
        let (unread, items) = self.unread().await?;
        let mut plan: Plan = plan(&me, &items);
        /* Work nobody said anything about but that can start now: a task the agent gave itself, one whose dependencies just closed. */
        let ready = self
            .api
            .ready(&self.agent.token)
            .await
            .map_err(|e| anyhow!("reading what is ready: {e}"))?;
        add_ready(&mut plan, &ready);
        let waiting: Vec<String> = plan.wakes.iter().map(|w| w.task_key.clone()).collect();
        self.update(|s| {
            s.last_poll = Some(SystemTime::now());
            s.unread = unread;
            s.waiting = waiting;
        });
        for id in &plan.taskless {
            if self.noted.insert(id.clone()) {
                tracing::info!("inbox item {id} has no task and is no message; nothing handles those");
            }
        }
        if !plan.own.is_empty() {
            tracing::debug!("{} unread item(s) are the agent's own; ignored", plan.own.len());
        }
        self.guard.retain(&plan);
        self.launch(&plan, runs).await?;
        self.queued(&plan);
        Ok(())
    }

    /// Messages to the agent that no run has had and none holds or is on: they wait for the next run.
    fn queued(&self, plan: &Plan) {
        let running: std::collections::HashSet<&str> = self
            .inflight
            .values()
            .flat_map(|r| r.items.iter().map(String::as_str))
            .collect();
        let queued = plan
            .messages
            .iter()
            .filter(|m| !m.claimed && !running.contains(m.item.as_str()) && !self.guard.had(&m.item))
            .count();
        self.update(|s| s.messages = queued);
    }

    /// One run for the messages no run has had yet and none holds, when nothing stands in its way: one
    /// going already, `max_runs`, or another run in the workdir. They wait for the next poll then.
    fn answer(&mut self, me: &Identity, plan: &Plan, runs: &mut JoinSet<Done>) {
        let batch = self.guard.new_messages(plan);
        if batch.is_empty() || self.inflight.contains_key(MESSAGES) {
            return;
        }
        if self.missing.stops(Role::Workdir) {
            tracing::debug!("{} message(s), but its program is missing; not starting", batch.len());
            return;
        }
        if self.inflight.len() >= self.agent.max_runs {
            tracing::debug!(
                "{} message(s), but {} runs are going, the most it may; next time",
                batch.len(),
                self.inflight.len()
            );
            return;
        }
        if self.inflight.values().any(|r| r.workdir) {
            tracing::debug!("{} message(s), but another run has the workdir; next time", batch.len());
            return;
        }
        self.inflight.insert(
            MESSAGES.to_string(),
            Inflight {
                key: MESSAGES.to_string(),
                workdir: true,
                items: batch.iter().map(|m| m.item.clone()).collect(),
            },
        );
        let (ctx, handle) = (self.ctx(), me.handle.clone());
        let id = runs
            .spawn(async move { ctx.answer(&handle, batch).await }.in_current_span())
            .id();
        self.spawned.insert(id, MESSAGES.to_string());
    }

    /// Start a run for the messages, then for each task that needs one, as far as
    /// `max_runs` and the workdir allow. Messages go first: they are said to the agent directly,
    /// and a run on them is short.
    async fn launch(&mut self, plan: &Plan, runs: &mut JoinSet<Done>) -> Result<()> {
        let me = self.identity().await?;
        if self.stopping() {
            return Ok(());
        }
        self.answer(&me, plan, runs);
        for wake in &plan.wakes {
            if self.stopping() {
                return Ok(());
            }
            /* A run on it already: it sees these items itself, or the next poll after it does. */
            if self.inflight.contains_key(&wake.task_id) {
                continue;
            }
            if self.inflight.len() >= self.agent.max_runs {
                tracing::debug!(task = %wake.task_key, "{} runs going, the most it may; next time", self.inflight.len());
                break;
            }
            if let Check::Seen { updated_at, held } = self.guard.check(wake) {
                let current = match self.api.task(&self.agent.token, &wake.task_id).await {
                    Ok(t) => Some((t.updated_at, t.claim.is_some())),
                    Err(e) if e.is_refusal() => None,
                    Err(e) => return Err(anyhow!("reading {}: {e}", wake.task_key)),
                };
                let now = current.as_ref().map(|(at, claimed)| (at.as_str(), *claimed));
                if !WakeGuard::again(&updated_at, held, now) {
                    if held {
                        tracing::debug!(task = %wake.task_key, "another run still holds it; waiting for that run to end");
                    } else {
                        tracing::debug!(task = %wake.task_key, "already handled these {} item(s); waiting for something new", wake.items.len());
                    }
                    continue;
                }
                if held {
                    tracing::info!(task = %wake.task_key, "the run that held it has ended; trying again");
                } else {
                    tracing::info!(task = %wake.task_key, "changed since the last run; waking");
                }
            }
            /* Coding work has a worktree of its own; anything else shares workdir, one run at a time.
            A run that turns out to answer without a claim also uses workdir, without waiting for it. */
            let lookup = self.ctx().lookup(&wake.task_id, &wake.task_key).await?;
            if lookup.role == Role::Skip {
                tracing::info!(task = %wake.task_key, "a milestone: a checkpoint, not work; nothing to run");
                self.guard.remember(wake, lookup.task.map(|t| t.updated_at), false);
                continue;
            }
            if self.missing.stops(lookup.role) {
                tracing::debug!(task = %wake.task_key, "a program its run needs is missing; not starting");
                continue;
            }
            let workdir = lookup.role == Role::Workdir;
            if workdir && self.inflight.values().any(|r| r.workdir) {
                tracing::debug!(task = %wake.task_key, "another run has the workdir; next time");
                continue;
            }
            self.inflight.insert(
                wake.task_id.clone(),
                Inflight {
                    key: wake.task_key.clone(),
                    workdir,
                    items: wake.items.clone(),
                },
            );
            let (ctx, handle, wake) = (self.ctx(), me.handle.clone(), wake.clone());
            let task_id = wake.task_id.clone();
            let id = runs
                .spawn(async move { ctx.work(&handle, wake).await }.in_current_span())
                .id();
            self.spawned.insert(id, task_id);
        }
        Ok(())
    }
}

/// What a run on a task is (COPL-87), by its board and its level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// No repo on its board, or no `code_command` for this agent: a run in `workdir`, as ever.
    Workdir,
    /// A task, a leaf: coded in its own worktree.
    Worker,
    /// An epic or a story, or anything with children: planned into tasks, reading the repo.
    Lead,
    /// A milestone: a checkpoint, not work. Nothing runs.
    Skip,
}

/// The rule, on its own so it can be tested: a leaf task is coded, anything that holds work is led.
pub fn role_of(code_command: bool, repo: bool, level: Option<&str>, has_children: bool) -> Role {
    if !code_command || !repo {
        return Role::Workdir;
    }
    match level {
        Some("milestone") => Role::Skip,
        Some("epic" | "story") => Role::Lead,
        _ if has_children => Role::Lead,
        _ => Role::Worker,
    }
}

/// What this machine lacks to start an agent's runs (COPL-136): its command's program, and for
/// coding work the sandbox's (`bwrap`, or `sandbox-exec` on macOS) and its `code_command`'s, or a
/// sandbox that is there but doesn't work (COPL-140). Looked at every poll, before a run is
/// started or a task claimed, so a missing program fails nothing and costs no task a strike: the
/// runs it would stop wait, and the agent's line says why.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Missing {
    /// The program runs in `workdir` (and message runs) start, when it can't be found.
    pub workdir: Option<String>,
    /// The first of the sandbox and the coding runtime that can't be found.
    pub code: Option<String>,
    /// The sandbox is there and `sandbox::probe` failed: what the agent's line says of it.
    pub broken: Option<String>,
    /// The agent has a `code_command`, so coding runs are its own.
    pub coding: bool,
}

impl Missing {
    pub fn of(agent: &AgentConfig, found: impl Fn(&str) -> bool) -> Self {
        let absent =
            |program: &String| (!found(program)).then(|| runner::program(std::slice::from_ref(program)).to_string());
        let workdir = agent.command.first().and_then(absent);
        let code = agent
            .code_command
            .as_ref()
            .and_then(|c| absent(&sandbox::of(agent).program().to_string()).or_else(|| c.first().and_then(absent)));
        Self {
            workdir,
            code,
            broken: None,
            coding: agent.code_command.is_some(),
        }
    }

    /// What the agent's line says ("bwrap not found on PATH: coding runs can't start; install
    /// …"), or None when nothing is missing.
    pub fn message(&self) -> Option<String> {
        let not_found = |p: &str, what: &str| format!("{p} not found on PATH: {what}");
        /* Linux distributions all package it under one name; say it. */
        let coding = |c: &str| match c {
            "bwrap" => format!(
                "{}; install the bubblewrap package (Arch, Debian, Ubuntu and Fedora all call it that)",
                not_found(c, "coding runs can't start")
            ),
            _ => not_found(c, "coding runs can't start"),
        };
        let mut said = match (&self.workdir, &self.code) {
            (None, None) => None,
            (Some(w), Some(c)) if w == c => Some(not_found(w, "runs can't start")),
            (Some(w), Some(c)) => Some(format!("{}; {}", not_found(w, "runs can't start"), coding(c))),
            (Some(w), None) if self.coding => Some(not_found(w, "only coding runs can start")),
            (Some(w), None) => Some(not_found(w, "runs can't start")),
            (None, Some(c)) => Some(coding(c)),
        };
        if let Some(b) = self.broken.as_ref().filter(|_| self.coding) {
            said = Some(match said {
                Some(s) => format!("{s}; {b}"),
                None => b.clone(),
            });
        }
        said
    }

    /// Whether a run of this role can't start: workdir runs need the command, coding runs the rest.
    fn stops(&self, role: Role) -> bool {
        match role {
            Role::Workdir => self.workdir.is_some(),
            Role::Worker | Role::Lead => self.code.is_some() || self.broken.is_some(),
            Role::Skip => false,
        }
    }
}

/// A task as a run would need it.
struct TaskInfo {
    role: Role,
    task: Option<crate::api::Task>,
    source: Option<crate::api::CodeSource>,
}

/// How a run ends, by how its runtime did. A runtime that never started is this machine's
/// trouble, not the task's: interrupted, so it costs the task no strike toward blocked.
fn ending_of(exit: &Exit) -> Ending {
    match exit {
        Exit::Code(0) => Ending::Completed,
        Exit::Stopped | Exit::SpawnFailed(_) => Ending::Interrupted,
        Exit::Cancelled => Ending::Cancelled,
        _ => Ending::Failed,
    }
}

/// The reason a run is failed with when its runtime exited 0 but left its work going (COPL-147).
pub const UNFINISHED: &str = "ended with the task still active";

/// Whether a run that claimed a task and whose runtime exited 0 left it unfinished (COPL-147): a
/// runtime's turn ending is its run ending, so work left in the background goes nowhere. These
/// are ways to stop: the task closed, blocked, back in todo or backlog; held by another run now;
/// planned rather than coded (an epic, a story, a task with children, a milestone), which stays
/// open while its children are worked; review_first with its PR open for a person, or on a repo
/// without PRs, where the branch is pushed and left. Only a task still in an active stage, none of
/// those, is unfinished. `category` is its stage's, None when that couldn't be read: not
/// unfinished, since failing a run needs to be sure.
pub fn unfinished(
    task: &crate::api::Task,
    category: Option<&str>,
    has_children: bool,
    run_id: &str,
    pull_requests: bool,
) -> bool {
    let active = task.completed_at.is_none() && category == Some("active");
    let planned = matches!(task.level.as_deref(), Some("epic" | "story" | "milestone")) || has_children;
    let elsewhere = task.claim.as_ref().is_some_and(|c| c.run_id != run_id);
    let for_review = task.review_first && (task.open_pr() || !pull_requests);
    active && !planned && !elsewhere && !for_review
}

/// What a run tells its loop when it is over.
struct Done {
    wake: Wake,
    /// For the guard: the task as the run left it, and whether another run held it. None when it
    /// went wrong before there was anything to remember (the run couldn't start or claim).
    remember: Option<(Option<String>, bool)>,
    /// A message run's: the messages it claimed, which the guard remembers whatever the ending.
    claimed: Vec<Message>,
    /// What went wrong, for the agent's error line.
    error: Option<String>,
}

impl Done {
    fn failed(wake: Wake, error: String) -> Self {
        Self {
            wake,
            remember: None,
            claimed: Vec::new(),
            error: Some(error),
        }
    }

    fn ran(wake: Wake, updated_at: Option<String>, held: bool) -> Self {
        Self {
            wake,
            remember: Some((updated_at, held)),
            claimed: Vec::new(),
            error: None,
        }
    }
}

/// Claim each message of a batch for one run (COPL-124), through `claim` (the run's secret
/// against `POST /api/messages/:id/claim`). Gives back those the run now holds, in order, and
/// the others with the server's word on each: another run has it ("claimed"), or it was dealt
/// with since the inbox was read ("read"). Only those claimed go in the run's prompt, so two
/// runs that planned from the same inbox never both handle a message. Anything but a refusal
/// (the server unreachable) is an error, and the run claims nothing more.
async fn claim_batch<F, Fut>(
    batch: Vec<Message>,
    mut claim: F,
) -> Result<(Vec<Message>, Vec<(Message, String)>), ApiError>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), ApiError>>,
{
    let (mut held, mut left) = (Vec::new(), Vec::new());
    for m in batch {
        match claim(m.id.clone()).await {
            Ok(()) => held.push(m),
            Err(e) if e.is_refusal() => left.push((m, e.to_string())),
            Err(e) => return Err(e),
        }
    }
    Ok((held, left))
}

/// What one run needs of its loop, cloned, so it can go on while the loop polls and starts others.
#[derive(Clone)]
struct RunCtx {
    slot: u64,
    agent: AgentConfig,
    api: Api,
    paths: Arc<Paths>,
    state: watch::Sender<DaemonState>,
    shutdown: watch::Receiver<bool>,
    stop_run: watch::Receiver<StopRequest>,
}

impl RunCtx {
    fn update(&self, f: impl FnOnce(&mut AgentState)) {
        let slot = self.slot;
        self.state
            .send_if_modified(|s| match s.agents.iter_mut().find(|a| a.slot == slot) {
                Some(a) => {
                    f(a);
                    true
                }
                None => false,
            });
    }

    /// The task as it is now, for the guard's memory.
    async fn updated_at(&self, task_id: &str) -> Option<String> {
        self.api
            .task(&self.agent.token, task_id)
            .await
            .ok()
            .map(|t| t.updated_at)
    }

    async fn finish(&self, run_id: &str, ending: Ending, reason: Option<&str>) -> String {
        match self.api.finish_run(&self.agent.token, run_id, ending, reason).await {
            Ok(r) => r.status,
            Err(e) => {
                tracing::warn!(run = %runner::short(run_id), "finishing the run as {} failed: {e}", ending.as_str());
                format!("unfinished ({e})")
            }
        }
    }

    /// One run on one task, start to finish: start it, claim, make the workspace when it is coding
    /// work, launch the runtime and wait for it, finish the run.
    async fn work(self, me: &str, wake: Wake) -> Done {
        let key = wake.task_key.clone();
        tracing::info!(task = %key, items = wake.items.len(), "waking for {key}");
        let started = match self.api.start_run(&self.agent.token, &self.agent.client).await {
            Ok(s) => s,
            Err(e) => return Done::failed(wake, format!("starting a run for {key}: {e}")),
        };
        let run_id = started.run.id.clone();
        let short = started.run.short.clone();
        self.update(|s| s.run_started(&short, &key));

        let brief = match self.api.claim(&started.secret, &wake.task_id).await {
            Ok(task) => {
                tracing::info!(run = %short, task = %task.key, "claimed");
                Brief::Work
            }
            Err(e @ ApiError::Status { .. }) if e.is_refusal() => match refused(e.code(), &wake) {
                Refused::Answer(brief) => {
                    /* Not the agent's to take, but something was said to it there: answer, without a claim. */
                    tracing::info!(run = %short, task = %key, "not claimed ({e}); launching to answer, without a claim");
                    brief
                }
                why => {
                    let ending = self.finish(&run_id, Ending::Cancelled, None).await;
                    self.update(|s| s.run_ended(&short));
                    let held = why == Refused::Hold;
                    if held {
                        tracing::info!(run = %short, task = %key, "another run holds it; coming back when that run ends: {e}");
                    } else {
                        tracing::info!(run = %short, task = %key, "claim refused, skipping: {e}");
                    }
                    let updated = self.updated_at(&wake.task_id).await;
                    self.summary(&short, &key, format!("skipped ({ending}): {e}"), false);
                    return Done::ran(wake, updated, held);
                }
            },
            Err(e) => {
                self.finish(&run_id, Ending::Interrupted, None).await;
                self.update(|s| s.run_ended(&short));
                return Done::failed(wake, format!("claiming {key}: {e}"));
            }
        };

        /* A coding task (its board has a repo, and the agent a code_command) runs in its workspace. */
        let workspace = if brief == Brief::Work {
            match self.workspace(&wake.task_id, &key).await {
                Ok(ws) => ws,
                Err(e) => {
                    tracing::warn!(run = %short, task = %key, "its workspace could not be made: {e:#}");
                    let ending = self.finish(&run_id, Ending::Failed, None).await;
                    self.update(|s| s.run_ended(&short));
                    let updated = self.updated_at(&wake.task_id).await;
                    self.summary(&short, &key, format!("{ending}: no workspace ({e})"), true);
                    return Done::ran(wake, updated, false);
                }
            }
        } else {
            None
        };
        if let Some(ws) = &workspace {
            tracing::info!(run = %short, task = %key, dir = %ws.dir.display(), branch = %ws.branch, fresh = ws.fresh, "workspace ready");
        }

        /* The program the run starts, for the plain word on one that dies at once. */
        let runtime = runner::program(match (&workspace, &self.agent.code_command) {
            (Some(_), Some(code)) => code,
            _ => &self.agent.command,
        })
        .to_string();
        let ended = runner::run(
            Launch {
                api: &self.api,
                agent: &self.agent,
                handle: me,
                run_id: &run_id,
                secret: &started.secret,
                task_id: &wake.task_id,
                task_key: &key,
                brief,
                messages: &[],
                state_dir: &self.paths.state_dir,
                runtime_dir: &self.paths.runtime_dir,
                workspace: workspace.as_ref(),
            },
            self.shutdown.clone(),
            stop_requested(self.stop_run.clone(), self.slot, short.clone()),
        )
        .await;
        let (mut ending, mut how) = (ending_of(&ended.exit), ended.reason());
        let mut left = false;
        let lead = workspace.as_ref().is_some_and(|ws| ws.read_only);
        if brief == Brief::Work && ending == Ending::Completed && !lead {
            let pull_requests = workspace.as_ref().is_some_and(|ws| ws.pull_requests);
            if let Some(task) = self.left_going(&wake.task_id, &key, &run_id, pull_requests).await {
                /* Failing puts back what the run holds: one that let it go takes it again first. */
                if task.claim.is_none() {
                    if let Err(e) = self.api.claim(&started.secret, &wake.task_id).await {
                        tracing::warn!(run = %short, task = %key, "taking it again to put it back: {e}");
                    }
                }
                tracing::warn!(run = %short, task = %key, "runtime {how}, with the task still active; failing the run");
                (ending, how) = (Ending::Failed, UNFINISHED.to_string());
                left = true;
            }
        }
        drop(started);
        let status = self.finish(&run_id, ending, Some(&how)).await;
        if status == ending.as_str() {
            tracing::info!(run = %short, task = %key, "runtime {how}; run {status}");
        } else {
            /* The runtime finished it first (finish_run), and its word stands. */
            tracing::info!(run = %short, task = %key, "runtime {how}; run {status} (finished by the runtime)");
        }
        /* A closed task's worktree has nothing left to do; its branch lives on in the remote. */
        if let Some(ws) = &workspace {
            if let Ok(t) = self.api.task(&self.agent.token, &wake.task_id).await {
                if t.completed_at.is_some() {
                    match workspace::remove(&self.agent.code_dir, &ws.repo, &ws.key).await {
                        Ok(_) => tracing::info!(task = %key, "task closed; its worktree is removed"),
                        Err(e) => tracing::warn!(task = %key, "removing its worktree: {e:#}"),
                    }
                }
            }
        }
        /* Remembered whatever the ending, a ceiling included, so it isn't launched again for the same items. */
        let updated = self.updated_at(&wake.task_id).await;
        self.ran(&run_id, &short, &key, status, &ended, &runtime, left);
        self.update(|s| s.run_ended(&short));
        Done::ran(wake, updated, false)
    }

    /// The task, when the run whose runtime just exited 0 left it unfinished (`unfinished`).
    /// None when it stopped properly, or when the task or its board can't be read.
    async fn left_going(
        &self,
        task_id: &str,
        key: &str,
        run_id: &str,
        pull_requests: bool,
    ) -> Option<crate::api::Task> {
        let read = async {
            let task = self.api.task(&self.agent.token, task_id).await?;
            let board = self.api.board_repos(&self.agent.token, &task.board_id).await?;
            Ok::<_, ApiError>((task, board))
        };
        let (task, board) = match read.await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(task = %key, "reading where the run left it: {e}");
                return None;
            }
        };
        let category = task.stage_id.as_deref().and_then(|s| board.category(s));
        let has_children = board.has_children(task_id);
        unfinished(&task, category, has_children, run_id, pull_requests).then_some(task)
    }

    /// One run on messages, about a task or not (COPL-127): start it, claim each message for it
    /// (COPL-124), launch the runtime in `workdir` with those it holds in its prompt, finish the run
    /// (which ends the claims). A message another run claimed first is left to it; a batch left
    /// empty launches nothing.
    async fn answer(self, me: &str, batch: Vec<Message>) -> Done {
        let wake = Wake {
            task_id: MESSAGES.to_string(),
            task_key: MESSAGES.to_string(),
            items: batch.iter().map(|m| m.item.clone()).collect(),
            oldest: batch.first().map(|m| m.at.clone()).unwrap_or_default(),
            mentioned: true,
            commented: true,
        };
        let n = batch.len();
        tracing::info!(messages = n, "waking for {n} message(s)");
        let started = match self.api.start_run(&self.agent.token, &self.agent.client).await {
            Ok(s) => s,
            Err(e) => return Done::failed(wake, format!("starting a run for {n} message(s): {e}")),
        };
        let run_id = started.run.id.clone();
        let short = started.run.short.clone();
        let claims = claim_batch(batch, |id| {
            let (api, secret) = (&self.api, &started.secret);
            async move { api.claim_message(secret, &id).await.map(|_| ()) }
        })
        .await;
        let claimed = match claims {
            Ok((claimed, left)) => {
                for (m, why) in &left {
                    tracing::info!(run = %short, message = %m.id, "message not claimed, leaving it: {why}");
                }
                claimed
            }
            Err(e) => {
                self.finish(&run_id, Ending::Interrupted, None).await;
                return Done::failed(wake, format!("claiming {n} message(s): {e}"));
            }
        };
        if claimed.is_empty() {
            let ending = self.finish(&run_id, Ending::Cancelled, None).await;
            tracing::info!(run = %short, "every message was claimed by another run or read; nothing to launch");
            self.summary(
                &short,
                MESSAGES,
                format!("skipped ({ending}): nothing left to claim"),
                false,
            );
            return Done::ran(wake, None, false);
        }
        let n = claimed.len();
        tracing::info!(run = %short, messages = n, "claimed {n} message(s)");
        self.update(|s| s.run_started(&short, MESSAGES));
        let ended = runner::run(
            Launch {
                api: &self.api,
                agent: &self.agent,
                handle: me,
                run_id: &run_id,
                secret: &started.secret,
                task_id: "",
                task_key: MESSAGES,
                brief: Brief::Message,
                messages: &claimed,
                state_dir: &self.paths.state_dir,
                runtime_dir: &self.paths.runtime_dir,
                workspace: None,
            },
            self.shutdown.clone(),
            stop_requested(self.stop_run.clone(), self.slot, short.clone()),
        )
        .await;
        drop(started);
        let how = ended.reason();
        let status = self.finish(&run_id, ending_of(&ended.exit), Some(&how)).await;
        tracing::info!(run = %short, messages = n, "runtime {how}; run {status}");
        self.ran(
            &run_id,
            &short,
            MESSAGES,
            status,
            &ended,
            runner::program(&self.agent.command),
            false,
        );
        self.update(|s| s.run_ended(&short));
        /* Remembered whatever the ending, so a message the run left unread doesn't launch another. */
        Done {
            claimed,
            ..Done::ran(wake, None, false)
        }
    }
    /// What a run on the task would be (COPL-87), with the task and the repo when it was read.
    async fn lookup(&self, task_id: &str, key: &str) -> Result<TaskInfo> {
        if self.agent.code_command.is_none() {
            return Ok(TaskInfo {
                role: Role::Workdir,
                task: None,
                source: None,
            });
        }
        let task = self
            .api
            .task(&self.agent.token, task_id)
            .await
            .map_err(|e| anyhow!("reading {key}: {e}"))?;
        let board = self
            .api
            .board_repos(&self.agent.token, &task.board_id)
            .await
            .map_err(|e| anyhow!("reading {key}'s board: {e}"))?;
        if board.repos.len() > 1 {
            tracing::debug!(task = %key, "its board has {} repos; working in the first", board.repos.len());
        }
        let has_children = board.has_children(task_id);
        let role = role_of(true, !board.repos.is_empty(), task.level.as_deref(), has_children);
        let source = board.repos.first().map(|r| r.source());
        Ok(TaskInfo {
            role,
            task: Some(task),
            source,
        })
    }

    /// Where the run works: a worker's worktree, a lead's read-only view of the repo, or none
    /// (the agent's `workdir`).
    async fn workspace(&self, task_id: &str, key: &str) -> Result<Option<Workspace>> {
        let TaskInfo { role, task, source } = self.lookup(task_id, key).await?;
        let (Some(task), Some(src)) = (task, source) else {
            return Ok(None);
        };
        let dir = &self.agent.code_dir;
        let ws = match role {
            Role::Worker => workspace::realize(dir, &src.remote, &src.dir, key, &task.title).await?,
            Role::Lead => workspace::view(dir, &src.remote, &src.dir, key).await?,
            Role::Workdir | Role::Skip => return Ok(None),
        };
        Ok(Some(Workspace {
            pull_requests: src.pull_requests,
            ..ws
        }))
    }

    fn summary(&self, run: &str, task: &str, outcome: String, failed: bool) {
        let last = RunSummary {
            run: run.to_string(),
            task: task.to_string(),
            outcome,
            failed,
            how: None,
            hint: None,
            log: None,
            ended: SystemTime::now(),
        };
        self.update(|s| s.last_run = Some(last));
    }

    /// A run whose runtime was launched is over: what the box says of it (COPL-136). Failed by how
    /// the runtime ended, whatever the run's status says (a runtime may finish its run, then die),
    /// or because it exited 0 with its task still active (`left`, COPL-147).
    #[allow(clippy::too_many_arguments)]
    fn ran(&self, run_id: &str, run: &str, task: &str, status: String, ended: &Ended, runtime: &str, left: bool) {
        let last = RunSummary {
            run: run.to_string(),
            task: task.to_string(),
            outcome: status,
            failed: left || !matches!(ended.exit, Exit::Code(0) | Exit::Stopped | Exit::Cancelled),
            how: Some(if left {
                format!("{}, {UNFINISHED}", ended.reason())
            } else {
                ended.reason()
            }),
            hint: ended.hint(runtime),
            log: Some(runner::log_path(&self.paths.state_dir, run_id)),
            ended: SystemTime::now(),
        };
        self.update(|s| s.last_run = Some(last));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Copland's message claims, as far as the race goes: one run per message, refused (409
    /// "claimed") to any other, and a read message never claimed (409 "read").
    #[derive(Default)]
    struct Server {
        claims: std::sync::Mutex<HashMap<String, String>>,
        read: std::sync::Mutex<std::collections::HashSet<String>>,
    }

    impl Server {
        async fn claim(&self, run: &str, id: String) -> Result<(), ApiError> {
            /* Let the other run in between every call, as two processes would. */
            tokio::task::yield_now().await;
            let refused = |code: &str| ApiError::Status {
                status: 409,
                code: Some(code.into()),
                message: format!("{id}: {code}"),
            };
            if self.read.lock().unwrap().contains(&id) {
                return Err(refused("read"));
            }
            let mut claims = self.claims.lock().unwrap();
            match claims.get(&id) {
                Some(holder) if holder != run => Err(refused("claimed")),
                _ => {
                    claims.insert(id, run.into());
                    Ok(())
                }
            }
        }
    }

    fn inbox_message(n: u32) -> InboxItem {
        serde_json::from_value(serde_json::json!({
            "id": format!("i{n}"),
            "kind": "message",
            "task": if n % 2 == 0 { serde_json::json!({ "id": "t1", "key": "COPL-1", "title": "" }) } else { serde_json::Value::Null },
            "actor": { "id": "u-owner", "handle": "owner" },
            "message": { "id": format!("m{n}"), "text": "create a dummy task on copland", "trusted": true },
            "createdAt": format!("2026-10-04T06:0{n}:00.000Z"),
            "readAt": null
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn two_runs_on_one_inbox_handle_each_message_exactly_once() {
        let me = Identity {
            id: "u-dev".into(),
            handle: "owner/dev".into(),
        };
        /* Two messages, one about a task; two daemons (or two runs) that read the inbox at the same time. */
        let items = [inbox_message(1), inbox_message(2)];
        let (a, b) = (WakeGuard::default(), WakeGuard::default());
        let (pa, pb) = (plan(&me, &items), plan(&me, &items));
        /* The message about a task wakes no task run. */
        assert!(pa.wakes.is_empty());
        let (batch_a, batch_b) = (a.new_messages(&pa), b.new_messages(&pb));
        assert_eq!(batch_a.len(), 2);
        assert_eq!(batch_a, batch_b);

        let server = Server::default();
        let (got_a, got_b) = tokio::join!(
            claim_batch(batch_a, |id| server.claim("run-a", id)),
            claim_batch(batch_b, |id| server.claim("run-b", id)),
        );
        let ((held_a, left_a), (held_b, left_b)) = (got_a.unwrap(), got_b.unwrap());
        let mut handled: Vec<_> = held_a.iter().chain(&held_b).map(|m| m.id.clone()).collect();
        handled.sort();
        assert_eq!(handled, ["m1", "m2"], "each message is in exactly one run's prompt");
        assert_eq!(left_a.len() + left_b.len(), 2, "and refused to the other");
        assert!(left_a.iter().chain(&left_b).all(|(_, why)| why.contains("claimed")));

        /* A third run that read the inbox before the first marked m1 read is refused it too. */
        server.read.lock().unwrap().insert("m1".into());
        server.claims.lock().unwrap().clear();
        let (held, left) = claim_batch(a.new_messages(&pa), |id| server.claim("run-c", id))
            .await
            .unwrap();
        assert_eq!(held.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m2"]);
        assert!(left[0].1.contains("read"));

        /* Everything refused: an empty batch, and the run launches nothing. */
        let (held, _) = claim_batch(b.new_messages(&pb), |id| server.claim("run-d", id))
            .await
            .unwrap();
        assert!(held.is_empty());

        /* Anything but a refusal stops the claiming: the run fails and claims nothing more. */
        let err = claim_batch(a.new_messages(&pa), |_| async {
            Err::<(), _>(ApiError::Transport("down".into()))
        })
        .await;
        assert!(err.is_err());
    }

    fn agent(command: &[&str], code: Option<&[&str]>) -> AgentConfig {
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        AgentConfig {
            url: "http://127.0.0.1:9".into(),
            handle: "me/dev".into(),
            token: crate::config::Secret::new("cpl_x"),
            command: argv(command),
            workdir: std::env::temp_dir(),
            client: "test".into(),
            code_command: code.map(argv),
            writable: Vec::new(),
            runtime: crate::config::Runtime::detect(&argv(code.unwrap_or(command))),
            code_dir: "/tmp/copland-code".into(),
            max_runs: 10,
        }
    }

    /// What the machine lacks is said before anything starts, and stops only the runs that need it.
    #[test]
    fn a_missing_program_is_said_and_stops_only_its_runs() {
        let claude = ["/run/current-system/sw/bin/claude", "-p"];
        let a = agent(&claude, Some(&claude));
        /* The agent's backend: the platform's fallback for Claude Code, Codex's own for Codex (COPL-143). */
        let program = sandbox::of(&a).program();
        assert_eq!(sandbox::of(&agent(&claude, Some(&["codex"]))).program(), "codex");
        let none = Missing::of(&a, |_| true);
        assert_eq!(none.message(), None);
        assert!(!none.stops(Role::Workdir) && !none.stops(Role::Worker));

        /* Missing bwrap says which package has it (COPL-140). */
        let no_bwrap = Missing::of(&a, |p| p != program);
        assert_eq!(
            no_bwrap.message().as_deref(),
            Some(if cfg!(target_os = "macos") {
                "sandbox-exec not found on PATH: coding runs can't start"
            } else {
                "bwrap not found on PATH: coding runs can't start; install the bubblewrap package (Arch, Debian, Ubuntu and Fedora all call it that)"
            })
        );
        assert!(no_bwrap.stops(Role::Worker) && no_bwrap.stops(Role::Lead));
        assert!(!no_bwrap.stops(Role::Workdir) && !no_bwrap.stops(Role::Skip));

        /* There but not working: said, and it stops coding runs only. */
        let broken = Missing {
            broken: Some(sandbox::of(&a).broken("setting up uid map: Permission denied")),
            ..none.clone()
        };
        let said = broken.message().expect("said");
        assert!(said.contains("setting up uid map: Permission denied") && said.contains("coding runs can't start"));
        if cfg!(target_os = "linux") {
            assert!(
                said.contains("AppArmor") && said.contains("bubblewrap package"),
                "{said}"
            );
        }
        assert!(broken.stops(Role::Worker) && broken.stops(Role::Lead) && !broken.stops(Role::Workdir));
        let both = Missing {
            broken: broken.broken.clone(),
            ..Missing::of(&agent(&["codex", "exec"], Some(&claude)), |p| p != "codex")
        };
        assert_eq!(
            both.message().as_deref(),
            Some(format!("codex not found on PATH: only coding runs can start; {said}").as_str())
        );
        /* Without coding runs a broken sandbox is nothing to say. */
        let plain = Missing {
            broken: broken.broken.clone(),
            ..Missing::of(&agent(&claude, None), |_| true)
        };
        assert_eq!(plain.message(), None);

        let no_claude = Missing::of(&a, |p| p == program);
        assert_eq!(
            no_claude.message().as_deref(),
            Some("claude not found on PATH: runs can't start")
        );
        assert!(no_claude.stops(Role::Workdir) && no_claude.stops(Role::Worker));

        let other = agent(&["codex", "exec"], Some(&claude));
        assert_eq!(
            Missing::of(&other, |p| p != "codex").message().as_deref(),
            Some("codex not found on PATH: only coding runs can start")
        );
        assert_eq!(
            Missing::of(&other, |p| p == program).message().as_deref(),
            Some("codex not found on PATH: runs can't start; claude not found on PATH: coding runs can't start")
        );

        /* No code_command: bwrap is never needed. */
        let plain = agent(&claude, None);
        assert_eq!(Missing::of(&plain, |p| p != program).message(), None);
        assert_eq!(
            Missing::of(&plain, |_| false).message().as_deref(),
            Some("claude not found on PATH: runs can't start")
        );
    }

    /// A runtime that never started is the machine's trouble: no strike for the task.
    #[test]
    fn a_spawn_failure_is_no_strike() {
        assert_eq!(
            ending_of(&Exit::SpawnFailed("bwrap: not found".into())),
            Ending::Interrupted
        );
        assert_eq!(ending_of(&Exit::Code(1)), Ending::Failed);
        assert_eq!(ending_of(&Exit::Signal(9)), Ending::Failed);
        assert_eq!(ending_of(&Exit::TimedOut), Ending::Failed);
        assert_eq!(ending_of(&Exit::Code(0)), Ending::Completed);
    }

    /// A task as GET /api/tasks/:id sends it, with `extra` over a plain leaf in a stage "s".
    fn task_with(extra: serde_json::Value) -> crate::api::Task {
        let mut t = serde_json::json!({
            "id": "t1", "key": "COPL-1", "boardId": "b1", "title": "", "updatedAt": "",
            "completedAt": null, "level": "task", "claim": null, "stageId": "s",
            "reviewFirst": false, "code": [],
        });
        t.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(t).unwrap()
    }

    /// COPL-147: a runtime that exits 0 with its task still active, and none of the ways to stop,
    /// left its work going (in the background, "I'll pick it up from there").
    #[test]
    fn an_active_task_left_behind_is_unfinished() {
        let plain = task_with(serde_json::json!({}));
        /* Held by this run, or by none (it let the task go): either way nobody is on it. */
        let mine = task_with(serde_json::json!({ "claim": { "runId": "r1", "run": "r1" } }));
        for t in [&plain, &mine] {
            assert!(unfinished(t, Some("active"), false, "r1", true));
            assert!(unfinished(t, Some("active"), false, "r1", false));
        }
        /* An open PR is no excuse without review_first: the agent merges those itself. */
        let pr = task_with(serde_json::json!({ "code": [{ "kind": "pull", "state": "open" }] }));
        assert!(unfinished(&pr, Some("active"), false, "r1", true));
        /* review_first on a GitHub repo needs the PR open; a branch or a merged PR isn't one. */
        let no_pr = task_with(serde_json::json!({
            "reviewFirst": true,
            "code": [{ "kind": "branch", "state": "open" }, { "kind": "pull", "state": "merged" }],
        }));
        assert!(unfinished(&no_pr, Some("active"), false, "r1", true));
    }

    /// COPL-147: the ways a run stops properly, which never fail it.
    #[test]
    fn the_ways_to_stop_are_not_unfinished() {
        let plain = task_with(serde_json::json!({}));
        for stage in ["done", "cancelled", "blocked", "todo", "backlog"] {
            assert!(!unfinished(&plain, Some(stage), false, "r1", true), "{stage}");
        }
        /* Closed, whatever the stage read says. */
        let closed = task_with(serde_json::json!({ "completedAt": "2026-10-05T00:00:00Z" }));
        assert!(!unfinished(&closed, Some("active"), false, "r1", true));
        /* A stage that couldn't be read: failing a run needs to be sure. */
        assert!(!unfinished(&plain, None, false, "r1", true));
        /* Another run is on it now. */
        let other = task_with(serde_json::json!({ "claim": { "runId": "r2", "run": "r2" } }));
        assert!(!unfinished(&other, Some("active"), false, "r1", true));
        /* Planned, not coded: it stays open while its children are worked. */
        for level in ["epic", "story", "milestone"] {
            let t = task_with(serde_json::json!({ "level": level }));
            assert!(!unfinished(&t, Some("active"), false, "r1", true), "{level}");
        }
        assert!(!unfinished(&plain, Some("active"), true, "r1", true));
        /* review_first, left in doing for a person: its PR open (a draft too), as COPL-146 was left. */
        for state in ["open", "draft"] {
            let t = task_with(serde_json::json!({
                "reviewFirst": true,
                "code": [{ "kind": "pull", "state": state }],
            }));
            assert!(!unfinished(&t, Some("active"), false, "r1", true), "{state}");
        }
        /* review_first on a repo without PRs (or no repo): the pushed branch is what it leaves. */
        let review = task_with(serde_json::json!({ "reviewFirst": true }));
        assert!(!unfinished(&review, Some("active"), false, "r1", false));
    }

    /// An older server sends none of what `unfinished` reads: no stage, so never unfinished.
    #[test]
    fn an_older_servers_task_reads_and_is_never_unfinished() {
        let t: crate::api::Task = serde_json::from_value(serde_json::json!({
            "id": "t1", "key": "COPL-1", "boardId": "b1", "title": "", "updatedAt": "", "completedAt": null,
        }))
        .unwrap();
        assert!(t.stage_id.is_none() && !t.review_first && !t.open_pr());
        let board: crate::api::BoardRepos = serde_json::from_value(serde_json::json!({ "repos": [] })).unwrap();
        assert_eq!(board.category("s"), None);
        assert!(!unfinished(&t, None, false, "r1", true));
    }

    #[test]
    fn a_leaf_task_is_coded_and_what_holds_work_is_led() {
        /* No coding setup or no repo: the old way, whatever the level. */
        assert_eq!(role_of(false, true, Some("story"), true), Role::Workdir);
        assert_eq!(role_of(true, false, Some("story"), true), Role::Workdir);
        assert_eq!(role_of(true, true, Some("task"), false), Role::Worker);
        assert_eq!(role_of(true, true, None, false), Role::Worker);
        assert_eq!(role_of(true, true, Some("story"), false), Role::Lead);
        assert_eq!(role_of(true, true, Some("epic"), false), Role::Lead);
        /* A task split into children is led too. */
        assert_eq!(role_of(true, true, Some("task"), true), Role::Lead);
        assert_eq!(role_of(true, true, Some("milestone"), false), Role::Skip);
    }

    #[test]
    fn the_sweep_removes_closed_and_gone_tasks_worktrees_only() {
        let boards = vec!["COPL".to_string(), "WRD".to_string()];
        let none: &[&str] = &[];
        assert!(removable("COPL-80", Lookup::Closed, &boards, none));
        assert!(!removable("COPL-81", Lookup::Open, &boards, none));
        /* Closed, but a run of this agent's is still on it (the run removes it itself when it ends). */
        assert!(!removable("COPL-80", Lookup::Closed, &boards, &["copl-80"]));
        assert!(removable("COPL-80", Lookup::Closed, &boards, &["COPL-8"]));
        /* A 404 on a board the agent is on is a deleted task; elsewhere it is a refusal. */
        assert!(removable("copl-9", Lookup::NotFound, &boards, none));
        assert!(!removable("OTHER-9", Lookup::NotFound, &boards, none));
        assert!(!removable("COPL-9", Lookup::NotFound, &boards, &["COPL-9"]));
        assert!(!removable("COPL-10", Lookup::Refused, &boards, none));
        assert!(!removable("COPL-10", Lookup::NotFound, &[], none));
    }

    #[tokio::test]
    async fn a_poll_answers_what_was_heard_before_it_and_keeps_what_came_during_it() {
        let w = Wakes::default();
        assert!(!w.due(true));
        /* A board change wakes only a loop that is waiting on one. */
        w.heard(false, true);
        /* Only a maybe: the wait spaces it out (BOARD_SPACING) instead of polling at once. */
        assert!(!w.inbox());
        assert!(w.due(true));
        assert!(!w.due(false));
        /* The permit stays for the waiter, even when nobody was waiting. */
        tokio::time::timeout(Duration::from_millis(50), w.notify.notified())
            .await
            .expect("woken");
        /* Polling now: everything so far is answered by it. */
        w.clear();
        assert!(!w.due(true));
        /* Heard while polling (or during a run): still due for the next wait. */
        w.heard(true, false);
        w.heard(true, true);
        assert!(w.due(false));
        tokio::time::timeout(Duration::from_millis(50), w.notify.notified())
            .await
            .expect("woken");
        /* Nothing heard: no wake. */
        w.clear();
        w.heard(false, false);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), w.notify.notified())
                .await
                .is_err()
        );
    }
}

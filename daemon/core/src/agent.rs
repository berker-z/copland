//! One agent's loop: poll its unread inbox, and for a task that needs it,
//! start a run, claim the task, launch the runtime, finish the run.
//!
//! Runs go on their own (RunCtx::work), so an agent can have several at once
//! (COPL-82), up to its `max_runs`. Only coding tasks run side by side, each in
//! its own worktree; anything else shares the agent's `workdir`, one at a time.
//! A task is never in two runs from one loop. The loop hears each run's end
//! (Done) and remembers it in the wake guard, as before.

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
use crate::guard::{Check, Identity, Plan, Refused, Wake, WakeGuard, plan, refused};
use crate::live::{self, FALLBACK_POLL, Heard, Link};
use crate::runner::{self, Brief, Exit, Launch};
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
    /// The tasks with a run going, by id, and whether that run uses `workdir` (not a worktree).
    inflight: HashMap<String, bool>,
    /// Which task each spawned run is for, by its join id, for a run that panics.
    spawned: HashMap<Id, String>,
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
            spawned: HashMap::new(),
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
                if let Some((updated, held)) = d.remember {
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
                    self.update(|s| s.last_error = None);
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
        /* A task the guard remembers wakes again on a change to it, which is a board change. */
        let board = self.guard.remembered() > 0;
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

    /// One poll. True when a run was launched (or tried), so the caller looks again at once.
    /// One poll: start a run for each task that needs one, as far as `max_runs` and the workdir allow.
    async fn tick(&mut self, runs: &mut JoinSet<Done>) -> Result<()> {
        let me = self.identity().await?;
        let (unread, items) = self.unread().await?;
        let plan: Plan = plan(&me, &items);
        let waiting: Vec<String> = plan.wakes.iter().map(|w| w.task_key.clone()).collect();
        self.update(|s| {
            s.last_poll = Some(SystemTime::now());
            s.unread = unread;
            s.waiting = waiting;
        });
        for id in &plan.taskless {
            if self.noted.insert(id.clone()) {
                tracing::info!("inbox item {id} has no task; nothing handles those yet");
            }
        }
        if !plan.own.is_empty() {
            tracing::debug!("{} unread item(s) are the agent's own; ignored", plan.own.len());
        }
        self.guard.retain(&plan);
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
            let workdir = self.ctx().repos(&wake.task_id, &wake.task_key).await?.is_none();
            if workdir && self.inflight.values().any(|w| *w) {
                tracing::debug!(task = %wake.task_key, "another run has the workdir; next time");
                continue;
            }
            self.inflight.insert(wake.task_id.clone(), workdir);
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

/// What a run tells its loop when it is over.
struct Done {
    wake: Wake,
    /// For the guard: the task as the run left it, and whether another run held it. None when it
    /// went wrong before there was anything to remember (the run couldn't start or claim).
    remember: Option<(Option<String>, bool)>,
    /// What went wrong, for the agent's error line.
    error: Option<String>,
}

impl Done {
    fn failed(wake: Wake, error: String) -> Self {
        Self {
            wake,
            remember: None,
            error: Some(error),
        }
    }
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

    async fn finish(&self, run_id: &str, ending: Ending) -> String {
        match self.api.finish_run(&self.agent.token, run_id, ending).await {
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
                    let ending = self.finish(&run_id, Ending::Cancelled).await;
                    self.update(|s| s.run_ended(&short));
                    let held = why == Refused::Hold;
                    if held {
                        tracing::info!(run = %short, task = %key, "another run holds it; coming back when that run ends: {e}");
                    } else {
                        tracing::info!(run = %short, task = %key, "claim refused, skipping: {e}");
                    }
                    let updated = self.updated_at(&wake.task_id).await;
                    self.summary(&short, &key, format!("skipped ({ending}): {e}"));
                    return Done {
                        wake,
                        remember: Some((updated, held)),
                        error: None,
                    };
                }
            },
            Err(e) => {
                self.finish(&run_id, Ending::Cancelled).await;
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
                    let ending = self.finish(&run_id, Ending::Failed).await;
                    self.update(|s| s.run_ended(&short));
                    let updated = self.updated_at(&wake.task_id).await;
                    self.summary(&short, &key, format!("{ending}: no workspace ({e})"));
                    return Done {
                        wake,
                        remember: Some((updated, false)),
                        error: None,
                    };
                }
            }
        } else {
            None
        };
        if let Some(ws) = &workspace {
            tracing::info!(run = %short, task = %key, dir = %ws.dir.display(), branch = %ws.branch, fresh = ws.fresh, "workspace ready");
        }

        let exit = runner::run(
            Launch {
                api: &self.api,
                agent: &self.agent,
                handle: me,
                run_id: &run_id,
                secret: &started.secret,
                task_key: &key,
                brief,
                state_dir: &self.paths.state_dir,
                runtime_dir: &self.paths.runtime_dir,
                workspace: workspace.as_ref(),
            },
            self.shutdown.clone(),
            stop_requested(self.stop_run.clone(), self.slot, short.clone()),
        )
        .await;
        drop(started);
        let ending = match exit {
            Exit::Code(0) => Ending::Completed,
            Exit::Stopped | Exit::Cancelled => Ending::Cancelled,
            _ => Ending::Failed,
        };
        let status = self.finish(&run_id, ending).await;
        if status == ending.as_str() {
            tracing::info!(run = %short, task = %key, "runtime {exit}; run {status}");
        } else {
            /* The runtime finished it first (finish_run), and its word stands. */
            tracing::info!(run = %short, task = %key, "runtime {exit}; run {status} (finished by the runtime)");
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
        let outcome = if exit == Exit::TimedOut {
            format!("{status} (stopped at the {} ceiling)", runner::span(runner::CEILING))
        } else {
            status
        };
        self.summary(&short, &key, outcome);
        self.update(|s| s.run_ended(&short));
        Done {
            wake,
            remember: Some((updated, false)),
            error: None,
        }
    }

    /// The board's repos when the task is coding work for this agent (it has a `code_command`), else none.
    async fn repos(&self, task_id: &str, key: &str) -> Result<Option<(crate::api::Task, Vec<String>)>> {
        if self.agent.code_command.is_none() {
            return Ok(None);
        }
        let task = self
            .api
            .task(&self.agent.token, task_id)
            .await
            .map_err(|e| anyhow!("reading {key}: {e}"))?;
        let repos = self
            .api
            .board_repos(&self.agent.token, &task.board_id)
            .await
            .map_err(|e| anyhow!("reading {key}'s board: {e}"))?;
        Ok((!repos.is_empty()).then_some((task, repos)))
    }

    /// The task's workspace when it is coding work: the agent has a `code_command` and the task's
    /// board has a repo. A board with several repos uses the first, for now.
    async fn workspace(&self, task_id: &str, key: &str) -> Result<Option<Workspace>> {
        let Some((task, repos)) = self.repos(task_id, key).await? else {
            return Ok(None);
        };
        let repo = &repos[0];
        if repos.len() > 1 {
            tracing::info!(task = %key, "its board has {} repos; working in the first, {repo}", repos.len());
        }
        workspace::realize(
            &self.agent.code_dir,
            &workspace::github_remote(repo),
            repo,
            key,
            &task.title,
        )
        .await
        .map(Some)
    }

    fn summary(&self, run: &str, task: &str, outcome: String) {
        let last = RunSummary {
            run: run.to_string(),
            task: task.to_string(),
            outcome,
            ended: SystemTime::now(),
        };
        self.update(|s| s.last_run = Some(last));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

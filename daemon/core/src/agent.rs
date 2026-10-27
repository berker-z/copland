//! One agent's loop: poll its unread inbox, and for a task that needs it,
//! start a run, claim the task, launch the runtime, finish the run.
//!
//! Runs go on their own (RunCtx::work), so an agent can have several at once
//! (COPL-82), up to its `max_runs`, and each takes a seat on its runtime
//! account, whose runs going at once across the daemon's agents are capped
//! (account.rs, COPL-232). Only coding tasks run side by side, each in
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

use anyhow::{Context, Result, anyhow};
use tokio::sync::{Notify, watch};
use tokio::task::{Id, JoinError, JoinHandle, JoinSet};
use tracing::Instrument;

use crate::account::{Account, Accounts, Seat};
use crate::api::{
    ACCOUNT_FULL, Api, ApiError, Backoff, BoardShell, Ending, HostCapabilities, HostReport, InboxItem, MAX_REPOS, Me, OnAccount,
    RepoCapability,
    RuntimeCapability,
};
use crate::chain;
use crate::config::AgentConfig;
use crate::guard::{Check, Identity, Message, Plan, Refused, Wake, WakeGuard, add_ready, plan, refused};
use crate::limit::{self, OutOfUsage};
use crate::live::{self, FALLBACK_POLL, Heard, Link};
use crate::runner::{self, Brief, Ended, Exit, Launch, MESSAGES};
use crate::sandbox;
use crate::state::{AgentState, DaemonState, Phase, RunSummary};
use crate::usage::Usage;
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
    let me = api.me(&agent.token).await.context("asking who the token is")?;
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
    /// Since when Copland has been unavailable to its polls (COPL-148), while it is.
    down: Option<SystemTime>,
    /// Which task each spawned run is for, by its join id, for a run that panics.
    spawned: HashMap<Id, String>,
    /// What this machine lacks to start the agent's runs, as of the last poll.
    missing: Missing,
    /// Which backend's program was found where, and what its `probe` said there: run once per
    /// backend and place, not every poll.
    probed: Option<(&'static str, PathBuf, Option<String>)>,
    /// How its runs ask again for their last word while Copland is down.
    last_word: Backoff,
    /// Whether it was held on this machine (`AgentState::holds`) at the last poll, to say it once.
    held: bool,
    /// What the repo check (COPL-178) found for each remote its boards name, by remote.
    repos: HashMap<String, Checked>,
    /// Whether every board's repos were checked since the loop started (`check_boards`).
    boards_checked: bool,
    /// How long it is held the next time its runtime is out of usage without saying until when
    /// (COPL-195): `limit::FIRST`, doubled each time up to `limit::MOST`, and back to the first once
    /// a runtime runs without running out.
    usage_wait: Duration,
    /// This machine's name as Copland keeps it (`setup::host`), read every poll; None when it has
    /// none to give, and then no run, socket or report names one.
    host: Option<String>,
    /// Where `host` is read from: `setup::host`, but for tests.
    hostname: fn() -> Option<String>,
    /// The token is an agent's: only an agent's reports its host (a person's would be refused).
    is_agent: bool,
    /// What the runtime checks (COPL-179) found, and when: made again every `RECHECK_RUNTIMES`.
    runtimes: Option<(Vec<RuntimeCapability>, tokio::time::Instant)>,
    /// The host report as it stands; the reporter (`report_host`) sends it when it changes.
    report: watch::Sender<Option<HostReport>>,
    /// The daemon's seats on each runtime account, shared by every agent's loop (COPL-232).
    accounts: Accounts,
    /// The agent's runtime account, read again every poll.
    account: Account,
    /// Moves on when a seat goes back anywhere; looked at by `wait` while `short` is.
    freed: watch::Receiver<u64>,
    /// Work waited at the last poll because its account had no seat free.
    short: bool,
    /// Until when Copland said its account is full across machines (COPL-234): nothing starts on it
    /// before then, as if no seat were free here, and the work waits unclaimed for the poll after.
    full_until: Option<tokio::time::Instant>,
}

/// How often the runtimes' checks are made again for the host report, so a login made or lost
/// shows on the agent's page without a restart. Each runs the runtime's own status command.
const RECHECK_RUNTIMES: Duration = Duration::from_secs(10 * 60);

/// One repo's check, and when it was made.
struct Checked {
    access: RepoCapability,
    at: tokio::time::Instant,
}

/// A repo that failed its check is checked again when a task on it comes up this long after,
/// so a login fixed meanwhile is picked up without a restart. One that passed stays passed.
const RECHECK_FAILED: Duration = Duration::from_secs(10 * 60);

/// Whether a run of this role can't go on a repo as its check found it (COPL-178): coding pushes,
/// so a worker needs push; a lead only reads its view of the repo, so it needs clone.
pub fn repo_stops(role: Role, access: &RepoCapability) -> bool {
    match role {
        Role::Worker | Role::Lane => !(access.clone && access.push),
        Role::Lead => !access.clone,
        Role::Workdir | Role::Skip => false,
    }
}

/// Whether the agent in `slot` is held on this machine: by hand, or out of usage (COPL-195).
fn held(st: &DaemonState, slot: u64) -> bool {
    let now = SystemTime::now();
    st.agents.iter().any(|a| a.slot == slot && a.holds(now))
}

/// How a run ends, by how its runtime did: as `ending_of` says, but interrupted when the runtime
/// is out of usage (COPL-195), which is its account's trouble, not the task's.
fn ended_as(ended: &Ended) -> Ending {
    if ended.out_of_usage.is_some() {
        Ending::Interrupted
    } else {
        ending_of(&ended.exit)
    }
}

/// Whether an error is Copland being down (`ApiError::is_unavailable`), whatever was being done.
fn unavailable(e: &anyhow::Error) -> bool {
    e.chain()
        .any(|c| c.downcast_ref::<ApiError>().is_some_and(ApiError::is_unavailable))
}

/// A run going on a task.
struct Inflight {
    key: String,
    /// It uses `workdir`, not a worktree.
    workdir: bool,
    /// The inbox items it was started for.
    items: Vec<String>,
    /// Its seat on the account, given back when the run is done with (dropped with this).
    _seat: Seat,
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

/// The host reporter, stopped when dropped.
struct Reporter(JoinHandle<()>);

impl Drop for Reporter {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The repos a host report carries: as many as Copland keeps (`MAX_REPOS`), the first by repo.
fn host_repos(mut repos: Vec<RepoCapability>) -> Vec<RepoCapability> {
    repos.truncate(MAX_REPOS);
    repos
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
        accounts: Accounts,
    ) -> Result<Self> {
        let api = Api::new(&agent.url)?;
        let account = Account::of(&agent);
        Ok(Self {
            freed: accounts.freed(),
            accounts,
            account,
            short: false,
            full_until: None,
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
            down: None,
            spawned: HashMap::new(),
            missing: Missing::default(),
            probed: None,
            last_word: Backoff::LAST_WORD,
            held: false,
            repos: HashMap::new(),
            boards_checked: false,
            usage_wait: limit::FIRST,
            host: crate::setup::host(),
            hostname: crate::setup::host,
            is_agent: false,
            runtimes: None,
            report: watch::channel(None).0,
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

    /// Held on this machine (COPL-186): set from the status socket, in the daemon's state.
    fn is_held(&self) -> bool {
        held(&self.state.borrow(), self.slot)
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
            last_word: self.last_word,
            user_id: self.me.as_ref().map(|m| m.id.clone()),
            host: self.host.clone(),
            account: self.account.shared.clone(),
            account_cap: self.accounts.cap(),
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
                if let Some(said) = d.full {
                    /* Copland counts the account's runs across machines (COPL-234): nothing was claimed or run,
                    so the work stays ready, and it is tried again at the next poll. */
                    tracing::info!("{} is at its cap across machines ({said}); waiting for a slot", self.account.shown);
                    self.full_until = Some(tokio::time::Instant::now() + self.poll);
                }
                if let Some(e) = d.error {
                    tracing::warn!("{e}");
                    self.update(|s| s.last_error = Some(e));
                }
                match d.runtime {
                    Runtime::NotLaunched => {}
                    Runtime::Ran => self.usage_wait = limit::FIRST,
                    Runtime::OutOfUsage(o) => self.out_of_usage(&o),
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

    /// Its runtime said it is out of usage (COPL-195): hold the agent until the reset it said, or
    /// for the back-off when it said none. Runs going on the same account run out too and say the
    /// same: a later reset moves the hold on, and the back-off grows only once a hold has passed.
    fn out_of_usage(&mut self, o: &OutOfUsage) {
        let now = SystemTime::now();
        let current = self
            .state
            .borrow()
            .agents
            .iter()
            .find(|a| a.slot == self.slot)
            .and_then(|a| a.until(now));
        let until = match (o.resets, current) {
            (Some(at), _) => at,
            (None, Some(current)) => current,
            (None, None) => {
                let until = now + self.usage_wait;
                self.usage_wait = (self.usage_wait * 2).min(limit::MOST);
                until
            }
        };
        let until = current.map_or(until, |c| c.max(until));
        if current != Some(until) {
            tracing::warn!(
                "the runtime is out of usage ({}); starting nothing until {}",
                o.said,
                crate::state::clock(until)
            );
        }
        self.update(|s| s.out_of_usage = Some(until));
        /* The other agents on the same account would run out the same way: they wait for the reset too. */
        let others: Vec<u64> = self
            .accounts
            .on(&self.account.key)
            .into_iter()
            .filter(|slot| *slot != self.slot)
            .collect();
        if !others.is_empty() {
            let shown = self.account.shown.clone();
            self.state.send_if_modified(|s| {
                let mut changed = false;
                for a in s.agents.iter_mut().filter(|a| others.contains(&a.slot)) {
                    if a.out_of_usage.is_none_or(|t| t < until) {
                        tracing::info!(other = %a.handle, "on the same account ({shown}): held until the reset too");
                        a.out_of_usage = Some(until);
                        changed = true;
                    }
                }
                changed
            });
        }
    }

    /// A seat on the agent's account for a run about to start, or None, noted in `short`, when its
    /// runs going at once are at their cap: the work waits, unclaimed, for a later poll.
    fn seat(&mut self) -> Option<Seat> {
        if self.full_elsewhere() {
            return None;
        }
        let seat = self.accounts.take(&self.account.key);
        if seat.is_none() {
            self.short = true;
        }
        seat
    }

    /// Whether a seat on the agent's account is free now, noting in `short` when none is.
    fn seat_free(&mut self) -> bool {
        if self.full_elsewhere() {
            return false;
        }
        let free = self.accounts.free(&self.account.key);
        if !free {
            self.short = true;
        }
        free
    }

    /// Whether Copland said the account is full across machines, recently enough that it is not
    /// asked again yet (COPL-234); noted in `short`, so the status says it waits for a slot.
    fn full_elsewhere(&mut self) -> bool {
        match self.full_until {
            Some(until) if tokio::time::Instant::now() < until => {
                self.short = true;
                true
            }
            Some(_) => {
                self.full_until = None;
                false
            }
            None => false,
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
        let _reporter = self.reporter();
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
                    if let Some(since) = self.down.take() {
                        tracing::info!(
                            "Copland answers again, unavailable since {}",
                            crate::state::clock(since)
                        );
                        self.update(|s| s.unavailable = None);
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
                    /* Copland is down (COPL-148): the poll found nothing to start, so nothing is started
                    or claimed until it answers again. Said once, with since when; runs going are left alone. */
                    if unavailable(&e) {
                        let since = match self.down {
                            Some(since) => {
                                tracing::debug!("{message}");
                                since
                            }
                            None => {
                                let since = SystemTime::now();
                                self.down = Some(since);
                                tracing::warn!(
                                    "Copland unavailable since {} ({message}); starting nothing until it answers",
                                    crate::state::clock(since)
                                );
                                since
                            }
                        };
                        self.update(|s| {
                            s.unavailable = Some(since);
                            s.last_error = s.unavailable_line();
                        });
                    } else {
                        /* It answered, even if to say no: it is up. */
                        if self.down.take().is_some() {
                            self.update(|s| s.unavailable = None);
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
        self.accounts.leave(self.slot);
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
        let (base, token, host) = (self.agent.url.clone(), self.agent.token.clone(), self.host.clone());
        let (state, slot) = (self.state.clone(), self.slot);
        let heard = wakes.clone();
        let task = tokio::spawn(
            async move {
                live::listen(
                    &base,
                    &token,
                    host.as_deref(),
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
                        Heard::Topics(burst) => heard.heard(burst.contains("inbox"), burst.contains("board")),
                    },
                )
                .await
            }
            .in_current_span(),
        );
        Live { wakes, link, task }
    }

    /// Send the host report (COPL-179) whenever it changes from the last one sent, for as long as
    /// the returned value lives. Copland being down is asked again with the runs' backoff
    /// (`last_word`); a refusal (an older server, a report it won't take) is said and left until
    /// the report changes. A newer report waits for the one being sent.
    fn reporter(&self) -> Reporter {
        let mut rx = self.report.subscribe();
        let (api, token, backoff, shutdown) = (
            self.api.clone(),
            self.agent.token.clone(),
            self.last_word,
            self.shutdown.clone(),
        );
        let task = tokio::spawn(
            async move {
                let mut sent: Option<HostReport> = None;
                loop {
                    let report = rx.borrow_and_update().clone();
                    if let Some(report) = report.filter(|r| sent.as_ref() != Some(r)) {
                        let what = format!("reporting this host ({}) to Copland", report.hostname);
                        match backoff
                            .retry(&what, shutdown.clone(), || api.report_host(&token, &report))
                            .await
                        {
                            Ok(_) => {
                                tracing::debug!("{what}: done");
                                sent = Some(report);
                            }
                            Err(e) => tracing::warn!("{what}: {e}"),
                        }
                    }
                    if rx.changed().await.is_err() {
                        return;
                    }
                }
            }
            .in_current_span(),
        );
        Reporter(task)
    }

    /// The host report as it is now: the hostname, read again; the runtimes, checked again once
    /// `RECHECK_RUNTIMES` has passed; the repos as their checks found them. Handed to the reporter,
    /// which sends it only when it changed. Nothing is reported without a hostname, or for a token
    /// that isn't an agent's.
    async fn report_host(&mut self) {
        self.host = (self.hostname)();
        let Some(hostname) = self.host.clone().filter(|_| self.is_agent) else {
            return;
        };
        if self
            .runtimes
            .as_ref()
            .is_none_or(|(_, at)| at.elapsed() >= RECHECK_RUNTIMES)
        {
            let found = crate::preflight::runtime_capabilities(&self.agent).await;
            self.runtimes = Some((found, tokio::time::Instant::now()));
        }
        let report = HostReport {
            hostname,
            version: env!("CARGO_PKG_VERSION").to_string(),
            capabilities: HostCapabilities {
                runtimes: self.runtimes.as_ref().map(|(r, _)| r.clone()).unwrap_or_default(),
                repos: host_repos(self.repo_list()),
            },
        };
        self.report.send_if_modified(|r| {
            let changed = r.as_ref() != Some(&report);
            if changed {
                *r = Some(report);
            }
            changed
        });
    }

    /// Every repo checked so far, sorted by repo.
    fn repo_list(&self) -> Vec<RepoCapability> {
        let mut all: Vec<RepoCapability> = self.repos.values().map(|c| c.access.clone()).collect();
        all.sort_by(|a, b| a.repo.cmp(&b.repo));
        all
    }

    /// Between polls: until the poll is due (seldom while the socket is up, at `poll_interval`
    /// while it is down), the socket says there is something, a run ends (given back), or the
    /// loop should stop.
    async fn wait(&self, live: &Live, runs: &mut JoinSet<Done>) -> Option<Result<(Id, Done), JoinError>> {
        let mut shutdown = self.shutdown.clone();
        let mut retire = self.retire.rx.clone();
        let generation = self.retire.generation;
        let mut link = live.link.clone();
        /* A hold or a release polls at once, so a release picks up the work waiting. */
        let mut holding = self.state.subscribe();
        let (slot, was_held) = (self.slot, self.is_held());
        let since = tokio::time::Instant::now();
        /* Out of usage (COPL-195): the reset polls at once, which picks the work up again. */
        let resets = self
            .state
            .borrow()
            .agents
            .iter()
            .find(|a| a.slot == slot)
            .and_then(|a| {
                let now = SystemTime::now();
                a.until(now).and_then(|t| t.duration_since(now).ok()).map(|d| since + d)
            });
        /* A board change can make work ready (a dependency closed, a lead assigned itself a task,
        COPL-86) or wake a task the guard remembers, so it is always worth a poll, spaced out. */
        let board = true;
        /* Set once a board change is heard: when the poll it asks for is due. */
        let mut board_due: Option<tokio::time::Instant> = None;
        /* Work waiting for a slot on its account polls again as soon as one goes back (COPL-232). */
        let mut freed = self.freed.clone();
        let short = self.short;
        let full_until = self.full_until;
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
                _ = async { let _ = holding.wait_for(|s| held(s, slot) != was_held).await; } => return None,
                _ = async { let _ = freed.changed().await; }, if short => {
                    tracing::debug!("a slot on its account went back");
                    return None;
                }
                _ = async { tokio::time::sleep_until(full_until.expect("guarded")).await }, if full_until.is_some() => {
                    tracing::debug!("asking Copland again for a slot on its account");
                    return None;
                }
                _ = async { tokio::time::sleep_until(resets.expect("guarded")).await }, if resets.is_some() => {
                    tracing::info!("its usage has reset; starting again");
                    return None;
                }
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
                Ok(t) if t.completed_at.is_some() => {
                    /* A task waiting on it may carry on in it (COPL-189): kept until that one starts. */
                    match self.api.dependents(&self.agent.token, &t.id).await {
                        Ok(waiting) if chain::waited_on(&t, &waiting, code_dir) => {
                            tracing::debug!(task = %key, "closed, and a task waiting on it may carry on in its worktree; kept");
                            Lookup::Open
                        }
                        _ => Lookup::Closed,
                    }
                }
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
            chain::forget_session(&self.paths.state_dir, &key);
        }
        Ok(())
    }

    /// Check every repo on the agent's boards (COPL-178), once when the loop starts, so the status
    /// says what this machine can push to before a task comes up. Repos added later are checked when
    /// a task on them does (`repo_access`).
    async fn check_boards(&mut self) -> Result<()> {
        let boards = self
            .api
            .boards(&self.agent.token)
            .await
            .map_err(|e| anyhow!("listing boards: {e}"))?;
        for b in boards {
            let repos = self
                .api
                .board_shell(&self.agent.token, &b.id)
                .await
                .map_err(|e| anyhow!("reading board {}: {e}", b.key))?;
            for r in &repos.repos {
                self.repo_access(&r.repo, &r.source().remote).await;
            }
        }
        Ok(())
    }

    /// One board repo's check: as found before, or made now when it never was or failed
    /// `RECHECK_FAILED` ago. A new result is logged when it changes and goes in the agent's state.
    async fn repo_access(&mut self, repo: &str, remote: &str) -> RepoCapability {
        if let Some(c) = self.repos.get(remote) {
            let passed = c.access.clone && c.access.push;
            if passed || c.at.elapsed() < RECHECK_FAILED {
                return c.access.clone();
            }
        }
        let access = crate::preflight::repo_access(repo, remote).await;
        let before = self.repos.get(remote).map(|c| &c.access);
        if before != Some(&access) {
            match &access.detail {
                None => tracing::info!(repo = %repo, "this machine can clone and push it"),
                Some(d) => tracing::warn!(
                    repo = %repo,
                    "{}; its coding tasks are left for a machine that can",
                    d.trim_end_matches('.')
                ),
            }
        }
        self.repos.insert(
            remote.to_string(),
            Checked {
                access: access.clone(),
                at: tokio::time::Instant::now(),
            },
        );
        let all = self.repo_list();
        self.update(|s| s.repos = all);
        access
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
        self.is_agent = me.user.kind == "agent";
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
                .context("reading the inbox")?;
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
            let said = missing.message();
            self.update(|s| s.missing = said);
            self.missing = missing;
        }
        let me = self.identity().await?;
        /* Who is signed in to the runtime can change between polls (a login, a logout). */
        let account = Account::of(&self.agent);
        if account != self.account {
            tracing::info!(
                "its runtime account is now {} (was {})",
                account.shown,
                self.account.shown
            );
            self.account = account;
        }
        self.accounts.join(self.slot, &self.account.key);
        self.freed.borrow_and_update();
        self.short = false;
        if self.agent.code_command.is_some() && !self.boards_checked {
            match self.check_boards().await {
                Ok(()) => self.boards_checked = true,
                Err(e) => tracing::debug!("checking its boards' repos, again next poll: {e:#}"),
            }
        }
        self.report_host().await;
        let (unread, items) = self.unread().await?;
        let mut plan: Plan = plan(&me, &items);
        /* Work nobody said anything about but that can start now: a task the agent gave itself, one whose dependencies just closed. */
        let ready = self
            .api
            .ready(&self.agent.token)
            .await
            .context("reading what is ready")?;
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
        /* Held on this machine: the poll goes on so the status stays current, but nothing starts
        or is claimed, as while Copland is down. Runs going are left alone. */
        let now = SystemTime::now();
        let passed = self
            .state
            .borrow()
            .agents
            .iter()
            .any(|a| a.slot == self.slot && a.out_of_usage.is_some() && a.until(now).is_none());
        if passed {
            self.update(|s| s.out_of_usage = None);
        }
        let held = self.is_held();
        if held != self.held {
            self.held = held;
            let usage = self
                .state
                .borrow()
                .agents
                .iter()
                .find(|a| a.slot == self.slot)
                .and_then(|a| a.out_of_usage_line(now));
            match (held, usage) {
                (true, Some(line)) => tracing::info!("{line}; starting nothing until then"),
                (true, None) => tracing::info!("held on this machine; starting nothing until released"),
                (false, _) => tracing::info!("released on this machine"),
            }
        }
        if held {
            if !plan.wakes.is_empty() || !plan.messages.is_empty() {
                tracing::debug!("held: {} task(s) and messages wait", plan.wakes.len());
            }
        } else {
            self.launch(&plan, runs).await?;
        }
        let waiting = self.short.then(|| self.account.shown.clone());
        if waiting.is_some()
            && !self
                .state
                .borrow()
                .agents
                .iter()
                .any(|a| a.slot == self.slot && a.waiting_for_slot.is_some())
        {
            tracing::info!(
                "{} runs going on {}, the most it may (max_runs_per_account); waiting for a slot",
                self.accounts.taken(&self.account.key),
                self.account.shown
            );
        }
        let shown = self.account.shown.clone();
        self.update(|s| {
            s.account = Some(shown);
            s.waiting_for_slot = waiting;
        });
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
        let Some(seat) = self.seat() else {
            tracing::debug!(
                "{} message(s), but no slot on {}; next time",
                batch.len(),
                self.account.shown
            );
            return;
        };
        self.inflight.insert(
            MESSAGES.to_string(),
            Inflight {
                key: MESSAGES.to_string(),
                workdir: true,
                items: batch.iter().map(|m| m.item.clone()).collect(),
                _seat: seat,
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
            /* Its account's runs going at once are at their cap (COPL-232): nothing is claimed or started, so
            the task stays ready in todo, costs no strike, and starts at the next poll with a slot. */
            if !self.seat_free() {
                tracing::debug!(task = %wake.task_key, "no slot on {}; next time", self.account.shown);
                break;
            }
            if let Check::Seen { updated_at, held } = self.guard.check(wake) {
                let current = match self.api.task(&self.agent.token, &wake.task_id).await {
                    /* Held as a story's task (COPL-236): its lane holds the story, not the task, between tasks. */
                    Ok(t) => {
                        let claimed = t.claim.is_some() || (held && self.ctx().lane_held(&t).await);
                        Some((t.updated_at, claimed))
                    }
                    Err(e) if e.is_refusal() => None,
                    Err(e) => return Err(anyhow::Error::new(e).context(format!("reading {}", wake.task_key))),
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
            /* A task of a story of the agent's own is its lane's (COPL-236): the run on the story does it, and
            reads what was said there. Remembered, so it is looked at again once the task changes. */
            if let Some(story) = &lookup.lane {
                if self.inflight.values().any(|r| r.key.eq_ignore_ascii_case(story)) {
                    tracing::debug!(task = %wake.task_key, "part of {story}, whose lane run is going; left to it");
                } else {
                    tracing::debug!(task = %wake.task_key, "part of {story}, which is a lane; left to the run on the story");
                }
                self.guard.remember(wake, lookup.task.map(|t| t.updated_at), false);
                continue;
            }
            if self.missing.stops(lookup.role) {
                tracing::debug!(task = %wake.task_key, "a program its run needs is missing; not starting");
                continue;
            }
            /* A repo this machine can't push to (or clone): the task stays in todo, unclaimed, for a machine that can. */
            let repo = lookup
                .board
                .as_ref()
                .and_then(|b| b.repos.first())
                .map(|r| r.repo.clone());
            if let (Some(src), Some(repo)) = (&lookup.source, &repo) {
                let access = self.repo_access(repo, &src.remote).await;
                if repo_stops(lookup.role, &access) {
                    let said = format!(
                        "{}; leaving it for a machine that can",
                        access
                            .detail
                            .as_deref()
                            .unwrap_or("its repo failed its check")
                            .trim_end_matches('.')
                    );
                    if self.noted.insert(format!("repo {} {said}", wake.task_id)) {
                        tracing::info!(task = %wake.task_key, repo = %repo, "{said}");
                    } else {
                        tracing::debug!(task = %wake.task_key, repo = %repo, "{said}");
                    }
                    continue;
                }
            }
            /* A chain's next task waits for the last one's run to end, which may still be in its worktree. */
            if let Some(after) = &lookup.after {
                if self.inflight.values().any(|r| r.key.eq_ignore_ascii_case(after)) {
                    tracing::debug!(task = %wake.task_key, "carries on from {after}, whose run is still going; next time");
                    continue;
                }
            }
            let workdir = lookup.role == Role::Workdir;
            if workdir && self.inflight.values().any(|r| r.workdir) {
                tracing::debug!(task = %wake.task_key, "another run has the workdir; next time");
                continue;
            }
            /* Another agent's loop may have taken the last slot while this one looked the task up. */
            let Some(seat) = self.seat() else {
                tracing::debug!(task = %wake.task_key, "no slot on {}; next time", self.account.shown);
                break;
            };
            self.inflight.insert(
                wake.task_id.clone(),
                Inflight {
                    key: wake.task_key.clone(),
                    workdir,
                    items: wake.items.clone(),
                    _seat: seat,
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
    /// An epic, or a task with children: planned into tasks, reading the repo.
    Lead,
    /// A story (COPL-236): one run in one worktree of its own does its tasks in order, one PR
    /// each, planning them first when it has none.
    Lane,
    /// A milestone: a checkpoint, not work. Nothing runs.
    Skip,
}

/// The rule, on its own so it can be tested: a leaf task is coded, a story is a lane, with
/// children or without, and an epic or a task with children is led.
pub fn role_of(code_command: bool, repo: bool, level: Option<&str>, has_children: bool) -> Role {
    if !code_command || !repo {
        return Role::Workdir;
    }
    match level {
        Some("milestone") => Role::Skip,
        Some("story") => Role::Lane,
        Some("epic") => Role::Lead,
        _ if has_children => Role::Lead,
        _ => Role::Worker,
    }
}

/// Whether `parent` is a story still open, whose tasks are its lane's (COPL-236).
fn in_lane(parent: &crate::api::Task) -> bool {
    parent.level.as_deref() == Some("story") && parent.completed_at.is_none()
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
            Role::Worker | Role::Lead | Role::Lane => self.code.is_some() || self.broken.is_some(),
            Role::Skip => false,
        }
    }
}

/// A task as a run would need it.
struct TaskInfo {
    role: Role,
    task: Option<crate::api::Task>,
    source: Option<crate::api::CodeSource>,
    board: Option<BoardShell>,
    /// The task a worker's run would carry on from (COPL-189), with the agent's `resume_chains`.
    after: Option<String>,
    /// The open story assigned to the agent that this leaf is a task of, by key (COPL-236): the
    /// story's lane run does it, so no run of its own starts for it.
    lane: Option<String>,
}

/// How a run ends, by how its runtime did. A runtime that never started is this machine's
/// trouble, not the task's: interrupted, so it costs the task no strike toward blocked.
fn ending_of(exit: &Exit) -> Ending {
    match exit {
        Exit::Code(0) | Exit::ForReview => Ending::Completed,
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

/// The task a lane run whose runtime exited 0 left unfinished (COPL-236): one of the story's
/// tasks (`held`, those the run claims, each with its stage's category) that `unfinished` says
/// it left going, as a worker's would be. The story itself doesn't count, active or not: it
/// follows its tasks. Tasks it closed are no longer held; with none left active, nothing is.
pub fn lane_unfinished<'a>(
    story: &crate::api::Task,
    held: &[(&'a crate::api::Task, Option<&str>)],
    run_id: &str,
    pull_requests: bool,
) -> Option<&'a crate::api::Task> {
    held.iter()
        .filter(|(t, _)| t.parent_id.as_deref() == Some(story.id.as_str()))
        .find(|(t, category)| unfinished(t, *category, t.has_children(), run_id, pull_requests))
        .map(|(t, _)| *t)
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
    /// Copland's word that the run's account is at its cap across machines (COPL-234): no run was
    /// started, nothing claimed, and the work waits.
    full: Option<String>,
    /// How its runtime went, as far as its account's usage goes (COPL-195).
    runtime: Runtime,
}

/// Whether a run launched its runtime, and whether that was out of usage.
enum Runtime {
    NotLaunched,
    Ran,
    OutOfUsage(OutOfUsage),
}

impl Runtime {
    fn of(ended: &Ended) -> Self {
        match &ended.out_of_usage {
            Some(o) => Runtime::OutOfUsage(o.clone()),
            None => Runtime::Ran,
        }
    }
}

impl Done {
    fn failed(wake: Wake, error: String) -> Self {
        Self {
            wake,
            remember: None,
            claimed: Vec::new(),
            error: Some(error),
            full: None,
            runtime: Runtime::NotLaunched,
        }
    }

    /// Copland refused to start the run: its account is full across machines (COPL-234).
    fn full(wake: Wake, said: String) -> Self {
        Self {
            wake,
            remember: None,
            claimed: Vec::new(),
            error: None,
            full: Some(said),
            runtime: Runtime::NotLaunched,
        }
    }

    fn ran(wake: Wake, updated_at: Option<String>, held: bool) -> Self {
        Self {
            wake,
            remember: Some((updated_at, held)),
            claimed: Vec::new(),
            error: None,
            full: None,
            runtime: Runtime::NotLaunched,
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
    last_word: Backoff,
    /// The agent's id, once the server has said: whose tasks a chain carries on from (COPL-189).
    user_id: Option<String>,
    /// The machine its runs start on, named on each (COPL-179).
    host: Option<String>,
    /// Its runtime account as Copland counts it, when it is one to share across machines, and the
    /// daemon's cap on it (COPL-234).
    account: Option<String>,
    account_cap: usize,
}

/// What Copland said when it refused a run for its account being full: its own words.
fn full_said(e: &ApiError) -> String {
    match e {
        ApiError::Status { message, .. } => message.clone(),
        other => other.to_string(),
    }
}

impl RunCtx {
    /// The account a run is started on, for Copland's count across machines (COPL-234).
    fn on(&self) -> Option<OnAccount<'_>> {
        self.account.as_deref().map(|account| OnAccount {
            account,
            cap: self.account_cap,
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

    /// The task as it is now, for the guard's memory.
    async fn updated_at(&self, task_id: &str) -> Option<String> {
        self.api
            .task(&self.agent.token, task_id)
            .await
            .ok()
            .map(|t| t.updated_at)
    }

    /// Finish the run, asking again while Copland is down (COPL-148): a finish that never lands
    /// leaves the run for the cron to end as stale, a strike on its task, and one that lands late
    /// still sets its ending right.
    async fn finish(&self, run_id: &str, ending: Ending, reason: Option<&str>, usage: Option<&Usage>) -> String {
        let what = format!("finishing run {} as {}", runner::short(run_id), ending.as_str());
        let sent = self
            .last_word
            .retry(&what, self.shutdown.clone(), || {
                self.api.finish_run(&self.agent.token, run_id, ending, reason, usage)
            })
            .await;
        match sent {
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
        let started = match self
            .api
            .start_run(&self.agent.token, &self.agent.client, self.host.as_deref(), self.on())
            .await
        {
            Ok(s) => s,
            Err(e) if e.code() == Some(ACCOUNT_FULL) => return Done::full(wake, full_said(&e)),
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
                    let ending = self.finish(&run_id, Ending::Cancelled, None, None).await;
                    self.update(|s| s.run_ended(&short));
                    let held = why == Refused::Hold;
                    if held {
                        tracing::info!(run = %short, task = %key, "another run holds it; coming back when that run ends: {e}");
                    } else if why == Refused::Dismiss && !wake.items.is_empty() {
                        /* Closed, and nothing there to answer: read, so no start wakes for it again (COPL-165). */
                        match self.api.mark_read(&self.agent.token, &wake.items).await {
                            Ok(()) => {
                                tracing::info!(run = %short, task = %key, items = wake.items.len(), "claim refused ({e}); nothing to answer, marked read")
                            }
                            Err(r) => {
                                tracing::warn!(run = %short, task = %key, "claim refused ({e}); marking its items read failed: {r}")
                            }
                        }
                    } else {
                        tracing::info!(run = %short, task = %key, "claim refused, skipping: {e}");
                    }
                    let updated = self.updated_at(&wake.task_id).await;
                    self.summary(&short, &key, format!("skipped ({ending}): {e}"), false);
                    return Done::ran(wake, updated, held);
                }
            },
            Err(e) => {
                self.finish(&run_id, Ending::Interrupted, None, None).await;
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
                    let ending = self.finish(&run_id, Ending::Failed, None, None).await;
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
            self.update(|s| s.run_worktree(&short, ws.dir.clone()));
        }
        let resume = workspace.as_ref().and_then(|ws| self.resume(&short, &key, ws));

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
                resume: resume.as_deref(),
                last_word: self.last_word,
            },
            self.shutdown.clone(),
            stop_requested(self.stop_run.clone(), self.slot, short.clone()),
        )
        .await;
        let (mut ending, mut how) = (ended_as(&ended), ended.reason());
        let mut left = false;
        let lead = workspace.as_ref().is_some_and(|ws| ws.read_only);
        let lane = workspace.as_ref().is_some_and(|ws| ws.lane);
        if brief == Brief::Work && ending == Ending::Completed && lane {
            let pull_requests = workspace.as_ref().is_some_and(|ws| ws.pull_requests);
            if let Some(task) = self
                .lane_left_going(&started.secret, &wake.task_id, &key, &run_id, pull_requests)
                .await
            {
                /* It still holds the task, so failing the run puts it and the story back in todo. */
                tracing::warn!(run = %short, task = %key, "runtime {how}, with {} still active; failing the run", task.key);
                (ending, how) = (Ending::Failed, format!("{UNFINISHED} ({})", task.key));
                left = true;
            }
        } else if brief == Brief::Work && ending == Ending::Completed && !lead {
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
        let status = self.finish(&run_id, ending, Some(&how), ended.usage.as_ref()).await;
        if status == ending.as_str() {
            tracing::info!(run = %short, task = %key, "runtime {how}; run {status}");
        } else {
            /* The runtime finished it first (finish_run), and its word stands. */
            tracing::info!(run = %short, task = %key, "runtime {how}; run {status} (finished by the runtime)");
        }
        /* Its session, for a chain's next task (COPL-189). */
        if let (Some(ws), Some(session)) = (&workspace, &ended.session) {
            if self.agent.resume_chains && !ws.read_only && !ws.lane {
                if let Err(e) = chain::save_session(&self.paths.state_dir, &key, &run_id, session) {
                    tracing::warn!(run = %short, task = %key, "keeping its session: {e:#}");
                }
            }
        }
        /* A closed task's worktree has nothing left to do, unless a task waiting on it will carry on
        in it (COPL-189); its branch lives on in the remote. */
        if let Some(ws) = &workspace {
            if let Ok(t) = self.api.task(&self.agent.token, &wake.task_id).await {
                if t.completed_at.is_some() && (ws.lane || !self.kept_for_chain(&t).await) {
                    match workspace::remove(&self.agent.code_dir, &ws.repo, &ws.key).await {
                        Ok(_) => tracing::info!(task = %key, "task closed; its worktree is removed"),
                        Err(e) => tracing::warn!(task = %key, "removing its worktree: {e:#}"),
                    }
                    chain::forget_session(&self.paths.state_dir, &key);
                }
            }
        }
        /* Remembered whatever the ending, a ceiling included, so it isn't launched again for the same items. */
        let updated = self.updated_at(&wake.task_id).await;
        self.ran(&run_id, &short, &key, status, &ended, &runtime, left);
        self.update(|s| s.run_ended(&short));
        let runtime = Runtime::of(&ended);
        if let Runtime::OutOfUsage(_) = runtime {
            /* Not remembered: its items are still unread, and the run after the reset takes them. */
            return Done {
                remember: None,
                runtime,
                ..Done::ran(wake, None, false)
            };
        }
        Done {
            runtime,
            ..Done::ran(wake, updated, false)
        }
    }

    /// The session a chain's next task resumes (COPL-189): the one the run on the task before it
    /// kept, carried to where the worktree is now, for a Claude Code `code_command` with
    /// `resume_chains`. Taken from that task, whose worktree this is now. None, to start cold, when
    /// there is none or it can't be carried.
    fn resume(&self, run: &str, key: &str, ws: &Workspace) -> Option<String> {
        let after = ws.after.as_deref()?;
        let code = self.agent.code_command.as_deref()?;
        let kept = chain::load_session(&self.paths.state_dir, after);
        chain::forget_session(&self.paths.state_dir, after);
        if !self.agent.resume_chains || !chain::resumable(code) {
            return None;
        }
        let Some(kept) = kept else {
            tracing::info!(run = %run, task = %key, "carries on in {after}'s worktree; no session of it kept, so starting cold");
            return None;
        };
        let carried = chain::claude_dir()
            .ok_or_else(|| anyhow!("no HOME or CLAUDE_CONFIG_DIR"))
            .and_then(|claude| chain::carry_session(&claude, &kept.session, &ws.dir));
        match carried {
            Ok(()) => {
                tracing::info!(run = %run, task = %key, session = %kept.session, "resuming {after}'s session (its run {})", runner::short(&kept.run));
                Some(kept.session)
            }
            Err(e) => {
                tracing::warn!(run = %run, task = %key, "resuming {after}'s session: {e:#}; starting cold");
                None
            }
        }
    }

    /// Whether a closed task's worktree stays for a task waiting on it (`chain::waited_on`). Only
    /// with `resume_chains`: this agent's own run on it is ending, and it would carry on in it.
    async fn kept_for_chain(&self, task: &crate::api::Task) -> bool {
        if !self.agent.resume_chains {
            return false;
        }
        match self.api.dependents(&self.agent.token, &task.id).await {
            Ok(waiting) => {
                let kept = chain::waited_on(task, &waiting, &self.agent.code_dir);
                if kept {
                    tracing::info!(task = %task.key, "task closed; its worktree stays for the task waiting on it");
                }
                kept
            }
            Err(e) => {
                tracing::warn!(task = %task.key, "reading the tasks waiting on it: {e}");
                false
            }
        }
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
            let board = self.api.board_shell(&self.agent.token, &task.board_id).await?;
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
        unfinished(&task, category, task.has_children(), run_id, pull_requests).then_some(task)
    }

    /// The story's task a lane run whose runtime just exited 0 left unfinished (`lane_unfinished`,
    /// COPL-236): one it still holds, by the run's claims. None when it left none going, or when
    /// the run, a task or the board can't be read.
    async fn lane_left_going(
        &self,
        secret: &crate::config::Secret,
        story_id: &str,
        key: &str,
        run_id: &str,
        pull_requests: bool,
    ) -> Option<crate::api::Task> {
        let read = async {
            let run = self.api.run(secret, run_id).await?;
            let story = self.api.task(&self.agent.token, story_id).await?;
            let board = self.api.board_shell(&self.agent.token, &story.board_id).await?;
            let mut held = Vec::new();
            for k in run.claims.iter().filter(|k| !k.eq_ignore_ascii_case(&story.key)) {
                held.push(self.api.task(&self.agent.token, k).await?);
            }
            Ok::<_, ApiError>((story, board, held))
        };
        let (story, board, held) = match read.await {
            Ok(r) => r,
            /* The runtime finished its run itself, so its claims went with it. */
            Err(e) if e.is_refusal() => {
                tracing::debug!(task = %key, "reading where the lane run left its tasks: {e}");
                return None;
            }
            Err(e) => {
                tracing::warn!(task = %key, "reading where the lane run left its tasks: {e}");
                return None;
            }
        };
        let with: Vec<_> = held
            .iter()
            .map(|t| (t, t.stage_id.as_deref().and_then(|s| board.category(s))))
            .collect();
        lane_unfinished(&story, &with, run_id, pull_requests).cloned()
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
        let started = match self
            .api
            .start_run(&self.agent.token, &self.agent.client, self.host.as_deref(), self.on())
            .await
        {
            Ok(s) => s,
            Err(e) if e.code() == Some(ACCOUNT_FULL) => return Done::full(wake, full_said(&e)),
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
                self.finish(&run_id, Ending::Interrupted, None, None).await;
                return Done::failed(wake, format!("claiming {n} message(s): {e}"));
            }
        };
        if claimed.is_empty() {
            let ending = self.finish(&run_id, Ending::Cancelled, None, None).await;
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
                resume: None,
                last_word: self.last_word,
            },
            self.shutdown.clone(),
            stop_requested(self.stop_run.clone(), self.slot, short.clone()),
        )
        .await;
        drop(started);
        let how = ended.reason();
        let status = self
            .finish(&run_id, ended_as(&ended), Some(&how), ended.usage.as_ref())
            .await;
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
        /* Remembered whatever the ending, so a message the run left unread doesn't launch another;
        but for a runtime out of usage, whose messages wait for the run after the reset. */
        let runtime = Runtime::of(&ended);
        let claimed = match runtime {
            Runtime::OutOfUsage(_) => Vec::new(),
            _ => claimed,
        };
        Done {
            claimed,
            runtime,
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
                board: None,
                after: None,
                lane: None,
            });
        }
        let task = self
            .api
            .task(&self.agent.token, task_id)
            .await
            .with_context(|| format!("reading {key}"))?;
        let board = self
            .api
            .board_shell(&self.agent.token, &task.board_id)
            .await
            .with_context(|| format!("reading {key}'s board"))?;
        if board.repos.len() > 1 {
            tracing::debug!(task = %key, "its board has {} repos; working in the first", board.repos.len());
        }
        let role = role_of(
            true,
            !board.repos.is_empty(),
            task.level.as_deref(),
            task.has_children(),
        );
        let source = board.repos.first().map(|r| r.source());
        let after = match (&self.user_id, self.agent.resume_chains && role == Role::Worker) {
            (Some(me), true) => self.carries_on_from(&task, me).await,
            _ => None,
        };
        let lane = match (&self.user_id, role == Role::Worker) {
            (Some(me), true) => self.lane_of(&task, me).await,
            _ => None,
        };
        Ok(TaskInfo {
            role,
            task: Some(task),
            source,
            board: Some(board),
            after,
            lane,
        })
    }

    /// The story `task` is a task of, by key, when that story is open and assigned to `me`, so its
    /// lane does the task (COPL-236). One read, of its parent; None when it has none, or it can't
    /// be read.
    async fn lane_of(&self, task: &crate::api::Task, me: &str) -> Option<String> {
        let parent = self.parent(task).await?;
        let mine = parent.assignee_ids.iter().any(|a| a == me);
        (in_lane(&parent) && mine).then_some(parent.key)
    }

    /// Whether a run holds the open story `task` is a task of, as a lane (COPL-236): what a claim
    /// refused as `lane` waits for, since between its tasks the lane run holds only the story.
    async fn lane_held(&self, task: &crate::api::Task) -> bool {
        self.parent(task)
            .await
            .is_some_and(|p| in_lane(&p) && p.claim.is_some())
    }

    async fn parent(&self, task: &crate::api::Task) -> Option<crate::api::Task> {
        let id = task.parent_id.as_deref()?;
        match self.api.task(&self.agent.token, id).await {
            Ok(p) => Some(p),
            Err(e) => {
                tracing::debug!(task = %task.key, "reading the task it is under: {e}");
                None
            }
        }
    }

    /// The task `task` would carry on from (`chain::before`), from the tasks it depends on, read
    /// one by one: a task waits on a few, its board has hundreds (COPL-212). One that can't be
    /// read is left out; with none, the run starts cold.
    async fn carries_on_from(&self, task: &crate::api::Task, me: &str) -> Option<String> {
        let mut deps = Vec::with_capacity(task.depends_on.len());
        for id in &task.depends_on {
            match self.api.task(&self.agent.token, id).await {
                Ok(t) => deps.push(t),
                Err(e) => tracing::debug!(task = %task.key, "reading a task it depends on: {e}"),
            }
        }
        chain::before(task, &deps, me).map(|t| t.key.clone())
    }

    /// Where the run works: a worker's worktree, a lane's (its story's), a lead's read-only view
    /// of the repo, or none (the agent's `workdir`).
    async fn workspace(&self, task_id: &str, key: &str) -> Result<Option<Workspace>> {
        let TaskInfo {
            role,
            task,
            source,
            after,
            ..
        } = self.lookup(task_id, key).await?;
        let (Some(task), Some(src)) = (task, source) else {
            return Ok(None);
        };
        let dir = &self.agent.code_dir;
        /* A chain's next task carries on in the last one's worktree, when it is there (COPL-189). */
        let carried = match &after {
            Some(after) => match workspace::continue_from(dir, &src.remote, &src.dir, key, &task.title, after).await {
                Ok(ws) => ws,
                Err(e) => {
                    tracing::warn!(task = %key, "carrying on in {after}'s worktree: {e:#}; starting a new one");
                    None
                }
            },
            None => None,
        };
        let ws = match role {
            Role::Worker if carried.is_some() => carried.expect("carried"),
            Role::Worker => workspace::realize(dir, &src.remote, &src.dir, key, &task.title).await?,
            Role::Lead => workspace::view(dir, &src.remote, &src.dir, key).await?,
            Role::Lane => workspace::lane(dir, &src.remote, &src.dir, key).await?,
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
            failed: left
                || (ended.out_of_usage.is_none()
                    && !matches!(
                        ended.exit,
                        Exit::Code(0) | Exit::ForReview | Exit::Stopped | Exit::Cancelled
                    )),
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
            account: None,
            resume_chains: false,
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

    /// A call, its body, and the host it named.
    type Sent = (String, Option<serde_json::Value>, Option<String>);

    /// A fake Copland on a socket of its own, for one agent with one task assigned (COPL-148): it
    /// answers every call with a 503 `storage_unavailable` while `down`, and the run's finish with
    /// one for its first `finish_down` tries, the way D1 running out of quota did.
    #[derive(Default)]
    struct Fake {
        down: AtomicBool,
        finish_down: std::sync::atomic::AtomicU32,
        /// "POST /api/runs", in the order they came.
        calls: std::sync::Mutex<Vec<String>>,
        /// What the finish that landed said.
        finished: std::sync::Mutex<Option<serde_json::Value>>,
        /// The task is closed: its claim is refused with a 409 `closed` (COPL-165).
        closed: AtomicBool,
        /// The run's account is full across machines: starting one is refused with a 409
        /// `account_full` (COPL-234).
        full: AtomicBool,
        /// The kind of the one inbox item, "assigned" when unset.
        kind: std::sync::Mutex<Option<String>>,
        /// The ids each `POST /api/inbox/read` named.
        marked: std::sync::Mutex<Vec<serde_json::Value>>,
        /// The plain git remote its board's one repo is at, when it has one (COPL-178).
        remote: std::sync::Mutex<Option<String>>,
        /// Each call's body, and the host it named in `x-copland-host`, in the order they came.
        sent: std::sync::Mutex<Vec<Sent>>,
    }

    impl Fake {
        fn start(self: &Arc<Self>) -> String {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let fake = self.clone();
            std::thread::spawn(move || {
                for conn in listener.incoming().flatten() {
                    let fake = fake.clone();
                    std::thread::spawn(move || fake.serve(conn));
                }
            });
            url
        }

        fn serve(&self, mut conn: std::net::TcpStream) {
            use std::io::{BufRead, BufReader, Read, Write};
            let mut reader = BufReader::new(conn.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                return;
            }
            let (method, path) = {
                let mut parts = line.split_whitespace();
                (
                    parts.next().unwrap_or("").to_string(),
                    parts.next().unwrap_or("").to_string(),
                )
            };
            let mut length = 0;
            let mut host = None;
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                    break;
                }
                if let Some((k, v)) = h.split_once(':') {
                    if k.eq_ignore_ascii_case("content-length") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                    if k.eq_ignore_ascii_case(crate::api::HOST_HEADER) {
                        host = Some(v.trim().to_string());
                    }
                }
            }
            let mut body = vec![0; length];
            let _ = reader.read_exact(&mut body);
            let path = path.split('?').next().unwrap_or("").to_string();
            let call = format!("{method} {path}");
            self.calls.lock().unwrap().push(call.clone());
            let said = serde_json::from_slice(&body).ok();
            self.sent.lock().unwrap().push((call.clone(), said, host));
            let (status, answer) = self.answer(&call, &body);
            let _ = write!(
                conn,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
                answer.len()
            );
        }

        fn answer(&self, call: &str, body: &[u8]) -> (u16, String) {
            let unavailable = (
                503,
                r#"{"error":"unavailable","code":"storage_unavailable","message":"Copland's storage is unavailable right now"}"#.to_string(),
            );
            if self.down.load(Ordering::SeqCst) {
                return unavailable;
            }
            let task = r#"{"id":"t1","key":"COPL-1","boardId":"b1","title":"one","updatedAt":"2026-10-04T23:00:00Z","completedAt":null}"#;
            let run = |status: &str| format!(r#"{{"id":"run-1","short":"run1","status":"{status}","claims":[]}}"#);
            match call {
                "GET /api/me" => (200, r#"{"user":{"id":"u-dev","kind":"agent","handle":"me/dev"},"access":{"scope":"write","via":"test","runId":null}}"#.into()),
                "GET /api/inbox" => {
                    let kind = self.kind.lock().unwrap().clone().unwrap_or_else(|| "assigned".into());
                    let unread = if self.marked.lock().unwrap().is_empty() { 1 } else { 0 };
                    let items = if unread == 0 {
                        String::new()
                    } else {
                        format!(r#"{{"id":"i1","kind":"{kind}","task":{{"id":"t1","key":"COPL-1","title":"one"}},"actor":{{"id":"u-me","handle":"me"}},"via":null,"createdAt":"2026-10-04T23:00:00Z","readAt":null}}"#)
                    };
                    (200, format!(r#"{{"unread":{unread},"items":[{items}],"next":null}}"#))
                }
                "POST /api/inbox/read" => {
                    let said: serde_json::Value = serde_json::from_slice(body).unwrap();
                    self.marked.lock().unwrap().push(said["ids"].clone());
                    (200, r#"{"unread":0}"#.into())
                }
                "GET /api/tasks/ready" => (200, r#"{"tasks":[]}"#.into()),
                "GET /api/boards" => (200, r#"[{"id":"b1","key":"COPL","name":"copland"}]"#.into()),
                "GET /api/boards/b1/shell" => {
                    let repos = match self.remote.lock().unwrap().as_deref() {
                        Some(r) => serde_json::json!([{ "repo": "o/r", "kind": "git", "remote": r }]),
                        None => serde_json::json!([]),
                    };
                    (200, serde_json::json!({ "repos": repos }).to_string())
                }
                "POST /api/tasks/t1/claim" if self.closed.load(Ordering::SeqCst) => (
                    409,
                    r#"{"error":"conflict","code":"closed","message":"COPL-1 is closed"}"#.into(),
                ),
                "GET /api/tasks/t1" | "POST /api/tasks/t1/claim" => (200, task.into()),
                "POST /api/runs" if self.full.load(Ordering::SeqCst) => (
                    409,
                    r#"{"error":"conflict","code":"account_full","message":"2 runs going on account 3f2a91 (desk, server), at its cap of 2; start it once one ends"}"#.into(),
                ),
                "POST /api/runs" => (200, format!(r#"{{"run":{},"secret":"cplr_run"}}"#, run("running"))),
                "GET /api/runs/run-1" => (200, run("running")),
                "PUT /api/hosts/self" => (
                    200,
                    r#"{"host":{"hostname":"test-host","firstReportedAt":"x","lastReportedAt":"x"}}"#.into(),
                ),
                "POST /api/runs/run-1/finish" => {
                    if self.finish_down.load(Ordering::SeqCst) > 0 {
                        self.finish_down.fetch_sub(1, Ordering::SeqCst);
                        return unavailable;
                    }
                    let said: serde_json::Value = serde_json::from_slice(body).unwrap();
                    let status = said["status"].as_str().unwrap_or("").to_string();
                    *self.finished.lock().unwrap() = Some(said);
                    (200, run(&status))
                }
                _ => (404, r#"{"error":"not_found","message":"Not found"}"#.into()),
            }
        }

        fn count(&self, call: &str) -> usize {
            self.calls.lock().unwrap().iter().filter(|c| *c == call).count()
        }

        /// The bodies of each `call`, and the host each named.
        fn sent(&self, call: &str) -> Vec<(Option<serde_json::Value>, Option<String>)> {
            let sent = self.sent.lock().unwrap();
            sent.iter()
                .filter(|(c, ..)| c == call)
                .map(|(_, body, host)| (body.clone(), host.clone()))
                .collect()
        }
    }

    /// Copland down (COPL-148): the loop starts and claims nothing, says so once with since when,
    /// and once it is back the run goes ahead, and its finish, refused with 503s for a while, lands.
    #[tokio::test]
    async fn while_copland_is_down_nothing_starts_and_the_finish_lands_after() {
        let fake = Arc::new(Fake::default());
        fake.down.store(true, Ordering::SeqCst);
        let url = fake.start();
        let mut l = Looping::start(&url, "outage");
        let watch_state = &mut l.state;
        let wait = |st: &mut watch::Receiver<DaemonState>, f: fn(&AgentState) -> bool| {
            let mut st = st.clone();
            async move {
                tokio::time::timeout(Duration::from_secs(10), st.wait_for(|s| f(&s.agents[0])))
                    .await
                    .expect("in time")
                    .map(|_| ())
                    .unwrap();
            }
        };

        /* Down: said on the agent's line, and several polls later nothing has started or been claimed. */
        wait(watch_state, |a| a.unavailable.is_some()).await;
        let line = watch_state.borrow().agents[0].last_error.clone().unwrap_or_default();
        assert!(
            line.starts_with("Copland unavailable since ") && line.ends_with(" UTC"),
            "{line}"
        );
        while fake.count("GET /api/me") < 5 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(fake.count("POST /api/runs"), 0, "no run started while down");
        assert_eq!(fake.count("POST /api/tasks/t1/claim"), 0, "nothing claimed while down");

        /* Back, but its finish still meets three 503s: the run goes ahead, and its finish lands after. */
        fake.finish_down.store(3, Ordering::SeqCst);
        fake.down.store(false, Ordering::SeqCst);
        wait(watch_state, |a| a.unavailable.is_none()).await;
        tokio::time::timeout(Duration::from_secs(10), async {
            while fake.finished.lock().unwrap().is_none() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the finish landed");
        let finished = fake.finished.lock().unwrap().clone().unwrap();
        assert_eq!(finished["status"], "completed", "{finished}");
        assert_eq!(
            fake.count("POST /api/runs/run-1/finish"),
            4,
            "three 503s, then it landed"
        );
        assert_eq!(fake.count("POST /api/runs"), 1);
        assert_eq!(watch_state.borrow().agents[0].last_error, None);
        l.stop().await;
    }

    /// One agent's loop on a fake Copland at `url`, running `true` as its runtime, in a dir of its own.
    struct Looping {
        state: watch::Receiver<DaemonState>,
        /// Holds and releases the agent, as the status socket does.
        holder: crate::daemon::Holder,
        stop: watch::Sender<bool>,
        looping: JoinHandle<WakeGuard>,
        dir: PathBuf,
        _wanted: watch::Sender<Wanted>,
        _stop_run: watch::Sender<StopRequest>,
    }

    impl Looping {
        fn start(url: &str, name: &str) -> Self {
            Self::start_with(url, name, &["true"], false)
        }

        /// Running `command`, held on this machine from the start when `held`.
        fn start_with(url: &str, name: &str, command: &[&str], held: bool) -> Self {
            Self::start_agent(url, name, agent(command, None), held)
        }

        fn start_agent(url: &str, name: &str, a: AgentConfig, held: bool) -> Self {
            Self::start_on(url, name, a, held, Accounts::default(), Vec::new())
        }

        /// `start_agent`, its runs taking seats from `accounts`, with `others` in the daemon's state
        /// after it (slot 1).
        fn start_on(
            url: &str,
            name: &str,
            mut a: AgentConfig,
            held: bool,
            accounts: Accounts,
            others: Vec<AgentState>,
        ) -> Self {
            let dir = std::env::temp_dir().join(format!("copland-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            a.url = url.to_string();
            a.workdir = dir.clone();
            let mut st = AgentState::new("me/dev", url);
            st.slot = 1;
            st.held = held;
            let (state, watch_state) = watch::channel(DaemonState {
                agents: std::iter::once(st).chain(others).collect(),
                stopping: false,
                autostart: false,
            });
            let (stop, shutdown) = watch::channel(false);
            let (wanted_tx, wanted) = watch::channel(Wanted {
                generation: 0,
                agent: Some(a.clone()),
                poll: Duration::from_millis(50),
            });
            let (stop_run_tx, stop_run) = watch::channel(None);
            let holder = crate::daemon::Holder(state.clone());
            let mut l = AgentLoop::new(
                1,
                a,
                Duration::from_millis(50),
                Arc::new(Paths {
                    state_dir: dir.clone(),
                    runtime_dir: dir.clone(),
                }),
                state,
                shutdown,
                Retire {
                    rx: wanted,
                    generation: 0,
                },
                stop_run,
                WakeGuard::default(),
                accounts,
            )
            .unwrap();
            l.hostname = || Some("test-host".into());
            l.host = (l.hostname)();
            l.last_word = Backoff {
                first: Duration::from_millis(20),
                most: Duration::from_millis(50),
                give_up: Duration::from_secs(30),
            };
            Looping {
                state: watch_state,
                holder,
                stop,
                looping: tokio::spawn(l.run()),
                dir,
                _wanted: wanted_tx,
                _stop_run: stop_run_tx,
            }
        }

        async fn stop(self) {
            self.stop.send_replace(true);
            tokio::time::timeout(Duration::from_secs(10), self.looping)
                .await
                .expect("stopped")
                .unwrap();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Until the fake heard a finish, then what it said.
    async fn finished(fake: &Fake) -> serde_json::Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(f) = fake.finished.lock().unwrap().clone() {
                    return f;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("a finish landed")
    }

    /// COPL-178: a coding agent checks its boards' repos when it starts, says the one it can't
    /// reach in its state, and claims no task on it, which waits in todo for a machine that can.
    #[tokio::test]
    async fn a_task_on_a_repo_it_cant_push_to_is_left_unclaimed() {
        let fake = Arc::new(Fake::default());
        let gone = std::env::temp_dir().join(format!("copland-no-such-remote-{}.git", std::process::id()));
        *fake.remote.lock().unwrap() = Some(gone.display().to_string());
        let mut a = agent(&["true"], Some(&["true"]));
        a.code_dir = std::env::temp_dir().join(format!("copland-repo-check-code-{}", std::process::id()));
        let mut l = Looping::start_agent(&fake.start(), "repo-check", a, false);
        tokio::time::timeout(
            Duration::from_secs(10),
            l.state.wait_for(|s| !s.agents[0].repos.is_empty()),
        )
        .await
        .expect("checked")
        .unwrap();
        let repos = l.state.borrow().agents[0].repos.clone();
        assert_eq!(repos.len(), 1, "{repos:?}");
        assert!(repos[0].repo == "o/r" && !repos[0].clone && !repos[0].push, "{repos:?}");
        let polls = fake.count("GET /api/inbox");
        while fake.count("GET /api/inbox") < polls + 3 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(fake.count("POST /api/runs"), 0, "no run started");
        assert_eq!(fake.count("POST /api/tasks/t1/claim"), 0, "nothing claimed");
        assert_eq!(fake.count("GET /api/boards"), 1, "its boards are checked once");
        /* From its shell, not the whole board with its tasks (COPL-212). */
        assert!(fake.count("GET /api/boards/b1/shell") >= 1);
        assert_eq!(fake.count("GET /api/boards/b1"), 0, "the board itself is never read");
        assert_eq!(l.state.borrow().agents[0].waiting, ["COPL-1"]);
        l.stop().await;
    }

    /// COPL-179: the loop reports its host once, with its runtimes and its boards' repos, and again
    /// only when that changes; each run and the live socket name the host.
    #[tokio::test]
    async fn the_host_is_reported_once_and_named_on_each_run() {
        let fake = Arc::new(Fake::default());
        let gone = std::env::temp_dir().join(format!("copland-no-such-remote-host-{}.git", std::process::id()));
        *fake.remote.lock().unwrap() = Some(gone.display().to_string());
        let mut a = agent(&["true"], Some(&["true"]));
        a.code_dir = std::env::temp_dir().join(format!("copland-host-code-{}", std::process::id()));
        let l = Looping::start_agent(&fake.start(), "host-report", a, false);
        tokio::time::timeout(Duration::from_secs(10), async {
            while fake.count("PUT /api/hosts/self") == 0 || fake.count("GET /api/live") == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("reported");
        let polls = fake.count("GET /api/inbox");
        while fake.count("GET /api/inbox") < polls + 3 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let reports = fake.sent("PUT /api/hosts/self");
        assert_eq!(reports.len(), 1, "only on a change: {reports:?}");
        let report = reports[0].0.clone().unwrap();
        assert_eq!(report["hostname"], "test-host");
        assert_eq!(report["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            report["capabilities"]["runtimes"],
            serde_json::json!([{ "name": "true", "onPath": true, "loggedIn": true }])
        );
        let repos = &report["capabilities"]["repos"];
        assert_eq!(repos.as_array().map(Vec::len), Some(1), "{report}");
        assert_eq!(
            (&repos[0]["repo"], &repos[0]["clone"], &repos[0]["push"]),
            (
                &serde_json::json!("o/r"),
                &serde_json::json!(false),
                &serde_json::json!(false)
            )
        );
        let live = fake.sent("GET /api/live");
        assert_eq!(live[0].1.as_deref(), Some("test-host"), "the socket names it");
        l.stop().await;

        /* A run names its host when it starts. */
        let fake = Arc::new(Fake::default());
        let l = Looping::start(&fake.start(), "host-run");
        finished(&fake).await;
        let runs = fake.sent("POST /api/runs");
        assert_eq!(runs[0].0.as_ref().unwrap()["host"], "test-host");
        l.stop().await;
    }

    /// A report carries as many repos as Copland keeps.
    #[test]
    fn a_host_report_carries_at_most_max_repos() {
        let repo = |n: usize| RepoCapability {
            repo: format!("o/r{n:03}"),
            clone: true,
            push: true,
            detail: None,
        };
        let kept = host_repos((0..MAX_REPOS + 5).map(repo).collect());
        assert_eq!(kept.len(), MAX_REPOS);
        assert_eq!(kept.last(), Some(&repo(MAX_REPOS - 1)));
    }

    /// COPL-178: coding needs push, leading only clone; nothing else is stopped by a repo.
    #[test]
    fn a_worker_needs_push_and_a_lead_clone() {
        let access = |clone, push| RepoCapability {
            repo: "o/r".into(),
            clone,
            push,
            detail: None,
        };
        let (both, read_only, none) = (access(true, true), access(true, false), access(false, false));
        assert!(!repo_stops(Role::Worker, &both) && !repo_stops(Role::Lead, &both));
        assert!(repo_stops(Role::Worker, &read_only) && !repo_stops(Role::Lead, &read_only));
        assert!(repo_stops(Role::Worker, &none) && repo_stops(Role::Lead, &none));
        assert!(!repo_stops(Role::Workdir, &none) && !repo_stops(Role::Skip, &none));
    }

    /// An agent on the account `shared`, running `command`.
    fn shared(command: &[&str]) -> AgentConfig {
        let mut a = agent(command, None);
        a.account = Some("shared".into());
        a
    }

    /// COPL-232: work its account has no slot for waits, unclaimed: no run is started or finished
    /// for it, so it costs no strike, and the status says what it waits for. The slot going back
    /// starts it at once.
    #[tokio::test]
    async fn work_waits_for_a_slot_on_its_account_without_a_run() {
        let fake = Arc::new(Fake::default());
        let accounts = Accounts::new(1);
        /* Another agent's run on the same account holds the one slot. */
        let elsewhere = accounts.take("shared").unwrap();
        let mut l = Looping::start_on(
            &fake.start(),
            "account-wait",
            shared(&["true"]),
            false,
            accounts.clone(),
            Vec::new(),
        );
        tokio::time::timeout(
            Duration::from_secs(10),
            l.state
                .wait_for(|s| s.agents[0].waiting_for_slot.as_deref() == Some("shared")),
        )
        .await
        .expect("waiting for a slot")
        .unwrap();
        let polls = fake.count("GET /api/inbox");
        while fake.count("GET /api/inbox") < polls + 3 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(fake.count("POST /api/runs"), 0, "no run started");
        assert_eq!(fake.count("POST /api/tasks/t1/claim"), 0, "nothing claimed");
        assert!(fake.finished.lock().unwrap().is_none(), "no run finished, so no strike");
        assert_eq!(l.state.borrow().agents[0].account.as_deref(), Some("shared"));
        let status = crate::status::Status::of(&l.state.borrow()).render();
        assert!(status.contains("waiting for a slot on shared"), "{status}");

        drop(elsewhere);
        let said = finished(&fake).await;
        assert_eq!(said["status"], "completed", "{said}");
        tokio::time::timeout(
            Duration::from_secs(10),
            l.state.wait_for(|s| s.agents[0].waiting_for_slot.is_none()),
        )
        .await
        .expect("no longer waiting")
        .unwrap();
        /* The seat goes back once the loop hears the run is done, a moment after its finish lands. */
        tokio::time::timeout(Duration::from_secs(10), async {
            while accounts.taken("shared") != 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the run gave its slot back");
        l.stop().await;
    }

    /// COPL-234: a run is started on its account with the daemon's cap, and Copland saying the account
    /// is full across machines leaves the task untouched: nothing claimed, no run to finish, so no
    /// strike, and the status says it waits for a slot. A later poll asks again and runs it.
    #[tokio::test]
    async fn an_account_full_across_machines_leaves_the_task_waiting() {
        let fake = Arc::new(Fake::default());
        fake.full.store(true, Ordering::SeqCst);
        let mut l = Looping::start_on(
            &fake.start(),
            "account-full",
            shared(&["true"]),
            false,
            Accounts::new(2),
            Vec::new(),
        );
        tokio::time::timeout(
            Duration::from_secs(10),
            l.state
                .wait_for(|s| s.agents[0].waiting_for_slot.as_deref() == Some("shared")),
        )
        .await
        .expect("waiting for a slot")
        .unwrap();
        let runs = fake.sent("POST /api/runs");
        let body = runs[0].0.as_ref().unwrap();
        assert_eq!(body["account"], Account::find(&shared(&["true"]), None, |_| None).shared.unwrap());
        assert_eq!(body["account_cap"], 2);
        let polls = fake.count("GET /api/inbox");
        while fake.count("GET /api/inbox") < polls + 3 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(fake.count("POST /api/tasks/t1/claim"), 0, "nothing claimed");
        assert!(fake.finished.lock().unwrap().is_none(), "no run to finish, so no strike");
        assert!(fake.marked.lock().unwrap().is_empty(), "its items stay unread");
        /* It asks again each poll, so read the state while it waits. */
        let waiting = tokio::time::timeout(
            Duration::from_secs(10),
            l.state
                .wait_for(|s| s.agents[0].waiting_for_slot.as_deref() == Some("shared")),
        )
        .await
        .expect("waiting again")
        .unwrap();
        assert_eq!(waiting.agents[0].last_error, None, "waiting is not an error");
        let status = crate::status::Status::of(&waiting).render();
        drop(waiting);
        assert!(status.contains("waiting for a slot on shared"), "{status}");

        fake.full.store(false, Ordering::SeqCst);
        let said = finished(&fake).await;
        assert_eq!(said["status"], "completed", "{said}");
        assert_eq!(fake.count("POST /api/tasks/t1/claim"), 1);
        l.stop().await;
    }

    /// COPL-232: two agents on one account never have more runs going together than its cap, and
    /// both get theirs done, one after the other.
    #[tokio::test]
    async fn two_agents_on_one_account_share_its_cap() {
        let accounts = Accounts::new(1);
        let (one, two) = (Arc::new(Fake::default()), Arc::new(Fake::default()));
        let command = ["sh", "-c", "sleep 0.3"];
        let a = Looping::start_on(
            &one.start(),
            "account-one",
            shared(&command),
            false,
            accounts.clone(),
            Vec::new(),
        );
        let b = Looping::start_on(
            &two.start(),
            "account-two",
            shared(&command),
            false,
            accounts.clone(),
            Vec::new(),
        );
        let mut most = 0;
        tokio::time::timeout(Duration::from_secs(20), async {
            while one.finished.lock().unwrap().is_none() || two.finished.lock().unwrap().is_none() {
                most = most.max(accounts.taken("shared"));
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("both ran");
        assert_eq!(most, 1, "never past the cap");
        assert_eq!((one.count("POST /api/runs"), two.count("POST /api/runs")), (1, 1));
        a.stop().await;
        b.stop().await;
    }

    /// COPL-232: a runtime out of usage holds every agent on its account until the reset, since
    /// they would all run out the same way; an agent on another account goes on.
    #[tokio::test]
    async fn out_of_usage_holds_every_agent_on_the_account() {
        let fake = Arc::new(Fake::default());
        let accounts = Accounts::default();
        let mut same = AgentState::new("me/review", "http://x");
        same.slot = 2;
        let mut other = AgentState::new("me/ops", "http://x");
        other.slot = 3;
        accounts.join(2, "shared");
        accounts.join(3, "codex");
        let command = ["sh", "-c", "echo 'Claude AI usage limit reached' >&2; exit 1"];
        let mut l = Looping::start_on(
            &fake.start(),
            "account-usage",
            shared(&command),
            false,
            accounts,
            vec![same, other],
        );
        finished(&fake).await;
        tokio::time::timeout(
            Duration::from_secs(10),
            l.state.wait_for(|s| s.agents[0].out_of_usage.is_some()),
        )
        .await
        .expect("held")
        .unwrap();
        let st = l.state.borrow().clone();
        assert_eq!(
            st.agents[1].out_of_usage, st.agents[0].out_of_usage,
            "the same account waits too"
        );
        assert!(st.agents[1].holds(SystemTime::now()));
        assert_eq!(st.agents[2].out_of_usage, None, "another account goes on");
        l.stop().await;
    }

    /// COPL-195: a runtime out of usage finishes its run as interrupted (no strike), not as a
    /// failure, and holds the agent: nothing more starts while the item waits, unread. Said no
    /// reset, it is held for the back-off, doubled the next time; released by hand, it tries again.
    #[tokio::test]
    async fn a_runtime_out_of_usage_holds_the_agent() {
        let fake = Arc::new(Fake::default());
        let command = ["sh", "-c", "echo 'Claude AI usage limit reached' >&2; exit 1"];
        let mut l = Looping::start_with(&fake.start(), "out-of-usage", &command, false);
        let said = finished(&fake).await;
        assert_eq!(
            (said["status"].as_str(), said["interrupted"].as_bool()),
            (Some("cancelled"), Some(true))
        );
        assert!(
            said["reason"]
                .as_str()
                .unwrap()
                .starts_with("out of usage, exit 1 after "),
            "{said}"
        );
        let until = |l: &Looping| {
            l.state.borrow().agents[0]
                .out_of_usage
                .map(|t| t.duration_since(SystemTime::now()).unwrap_or_default())
        };
        tokio::time::timeout(
            Duration::from_secs(10),
            l.state.wait_for(|s| s.agents[0].out_of_usage.is_some()),
        )
        .await
        .expect("held")
        .unwrap();
        let first = until(&l).unwrap();
        assert!(
            first > limit::FIRST - Duration::from_secs(60) && first <= limit::FIRST,
            "{first:?}"
        );
        let last = l.state.borrow().agents[0].last_run.clone().unwrap();
        assert!(!last.failed, "out of usage is not a failure: {last:?}");
        let polls = fake.count("GET /api/inbox");
        while fake.count("GET /api/inbox") < polls + 3 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            fake.count("POST /api/runs"),
            1,
            "nothing more started while out of usage"
        );
        assert!(!l.state.borrow().agents[0].held, "not a hold by hand");

        *fake.finished.lock().unwrap() = None;
        assert!(l.holder.set(1, false));
        assert_eq!(finished(&fake).await["interrupted"], true, "released, it tried again");
        assert_eq!(fake.count("POST /api/runs"), 2);
        tokio::time::timeout(Duration::from_secs(10), async {
            while until(&l).is_none_or(|d| d <= limit::FIRST) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("held again, for longer");
        let second = until(&l).unwrap();
        assert!(
            second > limit::FIRST * 2 - Duration::from_secs(60) && second <= limit::FIRST * 2,
            "{second:?}"
        );
        l.stop().await;
    }

    /// COPL-195: the reset the runtime said wakes the agent, which picks the work up by itself.
    #[tokio::test]
    async fn the_reset_picks_the_work_up_again() {
        let fake = Arc::new(Fake::default());
        let command = [
            "sh",
            "-c",
            "echo \"Claude AI usage limit reached|$(( $(date +%s) + 2 ))\" >&2; exit 1",
        ];
        let mut l = Looping::start_with(&fake.start(), "usage-reset", &command, false);
        assert_eq!(finished(&fake).await["interrupted"], true);
        tokio::time::timeout(
            Duration::from_secs(10),
            l.state.wait_for(|s| s.agents[0].out_of_usage.is_some()),
        )
        .await
        .expect("held")
        .unwrap();
        assert_eq!(fake.count("POST /api/runs"), 1, "nothing before the reset");
        tokio::time::timeout(Duration::from_secs(10), async {
            while fake.count("POST /api/runs") < 2 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("started again at the reset");
        l.stop().await;
    }

    /// COPL-186: a held agent with work waiting polls, says what waits, and starts and claims
    /// nothing; released, it polls at once and starts the run.
    #[tokio::test]
    async fn a_held_agent_starts_nothing_until_released() {
        let fake = Arc::new(Fake::default());
        let mut l = Looping::start_with(&fake.start(), "held", &["true"], true);
        tokio::time::timeout(
            Duration::from_secs(10),
            l.state.wait_for(|s| s.agents[0].waiting == ["COPL-1"]),
        )
        .await
        .expect("polled")
        .unwrap();
        while fake.count("GET /api/inbox") < 5 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(fake.count("POST /api/runs"), 0, "no run started while held");
        assert_eq!(fake.count("POST /api/tasks/t1/claim"), 0, "nothing claimed while held");
        assert!(l.state.borrow().agents[0].runs.is_empty());

        assert!(l.holder.set(1, false));
        assert!(!l.holder.set(9, false), "no agent in slot 9");
        assert_eq!(
            finished(&fake).await["status"],
            "completed",
            "released, the run went ahead"
        );
        assert_eq!(fake.count("POST /api/tasks/t1/claim"), 1);
        l.stop().await;
    }

    /// COPL-186: a run going when the hold comes finishes as it would, and nothing more starts.
    #[tokio::test]
    async fn a_hold_leaves_the_run_going_alone() {
        let fake = Arc::new(Fake::default());
        let mut l = Looping::start_with(&fake.start(), "hold-running", &["sh", "-c", "sleep 1"], false);
        tokio::time::timeout(
            Duration::from_secs(10),
            l.state.wait_for(|s| !s.agents[0].runs.is_empty()),
        )
        .await
        .expect("a run started")
        .unwrap();
        assert!(l.holder.set(1, true));
        assert_eq!(
            finished(&fake).await["status"],
            "completed",
            "the run finished untouched"
        );
        let polls = fake.count("GET /api/inbox");
        while fake.count("GET /api/inbox") < polls + 3 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(fake.count("POST /api/runs"), 1);
        assert!(l.state.borrow().agents[0].held);
        l.stop().await;
    }

    /// COPL-165: an assignment on a task that has since closed is refused its claim, and the
    /// daemon marks it read, so no later start (whose guard remembers nothing) wakes for it again.
    #[tokio::test]
    async fn a_closed_task_with_nothing_to_answer_is_marked_read() {
        let fake = Arc::new(Fake::default());
        fake.closed.store(true, Ordering::SeqCst);
        let l = Looping::start(&fake.start(), "closed-assigned");
        assert_eq!(
            finished(&fake).await["status"],
            "cancelled",
            "no runtime, the run skipped"
        );
        tokio::time::timeout(Duration::from_secs(10), async {
            while fake.marked.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("marked read");
        assert_eq!(*fake.marked.lock().unwrap(), [serde_json::json!(["i1"])]);
        /* Read now: later polls start nothing more. */
        while fake.count("GET /api/inbox") < 5 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(fake.count("POST /api/runs"), 1);
        assert_eq!(fake.count("POST /api/tasks/t1/claim"), 1);
        l.stop().await;
    }

    /// A mention on a closed task still gets a run that answers without a claim, and the daemon
    /// leaves its item for that run to mark read.
    #[tokio::test]
    async fn a_mention_on_a_closed_task_is_answered_not_marked_read() {
        let fake = Arc::new(Fake::default());
        fake.closed.store(true, Ordering::SeqCst);
        *fake.kind.lock().unwrap() = Some("mentioned".into());
        let l = Looping::start(&fake.start(), "closed-mentioned");
        assert_eq!(finished(&fake).await["status"], "completed", "the runtime ran");
        assert_eq!(fake.count("POST /api/inbox/read"), 0);
        l.stop().await;
    }

    #[tokio::test]
    async fn a_last_word_is_asked_again_only_while_copland_is_down() {
        let quick = Backoff {
            first: Duration::from_millis(1),
            most: Duration::from_millis(2),
            give_up: Duration::from_secs(5),
        };
        let (_tx, shutdown) = watch::channel(false);
        let tries = std::sync::atomic::AtomicU32::new(0);
        let call = |status: u16, ok_after: u32| {
            let tries = &tries;
            move || async move {
                let n = tries.fetch_add(1, Ordering::SeqCst) + 1;
                if n > ok_after {
                    Ok(n)
                } else {
                    Err(ApiError::Status {
                        status,
                        code: None,
                        message: "x".into(),
                    })
                }
            }
        };
        assert_eq!(quick.retry("x", shutdown.clone(), call(503, 2)).await.unwrap(), 3);
        tries.store(0, Ordering::SeqCst);
        /* A refusal is final at once. */
        assert!(quick.retry("x", shutdown.clone(), call(409, 2)).await.is_err());
        assert_eq!(tries.load(Ordering::SeqCst), 1);
        /* Shutting down: no more waiting. */
        tries.store(0, Ordering::SeqCst);
        let (_tx, stopping) = watch::channel(true);
        assert!(quick.retry("x", stopping, call(503, 2)).await.is_err());
        assert_eq!(tries.load(Ordering::SeqCst), 1);
        /* No answer at all is Copland down too; an unreadable answer is not. */
        assert!(ApiError::Unreachable("connection refused".into()).is_unavailable());
        assert!(!ApiError::Transport("unexpected answer".into()).is_retryable());
        assert!(
            ApiError::Status {
                status: 503,
                code: Some("storage_unavailable".into()),
                message: String::new()
            }
            .is_unavailable()
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
        /* Stopped with its review_first PR open (COPL-193): left for a person, so done for now. */
        assert_eq!(ending_of(&Exit::ForReview), Ending::Completed);
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

    /// COPL-236: a lane run that exits 0 with one of its story's tasks still active and held by
    /// it left that task unfinished, as a worker would; done tasks are no longer held, and the
    /// story itself, active as it follows its tasks, never counts.
    #[test]
    fn a_lane_left_with_a_task_active_is_unfinished() {
        let story = task_with(serde_json::json!({ "id": "s1", "key": "COPL-227", "level": "story" }));
        let mine = serde_json::json!({ "runId": "r1", "run": "r1" });
        let active = task_with(serde_json::json!({ "id": "t2", "key": "COPL-240", "parentId": "s1", "claim": mine }));
        let elsewhere = task_with(serde_json::json!({ "id": "t3", "key": "COPL-9", "parentId": "s9", "claim": mine }));
        /* Only the story held: between tasks, or all of them done. */
        assert!(lane_unfinished(&story, &[], "r1", true).is_none());
        let found = lane_unfinished(&story, &[(&active, Some("active"))], "r1", true);
        assert_eq!(found.map(|t| t.key.as_str()), Some("COPL-240"));
        /* Its task moved on properly: blocked for a person, back to todo, or done. */
        for stage in ["blocked", "todo", "done"] {
            assert!(
                lane_unfinished(&story, &[(&active, Some(stage))], "r1", true).is_none(),
                "{stage}"
            );
        }
        /* A task not of this story isn't the lane's to leave. */
        assert!(lane_unfinished(&story, &[(&elsewhere, Some("active"))], "r1", true).is_none());
        /* review_first with its PR open, left for a person, as a worker leaves it. */
        let review = task_with(serde_json::json!({
            "id": "t4", "parentId": "s1", "claim": mine, "reviewFirst": true,
            "code": [{ "kind": "pull", "state": "open" }],
        }));
        assert!(lane_unfinished(&story, &[(&review, Some("active"))], "r1", true).is_none());
    }

    /// An older server sends none of what `unfinished` reads: no stage, so never unfinished.
    #[test]
    fn an_older_servers_task_reads_and_is_never_unfinished() {
        let t: crate::api::Task = serde_json::from_value(serde_json::json!({
            "id": "t1", "key": "COPL-1", "boardId": "b1", "title": "", "updatedAt": "", "completedAt": null,
        }))
        .unwrap();
        assert!(t.stage_id.is_none() && !t.review_first && !t.open_pr());
        let board: crate::api::BoardShell = serde_json::from_value(serde_json::json!({ "repos": [] })).unwrap();
        assert_eq!(board.category("s"), None);
        assert!(!unfinished(&t, None, false, "r1", true));
    }

    #[test]
    fn a_leaf_task_is_coded_a_story_is_a_lane_and_what_holds_work_is_led() {
        /* No coding setup or no repo: the old way, whatever the level. */
        assert_eq!(role_of(false, true, Some("story"), true), Role::Workdir);
        assert_eq!(role_of(true, false, Some("story"), true), Role::Workdir);
        assert_eq!(role_of(true, true, Some("task"), false), Role::Worker);
        assert_eq!(role_of(true, true, None, false), Role::Worker);
        assert_eq!(role_of(true, true, Some("epic"), false), Role::Lead);
        assert_eq!(role_of(true, true, Some("epic"), true), Role::Lead);
        /* A task split into children is led too. */
        assert_eq!(role_of(true, true, Some("task"), true), Role::Lead);
        /* A story is a lane (COPL-236), planned yet or not; a task under an epic is still a leaf. */
        assert_eq!(role_of(true, true, Some("story"), false), Role::Lane);
        assert_eq!(role_of(true, true, Some("story"), true), Role::Lane);
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

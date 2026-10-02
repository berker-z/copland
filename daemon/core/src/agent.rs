//! One agent's loop: poll its unread inbox, and for a task that needs it,
//! start a run, claim the task, launch the runtime, finish the run.
//! At most one run at a time, so the loop simply waits for it.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Result, anyhow};
use tokio::sync::watch;

use crate::api::{Api, ApiError, Ending, InboxItem};
use crate::config::AgentConfig;
use crate::guard::{Check, Plan, Wake, WakeGuard, plan};
use crate::runner::{self, Exit, Launch};
use crate::state::{AgentState, DaemonState, Phase, RunSummary};

const PAGE: u32 = 100;
/// More unread than this is read on a later poll.
const MAX_PAGES: usize = 10;

pub struct Paths {
    pub state_dir: PathBuf,
    pub runtime_dir: PathBuf,
}

pub struct AgentLoop {
    index: usize,
    agent: AgentConfig,
    api: Api,
    poll: Duration,
    paths: Arc<Paths>,
    state: watch::Sender<DaemonState>,
    shutdown: watch::Receiver<bool>,
    /// The handle the server gave, once asked.
    handle: Option<String>,
    guard: WakeGuard,
    /// Task-less items already logged, so each is said once.
    noted: std::collections::HashSet<String>,
}

/// What became of one wake.
enum Outcome {
    Ran,
    Skipped,
}

impl AgentLoop {
    pub fn new(
        index: usize,
        agent: AgentConfig,
        poll: Duration,
        paths: Arc<Paths>,
        state: watch::Sender<DaemonState>,
        shutdown: watch::Receiver<bool>,
    ) -> Result<Self> {
        let api = Api::new(&agent.url)?;
        Ok(Self {
            index,
            agent,
            api,
            poll,
            paths,
            state,
            shutdown,
            handle: None,
            guard: WakeGuard::default(),
            noted: Default::default(),
        })
    }

    fn update(&self, f: impl FnOnce(&mut AgentState)) {
        self.state.send_modify(|s| f(&mut s.agents[self.index]));
    }

    fn stopping(&self) -> bool {
        *self.shutdown.borrow()
    }

    pub async fn run(mut self) {
        /* The same failure every poll (server down, a read-only token) is said once, until it changes. */
        let mut last_error: Option<String> = None;
        while !self.stopping() {
            let launched = match self.tick().await {
                Ok(launched) => {
                    if last_error.take().is_some() {
                        tracing::info!("working again");
                    }
                    self.update(|s| s.last_error = None);
                    launched
                }
                Err(e) => {
                    let message = format!("{e:#}");
                    if last_error.as_deref() == Some(message.as_str()) {
                        tracing::debug!("{message}");
                    } else {
                        tracing::warn!("{message}");
                    }
                    self.update(|s| s.last_error = Some(message.clone()));
                    last_error = Some(message);
                    false
                }
            };
            if self.stopping() {
                break;
            }
            /* After a run, look again at once: the inbox has likely moved on. */
            if launched {
                continue;
            }
            let mut shutdown = self.shutdown.clone();
            tokio::select! {
                _ = tokio::time::sleep(self.poll) => {}
                _ = shutdown.wait_for(|stop| *stop) => {}
            }
        }
        self.update(|s| s.phase = Phase::Stopped);
        tracing::info!("stopped");
    }

    /// Who the token is, from the server. The config's handle is only a label.
    async fn handle(&mut self) -> Result<String> {
        if let Some(h) = &self.handle {
            return Ok(h.clone());
        }
        let me = self
            .api
            .me(&self.agent.token)
            .await
            .map_err(|e| anyhow!("asking who the token is: {e}"))?;
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
        let handle = me.user.handle.clone();
        self.update(|s| {
            s.handle = handle.clone();
            s.phase = Phase::Idle;
        });
        self.handle = Some(handle.clone());
        Ok(handle)
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
    async fn tick(&mut self) -> Result<bool> {
        let me = self.handle().await?;
        let (unread, items) = self.unread().await?;
        self.update(|s| {
            s.last_poll = Some(SystemTime::now());
            s.unread = unread;
        });
        let plan: Plan = plan(&me, &items);
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
                return Ok(false);
            }
            if let Check::Seen { updated_at } = self.guard.check(wake) {
                let current = match self.api.task(&self.agent.token, &wake.task_id).await {
                    Ok(t) => Some(t.updated_at),
                    Err(e) if e.is_refusal() => None,
                    Err(e) => return Err(anyhow!("reading {}: {e}", wake.task_key)),
                };
                if !WakeGuard::changed(&updated_at, current.as_deref()) {
                    tracing::debug!(task = %wake.task_key, "already handled these {} item(s); waiting for something new", wake.items.len());
                    continue;
                }
                tracing::info!(task = %wake.task_key, "changed since the last run; waking");
            }
            match self.work(&me, wake).await? {
                Outcome::Ran => return Ok(true),
                Outcome::Skipped => continue,
            }
        }
        Ok(false)
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

    async fn work(&mut self, me: &str, wake: &Wake) -> Result<Outcome> {
        let key = wake.task_key.clone();
        tracing::info!(task = %key, items = wake.items.len(), "waking for {key}");
        let started = self
            .api
            .start_run(&self.agent.token, &self.agent.client)
            .await
            .map_err(|e| anyhow!("starting a run for {key}: {e}"))?;
        let run_id = started.run.id.clone();
        let short = started.run.short.clone();
        self.update(|s| {
            s.phase = Phase::Running {
                run: short.clone(),
                task: key.clone(),
                since: SystemTime::now(),
            }
        });

        match self.api.claim(&started.secret, &wake.task_id).await {
            Ok(task) => tracing::info!(run = %short, task = %task.key, "claimed"),
            Err(e) => {
                let ending = self.finish(&run_id, Ending::Cancelled).await;
                self.update(|s| s.phase = Phase::Idle);
                return match e {
                    ApiError::Status { .. } if e.is_refusal() => {
                        /* Someone else's run holds it, it is closed, or it is someone else's: leave it. */
                        tracing::info!(run = %short, task = %key, "claim refused, skipping: {e}");
                        let updated = self.updated_at(&wake.task_id).await;
                        self.guard.remember(wake, updated);
                        self.summary(&short, &key, format!("skipped ({ending}): {e}"));
                        Ok(Outcome::Skipped)
                    }
                    _ => Err(anyhow!("claiming {key}: {e}")),
                };
            }
        }

        let exit = runner::run(
            Launch {
                api: &self.api,
                agent: &self.agent,
                handle: me,
                run_id: &run_id,
                secret: &started.secret,
                task_key: &key,
                state_dir: &self.paths.state_dir,
                runtime_dir: &self.paths.runtime_dir,
            },
            self.shutdown.clone(),
        )
        .await;
        drop(started);
        let ending = match exit {
            Exit::Code(0) => Ending::Completed,
            Exit::Stopped => Ending::Cancelled,
            _ => Ending::Failed,
        };
        let status = self.finish(&run_id, ending).await;
        if status == ending.as_str() {
            tracing::info!(run = %short, task = %key, "runtime {exit}; run {status}");
        } else {
            /* The runtime finished it first (finish_run), and its word stands. */
            tracing::info!(run = %short, task = %key, "runtime {exit}; run {status} (finished by the runtime)");
        }
        let updated = self.updated_at(&wake.task_id).await;
        self.guard.remember(wake, updated);
        self.summary(&short, &key, status);
        self.update(|s| s.phase = Phase::Idle);
        Ok(Outcome::Ran)
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

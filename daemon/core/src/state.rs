//! What the daemon is doing, as a value anyone can watch. The headless binary
//! only logs; a window (COPL-33) subscribes to this and draws it.

use std::path::PathBuf;
use std::time::SystemTime;

use crate::live::Link;

#[derive(Debug, Clone, Default)]
pub struct DaemonState {
    /// One per configured agent, in config order.
    pub agents: Vec<AgentState>,
    /// Set once shutdown has begun.
    pub stopping: bool,
}

#[derive(Debug, Clone)]
pub struct AgentState {
    /// Which of the daemon's agents this is: stable across reloads, unlike its place in the list.
    pub slot: u64,
    /// The handle as `daemon.toml` has it, which is how a reload finds the agent again.
    pub configured: String,
    /// The agent's user id, once the server has said who the token is.
    pub user_id: Option<String>,
    /// "owner/name": the configured handle until the server has said.
    pub handle: String,
    pub url: String,
    /// Running while any run is going (the oldest one); see `runs` for all of them.
    pub phase: Phase,
    /// Every run going now, oldest first (COPL-82: an agent may run several at once).
    pub runs: Vec<ActiveRun>,
    pub last_poll: Option<SystemTime>,
    /// Unread items in the agent's inbox at the last poll.
    pub unread: u64,
    /// The last thing that went wrong, cleared by the next good poll.
    pub last_error: Option<String>,
    pub last_run: Option<RunSummary>,
    /// Tasks with unread items for the agent at the last poll, oldest first: what the box draws as todo.
    /// The task a run is on stays listed until the next poll after it, so a reader leaves that one out.
    pub waiting: Vec<String>,
    /// Messages to the agent (COPL-107), with or without a task, that no run has had and none is on
    /// yet: they wait for the next run, since nothing reaches a run once it has started. A run on
    /// messages that point at no task shows in `runs` under the task `runner::MESSAGES`.
    pub messages: usize,
    /// A reload changed or removed this agent and its loop is winding down: at once when idle,
    /// after the run when one is going. Cleared when its new binding starts.
    pub retiring: bool,
    /// The agent's live socket (COPL-62): connected, it wakes on new work at once and polls only
    /// as a fallback; reconnecting, it polls at `poll_interval` until the socket is back.
    pub live: Link,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    /// Not yet talked to the server.
    Starting,
    Idle,
    /// A run is starting, claiming, or its runtime is alive.
    Running {
        run: String,
        task: String,
        since: SystemTime,
    },
    Stopped,
}

/// One run going now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveRun {
    pub run: String,
    pub task: String,
    pub since: SystemTime,
}

#[derive(Debug, Clone)]
pub struct RunSummary {
    pub run: String,
    pub task: String,
    /// completed, failed, cancelled, or "skipped: …" when the claim was refused.
    pub outcome: String,
    /// It went wrong (COPL-136): its runtime died or never started, or the run couldn't get going.
    /// The box says so on the agent's line until its next run.
    pub failed: bool,
    /// How its runtime ended, as the run log's last line says ("exit 1 after 3.8s"), once launched.
    pub how: Option<String>,
    /// The plain word for a runtime that died at once with nothing to say (`runner::Ended::hint`).
    pub hint: Option<String>,
    /// The run's log, once its runtime was launched.
    pub log: Option<PathBuf>,
    pub ended: SystemTime,
}

impl AgentState {
    /// A run started.
    pub fn run_started(&mut self, run: &str, task: &str) {
        self.runs.push(ActiveRun {
            run: run.to_string(),
            task: task.to_string(),
            since: SystemTime::now(),
        });
        self.sync_phase();
    }

    /// A run ended, however it did.
    pub fn run_ended(&mut self, run: &str) {
        self.runs.retain(|r| r.run != run);
        self.sync_phase();
    }

    /// `phase` from `runs`: the oldest run while any is going, idle once none is.
    fn sync_phase(&mut self) {
        match self.runs.first() {
            Some(r) => {
                self.phase = Phase::Running {
                    run: r.run.clone(),
                    task: r.task.clone(),
                    since: r.since,
                }
            }
            None if matches!(self.phase, Phase::Running { .. }) => self.phase = Phase::Idle,
            None => {}
        }
    }

    pub fn new(handle: &str, url: &str) -> Self {
        Self {
            slot: 0,
            configured: handle.to_string(),
            user_id: None,
            handle: handle.to_string(),
            url: url.to_string(),
            phase: Phase::Starting,
            runs: Vec::new(),
            last_poll: None,
            unread: 0,
            last_error: None,
            last_run: None,
            waiting: Vec::new(),
            messages: 0,
            retiring: false,
            live: Link::Connecting,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_phase_follows_the_oldest_run_going() {
        let mut a = AgentState::new("me/dev", "http://x");
        a.phase = Phase::Idle;
        a.run_started("aaaa", "T-1");
        a.run_started("bbbb", "T-2");
        assert_eq!(a.runs.len(), 2);
        assert!(matches!(&a.phase, Phase::Running { run, task, .. } if run == "aaaa" && task == "T-1"));
        a.run_ended("aaaa");
        assert!(matches!(&a.phase, Phase::Running { run, .. } if run == "bbbb"));
        a.run_ended("bbbb");
        assert_eq!(a.phase, Phase::Idle);
        /* Ending a run never wakes a stopped agent. */
        a.phase = Phase::Stopped;
        a.run_ended("cccc");
        assert_eq!(a.phase, Phase::Stopped);
    }
}

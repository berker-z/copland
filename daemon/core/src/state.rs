//! What the daemon is doing, as a value anyone can watch. The headless binary
//! only logs; a window (COPL-33) subscribes to this and draws it.

use std::time::SystemTime;

#[derive(Debug, Clone, Default)]
pub struct DaemonState {
    /// One per configured agent, in config order.
    pub agents: Vec<AgentState>,
    /// Set once shutdown has begun.
    pub stopping: bool,
}

#[derive(Debug, Clone)]
pub struct AgentState {
    /// "owner/name": the configured handle until the server has said.
    pub handle: String,
    pub url: String,
    pub phase: Phase,
    pub last_poll: Option<SystemTime>,
    /// Unread items in the agent's inbox at the last poll.
    pub unread: u64,
    /// The last thing that went wrong, cleared by the next good poll.
    pub last_error: Option<String>,
    pub last_run: Option<RunSummary>,
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

#[derive(Debug, Clone)]
pub struct RunSummary {
    pub run: String,
    pub task: String,
    /// completed, failed, cancelled, or "skipped: …" when the claim was refused.
    pub outcome: String,
    pub ended: SystemTime,
}

impl AgentState {
    pub fn new(handle: &str, url: &str) -> Self {
        Self {
            handle: handle.to_string(),
            url: url.to_string(),
            phase: Phase::Starting,
            last_poll: None,
            unread: 0,
            last_error: None,
            last_run: None,
        }
    }
}

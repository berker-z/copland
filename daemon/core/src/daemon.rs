//! The daemon: one loop per configured agent, a state anyone can watch, and a
//! way to stop it all.

use std::sync::Arc;

use anyhow::Result;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tracing::Instrument;

use crate::agent::{AgentLoop, Paths};
use crate::config::Config;
use crate::state::{AgentState, DaemonState};

pub struct Daemon {
    state: watch::Receiver<DaemonState>,
    state_tx: watch::Sender<DaemonState>,
    shutdown: watch::Sender<bool>,
    loops: JoinSet<()>,
}

impl Daemon {
    /// Start every agent's loop. Must be called inside a Tokio runtime.
    pub fn start(config: Config, paths: Paths) -> Result<Self> {
        let initial = DaemonState {
            agents: config
                .agents
                .iter()
                .map(|a| AgentState::new(&a.handle, &a.url))
                .collect(),
            stopping: false,
        };
        let (state_tx, state) = watch::channel(initial);
        let (shutdown, shutdown_rx) = watch::channel(false);
        let paths = Arc::new(paths);
        let mut loops = JoinSet::new();
        for (index, agent) in config.agents.into_iter().enumerate() {
            let span = tracing::info_span!("agent", handle = %agent.handle);
            let worker = AgentLoop::new(
                index,
                agent,
                config.poll_interval,
                paths.clone(),
                state_tx.clone(),
                shutdown_rx.clone(),
            )?;
            loops.spawn(worker.run().instrument(span));
        }
        Ok(Self {
            state,
            state_tx,
            shutdown,
            loops,
        })
    }

    /// The daemon's state, now and as it changes.
    pub fn subscribe(&self) -> watch::Receiver<DaemonState> {
        self.state.clone()
    }

    /// Stop polling, stop running runtimes (their runs finish as cancelled). Returns at once; `join` waits.
    pub fn shutdown(&self) {
        self.state_tx.send_modify(|s| s.stopping = true);
        let _ = self.shutdown.send(true);
    }

    /// Wait for every loop to end.
    pub async fn join(mut self) {
        while let Some(result) = self.loops.join_next().await {
            if let Err(e) = result {
                tracing::error!("an agent loop crashed: {e}");
            }
        }
    }
}

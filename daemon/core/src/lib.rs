//! The Copland daemon's loop, without any UI.
//!
//! For each configured agent it watches the agent's inbox through Copland's
//! HTTP API, and when a task needs the agent it starts a run, claims the task
//! with the run's secret, launches the configured runtime with an MCP config
//! that connects it through that run, keeps the run alive while the runtime
//! lives, and finishes the run when it exits. `Daemon::subscribe` hands out the
//! state for a front end to draw.

pub mod agent;
pub mod api;
pub mod config;
pub mod daemon;
pub mod guard;
pub mod live;
pub mod reload;
pub mod runner;
pub mod state;

pub use agent::Paths;
pub use config::Config;
pub use daemon::{Daemon, Reloaded};
pub use live::Link;
pub use state::{AgentState, DaemonState, Phase};

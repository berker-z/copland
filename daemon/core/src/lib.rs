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
pub mod lock;
pub mod preflight;
pub mod reload;
pub mod runner;
pub mod runtime;
pub mod sandbox;
pub mod setup;
pub mod state;
pub mod status;
pub mod workspace;

pub use agent::Paths;
pub use config::Config;
pub use daemon::{Daemon, Reloaded, RunStopper};
pub use live::Link;
pub use lock::Lock;
pub use state::{AgentState, DaemonState, Phase};
pub use status::Status;

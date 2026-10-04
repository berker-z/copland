//! The daemon: one loop per configured agent, a state anyone can watch, a way
//! to change the agents while it runs, and a way to stop it all.
//!
//! Each agent has a slot: a supervising task that runs the agent's loop with
//! the binding it is given, and when a reload changes that binding, waits for
//! the loop to wind down and starts it again with the new one. Winding down
//! means the loop starts nothing new: it ends at once between polls, and
//! after the run when one is going, which is left to finish under its old
//! binding (a reload never signals a runtime; only shutdown does). Since the
//! next loop for an agent starts only once the last one has ended, an agent
//! never has two loops, or two runs, at once.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use tokio::sync::watch;
use tokio::task::JoinSet;
use tracing::Instrument;

use crate::agent::{AgentLoop, Paths, Retire, StopRequest, Wanted};
use crate::api::Api;
use crate::config::{AgentConfig, Config};
use crate::guard::WakeGuard;
use crate::reload::{self, Plan};
use crate::state::{AgentState, DaemonState, Phase};

/// One agent as the daemon runs it.
struct Slot {
    id: u64,
    agent: AgentConfig,
    /// What its supervisor should run. Closed once the supervisor has ended by itself.
    wanted: watch::Sender<Wanted>,
}

pub struct Daemon {
    state: watch::Receiver<DaemonState>,
    state_tx: watch::Sender<DaemonState>,
    shutdown: watch::Sender<bool>,
    /// Runs stopped by hand (`RunStopper`).
    stop_run: watch::Sender<StopRequest>,
    loops: JoinSet<()>,
    slots: Vec<Slot>,
    /// Slots a reload removed whose loops may still be finishing a run.
    leaving: Vec<watch::Sender<Wanted>>,
    poll: Duration,
    paths: Arc<Paths>,
    next_slot: u64,
}

/// Stops one run of this daemon by hand: the agent's loop sends its runtime's process group
/// SIGTERM (SIGKILL after the grace period), finishes the run as cancelled and remembers the
/// task's items in its wake guard, as after any run, so it doesn't start again on them. Safe to
/// call from any thread; asking for a run that has already ended does nothing.
#[derive(Clone)]
pub struct RunStopper(watch::Sender<StopRequest>);

impl RunStopper {
    /// Stop `run` (the short id `Phase::Running` shows) of the agent in `slot` (`AgentState::slot`).
    pub fn stop(&self, slot: u64, run: &str) {
        self.0.send_replace(Some((slot, run.to_string())));
    }
}

/// What a reload did, by handle as configured.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Reloaded {
    pub started: Vec<String>,
    pub rebound: Vec<String>,
    pub stopped: Vec<String>,
}

impl Daemon {
    /// Start every agent's loop. Must be called inside a Tokio runtime.
    pub fn start(config: Config, paths: Paths) -> Result<Self> {
        for agent in &config.agents {
            Api::new(&agent.url)?;
        }
        let (state_tx, state) = watch::channel(DaemonState::default());
        let (shutdown, _) = watch::channel(false);
        let (stop_run, _) = watch::channel(None);
        let mut daemon = Self {
            state,
            state_tx,
            shutdown,
            stop_run,
            loops: JoinSet::new(),
            slots: Vec::new(),
            leaving: Vec::new(),
            poll: config.poll_interval,
            paths: Arc::new(paths),
            next_slot: 1,
        };
        for agent in config.agents {
            let slot = daemon.spawn(agent, None);
            daemon.slots.push(slot);
        }
        Ok(daemon)
    }

    /// The daemon's state, now and as it changes.
    pub fn subscribe(&self) -> watch::Receiver<DaemonState> {
        self.state.clone()
    }

    /// A handle that stops one run by hand, for the box.
    pub fn run_stopper(&self) -> RunStopper {
        RunStopper(self.stop_run.clone())
    }

    /// Start a supervisor for `agent`: in a new slot, its state listed last, or again in
    /// `existing` (whose supervisor has ended), keeping its place.
    fn spawn(&mut self, agent: AgentConfig, existing: Option<u64>) -> Slot {
        let id = existing.unwrap_or_else(|| {
            let id = self.next_slot;
            self.next_slot += 1;
            let mut st = AgentState::new(&agent.handle, &agent.url);
            st.slot = id;
            self.state_tx.send_modify(|s| s.agents.push(st));
            id
        });
        let (wanted, rx) = watch::channel(Wanted {
            generation: 0,
            agent: Some(agent.clone()),
            poll: self.poll,
        });
        let span = tracing::info_span!("agent", handle = %agent.handle);
        self.loops.spawn(
            supervise(
                id,
                rx,
                self.paths.clone(),
                self.state_tx.clone(),
                self.shutdown.subscribe(),
                self.stop_run.subscribe(),
            )
            .instrument(span),
        );
        Slot { id, agent, wanted }
    }

    /// Run the agents `config` lists from now on, without stopping the others: new ones start,
    /// removed ones stop, and changed ones start again with their new binding. A removed or
    /// changed agent that is in a run finishes it first. The config's other keys (the box's)
    /// are not the daemon's and are ignored here.
    pub fn reload(&mut self, config: Config) -> Result<Reloaded> {
        if *self.shutdown.borrow() {
            bail!("the daemon is stopping");
        }
        for agent in &config.agents {
            Api::new(&agent.url)?;
        }
        let old: Vec<AgentConfig> = self.slots.iter().map(|s| s.agent.clone()).collect();
        let poll_changed = config.poll_interval != self.poll;
        let Plan {
            keep,
            rebind,
            start,
            stop,
        } = reload::plan(&old, &config.agents, poll_changed);
        self.poll = config.poll_interval;
        let mut done = Reloaded::default();

        let mut old_slots: Vec<Option<Slot>> = std::mem::take(&mut self.slots).into_iter().map(Some).collect();
        let mut placed: Vec<Option<Slot>> = (0..config.agents.len()).map(|_| None).collect();
        for (o, n) in keep {
            placed[n] = old_slots[o].take();
        }
        for (o, n) in rebind {
            let mut slot = old_slots[o].take().expect("each old agent matched once");
            let agent = config.agents[n].clone();
            done.rebound.push(agent.handle.clone());
            if slot.wanted.is_closed() {
                /* Its loop had ended by itself (its token was refused): start it afresh. */
                tracing::info!(handle = %agent.handle, "reload: starting again with its new binding");
                placed[n] = Some(self.spawn(agent, Some(slot.id)));
                continue;
            }
            tracing::info!(handle = %agent.handle, "reload: new binding from its next poll (after its run, if one is going)");
            self.mark_retiring(slot.id);
            let poll = self.poll;
            slot.wanted.send_modify(|w| {
                w.generation += 1;
                w.agent = Some(agent.clone());
                w.poll = poll;
            });
            slot.agent = agent;
            placed[n] = Some(slot);
        }
        for o in stop {
            let slot = old_slots[o].take().expect("each old agent matched once");
            tracing::info!(handle = %slot.agent.handle, "reload: no longer run here (after its run, if one is going)");
            done.stopped.push(slot.agent.handle.clone());
            if slot.wanted.is_closed() {
                let id = slot.id;
                self.state_tx.send_modify(|s| s.agents.retain(|a| a.slot != id));
                continue;
            }
            self.mark_retiring(slot.id);
            slot.wanted.send_modify(|w| {
                w.generation += 1;
                w.agent = None;
            });
            self.leaving.push(slot.wanted);
        }
        for n in start {
            let agent = config.agents[n].clone();
            tracing::info!(handle = %agent.handle, "reload: starting");
            done.started.push(agent.handle.clone());
            placed[n] = Some(self.spawn(agent, None));
        }
        self.slots = placed.into_iter().map(|s| s.expect("every new agent placed")).collect();
        self.leaving.retain(|w| !w.is_closed());
        Ok(done)
    }

    fn mark_retiring(&self, id: u64) {
        self.state_tx.send_modify(|s| {
            if let Some(a) = s.agents.iter_mut().find(|a| a.slot == id) {
                a.retiring = true;
            }
        });
    }

    /// Stop polling, stop running runtimes (their runs finish as cancelled). Returns at once; `join` waits.
    pub fn shutdown(&self) {
        self.state_tx.send_modify(|s| s.stopping = true);
        let _ = self.shutdown.send(true);
    }

    /// Wait for every loop to end: after `shutdown`, or when none is left (each one's token was
    /// unusable, or reloads removed them all). Safe to cancel and call again.
    pub async fn join(&mut self) {
        while let Some(result) = self.loops.join_next().await {
            if let Err(e) = result {
                tracing::error!("an agent loop crashed: {e}");
            }
        }
    }
}

/// One agent's slot: run its loop with the binding it is given until the daemon stops, a
/// reload removes it, or the loop ends by itself (its token was refused). The wake guard's
/// memory is carried from one binding to the next, so a rebind doesn't relaunch on items
/// a run has already seen.
async fn supervise(
    id: u64,
    mut wanted: watch::Receiver<Wanted>,
    paths: Arc<Paths>,
    state: watch::Sender<DaemonState>,
    shutdown: watch::Receiver<bool>,
    stop_run: watch::Receiver<StopRequest>,
) {
    let mut guard = WakeGuard::default();
    let update = |f: &dyn Fn(&mut AgentState)| {
        state.send_if_modified(|s| match s.agents.iter_mut().find(|a| a.slot == id) {
            Some(a) => {
                f(a);
                true
            }
            None => false,
        });
    };
    loop {
        if *shutdown.borrow() {
            return;
        }
        let w = wanted.borrow_and_update().clone();
        let Some(agent) = w.agent else {
            tracing::info!("no longer run here");
            state.send_modify(|s| s.agents.retain(|a| a.slot != id));
            return;
        };
        if w.generation > 0 {
            tracing::info!("starting with its new binding");
        }
        let (handle, url) = (agent.handle.clone(), agent.url.clone());
        update(&|a| {
            a.configured = handle.clone();
            a.url = url.clone();
            a.retiring = false;
            a.last_error = None;
            a.phase = Phase::Starting;
        });
        let retire = Retire {
            rx: wanted.clone(),
            generation: w.generation,
        };
        match AgentLoop::new(
            id,
            agent,
            w.poll,
            paths.clone(),
            state.clone(),
            shutdown.clone(),
            retire,
            stop_run.clone(),
            guard,
        ) {
            Ok(worker) => guard = worker.run().await,
            Err(e) => {
                let message = format!("{e:#}");
                tracing::error!("{message}");
                update(&|a| {
                    a.last_error = Some(message.clone());
                    a.phase = Phase::Stopped;
                });
                return;
            }
        }
        /* Not retired: it stopped by itself (shutdown, or a token it can't use). A reload that
        changes it later starts a new supervisor. */
        if wanted.borrow().generation == w.generation {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Secret;

    fn agent(handle: &str, command: &str) -> AgentConfig {
        AgentConfig {
            /* Nothing listens here: each loop's first call fails and it waits to poll again. */
            url: "http://127.0.0.1:9".into(),
            handle: handle.into(),
            token: Secret::new("cpl_t"),
            command: vec![command.into()],
            workdir: std::env::temp_dir(),
            client: "Claude Code".into(),
            code_command: None,
            writable: Vec::new(),
            runtime: crate::config::Runtime::ClaudeCode,
            code_dir: "/tmp/copland-code".into(),
            max_runs: 10,
        }
    }

    fn config(agents: Vec<AgentConfig>) -> Config {
        let mut c = Config::parse(
            &format!(
                "[[agent]]\nurl=\"http://x\"\nhandle=\"a\"\ntoken=\"cpl_a\"\ncommand=[\"x\"]\nworkdir=\"{}\"\n",
                std::env::temp_dir().display()
            ),
            |_| unreachable!(),
        )
        .unwrap();
        c.agents = agents;
        c
    }

    fn handles(st: &DaemonState) -> Vec<(u64, String, bool)> {
        st.agents
            .iter()
            .map(|a| (a.slot, a.configured.clone(), a.retiring))
            .collect()
    }

    #[tokio::test]
    async fn reloads_start_rebind_and_stop_loops_in_place() {
        let dir = std::env::temp_dir().join(format!("copland-reload-{}", std::process::id()));
        let paths = Paths {
            state_dir: dir.clone(),
            runtime_dir: dir.clone(),
        };
        let mut d = Daemon::start(
            config(vec![agent("me/dev", "claude"), agent("me/old", "claude")]),
            paths,
        )
        .unwrap();
        let mut st = d.subscribe();
        assert_eq!(
            handles(&st.borrow()),
            [(1, "me/dev".into(), false), (2, "me/old".into(), false)]
        );

        let done = d
            .reload(config(vec![agent("me/dev", "codex"), agent("me/new", "claude")]))
            .unwrap();
        assert_eq!(
            done,
            Reloaded {
                started: vec!["me/new".into()],
                rebound: vec!["me/dev".into()],
                stopped: vec!["me/old".into()],
            }
        );
        /* Idle loops wind down at once: me/old's slot goes, me/dev's keeps its place. */
        tokio::time::timeout(
            Duration::from_secs(5),
            st.wait_for(|s| handles(s) == [(1, "me/dev".to_string(), false), (3, "me/new".to_string(), false)]),
        )
        .await
        .expect("the reload settled")
        .unwrap();
        assert_eq!(d.slots[0].agent.command, ["codex"]);

        /* Nothing changed: nothing happens. */
        let same = d
            .reload(config(vec![agent("me/dev", "codex"), agent("me/new", "claude")]))
            .unwrap();
        assert_eq!(same, Reloaded::default());

        d.shutdown();
        tokio::time::timeout(Duration::from_secs(5), d.join())
            .await
            .expect("stopped");
        assert!(d.reload(config(vec![agent("me/dev", "claude")])).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

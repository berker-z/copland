//! What the daemon is doing, as a value for anything outside it (COPL-181): the box draws
//! `DaemonState` in-process, and this is the same state as JSON for the status socket and
//! `copland-daemon status` (COPL-170), and as text for a person.
//!
//! The JSON is a contract (see the README's "Status"): `version` is 1, fields are only ever
//! added, never renamed or removed, and a client ignores fields it doesn't know. Times are
//! RFC 3339 in UTC, to the second.

use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::live::Link;
use crate::runner::MESSAGES;
use crate::state::{AgentState, DaemonState, Phase};

/// The version of the JSON this daemon writes. Adding a field doesn't change it.
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    pub version: u32,
    /// Shutdown has begun.
    pub stopping: bool,
    /// One per configured agent, in config order.
    pub agents: Vec<Agent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agent {
    /// Which of the daemon's agents this is, stable across reloads.
    pub slot: u64,
    /// The handle as `daemon.toml` has it.
    pub configured: String,
    /// "owner/name" as the server says, the configured handle until it has.
    pub handle: String,
    /// The agent's user id, once the server has said.
    pub user_id: Option<String>,
    pub url: String,
    /// starting, watching, running or stopped.
    pub state: String,
    /// The live socket: connecting, connected or reconnecting.
    pub live: String,
    pub last_poll: Option<String>,
    /// Unread items in its inbox at the last poll.
    pub unread: u64,
    /// Tasks with unread items for it at the last poll that no run is on, oldest first.
    pub waiting: Vec<String>,
    /// Messages waiting for the next message run.
    pub messages: usize,
    /// A reload changed or removed it, and its loop is winding down.
    pub retiring: bool,
    /// Since when Copland hasn't answered: nothing starts until it does.
    pub unavailable_since: Option<String>,
    /// Held on this machine (the socket's `hold`): nothing starts until it is released. Not
    /// Copland's pause. Added after version 1 shipped, so an older daemon's status has none.
    #[serde(default)]
    pub held: bool,
    /// Every run going, oldest first.
    pub runs: Vec<Run>,
    /// What this machine lacks to start its runs, which wait until it is there.
    pub missing: Option<String>,
    /// What needs the owner to do something about this agent.
    pub needs: Vec<Need>,
    /// The last thing that went wrong, cleared by the next good poll.
    pub last_error: Option<String>,
    pub last_run: Option<LastRun>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    /// The run's short id.
    pub run: String,
    /// The task's key; None for a run on messages.
    pub task: Option<String>,
    /// task or messages.
    pub kind: String,
    pub since: String,
    /// Where it works, once made; None in the agent's workdir.
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastRun {
    pub run: String,
    pub task: Option<String>,
    pub kind: String,
    /// completed, failed, cancelled, or "skipped (…): …" when it never launched.
    pub outcome: String,
    /// Its runtime died or never started, or the run couldn't get going.
    pub failed: bool,
    /// The claim was refused and nothing launched; `outcome` says why.
    pub skipped: bool,
    /// How its runtime ended ("exit 1 after 3.8s"), once launched.
    pub how: Option<String>,
    /// The plain word for a runtime that died at once with nothing to say.
    pub hint: Option<String>,
    /// The run's log, once its runtime was launched.
    pub log: Option<String>,
    pub ended: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Need {
    /// stopped (the agent isn't watching), missing (its runs can't start) or failed (its last run).
    pub why: String,
    pub says: String,
}

impl Status {
    pub fn of(st: &DaemonState) -> Self {
        Self {
            version: VERSION,
            stopping: st.stopping,
            agents: st.agents.iter().map(Agent::of).collect(),
        }
    }

    /// For a person: one block per agent, in the box's words.
    pub fn render(&self) -> String {
        let mut out = String::new();
        if self.stopping {
            out.push_str("stopping\n");
        }
        if self.agents.is_empty() {
            out.push_str("no agents configured\n");
        }
        for (i, a) in self.agents.iter().enumerate() {
            if i > 0 {
                out.push('\n');
            }
            a.render(&mut out);
        }
        out
    }
}

/// A task's key, or None for the runs on messages.
fn task_of(task: &str) -> (Option<String>, String) {
    if task == MESSAGES {
        (None, "messages".into())
    } else {
        (Some(task.to_string()), "task".into())
    }
}

impl Agent {
    fn of(a: &AgentState) -> Self {
        let state = match a.phase {
            Phase::Starting => "starting",
            Phase::Idle => "watching",
            Phase::Running { .. } => "running",
            Phase::Stopped => "stopped",
        };
        let live = match a.live {
            Link::Connecting => "connecting",
            Link::Connected => "connected",
            Link::Reconnecting => "reconnecting",
        };
        let running: Vec<&str> = a.runs.iter().map(|r| r.task.as_str()).collect();
        let mut needs = Vec::new();
        if a.phase == Phase::Stopped {
            if let Some(e) = &a.last_error {
                needs.push(Need {
                    why: "stopped".into(),
                    says: e.clone(),
                });
            }
        }
        if let Some(m) = &a.missing {
            needs.push(Need {
                why: "missing".into(),
                says: m.clone(),
            });
        }
        if let Some(r) = a.last_run.as_ref().filter(|r| r.failed) {
            let how = r.how.as_deref().unwrap_or(&r.outcome);
            needs.push(Need {
                why: "failed".into(),
                says: match &r.hint {
                    Some(h) => format!("{} {how}: {h}", r.task),
                    None => format!("{} {how}", r.task),
                },
            });
        }
        Self {
            slot: a.slot,
            configured: a.configured.clone(),
            handle: a.handle.clone(),
            user_id: a.user_id.clone(),
            url: a.url.clone(),
            state: state.into(),
            live: live.into(),
            last_poll: a.last_poll.map(rfc3339),
            unread: a.unread,
            waiting: a
                .waiting
                .iter()
                .filter(|k| !running.contains(&k.as_str()))
                .cloned()
                .collect(),
            messages: a.messages,
            retiring: a.retiring,
            unavailable_since: a.unavailable.map(rfc3339),
            held: a.held,
            runs: a
                .runs
                .iter()
                .map(|r| {
                    let (task, kind) = task_of(&r.task);
                    Run {
                        run: r.run.clone(),
                        task,
                        kind,
                        since: rfc3339(r.since),
                        worktree: r.worktree.as_ref().map(|p| p.display().to_string()),
                    }
                })
                .collect(),
            missing: a.missing.clone(),
            needs,
            last_error: a.last_error.clone(),
            last_run: a.last_run.as_ref().map(|r| {
                let (task, kind) = task_of(&r.task);
                LastRun {
                    run: r.run.clone(),
                    task,
                    kind,
                    outcome: r.outcome.clone(),
                    failed: r.failed,
                    skipped: r.outcome.starts_with("skipped"),
                    how: r.how.clone(),
                    hint: r.hint.clone(),
                    log: r.log.as_ref().map(|p| p.display().to_string()),
                    ended: rfc3339(r.ended),
                }
            }),
        }
    }

    fn render(&self, out: &mut String) {
        let doing = match (self.state.as_str(), self.retiring) {
            ("running", true) => "● changes after this run".to_string(),
            ("running", false) => format!(
                "● {}",
                self.runs
                    .iter()
                    .map(|r| r.task.as_deref().unwrap_or("messages"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            (_, true) => "starting".to_string(),
            ("watching", _) => "○ watching".to_string(),
            (other, _) => other.to_string(),
        };
        out.push_str(&format!("@{}  {doing}\n", self.handle));
        let mut about = vec![self.url.clone(), format!("live {}", self.live)];
        if self.handle != self.configured {
            about.insert(0, format!("configured as {}", self.configured));
        }
        out.push_str(&format!("  {}\n", about.join(" · ")));
        if self.held {
            out.push_str("  ‖ held on this machine: starts nothing until released\n");
        }
        if let Some(t) = &self.unavailable_since {
            out.push_str(&format!("  × Copland unavailable since {}\n", clock(t)));
        }
        for r in &self.runs {
            let what = r.task.as_deref().unwrap_or("messages");
            let at = r.worktree.as_deref().map(|w| format!(" in {w}")).unwrap_or_default();
            out.push_str(&format!("  ● {what}: run {} since {}{at}\n", r.run, clock(&r.since)));
        }
        let mut inbox = vec![format!("{} unread", self.unread)];
        if !self.waiting.is_empty() {
            inbox.push(format!("todo {}", self.waiting.join(", ")));
        }
        if self.messages > 0 {
            let s = if self.messages == 1 { "" } else { "s" };
            inbox.push(format!("{} message{s} waiting", self.messages));
        }
        out.push_str(&format!("  {}\n", inbox.join(" · ")));
        for n in &self.needs {
            out.push_str(&format!("  × {}\n", n.says));
        }
        if let Some(e) = self
            .last_error
            .as_ref()
            .filter(|e| !self.needs.iter().any(|n| &n.says == *e) && self.unavailable_since.is_none())
        {
            out.push_str(&format!("  × {e}\n"));
        }
        if let Some(r) = &self.last_run {
            let what = r.task.as_deref().unwrap_or("messages");
            let how = r.how.as_deref().map(|h| format!(", {h}")).unwrap_or_default();
            out.push_str(&format!(
                "  last run {} on {what}: {}{how}, ended {}\n",
                r.run,
                r.outcome,
                clock(&r.ended)
            ));
            if let Some(l) = &r.log {
                out.push_str(&format!("    log {l}\n"));
            }
        }
    }
}

/// "2026-10-04T23:20:41Z" → "23:20 UTC", as `state::clock` says it.
fn clock(rfc: &str) -> String {
    match rfc.get(11..16) {
        Some(hm) => format!("{hm} UTC"),
        None => rfc.to_string(),
    }
}

/// RFC 3339 in UTC, to the second: "2026-10-04T23:20:41Z".
pub fn rfc3339(t: SystemTime) -> String {
    let secs = t.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (days, rest) = (secs / 86_400, secs % 86_400);
    /* Days to a civil date (Howard Hinnant's algorithm). */
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;
    use crate::state::RunSummary;

    /// 2026-10-04 23:20:41 UTC.
    fn at(extra: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_791_156_041 + extra)
    }

    fn busy() -> DaemonState {
        let mut a = AgentState::new("me/dev", "https://copland.example");
        a.slot = 3;
        a.handle = "me/dev".into();
        a.user_id = Some("u-1".into());
        a.phase = Phase::Idle;
        a.live = Link::Connected;
        a.last_poll = Some(at(60));
        a.unread = 4;
        a.waiting = vec!["T-1".into(), "T-2".into()];
        a.messages = 1;
        a.held = true;
        a.run_started("aaaa", "T-1");
        a.run_started("bbbb", MESSAGES);
        for r in &mut a.runs {
            r.since = at(0);
        }
        a.run_worktree("aaaa", PathBuf::from("/code/repo/T-1"));
        a.missing = Some("bwrap not found on PATH: coding runs can't start".into());
        a.last_error = a.missing.clone();
        a.last_run = Some(RunSummary {
            run: "cccc".into(),
            task: "T-9".into(),
            outcome: "failed".into(),
            failed: true,
            how: Some("exit 1 after 3.8s".into()),
            hint: None,
            log: Some(PathBuf::from("/state/runs/cccc.log")),
            ended: at(30),
        });
        DaemonState {
            agents: vec![a],
            stopping: false,
        }
    }

    #[test]
    fn times_are_rfc3339_utc() {
        assert_eq!(rfc3339(at(0)), "2026-10-04T23:20:41Z");
        assert_eq!(rfc3339(SystemTime::UNIX_EPOCH), "1970-01-01T00:00:00Z");
        /* A leap day, and the turn of a year. */
        assert_eq!(
            rfc3339(SystemTime::UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00Z"
        );
        assert_eq!(
            rfc3339(SystemTime::UNIX_EPOCH + Duration::from_secs(1_798_761_599)),
            "2026-12-31T23:59:59Z"
        );
    }

    /// The contract: these names and this shape. A field may be added here, never renamed or removed.
    #[test]
    fn the_json_keeps_its_fields() {
        let json = serde_json::to_value(Status::of(&busy())).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": 1,
                "stopping": false,
                "agents": [{
                    "slot": 3,
                    "configured": "me/dev",
                    "handle": "me/dev",
                    "user_id": "u-1",
                    "url": "https://copland.example",
                    "state": "running",
                    "live": "connected",
                    "last_poll": "2026-10-04T23:21:41Z",
                    "unread": 4,
                    "waiting": ["T-2"],
                    "messages": 1,
                    "retiring": false,
                    "unavailable_since": null,
                    "held": true,
                    "runs": [
                        {
                            "run": "aaaa",
                            "task": "T-1",
                            "kind": "task",
                            "since": "2026-10-04T23:20:41Z",
                            "worktree": "/code/repo/T-1"
                        },
                        {
                            "run": "bbbb",
                            "task": null,
                            "kind": "messages",
                            "since": "2026-10-04T23:20:41Z",
                            "worktree": null
                        }
                    ],
                    "missing": "bwrap not found on PATH: coding runs can't start",
                    "needs": [
                        { "why": "missing", "says": "bwrap not found on PATH: coding runs can't start" },
                        { "why": "failed", "says": "T-9 exit 1 after 3.8s" }
                    ],
                    "last_error": "bwrap not found on PATH: coding runs can't start",
                    "last_run": {
                        "run": "cccc",
                        "task": "T-9",
                        "kind": "task",
                        "outcome": "failed",
                        "failed": true,
                        "skipped": false,
                        "how": "exit 1 after 3.8s",
                        "hint": null,
                        "log": "/state/runs/cccc.log",
                        "ended": "2026-10-04T23:21:11Z"
                    }
                }]
            })
        );
    }

    #[test]
    fn it_reads_back_what_it_writes() {
        let s = Status::of(&busy());
        let back: Status = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        /* A newer daemon's added field is ignored by an older reader. */
        let mut v = serde_json::to_value(&s).unwrap();
        v["agents"][0]["paused"] = serde_json::json!(true);
        v["later"] = serde_json::json!("x");
        assert_eq!(serde_json::from_value::<Status>(v.clone()).unwrap(), s);
        /* A daemon from before `held` says nothing of it: not held. */
        v["agents"][0].as_object_mut().unwrap().remove("held");
        assert!(!serde_json::from_value::<Status>(v).unwrap().agents[0].held);
    }

    #[test]
    fn a_refused_claim_is_a_skipped_last_run_and_a_stopped_agent_needs_you() {
        let mut a = AgentState::new("me/dev", "http://x");
        a.phase = Phase::Stopped;
        a.last_error = Some("the token for @me/dev is read-only".into());
        a.last_run = Some(RunSummary {
            run: "dddd".into(),
            task: "T-4".into(),
            outcome: "skipped (cancelled): closed".into(),
            failed: false,
            how: None,
            hint: None,
            log: None,
            ended: at(0),
        });
        let s = Status::of(&DaemonState {
            agents: vec![a],
            stopping: true,
        });
        let a = &s.agents[0];
        assert_eq!(a.state, "stopped");
        assert!(a.last_run.as_ref().is_some_and(|r| r.skipped && !r.failed));
        assert_eq!(
            a.needs,
            vec![Need {
                why: "stopped".into(),
                says: "the token for @me/dev is read-only".into()
            }]
        );
        assert_eq!(
            s.render(),
            "stopping\n\
             @me/dev  stopped\n  \
             http://x · live connecting\n  \
             0 unread\n  \
             × the token for @me/dev is read-only\n  \
             last run dddd on T-4: skipped (cancelled): closed, ended 23:20 UTC\n"
        );
    }

    #[test]
    fn the_text_is_one_block_per_agent_in_the_boxs_words() {
        let mut st = busy();
        let mut idle = AgentState::new("me/ops", "http://x");
        idle.handle = "me/ops-renamed".into();
        idle.phase = Phase::Idle;
        idle.unavailable = Some(at(0));
        idle.last_error = idle.unavailable_line();
        st.agents.push(idle);
        assert_eq!(
            Status::of(&st).render(),
            "@me/dev  ● T-1, messages\n  \
             https://copland.example · live connected\n  \
             ‖ held on this machine: starts nothing until released\n  \
             ● T-1: run aaaa since 23:20 UTC in /code/repo/T-1\n  \
             ● messages: run bbbb since 23:20 UTC\n  \
             4 unread · todo T-2 · 1 message waiting\n  \
             × bwrap not found on PATH: coding runs can't start\n  \
             × T-9 exit 1 after 3.8s\n  \
             last run cccc on T-9: failed, exit 1 after 3.8s, ended 23:21 UTC\n    \
             log /state/runs/cccc.log\n\
             \n\
             @me/ops-renamed  ○ watching\n  \
             configured as me/ops · http://x · live connecting\n  \
             × Copland unavailable since 23:20 UTC\n  \
             0 unread\n"
        );
        assert_eq!(Status::of(&DaemonState::default()).render(), "no agents configured\n");
    }
}

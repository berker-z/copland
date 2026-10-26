//! What the tray shows for a status (COPL-198): its icon, its tooltip and its menu, as plain
//! values, so each platform's item (the StatusNotifierItem here, the macOS one later) only draws
//! them.

use copland_daemon_core::status::{Agent, Status};

/// The four states the icons come in (`daemon/release/tray/<state>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Icon {
    Idle,
    /// A run is going.
    Working,
    /// An agent needs its owner, or its last run failed.
    Needs,
    /// No daemon answers the socket.
    Stopped,
}

impl Icon {
    pub const ALL: [Icon; 4] = [Icon::Idle, Icon::Working, Icon::Needs, Icon::Stopped];

    /// Its directory under `daemon/release/tray`.
    pub fn dir(self) -> &'static str {
        match self {
            Icon::Idle => "idle",
            Icon::Working => "working",
            Icon::Needs => "needs",
            Icon::Stopped => "stopped",
        }
    }
}

/// What a menu entry does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Hold the agent in this slot on this machine (the socket's `hold`).
    Hold {
        slot: u64,
    },
    Release {
        slot: u64,
    },
    StopRun {
        slot: u64,
        run: String,
    },
    /// Quit the tray, and only the tray: the daemon keeps running.
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// A line of the menu; one without an action is shown disabled, as a note.
    Item {
        label: String,
        action: Option<Action>,
    },
    Separator,
}

impl Entry {
    fn note(label: impl Into<String>) -> Self {
        Entry::Item {
            label: label.into(),
            action: None,
        }
    }

    fn does(label: impl Into<String>, action: Action) -> Self {
        Entry::Item {
            label: label.into(),
            action: Some(action),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub icon: Icon,
    pub title: String,
    /// One line each.
    pub tooltip: Vec<String>,
    pub menu: Vec<Entry>,
}

/// The tray for `status`, None when no daemon answers, with `error` (the last request the daemon
/// refused, or why it can't be reached) in the tooltip and as the menu's first line.
pub fn view(status: Option<&Status>, error: Option<&str>) -> View {
    let mut tooltip = Vec::new();
    let mut menu = Vec::new();
    if let Some(e) = error {
        menu.push(Entry::note(format!("× {e}")));
        menu.push(Entry::Separator);
    }
    let icon = match status {
        None => {
            tooltip.push("not running".to_string());
            menu.push(Entry::note("The daemon isn't running"));
            Icon::Stopped
        }
        Some(s) => {
            if s.stopping {
                tooltip.push("stopping".to_string());
            }
            if s.agents.is_empty() {
                tooltip.push("no agents configured".to_string());
                menu.push(Entry::note("No agents configured"));
            }
            for (i, a) in s.agents.iter().enumerate() {
                tooltip.push(line(a));
                if i > 0 {
                    menu.push(Entry::Separator);
                }
                entries(a, &mut menu);
            }
            if s.agents.iter().any(|a| !a.needs.is_empty()) {
                Icon::Needs
            } else if s.agents.iter().any(|a| !a.runs.is_empty()) {
                Icon::Working
            } else {
                Icon::Idle
            }
        }
    };
    if let Some(e) = error {
        tooltip.push(format!("× {e}"));
    }
    menu.push(Entry::Separator);
    menu.push(Entry::does("Quit tray", Action::Quit));
    View {
        icon,
        title: "Copland".into(),
        tooltip,
        menu,
    }
}

/// "dev" for "berker-z/dev": the name part of the handle the server says.
fn name(a: &Agent) -> &str {
    a.handle.rsplit_once('/').map_or(a.handle.as_str(), |(_, n)| n)
}

/// What one run is on: its task, or the messages.
fn on(task: Option<&str>) -> &str {
    task.unwrap_or("messages")
}

/// "dev · working on COPL-166 · held".
fn line(a: &Agent) -> String {
    let doing = match (a.runs.as_slice(), a.state.as_str()) {
        ([first], _) => format!("working on {}", on(first.task.as_deref())),
        ([first, rest @ ..], _) => format!("working on {} and {} more", on(first.task.as_deref()), rest.len()),
        ([], "watching") => "idle".to_string(),
        ([], state) => state.to_string(),
    };
    let mut parts = vec![name(a).to_string(), doing];
    if a.held {
        parts.push("held".into());
    }
    /* Not a need: the account's usage comes back by itself at the reset (COPL-195). */
    if let Some(t) = &a.out_of_usage_until {
        parts.push(format!("out of usage until {}", clock(t)));
    }
    if let Some(n) = a.needs.first() {
        parts.push(format!("needs you: {}", n.says));
    }
    parts.join(" · ")
}

/// "2026-10-26T17:10:00Z" → "17:10 UTC", as the status's text says it.
fn clock(rfc: &str) -> String {
    match rfc.get(11..16) {
        Some(hm) => format!("{hm} UTC"),
        None => rfc.to_string(),
    }
}

fn entries(a: &Agent, menu: &mut Vec<Entry>) {
    let name = name(a);
    menu.push(if a.held {
        Entry::does(
            format!("Release {name} on this machine"),
            Action::Release { slot: a.slot },
        )
    } else {
        Entry::does(format!("Hold {name} on this machine"), Action::Hold { slot: a.slot })
    });
    for r in &a.runs {
        menu.push(Entry::does(
            format!("Stop {name}'s run on {}", on(r.task.as_deref())),
            Action::StopRun {
                slot: a.slot,
                run: r.run.clone(),
            },
        ));
    }
}

#[cfg(test)]
mod tests {
    use copland_daemon_core::status::{Need, Run};

    use super::*;

    fn agent(slot: u64, handle: &str) -> Agent {
        Agent {
            slot,
            configured: handle.into(),
            handle: handle.into(),
            user_id: None,
            url: "http://x".into(),
            state: "watching".into(),
            live: "connected".into(),
            last_poll: None,
            unread: 0,
            waiting: vec![],
            messages: 0,
            retiring: false,
            unavailable_since: None,
            held: false,
            out_of_usage_until: None,
            runs: vec![],
            missing: None,
            needs: vec![],
            last_error: None,
            last_run: None,
        }
    }

    fn run(run: &str, task: Option<&str>) -> Run {
        Run {
            run: run.into(),
            task: task.map(Into::into),
            kind: if task.is_some() { "task" } else { "messages" }.into(),
            since: "2026-10-26T17:00:00Z".into(),
            worktree: None,
        }
    }

    fn status(agents: Vec<Agent>) -> Status {
        Status {
            version: 1,
            stopping: false,
            agents,
        }
    }

    fn quit() -> [Entry; 2] {
        [Entry::Separator, Entry::does("Quit tray", Action::Quit)]
    }

    #[test]
    fn no_daemon_is_not_running() {
        let v = view(None, None);
        assert_eq!(v.icon, Icon::Stopped);
        assert_eq!(v.title, "Copland");
        assert_eq!(v.tooltip, ["not running"]);
        let mut menu = vec![Entry::note("The daemon isn't running")];
        menu.extend(quit());
        assert_eq!(v.menu, menu);
    }

    #[test]
    fn an_agent_watching_is_idle_and_can_be_held() {
        let v = view(Some(&status(vec![agent(1, "berker-z/dev")])), None);
        assert_eq!(v.icon, Icon::Idle);
        assert_eq!(v.tooltip, ["dev · idle"]);
        let mut menu = vec![Entry::does("Hold dev on this machine", Action::Hold { slot: 1 })];
        menu.extend(quit());
        assert_eq!(v.menu, menu);
    }

    #[test]
    fn held_alone_is_idle_and_can_be_released() {
        let mut a = agent(4, "berker-z/dev");
        a.held = true;
        let v = view(Some(&status(vec![a])), None);
        assert_eq!(v.icon, Icon::Idle);
        assert_eq!(v.tooltip, ["dev · idle · held"]);
        assert_eq!(
            v.menu[0],
            Entry::does("Release dev on this machine", Action::Release { slot: 4 })
        );
    }

    #[test]
    fn a_run_going_is_working_on_its_oldest_task_and_each_can_be_stopped() {
        let mut a = agent(2, "berker-z/dev");
        a.state = "running".into();
        a.runs = vec![run("aaaa", Some("COPL-166")), run("bbbb", None)];
        let mut b = agent(3, "berker-z/ops");
        b.state = "running".into();
        b.runs = vec![run("cccc", Some("COPL-12"))];
        let v = view(Some(&status(vec![a, b])), None);
        assert_eq!(v.icon, Icon::Working);
        assert_eq!(
            v.tooltip,
            ["dev · working on COPL-166 and 1 more", "ops · working on COPL-12"]
        );
        let mut menu = vec![
            Entry::does("Hold dev on this machine", Action::Hold { slot: 2 }),
            Entry::does(
                "Stop dev's run on COPL-166",
                Action::StopRun {
                    slot: 2,
                    run: "aaaa".into(),
                },
            ),
            Entry::does(
                "Stop dev's run on messages",
                Action::StopRun {
                    slot: 2,
                    run: "bbbb".into(),
                },
            ),
            Entry::Separator,
            Entry::does("Hold ops on this machine", Action::Hold { slot: 3 }),
            Entry::does(
                "Stop ops's run on COPL-12",
                Action::StopRun {
                    slot: 3,
                    run: "cccc".into(),
                },
            ),
        ];
        menu.extend(quit());
        assert_eq!(v.menu, menu);
    }

    #[test]
    fn needs_you_wins_over_working() {
        let mut a = agent(1, "berker-z/dev");
        a.state = "running".into();
        a.runs = vec![run("aaaa", Some("COPL-166"))];
        let mut b = agent(2, "berker-z/ops");
        b.needs = vec![Need {
            why: "failed".into(),
            says: "COPL-9 exit 1 after 3.8s".into(),
        }];
        let v = view(Some(&status(vec![a, b])), None);
        assert_eq!(v.icon, Icon::Needs);
        assert_eq!(
            v.tooltip,
            [
                "dev · working on COPL-166",
                "ops · idle · needs you: COPL-9 exit 1 after 3.8s"
            ]
        );
    }

    #[test]
    fn out_of_usage_says_until_when_and_is_not_a_need() {
        let mut a = agent(1, "berker-z/dev");
        a.out_of_usage_until = Some("2026-10-26T17:10:00Z".into());
        let v = view(Some(&status(vec![a])), None);
        assert_eq!(v.icon, Icon::Idle);
        assert_eq!(v.tooltip, ["dev · idle · out of usage until 17:10 UTC"]);
    }

    #[test]
    fn a_stopped_agent_and_a_stopping_daemon_say_so() {
        let mut a = agent(1, "dev");
        a.state = "stopped".into();
        let mut s = status(vec![a]);
        s.stopping = true;
        let v = view(Some(&s), None);
        assert_eq!(v.icon, Icon::Idle);
        assert_eq!(v.tooltip, ["stopping", "dev · stopped"]);
    }

    #[test]
    fn no_agents_is_idle() {
        let v = view(Some(&status(vec![])), None);
        assert_eq!(v.icon, Icon::Idle);
        assert_eq!(v.tooltip, ["no agents configured"]);
        let mut menu = vec![Entry::note("No agents configured")];
        menu.extend(quit());
        assert_eq!(v.menu, menu);
    }

    #[test]
    fn an_error_goes_in_the_tooltip_and_first_in_the_menu() {
        let v = view(
            Some(&status(vec![agent(1, "berker-z/dev")])),
            Some("no run zzzz going for @berker-z/dev (slot 1)"),
        );
        assert_eq!(
            v.tooltip,
            ["dev · idle", "× no run zzzz going for @berker-z/dev (slot 1)"]
        );
        assert_eq!(
            v.menu[..2],
            [
                Entry::note("× no run zzzz going for @berker-z/dev (slot 1)"),
                Entry::Separator
            ]
        );
        assert_eq!(view(None, Some("x")).icon, Icon::Stopped);
    }
}

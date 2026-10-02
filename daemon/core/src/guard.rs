//! What wakes an agent, and what must not wake it twice.
//!
//! The agent marks its inbox read itself, over the MCP. The daemon never
//! does, so it has to keep from relaunching on items a run has already seen
//! and left unread. The rules:
//!
//! - Items the agent wrote itself never wake it.
//! - Items without a task are logged and left alone (none exist yet).
//! - After a run on a task (or a claim refused), the daemon remembers which
//!   unread items it had and the task's `updatedAt` as the run left it. While
//!   the task's unread items are all ones it remembers and the task has not
//!   changed, it does not launch again. A new item, or a change to the task
//!   by anyone, wakes it.
//! - Once a task has no unread items, its memory is dropped.
//!
//! Memory is in-process: a restarted daemon launches once more for whatever
//! is still unread.

use std::collections::{HashMap, HashSet};

use crate::api::InboxItem;

/// A task with unread items for this agent: one possible wake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wake {
    pub task_id: String,
    pub task_key: String,
    /// The unread items, by id.
    pub items: Vec<String>,
    /// The oldest of them, which decides the order tasks are taken in.
    pub oldest: String,
}

#[derive(Debug, Default, Clone)]
pub struct Plan {
    /// Oldest first.
    pub wakes: Vec<Wake>,
    /// Items the agent wrote itself.
    pub own: Vec<String>,
    /// Items with no task, which nothing handles yet.
    pub taskless: Vec<String>,
}

/// Group unread items by task, leaving out the agent's own and those without a task.
pub fn plan(me: &str, items: &[InboxItem]) -> Plan {
    let mut plan = Plan::default();
    let mut by_task: HashMap<String, Wake> = HashMap::new();
    for item in items.iter().filter(|i| i.read_at.is_none()) {
        if item.actor.handle.eq_ignore_ascii_case(me) {
            plan.own.push(item.id.clone());
            continue;
        }
        let Some(task) = &item.task else {
            plan.taskless.push(item.id.clone());
            continue;
        };
        let wake = by_task.entry(task.id.clone()).or_insert_with(|| Wake {
            task_id: task.id.clone(),
            task_key: task.key.clone(),
            items: Vec::new(),
            oldest: item.created_at.clone(),
        });
        wake.items.push(item.id.clone());
        if item.created_at < wake.oldest {
            wake.oldest = item.created_at.clone();
        }
    }
    plan.wakes = by_task.into_values().collect();
    plan.wakes
        .sort_by(|a, b| a.oldest.cmp(&b.oldest).then_with(|| a.task_id.cmp(&b.task_id)));
    plan
}

#[derive(Debug, Clone)]
struct Memory {
    seen: HashSet<String>,
    /// The task as the last run left it; None when it could not be read.
    updated_at: Option<String>,
}

#[derive(Debug, Default)]
pub struct WakeGuard {
    tasks: HashMap<String, Memory>,
}

/// What the guard says about a wake before anything is fetched.
#[derive(Debug, PartialEq, Eq)]
pub enum Check {
    /// Something new: launch.
    New,
    /// Nothing but what a run already had. Launch only if the task changed since it was this.
    Seen { updated_at: Option<String> },
}

impl WakeGuard {
    pub fn check(&self, wake: &Wake) -> Check {
        match self.tasks.get(&wake.task_id) {
            Some(m) if wake.items.iter().all(|id| m.seen.contains(id)) => Check::Seen {
                updated_at: m.updated_at.clone(),
            },
            _ => Check::New,
        }
    }

    /// Whether a task seen before has changed: it has, unless both sides are known and equal.
    pub fn changed(remembered: &Option<String>, current: Option<&str>) -> bool {
        match (remembered, current) {
            (Some(was), Some(now)) => was != now,
            _ => true,
        }
    }

    /// After a run on the task, or a claim refused.
    pub fn remember(&mut self, wake: &Wake, updated_at: Option<String>) {
        let memory = self.tasks.entry(wake.task_id.clone()).or_insert_with(|| Memory {
            seen: HashSet::new(),
            updated_at: None,
        });
        memory.seen.extend(wake.items.iter().cloned());
        memory.updated_at = updated_at;
    }

    /// Forget tasks that have nothing unread any more.
    pub fn retain(&mut self, plan: &Plan) {
        let live: HashSet<&str> = plan.wakes.iter().map(|w| w.task_id.as_str()).collect();
        self.tasks.retain(|id, _| live.contains(id.as_str()));
    }

    pub fn remembered(&self) -> usize {
        self.tasks.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Actor, TaskRef};

    fn item(id: &str, task: Option<&str>, by: &str, at: &str) -> InboxItem {
        InboxItem {
            id: id.into(),
            kind: "commented".into(),
            task: task.map(|t| TaskRef {
                id: t.into(),
                key: t.to_uppercase(),
                title: String::new(),
            }),
            actor: Actor { handle: by.into() },
            via: None,
            created_at: at.into(),
            read_at: None,
        }
    }

    #[test]
    fn groups_by_task_oldest_first_and_drops_own_and_taskless() {
        let items = [
            item("i4", Some("b"), "sam", "2026-01-04T00:00:00.000Z"),
            item("i3", Some("a"), "sam", "2026-01-03T00:00:00.000Z"),
            item("i2", Some("b"), "sam", "2026-01-02T00:00:00.000Z"),
            item("i1", Some("a"), "Me/Dev", "2026-01-01T00:00:00.000Z"),
            item("i0", None, "sam", "2026-01-01T00:00:00.000Z"),
        ];
        let p = plan("me/dev", &items);
        assert_eq!(p.own, ["i1"]);
        assert_eq!(p.taskless, ["i0"]);
        let order: Vec<_> = p.wakes.iter().map(|w| (w.task_id.as_str(), w.items.len())).collect();
        assert_eq!(order, [("b", 2), ("a", 1)]);
    }

    #[test]
    fn own_items_alone_do_not_wake() {
        let p = plan("me/dev", &[item("i1", Some("a"), "me/dev", "2026-01-01T00:00:00.000Z")]);
        assert!(p.wakes.is_empty());
    }

    #[test]
    fn same_items_and_same_task_do_not_relaunch() {
        let p = plan("me/dev", &[item("i1", Some("a"), "sam", "2026-01-01T00:00:00.000Z")]);
        let mut g = WakeGuard::default();
        assert_eq!(g.check(&p.wakes[0]), Check::New);
        g.remember(&p.wakes[0], Some("t1".into()));
        let Check::Seen { updated_at } = g.check(&p.wakes[0]) else {
            panic!("should be seen")
        };
        assert!(!WakeGuard::changed(&updated_at, Some("t1")));
        assert!(WakeGuard::changed(&updated_at, Some("t2")));
        assert!(WakeGuard::changed(&updated_at, None));
        assert!(WakeGuard::changed(&None, Some("t1")));
    }

    #[test]
    fn a_newer_item_wakes_again() {
        let mut g = WakeGuard::default();
        let first = plan("me/dev", &[item("i1", Some("a"), "sam", "2026-01-01T00:00:00.000Z")]);
        g.remember(&first.wakes[0], Some("t1".into()));
        let second = plan(
            "me/dev",
            &[
                item("i2", Some("a"), "sam", "2026-01-02T00:00:00.000Z"),
                item("i1", Some("a"), "sam", "2026-01-01T00:00:00.000Z"),
            ],
        );
        assert_eq!(g.check(&second.wakes[0]), Check::New);
    }

    #[test]
    fn forgets_tasks_with_nothing_unread() {
        let mut g = WakeGuard::default();
        let p = plan("me/dev", &[item("i1", Some("a"), "sam", "2026-01-01T00:00:00.000Z")]);
        g.remember(&p.wakes[0], None);
        g.retain(&p);
        assert_eq!(g.remembered(), 1);
        g.retain(&Plan::default());
        assert_eq!(g.remembered(), 0);
    }
}

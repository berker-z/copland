//! What wakes an agent, and what must not wake it twice.
//!
//! The agent marks its inbox read itself, over the MCP. The daemon never
//! does, so it has to keep from relaunching on items a run has already seen
//! and left unread. The rules:
//!
//! - Items the agent wrote itself never wake it. "Itself" is the actor's id
//!   against the token's own (the handle only when a server sends no id).
//! - Items without a task are logged and left alone (none exist yet).
//! - After a run on a task (or a claim refused), the daemon remembers which
//!   unread items it had and the task's `updatedAt` as the run left it. While
//!   the task's unread items are all ones it remembers and the task has not
//!   changed, it does not launch again. A new item, or a change to the task
//!   by anyone, wakes it.
//! - A claim refused because another run holds the task is remembered as
//!   held: that task wakes again once it has no live claim (its run ended or
//!   went quiet), and not while it still has one, whatever else changes.
//! - Once a task has no unread items, its memory is dropped.
//!
//! Memory is in-process: a restarted daemon launches once more for whatever
//! is still unread.

use std::collections::{HashMap, HashSet};

use crate::api::InboxItem;
use crate::runner::Brief;

/// Who the agent is, as the server says: what its own items are told apart by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub id: String,
    pub handle: String,
}

impl Identity {
    /// Whether the agent itself did this. By id; by handle only when the item has no id.
    pub fn is(&self, item: &InboxItem) -> bool {
        match &item.actor.id {
            Some(id) => *id == self.id,
            None => item.actor.handle.eq_ignore_ascii_case(&self.handle),
        }
    }
}

/// A task with unread items for this agent: one possible wake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wake {
    pub task_id: String,
    pub task_key: String,
    /// The unread items, by id.
    pub items: Vec<String>,
    /// The oldest of them, which decides the order tasks are taken in.
    pub oldest: String,
    /// Someone @mentioned the agent in one of them.
    pub mentioned: bool,
    /// One of them is a comment (a mention is one too).
    pub commented: bool,
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
pub fn plan(me: &Identity, items: &[InboxItem]) -> Plan {
    let mut plan = Plan::default();
    let mut by_task: HashMap<String, Wake> = HashMap::new();
    for item in items.iter().filter(|i| i.read_at.is_none()) {
        if me.is(item) {
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
            mentioned: false,
            commented: false,
        });
        wake.items.push(item.id.clone());
        if item.created_at < wake.oldest {
            wake.oldest = item.created_at.clone();
        }
        wake.mentioned |= item.kind == "mentioned";
        wake.commented |= item.kind == "mentioned" || item.kind == "commented";
    }
    plan.wakes = by_task.into_values().collect();
    plan.wakes
        .sort_by(|a, b| a.oldest.cmp(&b.oldest).then_with(|| a.task_id.cmp(&b.task_id)));
    plan
}

/// What to do when the claim is refused, by the server's reason (its `code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Another run holds it: come back when that run ends.
    Hold,
    /// Launch anyway, without the claim, to answer what was said to the agent.
    Answer(Brief),
    /// Leave it until something new arrives.
    Skip,
}

/// Someone else's task is answered when it was discussed with the agent (a
/// mention or a comment); a closed one only when the agent was mentioned, so
/// chatter on finished work doesn't launch anything. A bare assignment the
/// agent has since lost is skipped.
pub fn refused(code: Option<&str>, wake: &Wake) -> Refused {
    match code {
        Some("claimed") => Refused::Hold,
        Some("assigned_elsewhere") if wake.mentioned => Refused::Answer(Brief::Mentioned),
        Some("assigned_elsewhere") if wake.commented => Refused::Answer(Brief::Commented),
        Some("closed") if wake.mentioned => Refused::Answer(Brief::Closed),
        _ => Refused::Skip,
    }
}

#[derive(Debug, Clone)]
struct Memory {
    seen: HashSet<String>,
    /// The task as the last run left it; None when it could not be read.
    updated_at: Option<String>,
    /// The last claim was refused because another run held it.
    held: bool,
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
    /// Nothing but what a run already had. Launch only if `again` says so, given the task as it is now.
    Seen { updated_at: Option<String>, held: bool },
}

/// The task as it is now, for a wake that was seen: its `updatedAt`, and whether a run holds it. None when it could not be read.
pub type Current<'a> = Option<(&'a str, bool)>;

impl WakeGuard {
    pub fn check(&self, wake: &Wake) -> Check {
        match self.tasks.get(&wake.task_id) {
            Some(m) if wake.items.iter().all(|id| m.seen.contains(id)) => Check::Seen {
                updated_at: m.updated_at.clone(),
                held: m.held,
            },
            _ => Check::New,
        }
    }

    /// Whether a task seen before has changed: it has, unless both sides are equal (two unknowns count as equal, so a task the agent cannot read does not relaunch every poll).
    pub fn changed(remembered: &Option<String>, current: Option<&str>) -> bool {
        remembered.as_deref() != current
    }

    /// Whether a seen task wakes again. One held by another run wakes once it has no live claim, and not before; any other once it changed.
    pub fn again(updated_at: &Option<String>, held: bool, current: Current<'_>) -> bool {
        if held {
            return matches!(current, Some((_, false)));
        }
        Self::changed(updated_at, current.map(|(at, _)| at))
    }

    /// After a run on the task, or a claim refused (`held` when another run had it).
    pub fn remember(&mut self, wake: &Wake, updated_at: Option<String>, held: bool) {
        let memory = self.tasks.entry(wake.task_id.clone()).or_insert_with(|| Memory {
            seen: HashSet::new(),
            updated_at: None,
            held: false,
        });
        memory.seen.extend(wake.items.iter().cloned());
        memory.updated_at = updated_at;
        memory.held = held;
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

    fn me() -> Identity {
        Identity {
            id: "u-me".into(),
            handle: "me/dev".into(),
        }
    }

    fn item(id: &str, task: Option<&str>, by: &str, at: &str) -> InboxItem {
        kind_item(id, "commented", task, by, at)
    }

    /// `by` is a handle; its id is "u-<by>", except the agent's own, "u-me".
    fn kind_item(id: &str, kind: &str, task: Option<&str>, by: &str, at: &str) -> InboxItem {
        let actor_id = if by.eq_ignore_ascii_case("me/dev") {
            "u-me".to_string()
        } else {
            format!("u-{by}")
        };
        InboxItem {
            id: id.into(),
            kind: kind.into(),
            task: task.map(|t| TaskRef {
                id: t.into(),
                key: t.to_uppercase(),
                title: String::new(),
            }),
            actor: Actor {
                id: Some(actor_id),
                handle: by.into(),
            },
            via: None,
            created_at: at.into(),
            read_at: None,
        }
    }

    fn one(kind: &str) -> Wake {
        plan(
            &me(),
            &[kind_item("i1", kind, Some("a"), "sam", "2026-01-01T00:00:00.000Z")],
        )
        .wakes[0]
            .clone()
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
        let p = plan(&me(), &items);
        assert_eq!(p.own, ["i1"]);
        assert_eq!(p.taskless, ["i0"]);
        let order: Vec<_> = p.wakes.iter().map(|w| (w.task_id.as_str(), w.items.len())).collect();
        assert_eq!(order, [("b", 2), ("a", 1)]);
    }

    #[test]
    fn own_items_alone_do_not_wake() {
        let p = plan(&me(), &[item("i1", Some("a"), "me/dev", "2026-01-01T00:00:00.000Z")]);
        assert!(p.wakes.is_empty());
    }

    #[test]
    fn own_is_by_id_not_handle() {
        /* Someone else who once had the handle (or a renamed agent): the id decides. */
        let mut theirs = item("i1", Some("a"), "sam", "2026-01-01T00:00:00.000Z");
        theirs.actor.handle = "me/dev".into();
        let mut mine = item("i2", Some("a"), "sam", "2026-01-02T00:00:00.000Z");
        mine.actor.id = Some("u-me".into());
        let p = plan(&me(), &[theirs, mine]);
        assert_eq!(p.own, ["i2"]);
        assert_eq!(p.wakes[0].items, ["i1"]);
    }

    #[test]
    fn own_falls_back_to_the_handle_without_an_id() {
        let mut old = item("i1", Some("a"), "Me/Dev", "2026-01-01T00:00:00.000Z");
        old.actor.id = None;
        let p = plan(&me(), &[old]);
        assert_eq!(p.own, ["i1"]);
    }

    #[test]
    fn same_items_and_same_task_do_not_relaunch() {
        let p = plan(&me(), &[item("i1", Some("a"), "sam", "2026-01-01T00:00:00.000Z")]);
        let mut g = WakeGuard::default();
        assert_eq!(g.check(&p.wakes[0]), Check::New);
        g.remember(&p.wakes[0], Some("t1".into()), false);
        let Check::Seen { updated_at, held } = g.check(&p.wakes[0]) else {
            panic!("should be seen")
        };
        assert!(!held);
        assert!(!WakeGuard::changed(&updated_at, Some("t1")));
        assert!(WakeGuard::changed(&updated_at, Some("t2")));
        assert!(WakeGuard::changed(&updated_at, None));
        assert!(WakeGuard::changed(&None, Some("t1")));
        assert!(!WakeGuard::changed(&None, None));
        assert!(!WakeGuard::again(&updated_at, held, Some(("t1", false))));
        assert!(WakeGuard::again(&updated_at, held, Some(("t2", true))));
    }

    #[test]
    fn a_newer_item_wakes_again() {
        let mut g = WakeGuard::default();
        let first = plan(&me(), &[item("i1", Some("a"), "sam", "2026-01-01T00:00:00.000Z")]);
        g.remember(&first.wakes[0], Some("t1".into()), false);
        let second = plan(
            &me(),
            &[
                item("i2", Some("a"), "sam", "2026-01-02T00:00:00.000Z"),
                item("i1", Some("a"), "sam", "2026-01-01T00:00:00.000Z"),
            ],
        );
        assert_eq!(g.check(&second.wakes[0]), Check::New);
    }

    #[test]
    fn a_held_task_wakes_when_its_claim_is_gone_and_not_before() {
        let mut g = WakeGuard::default();
        let w = one("commented");
        g.remember(&w, Some("t1".into()), true);
        let Check::Seen { updated_at, held } = g.check(&w) else {
            panic!("should be seen")
        };
        assert!(held);
        /* Still claimed: no, even though the holder moved it. */
        assert!(!WakeGuard::again(&updated_at, held, Some(("t1", true))));
        assert!(!WakeGuard::again(&updated_at, held, Some(("t2", true))));
        /* Unreadable: no. */
        assert!(!WakeGuard::again(&updated_at, held, None));
        /* The claim is gone, whether or not the task changed: yes. */
        assert!(WakeGuard::again(&updated_at, held, Some(("t1", false))));
        assert!(WakeGuard::again(&updated_at, held, Some(("t2", false))));
        /* A later attempt that was not held clears it. */
        g.remember(&w, Some("t3".into()), false);
        assert_eq!(
            g.check(&w),
            Check::Seen {
                updated_at: Some("t3".into()),
                held: false
            }
        );
    }

    #[test]
    fn refusals_by_reason() {
        assert_eq!(refused(Some("claimed"), &one("assigned")), Refused::Hold);
        assert_eq!(
            refused(Some("assigned_elsewhere"), &one("mentioned")),
            Refused::Answer(Brief::Mentioned)
        );
        assert_eq!(
            refused(Some("assigned_elsewhere"), &one("commented")),
            Refused::Answer(Brief::Commented)
        );
        assert_eq!(refused(Some("assigned_elsewhere"), &one("assigned")), Refused::Skip);
        assert_eq!(
            refused(Some("closed"), &one("mentioned")),
            Refused::Answer(Brief::Closed)
        );
        assert_eq!(refused(Some("closed"), &one("commented")), Refused::Skip);
        assert_eq!(refused(None, &one("mentioned")), Refused::Skip);
        assert_eq!(refused(Some("something_new"), &one("mentioned")), Refused::Skip);
    }

    #[test]
    fn a_mention_marks_the_wake() {
        let p = plan(
            &me(),
            &[
                kind_item("i1", "assigned", Some("a"), "sam", "2026-01-01T00:00:00.000Z"),
                kind_item("i2", "mentioned", Some("a"), "sam", "2026-01-02T00:00:00.000Z"),
            ],
        );
        assert!(p.wakes[0].mentioned && p.wakes[0].commented);
        assert!(!one("assigned").commented);
    }

    #[test]
    fn forgets_tasks_with_nothing_unread() {
        let mut g = WakeGuard::default();
        let p = plan(&me(), &[item("i1", Some("a"), "sam", "2026-01-01T00:00:00.000Z")]);
        g.remember(&p.wakes[0], None, false);
        g.retain(&p);
        assert_eq!(g.remembered(), 1);
        g.retain(&Plan::default());
        assert_eq!(g.remembered(), 0);
    }
}

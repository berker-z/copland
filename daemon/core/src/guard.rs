//! What wakes an agent, and what must not wake it twice.
//!
//! The agent marks its inbox read itself, over the MCP. The daemon never
//! does, so it has to keep from relaunching on items a run has already seen
//! and left unread. The rules:
//!
//! - Items the agent wrote itself never wake it. "Itself" is the actor's id
//!   against the token's own (the handle only when a server sends no id).
//! - A message (COPL-106) about a task joins that task's wake like a mention
//!   does, and the run's prompt quotes it.
//! - Task-less messages are woken for together: one run, in the shared
//!   workdir and without a claim, for those no run has had yet, oldest first
//!   (`MESSAGES_PER_RUN` at most; the rest go to the next). The guard
//!   remembers each by its item id once a run has had it, so one a run left
//!   unread never launches another; a new message does. Any other task-less
//!   item is logged and left alone (none exist).
//! - After a run on a task (or a claim refused), the daemon remembers which
//!   unread items it had and the task's `updatedAt` as the run left it. While
//!   the task's unread items are all ones it remembers and the task has not
//!   changed, it does not launch again. A new item, or a change to the task
//!   by anyone, wakes it.
//! - A claim refused because another run holds the task is remembered as
//!   held: that task wakes again once it has no live claim (its run ended or
//!   went quiet), and not while it still has one, whatever else changes.
//! - Once a task has no unread items, its memory is dropped; so is that of a
//!   task-less message once it is read.
//! - Nothing reaches a run once it has started: what arrives while one is
//!   going waits for the next.
//!
//! Memory is in-process: a restarted daemon launches once more for whatever
//! is still unread.

use std::collections::{HashMap, HashSet};

use crate::api::{InboxItem, ReadyTask};
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

/// The most task-less messages one run is given; the rest wait for the next.
pub const MESSAGES_PER_RUN: usize = 20;

/// A message sent to the agent (COPL-106), as a run's prompt quotes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// The inbox item, for mark_read.
    pub item: String,
    /// The message, for send_message's reply_to.
    pub id: String,
    /// The sender's handle.
    pub from: String,
    /// From the agent's owner (their request), or someone else's (untrusted, like a comment).
    pub trusted: bool,
    pub text: String,
    pub at: String,
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
    /// Someone @mentioned the agent in one of them, or messaged it about the task.
    pub mentioned: bool,
    /// One of them is a comment (a mention or a message is one too).
    pub commented: bool,
    /// The messages among them, oldest first, for the prompt.
    pub messages: Vec<Message>,
}

#[derive(Debug, Default, Clone)]
pub struct Plan {
    /// Oldest first.
    pub wakes: Vec<Wake>,
    /// Items the agent wrote itself.
    pub own: Vec<String>,
    /// Unread messages that point at no task, oldest first.
    pub messages: Vec<Message>,
    /// Other items with no task, which nothing handles.
    pub taskless: Vec<String>,
}

/// The message an item carries, when it is one.
fn message(item: &InboxItem) -> Option<Message> {
    let m = item.message.as_ref().filter(|_| item.kind == "message")?;
    Some(Message {
        item: item.id.clone(),
        id: m.id.clone(),
        from: item.actor.handle.trim_start_matches('@').to_string(),
        trusted: m.trusted,
        text: m.text.clone(),
        at: item.created_at.clone(),
    })
}

fn oldest_first(messages: &mut [Message]) {
    messages.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.item.cmp(&b.item)));
}

/// Group unread items by task, leaving out the agent's own and those without a task.
/// Add the tasks the agent can start now (GET /api/tasks/ready) to the plan, as wakes with no
/// items: nothing was said, the task is simply ready. One already woken by its inbox stays as it
/// is. The guard treats them like any other: a task a run already had wakes again only once it changed.
pub fn add_ready(plan: &mut Plan, ready: &[ReadyTask]) {
    for r in ready {
        if plan.wakes.iter().any(|w| w.task_id == r.id) {
            continue;
        }
        plan.wakes.push(Wake {
            task_id: r.id.clone(),
            task_key: r.key.clone(),
            items: Vec::new(),
            oldest: r.updated_at.clone(),
            mentioned: false,
            commented: false,
            messages: Vec::new(),
        });
    }
    plan.wakes
        .sort_by(|a, b| a.oldest.cmp(&b.oldest).then_with(|| a.task_id.cmp(&b.task_id)));
}

pub fn plan(me: &Identity, items: &[InboxItem]) -> Plan {
    let mut plan = Plan::default();
    let mut by_task: HashMap<String, Wake> = HashMap::new();
    for item in items.iter().filter(|i| i.read_at.is_none()) {
        if me.is(item) {
            plan.own.push(item.id.clone());
            continue;
        }
        let message = message(item);
        let Some(task) = &item.task else {
            match message {
                Some(m) => plan.messages.push(m),
                None => plan.taskless.push(item.id.clone()),
            }
            continue;
        };
        let wake = by_task.entry(task.id.clone()).or_insert_with(|| Wake {
            task_id: task.id.clone(),
            task_key: task.key.clone(),
            items: Vec::new(),
            oldest: item.created_at.clone(),
            mentioned: false,
            commented: false,
            messages: Vec::new(),
        });
        wake.items.push(item.id.clone());
        if item.created_at < wake.oldest {
            wake.oldest = item.created_at.clone();
        }
        /* A message is said to the agent directly, as much as a mention is. */
        let direct = item.kind == "mentioned" || item.kind == "message";
        wake.mentioned |= direct;
        wake.commented |= direct || item.kind == "commented";
        wake.messages.extend(message);
    }
    oldest_first(&mut plan.messages);
    plan.wakes = by_task
        .into_values()
        .map(|mut w| {
            oldest_first(&mut w.messages);
            w
        })
        .collect();
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
        /* Waiting on tasks that aren't done: answer what was said, but those closing is what lets it start. */
        Some("waiting") if wake.mentioned || wake.commented => Refused::Answer(Brief::Waiting),
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
    /// Task-less messages a run has had, by item id.
    messages: HashSet<String>,
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

    /// The task-less messages no run has had yet, oldest first, at most `MESSAGES_PER_RUN`: the
    /// next message run's batch. Empty when there is nothing new, whatever is still unread.
    pub fn new_messages(&self, plan: &Plan) -> Vec<Message> {
        plan.messages
            .iter()
            .filter(|m| !self.messages.contains(&m.item))
            .take(MESSAGES_PER_RUN)
            .cloned()
            .collect()
    }

    /// After a run had these task-less messages: they never launch another.
    pub fn remember_messages(&mut self, batch: &[Message]) {
        self.messages.extend(batch.iter().map(|m| m.item.clone()));
    }

    /// Whether a run has had this message, task-less or about a task.
    pub fn had(&self, task_id: Option<&str>, item: &str) -> bool {
        match task_id {
            None => self.messages.contains(item),
            Some(t) => self.tasks.get(t).is_some_and(|m| m.seen.contains(item)),
        }
    }

    /// Forget tasks that have nothing unread any more, and task-less messages that were read.
    pub fn retain(&mut self, plan: &Plan) {
        let live: HashSet<&str> = plan.wakes.iter().map(|w| w.task_id.as_str()).collect();
        self.tasks.retain(|id, _| live.contains(id.as_str()));
        let unread: HashSet<&str> = plan.messages.iter().map(|m| m.item.as_str()).collect();
        self.messages.retain(|id| unread.contains(id.as_str()));
    }

    pub fn remembered(&self) -> usize {
        self.tasks.len() + self.messages.len()
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
            message: None,
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
            refused(Some("waiting"), &one("mentioned")),
            Refused::Answer(Brief::Waiting)
        );
        assert_eq!(refused(Some("waiting"), &one("assigned")), Refused::Skip);
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

    fn ready(id: &str, key: &str, at: &str) -> ReadyTask {
        ReadyTask {
            id: id.into(),
            key: key.into(),
            board_id: "b".into(),
            updated_at: at.into(),
        }
    }

    #[test]
    fn ready_work_wakes_without_inbox_items_once_until_it_changes() {
        let mut p = Plan::default();
        p.wakes.push(Wake {
            task_id: "t1".into(),
            task_key: "T-1".into(),
            items: vec!["i1".into()],
            oldest: "2026-10-03T10:00:00Z".into(),
            mentioned: false,
            commented: false,
            messages: Vec::new(),
        });
        add_ready(
            &mut p,
            &[
                ready("t1", "T-1", "2026-10-03T09:00:00Z"),
                ready("t2", "T-2", "2026-10-03T08:00:00Z"),
            ],
        );
        /* The inbox wake stays as it was; the ready one joins, oldest first. */
        assert_eq!(
            p.wakes.iter().map(|w| w.task_key.as_str()).collect::<Vec<_>>(),
            ["T-2", "T-1"]
        );
        assert_eq!(p.wakes[1].items, ["i1"]);
        let pulled = p.wakes[0].clone();
        assert!(pulled.items.is_empty());

        let mut g = WakeGuard::default();
        assert_eq!(g.check(&pulled), Check::New);
        g.remember(&pulled, Some("u1".into()), false);
        let Check::Seen { updated_at, held } = g.check(&pulled) else {
            panic!("a pulled task a run had is seen");
        };
        assert!(!WakeGuard::again(&updated_at, held, Some(("u1", false))));
        assert!(WakeGuard::again(&updated_at, held, Some(("u2", false))));
    }

    fn msg(id: &str, task: Option<&str>, by: &str, at: &str, trusted: bool) -> InboxItem {
        let mut i = kind_item(id, "message", task, by, at);
        i.message = Some(crate::api::InboxMessage {
            id: format!("m-{id}"),
            text: format!("text of {id}"),
            trusted,
        });
        i
    }

    #[test]
    fn taskless_messages_are_planned_oldest_first_apart_from_tasks() {
        let p = plan(
            &me(),
            &[
                msg("i3", None, "sam", "2026-01-03T00:00:00.000Z", false),
                msg("i2", None, "me/dev", "2026-01-02T00:00:00.000Z", true),
                msg("i1", None, "boss", "2026-01-01T00:00:00.000Z", true),
                /* A message kind without its payload (it can't be quoted): left alone, like any task-less item. */
                kind_item("i0", "message", None, "boss", "2026-01-01T00:00:00.000Z"),
            ],
        );
        assert!(p.wakes.is_empty());
        assert_eq!(p.own, ["i2"]);
        assert_eq!(p.taskless, ["i0"]);
        let got: Vec<_> = p
            .messages
            .iter()
            .map(|m| (m.item.as_str(), m.id.as_str(), m.from.as_str(), m.trusted))
            .collect();
        assert_eq!(got, [("i1", "m-i1", "boss", true), ("i3", "m-i3", "sam", false)]);
        assert_eq!(p.messages[0].text, "text of i1");
    }

    #[test]
    fn a_message_about_a_task_joins_its_wake_as_a_mention() {
        let p = plan(
            &me(),
            &[
                msg("i2", Some("a"), "boss", "2026-01-02T00:00:00.000Z", true),
                kind_item("i1", "assigned", Some("a"), "boss", "2026-01-01T00:00:00.000Z"),
            ],
        );
        assert!(p.messages.is_empty());
        let w = &p.wakes[0];
        assert_eq!(w.items, ["i2", "i1"]);
        assert!(w.mentioned && w.commented);
        assert_eq!(w.messages.len(), 1);
        assert_eq!(w.messages[0].id, "m-i2");
        /* So a task that isn't the agent's, or is closed, is still answered. */
        assert_eq!(refused(Some("closed"), w), Refused::Answer(Brief::Closed));
        assert_eq!(
            refused(Some("assigned_elsewhere"), w),
            Refused::Answer(Brief::Mentioned)
        );
    }

    #[test]
    fn a_taskless_message_a_run_had_never_launches_another() {
        let mut g = WakeGuard::default();
        let first = plan(&me(), &[msg("i1", None, "boss", "2026-01-01T00:00:00.000Z", true)]);
        let batch = g.new_messages(&first);
        assert_eq!(batch.len(), 1);
        assert!(!g.had(None, "i1"));
        g.remember_messages(&batch);
        assert!(g.had(None, "i1"));
        /* Left unread by the run: nothing new, no run. */
        g.retain(&first);
        assert!(g.new_messages(&first).is_empty());
        /* A new one arrives: a run for it alone. */
        let second = plan(
            &me(),
            &[
                msg("i2", None, "boss", "2026-01-02T00:00:00.000Z", true),
                msg("i1", None, "boss", "2026-01-01T00:00:00.000Z", true),
            ],
        );
        let batch = g.new_messages(&second);
        assert_eq!(batch.iter().map(|m| m.item.as_str()).collect::<Vec<_>>(), ["i2"]);
        /* Once read, it is forgotten. */
        g.retain(&Plan::default());
        assert_eq!(g.remembered(), 0);
    }

    #[test]
    fn a_message_batch_is_capped_and_the_rest_waits() {
        let items: Vec<_> = (0..MESSAGES_PER_RUN + 3)
            .map(|n| {
                msg(
                    &format!("i{n:02}"),
                    None,
                    "boss",
                    &format!("2026-01-01T00:00:{n:02}.000Z"),
                    true,
                )
            })
            .collect();
        let p = plan(&me(), &items);
        let mut g = WakeGuard::default();
        let first = g.new_messages(&p);
        assert_eq!(first.len(), MESSAGES_PER_RUN);
        assert_eq!(first[0].item, "i00");
        g.remember_messages(&first);
        let rest = g.new_messages(&p);
        assert_eq!(
            rest.iter().map(|m| m.item.as_str()).collect::<Vec<_>>(),
            ["i20", "i21", "i22"]
        );
    }

    #[test]
    fn a_task_message_a_run_had_is_known() {
        let mut g = WakeGuard::default();
        let p = plan(&me(), &[msg("i1", Some("a"), "boss", "2026-01-01T00:00:00.000Z", true)]);
        assert!(!g.had(Some("a"), "i1"));
        g.remember(&p.wakes[0], None, false);
        assert!(g.had(Some("a"), "i1"));
        assert!(!g.had(None, "i1"));
    }
}

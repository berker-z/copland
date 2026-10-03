//! What needs you, and telling you once (COPL-64).
//!
//! Two things need the owner: a task of their agents' that has gone to a
//! blocked stage (from `/api/wired`), and an unread item in their own inbox
//! that @mentions them (`GET /api/inbox?unread=true` with their read-only
//! token). The bell in the title bar counts both and lists them; each opens its
//! task. Nothing else is a need: routine moves, comments, assignments to the
//! agents are the scene's business, not the bell's.
//!
//! A desktop notification fires once per need. What has been notified is kept
//! in `$XDG_STATE_HOME/copland/notified.toml`, so a restart doesn't repeat it,
//! and an id is forgotten once its need is gone (unblocked, read), so a task
//! that is blocked again later is a new need. The very first time (no file
//! yet), what is already there is taken as seen, not announced in a burst.
//! Several new at once are one notification. No sound: the notification says
//! so (`suppress-sound`), and the box never plays one.
//!
//! On Linux the notifications go over D-Bus to `org.freedesktop.Notifications`
//! (zbus, which GPUI already brings), with a default action, so clicking one
//! opens its task. Elsewhere they are not sent yet; the bell still works.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::feed::Feed;
use crate::view::task_link;

/// Why something needs you.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Why {
    /// One of your agents' tasks is in a blocked stage: waiting on a person.
    Blocked,
    /// Someone @mentioned you; the inbox item is unread.
    Mentioned,
}

impl Why {
    fn prefix(self) -> &'static str {
        match self {
            Why::Blocked => "blocked:",
            Why::Mentioned => "mention:",
        }
    }
}

/// One thing that needs you.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Need {
    /// What it is remembered by: the task for a block, the inbox item for a mention.
    pub id: String,
    pub why: Why,
    /// "COPL-12".
    pub key: String,
    pub title: String,
    /// The agent that is blocked, or who mentioned you.
    pub who: String,
    /// The task's page.
    pub link: Option<String>,
}

/// What the bell counts and lists: what needs you, or nothing without the owner's feed. Not
/// narrowed by the boards filter, which is about the scene: a block anywhere still needs you.
pub fn needs_shown(feed: Option<&Feed>) -> Vec<Need> {
    feed.map(needs).unwrap_or_default()
}

/// What needs you in the feed, blocked first (oldest change first), then mentions (newest
/// first), one per task and reason. Empty for what hasn't been read yet.
pub fn needs(feed: &Feed) -> Vec<Need> {
    let mut out = Vec::new();
    if let Some((w, _)) = &feed.wired {
        let agent = |id: &str| {
            w.agents
                .iter()
                .find(|a| a.id == id)
                .map_or_else(|| "an agent".to_string(), |a| a.name.clone())
        };
        for t in &w.blocked {
            out.push(Need {
                id: format!("{}{}", Why::Blocked.prefix(), t.id),
                why: Why::Blocked,
                key: t.key.clone(),
                title: t.title.clone(),
                who: agent(&t.agent_id),
                link: task_link(&feed.url, &t.key),
            });
        }
    }
    let mut seen: HashSet<String> = HashSet::new();
    for m in feed.mentions.iter().flatten() {
        let Some(task) = &m.task else { continue };
        if m.kind != "mentioned" || !seen.insert(task.key.clone()) {
            continue;
        }
        out.push(Need {
            id: format!("{}{}", Why::Mentioned.prefix(), m.id),
            why: Why::Mentioned,
            key: task.key.clone(),
            title: task.title.clone(),
            who: m.actor.handle.trim_start_matches('@').to_string(),
            link: task_link(&feed.url, &task.key),
        });
    }
    out
}

/// What has been notified, by need id. Kept across restarts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Memory {
    #[serde(default)]
    pub notified: Vec<String>,
}

/// More than this many new at once are one notification.
const BURST: usize = 3;

impl Memory {
    /// The needs not notified yet, remembered from now on. `read` are the kinds the feed has
    /// actually read: an id of one of those that is no longer a need is forgotten, so it can
    /// come back as a new one; the others' are kept until they are read.
    pub fn fresh(&mut self, now: &[Need], read: &[Why]) -> Vec<Need> {
        let current: HashSet<&str> = now.iter().map(|n| n.id.as_str()).collect();
        self.notified.retain(|id| {
            let kind_read = read.iter().any(|w| id.starts_with(w.prefix()));
            !kind_read || current.contains(id.as_str())
        });
        let mut out = Vec::new();
        for n in now {
            if read.contains(&n.why) && !self.notified.contains(&n.id) {
                self.notified.push(n.id.clone());
                out.push(n.clone());
            }
        }
        out
    }

    pub fn load(path: &Path) -> Option<Memory> {
        let text = std::fs::read_to_string(path).ok()?;
        Some(toml::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!("{}: {e}; starting it again", path.display());
            Memory::default()
        }))
    }

    pub fn save(&self, path: &Path) {
        let text = format!(
            "# What copland-box has told you about, so it doesn't again. Safe to delete.\n{}",
            toml::to_string(self).unwrap_or_default()
        );
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(path, text));
        if let Err(e) = written {
            tracing::warn!("keeping what was notified in {}: {e}", path.display());
        }
    }
}

/// `$XDG_STATE_HOME/copland/notified.toml`.
pub fn memory_path() -> PathBuf {
    copland_daemon_core::config::default_state_dir().join("notified.toml")
}

/// One desktop notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub summary: String,
    pub body: String,
    /// Opened when it is clicked.
    pub link: Option<String>,
}

/// What to say about `fresh` needs: one note each, or one for the lot when there are many.
pub fn notes(fresh: &[Need]) -> Vec<Note> {
    let one = |n: &Need| Note {
        summary: match n.why {
            Why::Blocked => format!("{} is blocked", n.key),
            Why::Mentioned => format!("@{} mentioned you on {}", n.who, n.key),
        },
        body: match n.why {
            Why::Blocked => format!("{} · {} is waiting on you", n.title, n.who),
            Why::Mentioned => n.title.clone(),
        },
        link: n.link.clone(),
    };
    if fresh.len() <= BURST {
        return fresh.iter().map(one).collect();
    }
    vec![Note {
        summary: format!("{} things need you", fresh.len()),
        body: fresh.iter().map(|n| n.key.as_str()).collect::<Vec<_>>().join(" "),
        link: fresh[0].link.clone(),
    }]
}

/// Decides what to notify after each read of the feed: the memory, loaded once, and whether
/// this is the first time ever (then what is there is only remembered).
pub struct Notifier {
    path: PathBuf,
    memory: Option<Memory>,
    loaded: bool,
}

impl Notifier {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            memory: None,
            loaded: false,
        }
    }

    /// The notes for what is new in `feed` since anything was said, remembered either way.
    /// Nothing until both kinds have been read once, so a first read of one kind doesn't
    /// count the other as gone.
    pub fn check(&mut self, feed: &Feed) -> Vec<Note> {
        let mut read = Vec::new();
        if feed.wired.is_some() {
            read.push(Why::Blocked);
        }
        if feed.mentions.is_some() {
            read.push(Why::Mentioned);
        }
        if read.is_empty() {
            return Vec::new();
        }
        if !self.loaded {
            self.loaded = true;
            self.memory = Memory::load(&self.path);
        }
        let now = needs(feed);
        let first = self.memory.is_none();
        let memory = self.memory.get_or_insert_with(Memory::default);
        let before = memory.clone();
        let fresh = memory.fresh(&now, &read);
        if *memory != before {
            memory.save(&self.path);
        }
        if first {
            if !fresh.is_empty() {
                tracing::info!("{} thing(s) need you already; the bell has them", fresh.len());
            }
            return Vec::new();
        }
        notes(&fresh)
    }
}

/// `&`, `<` and `>` escaped: a notification body may be read as markup.
fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Sends desktop notifications and reports which link a clicked one opens.
#[derive(Clone)]
pub struct Desktop {
    tx: std::sync::mpsc::Sender<Note>,
}

impl Desktop {
    /// Start the notifier's thread. A clicked notification's link goes to `clicked`.
    pub fn start(clicked: tokio::sync::mpsc::UnboundedSender<String>) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<Note>();
        imp::start(rx, clicked);
        Self { tx }
    }

    pub fn send(&self, note: Note) {
        let _ = self.tx.send(note);
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::HashMap;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};

    use zbus::export::futures_core::Stream;
    use zbus::zvariant::Value;
    use zbus::{Connection, Proxy};

    use super::{Note, escape};

    const DEST: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    /// Links of the notifications still out, at most this many.
    const KEEP: usize = 64;

    async fn proxy(conn: &Connection) -> zbus::Result<Proxy<'static>> {
        Proxy::new(conn, DEST, PATH, DEST).await
    }

    /// One thread sends what it is given; another waits for clicks. Both on zbus's own
    /// async-io executor, apart from GPUI's and the daemon's.
    pub fn start(rx: std::sync::mpsc::Receiver<Note>, clicked: tokio::sync::mpsc::UnboundedSender<String>) {
        let conn = match zbus::block_on(Connection::session()) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("desktop notifications: no session bus ({e}); the bell still counts");
                return;
            }
        };
        let links: Arc<Mutex<Vec<(u32, String)>>> = Arc::default();
        let (c, l) = (conn.clone(), links.clone());
        let sent = std::thread::Builder::new().name("notify".into()).spawn(move || {
            let Ok(p) = zbus::block_on(proxy(&c)) else { return };
            while let Ok(note) = rx.recv() {
                let mut hints: HashMap<&str, Value> = HashMap::new();
                hints.insert("desktop-entry", Value::from(crate::APP_ID));
                hints.insert("suppress-sound", Value::from(true));
                hints.insert("urgency", Value::from(1u8));
                let actions: Vec<&str> = if note.link.is_some() {
                    vec!["default", "Open"]
                } else {
                    vec![]
                };
                let body = (
                    "Copland",
                    0u32,
                    crate::APP_ID,
                    note.summary.as_str(),
                    escape(&note.body),
                    actions,
                    hints,
                    -1i32,
                );
                match zbus::block_on(p.call::<_, _, u32>("Notify", &body)) {
                    Ok(id) => {
                        if let Some(link) = note.link {
                            let mut l = l.lock().expect("not poisoned");
                            l.push((id, link));
                            let over = l.len().saturating_sub(KEEP);
                            l.drain(..over);
                        }
                    }
                    Err(e) => tracing::warn!("desktop notification: {e}"),
                }
            }
        });
        let clicks = std::thread::Builder::new().name("notify-clicks".into()).spawn(move || {
            zbus::block_on(async move {
                let Ok(p) = proxy(&conn).await else { return };
                let Ok(mut signals) = p.receive_signal("ActionInvoked").await else {
                    return;
                };
                /* zbus's own re-export of the Stream trait, so no stream crate of ours. */
                while let Some(msg) = std::future::poll_fn(|cx| Pin::new(&mut signals).poll_next(cx)).await {
                    let Ok((id, action)) = msg.body().deserialize::<(u32, String)>() else {
                        continue;
                    };
                    if action != "default" {
                        continue;
                    }
                    let link = links
                        .lock()
                        .expect("not poisoned")
                        .iter()
                        .find(|(i, _)| *i == id)
                        .map(|(_, l)| l.clone());
                    if let Some(link) = link {
                        let _ = clicked.send(link);
                    }
                }
            })
        });
        if let Err(e) = sent.and(clicks) {
            tracing::warn!("desktop notifications: {e}");
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::Note;

    /// TODO(macOS): UNUserNotificationCenter needs a signed app bundle; until the box has one,
    /// notes are dropped and the bell is the only notice.
    pub fn start(rx: std::sync::mpsc::Receiver<Note>, _clicked: tokio::sync::mpsc::UnboundedSender<String>) {
        std::thread::spawn(move || while rx.recv().is_ok() {});
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use copland_daemon_core::api::{Actor, InboxItem, TaskRef, Wired, WiredAgent, WiredTask};

    fn blocked(id: &str, key: &str) -> WiredTask {
        WiredTask {
            id: id.into(),
            board_id: "b".into(),
            key: key.into(),
            title: format!("{key} title"),
            agent_id: "a1".into(),
            since: None,
            live: false,
        }
    }

    fn mention(id: &str, key: &str, kind: &str) -> InboxItem {
        InboxItem {
            id: id.into(),
            kind: kind.into(),
            task: Some(TaskRef {
                id: key.to_lowercase(),
                key: key.into(),
                title: format!("{key} title"),
            }),
            actor: Actor {
                id: Some("u2".into()),
                handle: "sam".into(),
            },
            via: None,
            message: None,
            created_at: "2026-10-03T10:00:00Z".into(),
            read_at: None,
        }
    }

    fn feed(blocked_tasks: Vec<WiredTask>, mentions: Option<Vec<InboxItem>>) -> Feed {
        Feed {
            url: "http://x".into(),
            wired: Some((
                Wired {
                    agents: vec![WiredAgent {
                        id: "a1".into(),
                        handle: "me/dev".into(),
                        name: "dev".into(),
                        paused: false,
                    }],
                    todo: vec![],
                    doing: vec![],
                    blocked: blocked_tasks,
                    done: vec![],
                    done_count: 0,
                    done_window_hours: 24,
                },
                std::time::SystemTime::now(),
            )),
            mentions,
            ..Default::default()
        }
    }

    #[test]
    fn needs_are_blocked_tasks_and_mentions_of_you() {
        let f = feed(
            vec![blocked("t1", "COPL-1")],
            Some(vec![
                mention("i1", "COPL-2", "mentioned"),
                mention("i2", "COPL-2", "mentioned"),
            ]),
        );
        let n = needs(&f);
        assert_eq!(n.len(), 2);
        assert_eq!((n[0].why, n[0].who.as_str()), (Why::Blocked, "dev"));
        assert_eq!(n[0].link.as_deref(), Some("http://x/b/COPL?task=COPL-1"));
        assert_eq!((n[1].why, n[1].id.as_str()), (Why::Mentioned, "mention:i1"));
    }

    #[test]
    fn says_each_thing_once_and_again_only_when_it_comes_back() {
        let mut m = Memory::default();
        let both = [Why::Blocked, Why::Mentioned];
        let f = feed(
            vec![blocked("t1", "COPL-1")],
            Some(vec![mention("i1", "COPL-2", "mentioned")]),
        );
        assert_eq!(m.fresh(&needs(&f), &both).len(), 2);
        /* The same again: nothing. */
        assert!(m.fresh(&needs(&f), &both).is_empty());
        /* A new mention: only that. */
        let f2 = feed(
            vec![blocked("t1", "COPL-1")],
            Some(vec![
                mention("i1", "COPL-2", "mentioned"),
                mention("i3", "COPL-3", "mentioned"),
            ]),
        );
        let fresh = m.fresh(&needs(&f2), &both);
        assert_eq!(fresh.iter().map(|n| n.key.as_str()).collect::<Vec<_>>(), ["COPL-3"]);
        /* Unblocked, then blocked again: a new need. */
        let unblocked = feed(vec![], Some(vec![]));
        assert!(m.fresh(&needs(&unblocked), &both).is_empty());
        assert!(m.notified.is_empty());
        assert_eq!(m.fresh(&needs(&f), &both).len(), 2);
        /* Mentions not read this time: theirs are kept, not forgotten. */
        let no_inbox = feed(vec![blocked("t1", "COPL-1")], None);
        assert!(m.fresh(&needs(&no_inbox), &[Why::Blocked]).is_empty());
        assert!(m.notified.contains(&"mention:i1".to_string()));
    }

    #[test]
    fn survives_a_restart_and_starts_quietly_the_first_time() {
        let dir = std::env::temp_dir().join(format!("copland-notify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("notified.toml");
        let f = feed(
            vec![blocked("t1", "COPL-1")],
            Some(vec![mention("i1", "COPL-2", "mentioned")]),
        );

        /* First ever: what is there is remembered, not announced. */
        let mut n = Notifier::new(path.clone());
        assert!(n.check(&f).is_empty());
        assert!(path.exists());

        /* After a restart: still nothing for those; a new one is said. */
        let mut n = Notifier::new(path.clone());
        assert!(n.check(&f).is_empty());
        let f2 = feed(
            vec![blocked("t1", "COPL-1"), blocked("t2", "COPL-4")],
            Some(vec![mention("i1", "COPL-2", "mentioned")]),
        );
        let notes = n.check(&f2);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].summary, "COPL-4 is blocked");
        assert_eq!(notes[0].body, "COPL-4 title · dev is waiting on you");
        assert_eq!(notes[0].link.as_deref(), Some("http://x/b/COPL?task=COPL-4"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn many_at_once_are_one_note() {
        let many: Vec<Need> = (1..=5)
            .map(|i| Need {
                id: format!("blocked:t{i}"),
                why: Why::Blocked,
                key: format!("T-{i}"),
                title: "x".into(),
                who: "dev".into(),
                link: Some(format!("http://x/b/T?task=T-{i}")),
            })
            .collect();
        let n = notes(&many);
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].summary, "5 things need you");
        assert_eq!(n[0].body, "T-1 T-2 T-3 T-4 T-5");
        assert_eq!(notes(&many[..3]).len(), 3);
        assert_eq!(notes(&many[..1])[0].summary, "T-1 is blocked");
        assert_eq!(escape("a <b> & c"), "a &lt;b&gt; &amp; c");
    }
}

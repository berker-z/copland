//! The menu (COPL-65): ≡ in the title bar, or `m`, opens small panels under the
//! poles, one at a time, named across the title bar. The bell (COPL-64) opens
//! the first of them, what needs you.
//!
//! - **needs you**: your agents' blocked tasks and your unread mentions; each opens its task.
//! - **agents**: the agents screen (`agents.rs`), which `a` still opens directly.
//! - **boards**: which boards' tickets the box shows (`boards = [...]`, all by default). Display
//!   only: the agents still wake for anything on any board.
//! - **settings**: theme (one of the seven, or "copland", your own theme there), motion,
//!   desktop notifications, start at login, compact.
//! - **session**: who the box is signed in as, and on which Copland; signing out.
//! - **about**: this version, and whether a newer box has been released.
//!
//! Every panel takes keys and clicks alike: a line's click is a key its handler already takes.
//! Settings and boards apply at once and are written to daemon.toml when the menu closes,
//! once, through `edit.rs` (comments kept, the old file kept as a backup). Start at login is a
//! file of its own and is written as it is switched.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Result;
use copland_daemon_core::DaemonState;
use copland_daemon_core::api::Api;
use copland_daemon_core::config::{Secret, expand_home};
use gpui::{Context, Task};

use crate::agents::{Agents, Control, Key};
use crate::edit;
use crate::feed::Feed;
use crate::notify::{self, Why};
use crate::prefs::{self, Checked};
use crate::scene::{Line, Role, Span};
use crate::setup;
use crate::theme::Theme;
use crate::view::BoxView;
use crate::wizard::{Panel, key};

/// Rows a panel lists at once; the rest scroll with the selection.
const ROWS: usize = 4;

/// "copland" for a theme: the one you chose in Copland's settings, read with your token.
pub const FOLLOW: &str = "copland";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Needs,
    Agents,
    Boards,
    Settings,
    Session,
    About,
}

impl Tab {
    pub const ALL: [Tab; 6] = [
        Tab::Needs,
        Tab::Agents,
        Tab::Boards,
        Tab::Settings,
        Tab::Session,
        Tab::About,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Tab::Needs => "needs you",
            Tab::Agents => "agents",
            Tab::Boards => "boards",
            Tab::Settings => "settings",
            Tab::Session => "session",
            Tab::About => "about",
        }
    }
}

/// The box's own settings, as daemon.toml has them and as the window uses them now.
#[derive(Debug, Clone)]
pub struct Prefs {
    /// One of the seven themes, or `FOLLOW`.
    pub theme: String,
    pub motion: bool,
    /// Shared with the owner's feed, which sends the notes.
    pub notifications: Arc<AtomicBool>,
    pub compact: bool,
    /// Board keys whose tickets show; None is every board.
    pub boards: Option<Vec<String>>,
    /// Keys changed since daemon.toml was written.
    pub dirty: Vec<&'static str>,
}

impl Prefs {
    /// From the config file's table, leniently: a config the daemon refuses still sets them.
    pub fn from_table(t: Option<&toml::Table>) -> Self {
        let b = |k: &str, d: bool| t.and_then(|t| t.get(k)?.as_bool()).unwrap_or(d);
        let boards = t.and_then(|t| t.get("boards")?.as_array()).map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_ascii_uppercase())
                .filter(|s| !s.is_empty())
                .collect()
        });
        Prefs {
            theme: t
                .and_then(|t| t.get("theme")?.as_str())
                .map_or_else(|| crate::theme::DEFAULT.to_string(), str::to_string),
            motion: b("motion", true),
            notifications: Arc::new(AtomicBool::new(b("notifications", true))),
            compact: b("compact", false),
            boards,
            dirty: Vec::new(),
        }
    }

    fn touch(&mut self, key: &'static str) {
        if !self.dirty.contains(&key) {
            self.dirty.push(key);
        }
    }

    /// The theme to draw with now: the named one, or your Copland theme (the default until
    /// it has been read, or when it is one the box doesn't know).
    pub fn theme_now(&self, feed: Option<&Feed>) -> &'static Theme {
        let name = if self.theme == FOLLOW {
            feed.and_then(|f| f.theme.clone()).unwrap_or_default()
        } else {
            self.theme.clone()
        };
        Theme::named(&name).unwrap_or_else(|| Theme::named(crate::theme::DEFAULT).expect("the default theme"))
    }

    /// Whether a task with this key is on a board the box shows.
    pub fn shows(&self, key: &str) -> bool {
        board_of(key).is_none_or(|b| self.boards.as_ref().is_none_or(|list| list.iter().any(|k| k == b)))
    }

    /// daemon.toml with the changed keys written as they are now. A key at its default is
    /// taken out rather than written, so a file nobody changed stays as setup wrote it.
    pub fn render(&self, text: &str) -> String {
        let mut out = text.to_string();
        for &k in &self.dirty {
            let value = match k {
                "theme" => (self.theme != crate::theme::DEFAULT).then(|| edit::toml_str(&self.theme)),
                "motion" => (!self.motion).then(|| "false".to_string()),
                "notifications" => (!self.notifications.load(Ordering::Relaxed)).then(|| "false".to_string()),
                "compact" => self.compact.then(|| "true".to_string()),
                "boards" => self.boards.as_ref().map(|b| edit::toml_strs(b)),
                _ => continue,
            };
            out = edit::set_key(&out, k, value.as_deref());
        }
        out
    }

    /// Write the changes to `config` (backup kept); nothing when there are none.
    pub fn write(&mut self, config: &Path) -> Result<Option<PathBuf>> {
        if self.dirty.is_empty() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(config)?;
        let changed = self.render(&text);
        self.dirty.clear();
        if changed == text {
            return Ok(None);
        }
        let (_, backup) = edit::save(config, &changed)?;
        Ok(Some(backup))
    }
}

/// "COPL" for "COPL-12".
pub fn board_of(key: &str) -> Option<&str> {
    key.rsplit_once('-').map(|(b, _)| b).filter(|b| !b.is_empty())
}

/// The first row to list so `selected` shows, `rows` at a time.
fn first_row(selected: usize, n: usize, rows: usize) -> usize {
    selected.saturating_sub(rows - 1).min(n.saturating_sub(rows))
}

fn on_off(b: bool) -> &'static str {
    if b { "on" } else { "off" }
}

/// What a key did in the menu.
pub enum Act {
    Handled,
    Ignored,
    Close,
    /// Sign out was confirmed: the view stops the daemon and does it.
    SignOut,
    /// Compact was switched: the window changes size.
    Resize,
}

/// What the about panel knows.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Release {
    Checking,
    Checked(Checked),
    Failed(String),
}

pub struct Menu {
    pub tab: Tab,
    control: Control,
    agents: Option<Agents>,
    selected: [usize; 6],
    /// x was pressed once on the session panel.
    confirm_signout: bool,
    /// Signing out is under way; keys wait.
    pub signing_out: bool,
    release: Release,
    /// The last thing done or refused, under the panel.
    message: Option<(String, Role)>,
    job: Option<Task<()>>,
    /// What the autostart switch writes or removes, and runs.
    autostart: Option<PathBuf>,
    exec: prefs::Exec,
}

impl Menu {
    pub fn open(control: Control, tab: Tab, cx: &mut Context<BoxView>) -> Self {
        let exec = prefs::exec(
            std::env::var("PATH").ok().as_deref(),
            std::env::current_exe().ok().as_deref(),
        );
        let mut m = Self {
            tab: Tab::Needs,
            control,
            agents: None,
            selected: [0; 6],
            confirm_signout: false,
            signing_out: false,
            release: Release::Checking,
            message: None,
            job: None,
            autostart: prefs::autostart_file(),
            exec,
        };
        m.go(tab, cx);
        m
    }

    fn index(&self) -> usize {
        Tab::ALL.iter().position(|t| *t == self.tab).unwrap_or(0)
    }

    /// Show `tab`, starting what it needs.
    pub fn go(&mut self, tab: Tab, cx: &mut Context<BoxView>) {
        self.tab = tab;
        self.confirm_signout = false;
        self.message = None;
        match tab {
            Tab::Agents if self.agents.is_none() => self.agents = Some(Agents::open(self.control.clone(), cx)),
            Tab::About => self.check(false, cx),
            _ => {}
        }
    }

    /// The agents screen, while it is the open panel's (for its jobs to come back to).
    pub fn agents(&mut self) -> Option<&mut Agents> {
        self.agents.as_mut()
    }

    pub fn animating(&self) -> bool {
        self.signing_out
            || (self.tab == Tab::Agents && self.agents.as_ref().is_some_and(Agents::animating))
            || (self.tab == Tab::About && self.release == Release::Checking)
    }

    /// Ask (or re-ask) whether a newer box is out.
    fn check(&mut self, again: bool, cx: &mut Context<BoxView>) {
        if !again && matches!(self.release, Release::Checked(_)) {
            return;
        }
        let cache = prefs::release_cache();
        if again {
            let _ = std::fs::remove_file(&cache);
        }
        self.release = Release::Checking;
        let handle = self.control.rt.spawn(prefs::check(cache));
        self.job = Some(cx.spawn(async move |this, cx| {
            let Ok(out) = handle.await else { return };
            let _ = this.update(cx, |view, cx| {
                if let Some(m) = view.menu() {
                    m.release = match out {
                        Ok(c) => Release::Checked(c),
                        Err(e) => Release::Failed(e),
                    };
                }
                cx.notify();
            });
        }));
    }

    /// A key by name, or a click as one. `prefs` are changed in place.
    pub fn press(
        &mut self,
        name: &str,
        prefs: &mut Prefs,
        st: &DaemonState,
        feed: Option<&Feed>,
        cx: &mut Context<BoxView>,
    ) -> Act {
        if self.signing_out {
            return Act::Ignored;
        }
        /* Tabs: their number, or a click on their name ("tab:2"). */
        let jump = name
            .strip_prefix("tab:")
            .and_then(|n| n.parse::<usize>().ok())
            .or_else(|| {
                name.parse::<usize>()
                    .ok()
                    .filter(|n| (1..=6).contains(n))
                    .map(|n| n - 1)
            });
        if let Some(i) = jump.filter(|i| *i < Tab::ALL.len()) {
            self.go(Tab::ALL[i], cx);
            return Act::Handled;
        }
        if name == "m" || name == "escape" && self.tab != Tab::Agents {
            return Act::Close;
        }
        let tab = self.index();
        match self.tab {
            Tab::Agents => {
                let Some(a) = self.agents.as_mut() else {
                    return Act::Ignored;
                };
                match a.press(name, st, feed, cx) {
                    Key::Close => Act::Close,
                    Key::Handled => Act::Handled,
                    Key::Ignored => Act::Ignored,
                }
            }
            Tab::Needs => {
                let needs = notify::needs_shown(feed);
                if let Some(i) = self.row(name, needs.len()) {
                    if let Some(link) = needs.get(i).and_then(|n| n.link.clone()) {
                        cx.open_url(&link);
                    }
                    return Act::Handled;
                }
                self.list_keys(name, needs.len())
            }
            Tab::Boards => {
                let list = boards(prefs, feed);
                if name == "a" {
                    prefs.boards = None;
                    prefs.touch("boards");
                    return Act::Handled;
                }
                match self.row(name, list.len()) {
                    Some(i) => {
                        toggle_board(prefs, &list, i);
                        Act::Handled
                    }
                    None => self.list_keys(name, list.len()),
                }
            }
            Tab::Settings => {
                let n = 5;
                let by = match name {
                    "left" | "h" => -1,
                    "space" | "enter" | "right" | "l" => 1,
                    _ => 0,
                };
                let row = match self.row(name, n) {
                    Some(i) => Some((i, 1)),
                    None if by != 0 => Some((self.selected[tab], by)),
                    None => None,
                };
                match row {
                    Some((i, by)) => self.setting(i, by, prefs),
                    None => self.list_keys(name, n),
                }
            }
            Tab::Session => match name {
                "x" if self.confirm_signout => {
                    self.confirm_signout = false;
                    Act::SignOut
                }
                "x" => {
                    self.confirm_signout = true;
                    Act::Handled
                }
                _ if self.confirm_signout => {
                    self.confirm_signout = false;
                    Act::Handled
                }
                _ => Act::Ignored,
            },
            Tab::About => match name {
                "r" => {
                    self.check(true, cx);
                    Act::Handled
                }
                "o" | "enter" | "row:1" => {
                    let url = match &self.release {
                        Release::Checked(Checked {
                            newer: Some((_, url)), ..
                        }) => url.clone(),
                        _ => format!("https://github.com/{}/releases", prefs::REPO),
                    };
                    cx.open_url(&url);
                    Act::Handled
                }
                _ => Act::Ignored,
            },
        }
    }

    /// A click on a row, or enter on the selected one: the row it acts on. A click on another
    /// row picks it first.
    fn row(&mut self, name: &str, n: usize) -> Option<usize> {
        let tab = self.index();
        if let Some(i) = name.strip_prefix("row:").and_then(|i| i.parse::<usize>().ok()) {
            if i >= n {
                return None;
            }
            self.selected[tab] = i;
            return Some(i);
        }
        matches!(name, "enter" | "space")
            .then_some(self.selected[tab])
            .filter(|i| *i < n)
    }

    /// ↑↓ through a list of `n`.
    fn list_keys(&mut self, name: &str, n: usize) -> Act {
        let s = &mut self.selected[Tab::ALL.iter().position(|t| *t == self.tab).unwrap_or(0)];
        match name {
            "up" | "k" if n > 0 => *s = (*s + n - 1) % n,
            "down" | "j" if n > 0 => *s = (*s + 1) % n,
            _ => return Act::Ignored,
        }
        Act::Handled
    }

    /// Change setting `i` by one step (`by` back or on).
    fn setting(&mut self, i: usize, by: isize, prefs: &mut Prefs) -> Act {
        self.selected[self.index()] = i;
        self.message = None;
        match i {
            0 => {
                let names: Vec<&str> = Theme::names().chain([FOLLOW]).collect();
                let at = names.iter().position(|n| *n == prefs.theme).unwrap_or(0) as isize;
                let next = (at + by).rem_euclid(names.len() as isize) as usize;
                prefs.theme = names[next].to_string();
                prefs.touch("theme");
            }
            1 => {
                prefs.motion = !prefs.motion;
                prefs.touch("motion");
            }
            2 => {
                let on = !prefs.notifications.load(Ordering::Relaxed);
                prefs.notifications.store(on, Ordering::Relaxed);
                prefs.touch("notifications");
            }
            3 => {
                let Some(file) = self.autostart.clone() else {
                    self.message = Some(("× no HOME, so nowhere to put the entry".into(), Role::Red));
                    return Act::Handled;
                };
                let on = !file.exists();
                let config = (self.control.config != copland_daemon_core::config::default_config_path())
                    .then_some(self.control.config.as_path());
                self.message = Some(match prefs::set_autostart(&file, on, config, &self.exec) {
                    Ok(()) if on => (format!("wrote {}", setup::tilde(&file)), Role::Green),
                    Ok(()) => (format!("removed {}", setup::tilde(&file)), Role::Green),
                    Err(e) => (format!("× {e:#}"), Role::Red),
                });
            }
            4 => {
                prefs.compact = !prefs.compact;
                prefs.touch("compact");
                return Act::Resize;
            }
            _ => return Act::Ignored,
        }
        Act::Handled
    }

    /// What the open panel shows.
    pub fn panel(&self, prefs: &Prefs, st: &DaemonState, feed: Option<&Feed>, dots: &str) -> Panel {
        if self.signing_out {
            return Panel {
                lines: vec![
                    Line::one(format!("signing out{dots}"), Role::Muted),
                    Line::one("stopping the agents here, then revoking this box's tokens", Role::Faint),
                ],
                ..Default::default()
            };
        }
        let sel = self.selected[self.index()];
        let mut p = match self.tab {
            Tab::Agents => match &self.agents {
                Some(a) => return with_tab_keys(a.panel(st, feed)),
                None => Panel::default(),
            },
            Tab::Needs => self.needs_panel(feed, sel),
            Tab::Boards => self.boards_panel(prefs, feed, sel),
            Tab::Settings => self.settings_panel(prefs, sel),
            Tab::Session => self.session_panel(feed),
            Tab::About => self.about_panel(dots),
        };
        if let Some((m, role)) = &self.message {
            p.lines.push(Line::one(m.clone(), *role));
            p.clicks.push(None);
        }
        with_tab_keys(p)
    }

    fn needs_panel(&self, feed: Option<&Feed>, sel: usize) -> Panel {
        let needs = notify::needs_shown(feed);
        let mut lines = Vec::new();
        let mut clicks = Vec::new();
        if feed.is_none() {
            lines.push(Line::one(
                "owner_token_file in daemon.toml shows what needs you",
                Role::Faint,
            ));
            clicks.push(None);
        } else if needs.is_empty() {
            lines.push(Line::one("nothing needs you", Role::Muted));
            clicks.push(None);
            lines.push(Line::one(
                "the bell counts your agents' blocked tasks and your unread @mentions",
                Role::Faint,
            ));
            clicks.push(None);
        }
        let first = first_row(sel, needs.len(), ROWS);
        for (i, n) in needs.iter().enumerate().skip(first).take(ROWS) {
            let on = i == sel;
            let (mark, role, what) = match n.why {
                Why::Blocked => ("▲ ", Role::Red, format!("blocked · {}", n.who)),
                Why::Mentioned => ("@ ", Role::Blue, format!("@{} mentioned you", n.who)),
            };
            lines.push(Line(
                vec![
                    Span::new(if on { "› " } else { "  " }, Role::Blue),
                    Span::new(mark, role),
                    Span::new(format!("{:<9} ", n.key), if on { Role::Ink } else { Role::Muted }),
                    Span::new(format!("{what}  "), Role::Muted),
                    Span::new(n.title.clone(), Role::Faint),
                ],
                None,
            ));
            clicks.push(Some(format!("row:{i}")));
        }
        let mut keys = Vec::new();
        if !needs.is_empty() {
            keys.push(key("enter", "open"));
        }
        if needs.len() > 1 {
            keys.push(key("↑↓", "pick"));
        }
        Panel {
            lines,
            keys,
            clicks,
            ..Default::default()
        }
    }

    fn boards_panel(&self, prefs: &Prefs, feed: Option<&Feed>, sel: usize) -> Panel {
        let list = boards(prefs, feed);
        let mut lines = Vec::new();
        let mut clicks = Vec::new();
        let shown = list.iter().filter(|(k, _)| prefs.shows(&format!("{k}-1"))).count();
        lines.push(Line(
            vec![
                Span::new(
                    match &prefs.boards {
                        None => "every board's tickets show".to_string(),
                        Some(_) => format!("{shown} of {} boards show", list.len()),
                    },
                    Role::Muted,
                ),
                Span::new(" · display only: agents still wake for any board", Role::Faint),
            ],
            None,
        ));
        clicks.push(None);
        if list.is_empty() {
            lines.push(Line::one(
                match feed {
                    None => "owner_token_file in daemon.toml lists your boards",
                    Some(_) => "reading your boards…",
                },
                Role::Faint,
            ));
            clicks.push(None);
        }
        let rows = ROWS - 1;
        let first = first_row(sel, list.len(), rows);
        for (i, (k, name)) in list.iter().enumerate().skip(first).take(rows) {
            let on = i == sel;
            let ticked = prefs.shows(&format!("{k}-1"));
            lines.push(Line(
                vec![
                    Span::new(if on { "› " } else { "  " }, Role::Blue),
                    Span::new(
                        if ticked { "■ " } else { "□ " },
                        if ticked { Role::Green } else { Role::Faint },
                    ),
                    Span::new(format!("{k:<6} "), if on { Role::Ink } else { Role::Muted }),
                    Span::new(name.clone(), Role::Faint),
                ],
                None,
            ));
            clicks.push(Some(format!("row:{i}")));
        }
        let mut keys = Vec::new();
        if !list.is_empty() {
            keys.push(key("space", "show or hide"));
            keys.push(key("a", "all"));
        }
        if list.len() > 1 {
            keys.push(key("↑↓", "board"));
        }
        Panel {
            lines,
            keys,
            clicks,
            ..Default::default()
        }
    }

    fn settings_panel(&self, prefs: &Prefs, sel: usize) -> Panel {
        let notes = prefs.notifications.load(Ordering::Relaxed);
        let autostart = self.autostart.as_ref().is_some_and(|f| f.exists());
        let theme = if prefs.theme == FOLLOW {
            "copland (your theme there)".to_string()
        } else {
            prefs.theme.clone()
        };
        let rows: [(&str, String, &str); 5] = [
            ("theme", theme, "one of copland's seven, or the one you use in copland"),
            (
                "motion",
                on_off(prefs.motion).into(),
                "off: a still picture, redrawn when something changes",
            ),
            (
                "notifications",
                on_off(notes).into(),
                "a quiet desktop notice when something needs you; the bell counts either way",
            ),
            (
                "start at login",
                on_off(autostart).into(),
                "an autostart entry in ~/.config/autostart",
            ),
            (
                "compact",
                on_off(prefs.compact).into(),
                "just the status line, in a small window",
            ),
        ];
        let first = first_row(sel, rows.len(), ROWS);
        let mut lines = Vec::new();
        let mut clicks = Vec::new();
        for (i, (name, value, _)) in rows.iter().enumerate().skip(first).take(ROWS) {
            let on = i == sel;
            lines.push(Line(
                vec![
                    Span::new(if on { "› " } else { "  " }, Role::Blue),
                    Span::new(format!("{name:<16}"), if on { Role::Ink } else { Role::Muted }),
                    Span::new(
                        value.clone(),
                        if on {
                            Role::Yellow
                        } else if value == "off" {
                            Role::Faint
                        } else {
                            Role::Muted
                        },
                    ),
                ],
                None,
            ));
            clicks.push(Some(format!("row:{i}")));
        }
        if self.message.is_none() {
            let mut hint = rows[sel.min(rows.len() - 1)].2.to_string();
            if sel == 3 {
                hint = match &self.exec.caveat {
                    Some(c) => format!("runs {} · {c}", self.exec.program),
                    None => format!("runs {}", self.exec.program),
                };
            }
            lines.push(Line::one(hint, Role::Faint));
            clicks.push(None);
        }
        Panel {
            lines,
            keys: vec![key("space", "change"), key("↑↓", "setting")],
            clicks,
            ..Default::default()
        }
    }

    fn session_panel(&self, feed: Option<&Feed>) -> Panel {
        let held = held_tokens(&std::fs::read_to_string(&self.control.config).unwrap_or_default());
        let url = feed
            .map(|f| f.url.clone())
            .or_else(|| held.first().map(|h| h.url.clone()))
            .unwrap_or_default();
        let who = feed
            .and_then(|f| f.who.clone())
            .map_or_else(|| "(no token of yours here)".to_string(), |w| format!("@{w}"));
        let names: Vec<String> = held.iter().map(|h| h.label.clone()).collect();
        let mut lines = vec![
            Line(
                vec![
                    Span::new("signed in as ", Role::Muted),
                    Span::new(who, Role::Ink),
                    Span::new(" on ", Role::Muted),
                    Span::new(url.clone(), Role::Blue),
                ],
                (!url.is_empty()).then(|| url.clone()),
            ),
            Line::one(
                format!(
                    "this box holds {} token{}: {}",
                    held.len(),
                    if held.len() == 1 { "" } else { "s" },
                    names.join(", ")
                ),
                Role::Faint,
            ),
            Line::one(format!("config {}", setup::tilde(&self.control.config)), Role::Faint),
        ];
        let keys = if self.confirm_signout {
            lines.push(Line::one(
                "x again signs out: revokes these tokens, deletes them and daemon.toml, then sets up again",
                Role::Yellow,
            ));
            vec![key("x", "sign out"), key("any key", "stay")]
        } else {
            lines.push(Line::one(
                "to switch or add an account, sign out and set up again",
                Role::Faint,
            ));
            vec![key("x", "sign out")]
        };
        let clicks = vec![None; lines.len()];
        Panel {
            lines,
            keys,
            clicks,
            ..Default::default()
        }
    }

    fn about_panel(&self, dots: &str) -> Panel {
        let mut lines = vec![Line(
            vec![
                Span::new(format!("copland-box {}", prefs::VERSION), Role::Ink),
                Span::new(format!("  github.com/{}", prefs::REPO), Role::Faint),
            ],
            Some(format!("https://github.com/{}", prefs::REPO)),
        )];
        lines.push(match &self.release {
            Release::Checking => Line::one(format!("looking for a newer release{dots}"), Role::Faint),
            Release::Checked(Checked {
                newer: Some((tag, url)),
                ..
            }) => Line(
                vec![
                    Span::new("newer: ", Role::Muted),
                    Span::new(tag.clone(), Role::Yellow),
                    Span::new("  release notes and downloads", Role::Faint),
                ],
                Some(url.clone()),
            ),
            Release::Checked(Checked { newer: None, .. }) => Line::one("this is the newest release", Role::Green),
            Release::Failed(e) => Line::one(format!("couldn't check for releases · {e}"), Role::Faint),
        });
        let clicks = vec![None, Some("row:1".to_string())];
        Panel {
            lines,
            keys: vec![key("r", "check again"), key("o", "releases")],
            clicks,
            ..Default::default()
        }
    }
}

/// The menu's own keys after a panel's.
fn with_tab_keys(mut p: Panel) -> Panel {
    p.keys
        .retain(|k| crate::wizard::hint_key(k).as_deref() != Some("escape"));
    p.keys.push(key("1-6", "panel"));
    p.keys.push(key("esc", "close"));
    p
}

/// The boards to list: yours from Copland when they have been read, else the keys the box
/// has seen or been told; with names when known.
pub fn boards(prefs: &Prefs, feed: Option<&Feed>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = match feed.and_then(|f| f.boards.as_ref()) {
        Some(b) => b
            .iter()
            .map(|b| {
                let name = if b.is_inbox {
                    "your inbox".to_string()
                } else {
                    b.name.clone()
                };
                (b.key.to_ascii_uppercase(), name)
            })
            .collect(),
        None => {
            let mut keys: Vec<String> = feed
                .and_then(|f| f.wired.as_ref())
                .map(|(w, _)| {
                    w.todo
                        .iter()
                        .chain(&w.doing)
                        .chain(&w.blocked)
                        .chain(&w.done)
                        .filter_map(|t| board_of(&t.key).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            keys.sort();
            keys.dedup();
            keys.into_iter().map(|k| (k, String::new())).collect()
        }
    };
    for k in prefs.boards.iter().flatten() {
        if !out.iter().any(|(o, _)| o == k) {
            out.push((k.clone(), "(not one of yours now)".into()));
        }
    }
    out
}

/// Show or hide board `i` of `list`. Every board shown again is no filter at all.
pub fn toggle_board(prefs: &mut Prefs, list: &[(String, String)], i: usize) {
    let Some((k, _)) = list.get(i) else { return };
    let mut shown: Vec<String> = match &prefs.boards {
        None => list.iter().map(|(k, _)| k.clone()).collect(),
        Some(b) => b.clone(),
    };
    if let Some(at) = shown.iter().position(|s| s == k) {
        shown.remove(at);
    } else {
        shown.push(k.clone());
    }
    prefs.boards = if list.iter().all(|(k, _)| shown.contains(k)) {
        None
    } else {
        Some(shown)
    };
    prefs.touch("boards");
}

/* ---------- signing out ---------- */

/// One token this box holds: whose, for which Copland, and where it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    /// "you", or the agent's name.
    pub label: String,
    pub url: String,
    pub token: Option<String>,
    pub file: Option<PathBuf>,
}

/// The tokens a daemon.toml names, yours first, read leniently (a broken config still signs out).
pub fn held_tokens(text: &str) -> Vec<Held> {
    let Ok(t) = toml::from_str::<toml::Table>(text) else {
        return Vec::new();
    };
    let s = |t: &toml::Table, k: &str| t.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let agents: Vec<&toml::Table> = t
        .get("agent")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_table()).collect())
        .unwrap_or_default();
    let first_url = agents.first().and_then(|a| s(a, "url")).unwrap_or_default();
    let mut out = Vec::new();
    let (token, file) = (s(&t, "owner_token"), s(&t, "owner_token_file"));
    if token.is_some() || file.is_some() {
        out.push(Held {
            label: "yours".into(),
            url: s(&t, "owner_url").unwrap_or(first_url),
            token,
            file: file.map(|f| expand_home(&f)),
        });
    }
    for a in agents {
        let handle = s(a, "handle").unwrap_or_default();
        out.push(Held {
            label: handle.rsplit('/').next().unwrap_or(&handle).to_string(),
            url: s(a, "url").unwrap_or_default(),
            token: s(a, "token"),
            file: s(a, "token_file").map(|f| expand_home(&f)),
        });
    }
    out
}

/// The files signing out removes besides the token files: the config, its backups, a setup
/// left half done, and what the bell remembers.
pub fn local_files(config: &Path, memory: &Path) -> Vec<PathBuf> {
    let mut out = vec![config.to_path_buf(), setup::pending_path(config)];
    if let (Some(dir), Some(name)) = (config.parent(), config.file_name()) {
        let base = name.to_string_lossy().into_owned();
        if let Ok(entries) = std::fs::read_dir(if dir.as_os_str().is_empty() {
            Path::new(".")
        } else {
            dir
        }) {
            for e in entries.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.starts_with(&format!("{base}.bak")) || n == format!("{base}.tmp") {
                    out.push(e.path());
                }
            }
        }
    }
    out.push(memory.to_path_buf());
    out
}

/// Revoke every token the config holds (each with itself) and delete them and the config.
/// Blocking; run it off the window's thread once the daemon has stopped. Gives back what
/// couldn't be revoked, with why: those stay valid until revoked in settings.
pub fn sign_out(config: &Path, memory: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(config).unwrap_or_default();
    let held = held_tokens(&text);
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return vec![format!("{e}")],
    };
    let mut failed = Vec::new();
    for h in &held {
        let token = h
            .token
            .clone()
            .or_else(|| h.file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()))
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        let Some(token) = token else { continue };
        let result = rt.block_on(async {
            let api = Api::new(&h.url).map_err(|e| format!("{e:#}"))?;
            match api.revoke_self(&Secret::new(token)).await {
                Ok(_) => Ok(()),
                /* Refused: revoked already, or never valid; either way it opens nothing now. */
                Err(e) if e.status() == Some(401) => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        });
        match result {
            Ok(()) => tracing::info!("sign out: revoked the token ({})", h.label),
            Err(e) => {
                tracing::warn!("sign out: the token ({}): {e}", h.label);
                failed.push(format!("{}: {e}", h.label));
            }
        }
    }
    for f in held
        .iter()
        .filter_map(|h| h.file.clone())
        .chain(local_files(config, memory))
    {
        match std::fs::remove_file(&f) {
            Ok(()) => tracing::info!("sign out: deleted {}", f.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => failed.push(format!("{}: {e}", setup::tilde(&f))),
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use copland_daemon_core::api::BoardRef;

    fn prefs(boards: Option<&[&str]>) -> Prefs {
        let mut p = Prefs::from_table(None);
        p.boards = boards.map(|b| b.iter().map(|s| s.to_string()).collect());
        p
    }

    #[test]
    fn the_boards_filter_shows_and_hides_by_board_key() {
        let all = prefs(None);
        assert!(all.shows("COPL-1") && all.shows("HOME-2") && all.shows("odd"));
        let some = prefs(Some(&["COPL"]));
        assert!(some.shows("COPL-12") && !some.shows("HOME-2") && !some.shows("MY-BOARD-3"));
        /* Not a task key: nothing to filter by, so it shows. */
        assert!(some.shows("nope"));
        assert_eq!(board_of("MY-BOARD-3"), Some("MY-BOARD"));
    }

    #[test]
    fn toggling_boards_comes_back_to_all() {
        let list: Vec<(String, String)> = ["COPL", "HOME", "INBOX"]
            .iter()
            .map(|k| (k.to_string(), String::new()))
            .collect();
        let mut p = prefs(None);
        toggle_board(&mut p, &list, 1);
        assert_eq!(p.boards, Some(vec!["COPL".to_string(), "INBOX".to_string()]));
        assert_eq!(p.dirty, ["boards"]);
        toggle_board(&mut p, &list, 0);
        assert_eq!(p.boards, Some(vec!["INBOX".to_string()]));
        toggle_board(&mut p, &list, 0);
        toggle_board(&mut p, &list, 1);
        assert_eq!(p.boards, None);
    }

    #[test]
    fn lists_your_boards_and_any_filtered_one_that_is_gone() {
        let feed = Feed {
            boards: Some(vec![
                BoardRef {
                    id: "1".into(),
                    key: "copl".into(),
                    name: "copland".into(),
                    is_inbox: false,
                },
                BoardRef {
                    id: "2".into(),
                    key: "ME".into(),
                    name: "x".into(),
                    is_inbox: true,
                },
            ]),
            ..Default::default()
        };
        let p = prefs(Some(&["OLD"]));
        assert_eq!(
            boards(&p, Some(&feed)),
            [
                ("COPL".to_string(), "copland".to_string()),
                ("ME".to_string(), "your inbox".to_string()),
                ("OLD".to_string(), "(not one of yours now)".to_string())
            ]
        );
    }

    #[test]
    fn settings_round_trip_through_daemon_toml() {
        let dir = std::env::temp_dir().join(format!("copland-menu-prefs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("me.token"), "cpl_me\n").unwrap();
        let config = dir.join("daemon.toml");
        let text = format!(
            "# mine\nowner_token_file = \"{0}/me.token\"\n\n[[agent]]\nurl = \"http://x\"\nhandle = \"me/dev\"\ntoken = \"cpl_a\"\ncommand = [\"x\"]\nworkdir = \"{0}\"\n",
            dir.display()
        );
        std::fs::write(&config, &text).unwrap();
        let table: toml::Table = toml::from_str(&text).unwrap();
        let mut p = Prefs::from_table(Some(&table));
        assert_eq!((p.theme.as_str(), p.motion, p.compact), ("nord", true, false));
        /* Nothing changed: nothing written, no backup. */
        assert_eq!(p.write(&config).unwrap(), None);

        p.theme = FOLLOW.into();
        p.touch("theme");
        p.motion = false;
        p.touch("motion");
        p.notifications.store(false, Ordering::Relaxed);
        p.touch("notifications");
        p.compact = true;
        p.touch("compact");
        p.boards = Some(vec!["COPL".into()]);
        p.touch("boards");
        let backup = p.write(&config).unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), text);
        let written = std::fs::read_to_string(&config).unwrap();
        assert!(written.starts_with("# mine\n"));
        let back = Prefs::from_table(Some(&toml::from_str(&written).unwrap()));
        assert_eq!(back.theme, FOLLOW);
        assert!(!back.motion && back.compact && !back.notifications.load(Ordering::Relaxed));
        assert_eq!(back.boards, Some(vec!["COPL".to_string()]));
        /* The daemon reads it too. */
        let c = copland_daemon_core::Config::load(&config).unwrap();
        assert_eq!(c.boards, Some(vec!["COPL".to_string()]));

        /* Back to the defaults: the keys go, and the file is what it was. */
        let mut q = back;
        q.theme = crate::theme::DEFAULT.into();
        q.motion = true;
        q.notifications.store(true, Ordering::Relaxed);
        q.compact = false;
        q.boards = None;
        q.dirty = vec!["theme", "motion", "notifications", "compact", "boards"];
        q.write(&config).unwrap();
        assert_eq!(std::fs::read_to_string(&config).unwrap(), text);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn follows_your_copland_theme_once_it_is_known() {
        let mut p = prefs(None);
        p.theme = FOLLOW.into();
        assert_eq!(p.theme_now(None).name, "nord");
        let feed = Feed {
            theme: Some("dracula".into()),
            ..Default::default()
        };
        assert_eq!(p.theme_now(Some(&feed)).name, "dracula");
        p.theme = "gruvbox".into();
        assert_eq!(p.theme_now(Some(&feed)).name, "gruvbox");
    }

    #[test]
    fn finds_every_token_the_box_holds() {
        let text = "owner_token_file = \"/c/me.token\"\n[[agent]]\nurl = \"http://x\"\nhandle = \"me/dev\"\ntoken_file = \"/c/dev.token\"\n[[agent]]\nurl = \"http://y\"\nhandle = \"me/review\"\ntoken = \"cpl_r\"\n";
        let h = held_tokens(text);
        assert_eq!(h.len(), 3);
        assert_eq!(
            (h[0].label.as_str(), h[0].url.as_str(), h[0].file.as_deref()),
            ("yours", "http://x", Some(Path::new("/c/me.token")))
        );
        assert_eq!((h[1].label.as_str(), h[1].url.as_str()), ("dev", "http://x"));
        assert_eq!((h[2].label.as_str(), h[2].token.as_deref()), ("review", Some("cpl_r")));
        assert!(held_tokens("not = [toml").is_empty());
    }

    #[test]
    fn signing_out_deletes_the_tokens_the_config_and_its_backups() {
        let dir = std::env::temp_dir().join(format!("copland-signout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("daemon.toml");
        /* Nothing listens on port 9: the revoke fails, and is said; the files go anyway. */
        std::fs::write(
            &config,
            format!(
                "owner_token_file = \"{0}/me.token\"\n[[agent]]\nurl = \"http://127.0.0.1:9\"\nhandle = \"me/dev\"\ntoken_file = \"{0}/dev.token\"\n",
                dir.display()
            ),
        )
        .unwrap();
        for f in [
            "me.token",
            "dev.token",
            "daemon.toml.bak",
            "daemon.toml.bak.2",
            "notified.toml",
            "other.txt",
        ] {
            std::fs::write(dir.join(f), "cpl_x\n").unwrap();
        }
        let failed = sign_out(&config, &dir.join("notified.toml"));
        assert_eq!(failed.len(), 2, "{failed:?}");
        assert!(failed[0].starts_with("yours: "));
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, ["other.txt"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

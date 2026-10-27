//! Runtime accounts, and the cap on runs going at once on each (COPL-232).
//!
//! An agent's account is its runtime and who is signed in to it: two agents
//! on one Claude subscription share one, and so do two machines signed in to
//! it, with no config. It is read from the runtime's own files each poll
//! (Claude Code's `.claude.json`, Codex's `auth.json`), and `account = "…"`
//! on an `[[agent]]` overrides it. When nothing can be read it is the
//! runtime's name, so every agent on that runtime on this machine shares one.
//!
//! The daemon keeps one `Accounts` for all its agents: before a run starts,
//! the agent's loop takes a `Seat` on its account, and the seat goes back
//! when the run ends, however it does (dropping it does). At most
//! `max_runs_per_account` seats are out per account; an agent's own
//! `max_runs` is a second limit on top. Who is signed in is personal, so an
//! account is shown (`Account::shown`) by the runtime and a masked email or a
//! short hash, never in full.
//!
//! Copland shares the cap across machines (COPL-234): each run is started
//! with the account (`Account::shared`, a hash of its key, never the id or
//! an email) and this daemon's cap, and Copland refuses it with
//! `account_full` while the owner's live runs on that account, from any
//! machine, are at the cap. An account read off no sign-in is the runtime's
//! name alone, which says nothing about who is signed in, so it is never
//! sent: two machines with nothing in common would share it.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::config::{AgentConfig, Runtime};

/// Runs going at once on one account, across the daemon's agents, unless the config says.
/// Low enough that a feature's lanes (2 to 4) run side by side without the account hitting its
/// usage limit together: COPL-195 hit it with ten runs going on one Claude subscription.
pub const DEFAULT_MAX_RUNS_PER_ACCOUNT: usize = 3;

/// An agent's runtime account.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Account {
    /// What the cap counts by: `claude-code:<account uuid>`, `codex:<account id>`, the runtime's
    /// name alone when nothing could be read, or the config's `account` as written.
    pub key: String,
    /// For logs and the status: "claude-code (b…@…)", "codex (3f2a91)", "claude-code".
    pub shown: String,
    /// What Copland counts it by across machines: the first 16 hex digits of the key's SHA-256.
    /// None when it is only the runtime's name.
    pub shared: Option<String>,
}

impl Account {
    /// The agent's account as this machine has it now: `account =` in its config, else read off
    /// its runtime's files under $HOME, else the runtime's name.
    pub fn of(agent: &AgentConfig) -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Self::find(agent, home.as_deref(), |var| std::env::var_os(var))
    }

    /// `of`, with $HOME and the environment given (a seam for tests).
    pub fn find(agent: &AgentConfig, home: Option<&Path>, env: impl Fn(&str) -> Option<OsString>) -> Self {
        if let Some(name) = &agent.account {
            return Self {
                key: name.clone(),
                shown: name.clone(),
                shared: Some(shared(name)),
            };
        }
        let runtime = agent.runtime.name();
        let read = match &agent.runtime {
            Runtime::ClaudeCode => claude_code(home, &env),
            Runtime::Codex => codex(home, &env),
            Runtime::Unknown(_) => None,
        };
        match read {
            Some(Who { id, email }) => {
                let key = format!("{runtime}:{id}");
                Self {
                    shared: Some(shared(&key)),
                    shown: format!(
                        "{runtime} ({})",
                        email.as_deref().map(mask).unwrap_or_else(|| short_hash(&id))
                    ),
                    key,
                }
            }
            None => Self {
                key: runtime.to_string(),
                shown: runtime.to_string(),
                shared: None,
            },
        }
    }
}

/// Who is signed in to a runtime.
struct Who {
    id: String,
    email: Option<String>,
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn dir_from(env: &impl Fn(&str) -> Option<OsString>, var: &str) -> Option<PathBuf> {
    env(var).filter(|d| !d.is_empty()).map(PathBuf::from)
}

/// Claude Code keeps its global config in `.claude.json`, in `$CLAUDE_CONFIG_DIR` when that is
/// set and in $HOME otherwise; a subscription login writes `oauthAccount` there, with the
/// account's `accountUuid` and `emailAddress` (as Claude Code 2.1.301 does). An API key login has none.
fn claude_code(home: Option<&Path>, env: &impl Fn(&str) -> Option<OsString>) -> Option<Who> {
    let dir = dir_from(env, "CLAUDE_CONFIG_DIR").or_else(|| home.map(Path::to_path_buf))?;
    let json = read_json(&dir.join(".claude.json"))?;
    let account = json.get("oauthAccount")?;
    let id = account.get("accountUuid")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    Some(Who {
        id: id.to_string(),
        email: account.get("emailAddress").and_then(|e| e.as_str()).map(str::to_string),
    })
}

/// Codex keeps its login in `auth.json`, in `$CODEX_HOME` when that is set and in `~/.codex`
/// otherwise; a ChatGPT login writes `tokens.account_id` there (as Codex 0.163.0 does). An API key
/// login has none.
fn codex(home: Option<&Path>, env: &impl Fn(&str) -> Option<OsString>) -> Option<Who> {
    let dir = dir_from(env, "CODEX_HOME").or_else(|| home.map(|h| h.join(".codex")))?;
    let json = read_json(&dir.join("auth.json"))?;
    let id = json.get("tokens")?.get("account_id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    Some(Who {
        id: id.to_string(),
        email: None,
    })
}

/// "berker@example.com" → "b…@…": enough to tell two of yours apart, nothing more.
fn mask(email: &str) -> String {
    match email.trim().chars().next() {
        Some(first) if email.contains('@') => format!("{first}…@…"),
        _ => "…".to_string(),
    }
}

/// The first six hex digits of the id's SHA-256: the same on every machine, and not the id.
fn short_hash(id: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, id.as_bytes());
    digest.as_ref()[..3].iter().map(|b| format!("{b:02x}")).collect()
}

/// An account's key as Copland is told it (COPL-234): the first 16 hex digits of its SHA-256, the
/// same on every machine signed in to it, and neither the runtime's id nor an email.
fn shared(key: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, key.as_bytes());
    digest.as_ref()[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// The daemon's seats, by account: one, shared by every agent loop.
#[derive(Clone)]
pub struct Accounts {
    inner: Arc<Mutex<Inner>>,
    /// Moves on each time a seat goes back, so a loop waiting for one polls again at once.
    freed: watch::Sender<u64>,
}

struct Inner {
    cap: usize,
    /// Seats taken, by account key.
    taken: HashMap<String, usize>,
    /// Each agent's account as its loop last read it, by the agent's slot.
    members: HashMap<u64, String>,
}

/// One run's seat on its account, given back when dropped.
pub struct Seat {
    inner: Arc<Mutex<Inner>>,
    freed: watch::Sender<u64>,
    key: String,
}

impl std::fmt::Debug for Accounts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.inner.lock().expect("accounts lock");
        f.debug_struct("Accounts")
            .field("cap", &inner.cap)
            .field("taken", &inner.taken.values().sum::<usize>())
            .finish()
    }
}

impl Default for Accounts {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_RUNS_PER_ACCOUNT)
    }
}

impl Accounts {
    pub fn new(cap: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                cap,
                taken: HashMap::new(),
                members: HashMap::new(),
            })),
            freed: watch::channel(0).0,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("accounts lock")
    }

    /// A new cap, from a reload. Runs going keep their seats; with fewer seats than are taken,
    /// nothing new starts on that account until enough of them have ended.
    pub fn set_cap(&self, cap: usize) {
        let mut inner = self.lock();
        if inner.cap != cap {
            tracing::info!("runs going at once per runtime account: {cap} (was {})", inner.cap);
            inner.cap = cap;
            drop(inner);
            /* A higher cap may let a waiting loop start now. */
            self.freed.send_modify(|n| *n += 1);
        }
    }

    pub fn cap(&self) -> usize {
        self.lock().cap
    }

    /// Seats taken on `key` now.
    pub fn taken(&self, key: &str) -> usize {
        self.lock().taken.get(key).copied().unwrap_or(0)
    }

    /// Whether a seat on `key` is free now. Another loop may take it before this one does.
    pub fn free(&self, key: &str) -> bool {
        let inner = self.lock();
        inner.taken.get(key).copied().unwrap_or(0) < inner.cap
    }

    /// A seat on `key`, when one is free.
    pub fn take(&self, key: &str) -> Option<Seat> {
        let mut inner = self.lock();
        let cap = inner.cap;
        let taken = inner.taken.entry(key.to_string()).or_default();
        if *taken >= cap {
            return None;
        }
        *taken += 1;
        Some(Seat {
            inner: self.inner.clone(),
            freed: self.freed.clone(),
            key: key.to_string(),
        })
    }

    /// The agent in `slot` is on `key`, as its loop read it just now.
    pub fn join(&self, slot: u64, key: &str) {
        self.lock().members.insert(slot, key.to_string());
    }

    /// The agent in `slot` is no longer run (its loop ended).
    pub fn leave(&self, slot: u64) {
        self.lock().members.remove(&slot);
    }

    /// Every agent on `key`, by slot: who an account out of usage holds.
    pub fn on(&self, key: &str) -> HashSet<u64> {
        self.lock()
            .members
            .iter()
            .filter(|(_, k)| *k == key)
            .map(|(slot, _)| *slot)
            .collect()
    }

    /// Changes each time a seat goes back or the cap changes.
    pub fn freed(&self) -> watch::Receiver<u64> {
        self.freed.subscribe()
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        let mut inner = self.inner.lock().expect("accounts lock");
        if let Some(n) = inner.taken.get_mut(&self.key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                inner.taken.remove(&self.key);
            }
        }
        drop(inner);
        self.freed.send_modify(|n| *n += 1);
    }
}

impl std::fmt::Debug for Seat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Seat")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Secret;

    fn agent(runtime: Runtime) -> AgentConfig {
        AgentConfig {
            url: "http://x".into(),
            handle: "me/dev".into(),
            token: Secret::new("cpl_t"),
            command: vec!["claude".into()],
            workdir: "/tmp".into(),
            client: "Claude Code".into(),
            code_command: None,
            writable: Vec::new(),
            runtime,
            code_dir: "/tmp/copland-code".into(),
            max_runs: 10,
            account: None,
            resume_chains: false,
        }
    }

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-account-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn none(_: &str) -> Option<OsString> {
        None
    }

    #[test]
    fn reads_claude_codes_signed_in_account() {
        let home = fixture("claude");
        std::fs::write(
            home.join(".claude.json"),
            r#"{"numStartups":3,"oauthAccount":{"accountUuid":"0b9e6c1e-1111-4a2b-9c3d-123456789abc","emailAddress":"berker@example.com","organizationUuid":"x"}}"#,
        )
        .unwrap();
        let a = Account::find(&agent(Runtime::ClaudeCode), Some(&home), none);
        assert_eq!(a.key, "claude-code:0b9e6c1e-1111-4a2b-9c3d-123456789abc");
        assert_eq!(a.shown, "claude-code (b…@…)");
        assert!(!a.shown.contains("berker"), "the email is never shown");
        /* Copland is told a hash of the key: the same on every machine, and neither the id nor the email. */
        let told = a.shared.clone().unwrap();
        assert_eq!(told.len(), 16);
        assert!(told.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!told.contains("0b9e6c1e") && !told.contains("berker"));
        assert_eq!(Account::find(&agent(Runtime::ClaudeCode), Some(&home), none).shared, Some(told));

        /* $CLAUDE_CONFIG_DIR wins over $HOME. */
        let other = fixture("claude-dir");
        std::fs::write(
            other.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"other-uuid"}}"#,
        )
        .unwrap();
        let env = |v: &str| (v == "CLAUDE_CONFIG_DIR").then(|| other.clone().into_os_string());
        let a = Account::find(&agent(Runtime::ClaudeCode), Some(&home), env);
        assert_eq!(a.key, "claude-code:other-uuid");
        assert_eq!(a.shown, format!("claude-code ({})", short_hash("other-uuid")));
        assert_eq!(short_hash("other-uuid").len(), 6);
    }

    #[test]
    fn reads_codexs_signed_in_account() {
        let home = fixture("codex");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(
            home.join(".codex/auth.json"),
            r#"{"OPENAI_API_KEY":null,"tokens":{"id_token":"x","access_token":"y","refresh_token":"z","account_id":"acct-123"},"last_refresh":"2026-10-27T00:00:00Z"}"#,
        )
        .unwrap();
        let a = Account::find(&agent(Runtime::Codex), Some(&home), none);
        assert_eq!(a.key, "codex:acct-123");
        assert_eq!(a.shown, format!("codex ({})", short_hash("acct-123")));

        let elsewhere = fixture("codex-home");
        std::fs::write(elsewhere.join("auth.json"), r#"{"tokens":{"account_id":"acct-9"}}"#).unwrap();
        let env = |v: &str| (v == "CODEX_HOME").then(|| elsewhere.clone().into_os_string());
        assert_eq!(
            Account::find(&agent(Runtime::Codex), Some(&home), env).key,
            "codex:acct-9"
        );
    }

    #[test]
    fn falls_back_to_the_runtime_and_the_config_overrides() {
        let home = fixture("empty");
        /* Nothing signed in (or an API key): every agent on the runtime here shares one. */
        let fallback = Account::find(&agent(Runtime::ClaudeCode), Some(&home), none);
        assert_eq!(fallback.key, "claude-code");
        assert_eq!(fallback.shared, None, "only the runtime's name: never shared across machines");
        std::fs::write(home.join(".claude.json"), r#"{"oauthAccount":{}}"#).unwrap();
        assert_eq!(
            Account::find(&agent(Runtime::ClaudeCode), Some(&home), none).shown,
            "claude-code"
        );
        assert_eq!(Account::find(&agent(Runtime::Codex), None, none).key, "codex");
        let mut named = agent(Runtime::ClaudeCode);
        named.account = Some("work".into());
        let a = Account::find(&named, Some(&home), none);
        assert_eq!((a.key.as_str(), a.shown.as_str()), ("work", "work"));
        assert_eq!(a.shared, Some(shared("work")), "a named account is shared across machines");
    }

    #[test]
    fn seats_are_capped_per_account_and_go_back_when_dropped() {
        let accounts = Accounts::new(2);
        let a = accounts.take("claude-code:a").unwrap();
        let b = accounts.take("claude-code:a").unwrap();
        assert!(accounts.take("claude-code:a").is_none());
        assert!(!accounts.free("claude-code:a"));
        /* Another account has seats of its own. */
        let other = accounts.take("codex").unwrap();
        assert_eq!(accounts.taken("claude-code:a"), 2);
        let freed = accounts.freed();
        drop(a);
        assert!(freed.has_changed().unwrap(), "a seat going back wakes whoever waits");
        assert!(accounts.free("claude-code:a"));
        let _c = accounts.take("claude-code:a").unwrap();
        drop((b, other));
        assert_eq!(accounts.taken("claude-code:a"), 1);
        assert_eq!(accounts.taken("codex"), 0);
    }

    #[test]
    fn a_new_cap_keeps_the_seats_taken() {
        let accounts = Accounts::new(3);
        let seats: Vec<Seat> = (0..3).map(|_| accounts.take("k").unwrap()).collect();
        accounts.set_cap(1);
        assert!(accounts.take("k").is_none());
        assert_eq!(accounts.taken("k"), 3, "runs going keep their seats");
        drop(seats);
        let one = accounts.take("k").unwrap();
        assert!(accounts.take("k").is_none());
        accounts.set_cap(2);
        assert!(accounts.take("k").is_some());
        drop(one);
    }

    #[test]
    fn knows_which_agents_share_an_account() {
        let accounts = Accounts::default();
        accounts.join(1, "claude-code:a");
        accounts.join(2, "claude-code:a");
        accounts.join(3, "codex");
        assert_eq!(accounts.on("claude-code:a"), HashSet::from([1, 2]));
        accounts.join(2, "codex");
        accounts.leave(3);
        assert_eq!(accounts.on("codex"), HashSet::from([2]));
    }
}

//! Chains (COPL-189): a task that depends on another task of the same agent, on
//! the same repo, starts from where that one left off rather than cold. Behind
//! `resume_chains` in the agent's config, off by default.
//!
//! - **The worktree.** The next task gets the last one's (`workspace::continue_from`),
//!   on a branch of its own from the default branch as it is now, so its build
//!   output is still warm. The sweep keeps a closed task's worktree while a task
//!   waiting on it could still have it (`waited_on`, from the tasks depending on it
//!   rather than its whole board, COPL-212).
//! - **The session.** With `resume_chains` on, a worker's Claude Code run keeps
//!   its session (no `--no-session-persistence`), and the daemon keeps its id with
//!   the run under `state_dir/sessions/<KEY>.json`. The next task's run starts with
//!   `--resume <id>`, the session's file carried to the worktree's new place first,
//!   since Claude Code finds sessions by the directory they ran in (`carry_session`).
//!   Codex runs are `--ephemeral` and resume nothing: they get the worktree alone.
//!
//! A resumed session carries everything the last task did, so every turn of the
//! next is billed on that context, and it fills up sooner against the run ceiling.
//! It may cost more than it saves: resumed runs say so in their usage (COPL-71),
//! for comparing them.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::api::{Dependent, Task};

/// The task `task` carries on from: one it depends on (`deps`, those it names, as read), closed,
/// assigned to `me` (the agent) as `task` is. The one closed last, when there are several. They
/// share a board, so a repo.
pub fn before<'a>(task: &Task, deps: &'a [Task], me: &str) -> Option<&'a Task> {
    if !task.assignee_ids.iter().any(|a| a == me) {
        return None;
    }
    deps.iter()
        .filter(|t| task.depends_on.contains(&t.id) && !t.key.is_empty())
        .filter(|t| t.completed_at.is_some() && t.assignee_ids.iter().any(|a| a == me))
        .max_by(|a, b| a.completed_at.cmp(&b.completed_at))
}

/// Whether the sweep keeps the worktree of `done`, closed (COPL-189): a task that depends on it
/// (`dependents`, the open ones, `Api::dependents`) may still carry on in it. That is one not
/// parked in backlog, sharing an assignee with it, and with no worktree of its own yet (one that
/// has started elsewhere doesn't want it). Whatever the sweeping agent's `resume_chains`, since
/// agents share `code_dir` and another's may be on; with it off, the waiting task starts in a
/// worktree of its own and the next sweep takes this one.
pub fn waited_on(done: &Task, dependents: &[Dependent], code_dir: &Path) -> bool {
    dependents.iter().any(|t| {
        t.category != "backlog"
            && t.assignee_ids.iter().any(|a| done.assignee_ids.contains(a))
            && crate::workspace::valid_key(&t.key)
            && !code_dir.join("work").join(&t.key).exists()
    })
}

/// A run's session, kept with the run for the next task of its chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub run: String,
    pub session: String,
}

fn session_path(state_dir: &Path, key: &str) -> Option<PathBuf> {
    crate::workspace::valid_key(key).then(|| state_dir.join("sessions").join(format!("{key}.json")))
}

/// Keep the session `run` ended with on `key`, for whatever task carries on from it.
pub fn save_session(state_dir: &Path, key: &str, run: &str, session: &str) -> Result<()> {
    let path = session_path(state_dir, key).with_context(|| format!("{key:?} is not a task key"))?;
    let dir = path.parent().expect("a session path has a parent");
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let text = serde_json::to_string(&Session {
        run: run.into(),
        session: session.into(),
    })?;
    std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))
}

/// The session the last run on `key` kept, if it kept one.
pub fn load_session(state_dir: &Path, key: &str) -> Option<Session> {
    let text = std::fs::read_to_string(session_path(state_dir, key)?).ok()?;
    serde_json::from_str::<Session>(&text)
        .ok()
        .filter(|s| valid_session(&s.session))
}

/// Forget `key`'s session: its worktree is gone, or the next task has it now.
pub fn forget_session(state_dir: &Path, key: &str) {
    if let Some(path) = session_path(state_dir, key) {
        let _ = std::fs::remove_file(path);
    }
}

/// A session id as Claude Code makes them (a UUID): nothing that could be a path or a flag.
fn valid_session(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('-')
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Whether a code_command can keep and resume sessions: Claude Code's, started as `claude` itself,
/// so the flags go where Claude Code reads them (not to a wrapper in front of it).
pub fn resumable(argv: &[String]) -> bool {
    argv.first()
        .and_then(|p| Path::new(p).file_name())
        .is_some_and(|n| n == "claude")
}

/// A Claude Code argv that keeps its session, and with `resume` carries on in that one.
pub fn argv(code: &[String], resume: Option<&str>) -> Vec<String> {
    let mut argv: Vec<String> = code
        .iter()
        .filter(|a| *a != "--no-session-persistence")
        .cloned()
        .collect();
    if let Some(id) = resume {
        argv.splice(1..1, ["--resume".to_string(), id.to_string()]);
    }
    argv
}

/// Where Claude Code keeps its state: `CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn claude_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")))
}

/// The folder under `projects/` Claude Code keeps a directory's sessions in: its path with every
/// character but letters and digits a dash.
pub fn project_name(dir: &Path) -> String {
    dir.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Put `session`'s files where Claude Code looks for them from `to` (COPL-189): the worktree has
/// moved, and Claude Code finds a session by the directory it is resumed in. Copied, from
/// whichever project has it, with the folder of the same name a session may keep beside it.
pub fn carry_session(claude: &Path, session: &str, to: &Path) -> Result<()> {
    anyhow::ensure!(valid_session(session), "{session:?} is not a session id");
    let projects = claude.join("projects");
    let to = to.canonicalize().unwrap_or_else(|_| to.to_path_buf());
    let dest = projects.join(project_name(&to));
    let file = format!("{session}.jsonl");
    if dest.join(&file).exists() {
        return Ok(());
    }
    let from = std::fs::read_dir(&projects)
        .with_context(|| format!("reading {}", projects.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.join(&file).is_file())
        .with_context(|| format!("no session {session} under {}", projects.display()))?;
    std::fs::create_dir_all(&dest).with_context(|| format!("creating {}", dest.display()))?;
    std::fs::copy(from.join(&file), dest.join(&file)).with_context(|| format!("copying {file}"))?;
    let beside = from.join(session);
    if beside.is_dir() {
        copy_dir(&beside, &dest.join(session))?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &to.join(entry.file_name()))?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(depends: &[&str], assignees: &[&str]) -> Task {
        closed("t", "COPL-9", None, depends, assignees)
    }

    fn closed(id: &str, key: &str, at: Option<&str>, depends: &[&str], assignees: &[&str]) -> Task {
        serde_json::from_value(serde_json::json!({
            "id": id, "key": key, "boardId": "b", "title": "x", "updatedAt": "",
            "completedAt": at, "dependsOn": depends, "assigneeIds": assignees,
        }))
        .unwrap()
    }

    #[test]
    fn a_task_carries_on_from_the_agents_own_closed_task_closed_last() {
        let deps = [
            closed("a", "COPL-1", Some("2026-10-01T00:00:00Z"), &[], &["me"]),
            closed("b", "COPL-2", Some("2026-10-03T00:00:00Z"), &[], &["me", "sam"]),
            closed("c", "COPL-3", Some("2026-10-05T00:00:00Z"), &[], &["sam"]),
            closed("d", "COPL-4", None, &[], &["me"]),
        ];
        let pick = |names: &[&str], who: &[&str]| before(&task(names, who), &deps, "me").map(|t| t.key.clone());
        assert_eq!(pick(&["a", "b", "c"], &["me"]).as_deref(), Some("COPL-2"));
        assert_eq!(pick(&["a"], &["me"]).as_deref(), Some("COPL-1"));
        /* Someone else's, still open, or not one it waits on: cold. */
        assert_eq!(pick(&["c", "d"], &["me"]), None);
        assert_eq!(pick(&[], &["me"]), None);
        /* Not the agent's own task. */
        assert_eq!(pick(&["a"], &["sam"]), None);
    }

    #[test]
    fn a_closed_worktree_is_kept_while_its_chain_may_want_it() {
        let code = std::env::temp_dir().join(format!("copland-chain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&code);
        let done = closed("a", "COPL-1", Some("2026-10-01T00:00:00Z"), &[], &["me"]);
        let waiting = |category: &str, who: &str| -> Vec<Dependent> {
            serde_json::from_value(serde_json::json!([
                { "id": "n", "key": "COPL-5", "stageId": "s", "category": category, "assigneeIds": [who] },
            ]))
            .unwrap()
        };
        assert!(waited_on(&done, &waiting("todo", "me"), &code));
        assert!(waited_on(&done, &waiting("active", "me"), &code));
        assert!(!waited_on(&done, &waiting("backlog", "me"), &code));
        assert!(!waited_on(&done, &waiting("todo", "sam"), &code));
        assert!(!waited_on(&done, &[], &code));
        /* Started in a worktree of its own: it doesn't want this one. */
        std::fs::create_dir_all(code.join("work/COPL-5")).unwrap();
        assert!(!waited_on(&done, &waiting("todo", "me"), &code));
        let _ = std::fs::remove_dir_all(&code);
    }

    #[test]
    fn sessions_are_kept_by_task_and_forgotten() {
        let dir = std::env::temp_dir().join(format!("copland-sessions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load_session(&dir, "COPL-1"), None);
        save_session(&dir, "COPL-1", "run1", "0f3c-9a").unwrap();
        assert_eq!(
            load_session(&dir, "COPL-1"),
            Some(Session {
                run: "run1".into(),
                session: "0f3c-9a".into()
            })
        );
        assert!(save_session(&dir, "../x", "r", "s").is_err());
        forget_session(&dir, "COPL-1");
        assert_eq!(load_session(&dir, "COPL-1"), None);
        /* What isn't a session id is never handed to --resume. */
        std::fs::write(
            dir.join("sessions/COPL-2.json"),
            r#"{"run":"r","session":"--dangerously-skip-permissions"}"#,
        )
        .unwrap();
        assert_eq!(load_session(&dir, "COPL-2"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_runs_keep_their_session_and_resume_one() {
        let code = crate::runtime::Runtime::ClaudeCode.code_command();
        assert!(resumable(&code));
        assert!(!resumable(&crate::runtime::Runtime::Codex.code_command()));
        assert!(code.iter().any(|a| a == "--no-session-persistence"));
        let kept = argv(&code, None);
        assert!(!kept.iter().any(|a| a == "--no-session-persistence"));
        assert_eq!(kept.len(), code.len() - 1);
        let resumed = argv(&code, Some("abc-1"));
        assert_eq!(resumed[..3], ["claude", "--resume", "abc-1"]);
        assert_eq!(resumed[3..], kept[1..]);
    }

    #[test]
    fn a_session_follows_its_worktree() {
        let root = std::env::temp_dir().join(format!("copland-carry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let claude = root.join("claude");
        let (old, new) = (root.join("work/COPL-1"), root.join("work/COPL-2"));
        std::fs::create_dir_all(&new).unwrap();
        let was = claude.join("projects").join(project_name(&old));
        std::fs::create_dir_all(was.join("s-1/subagents")).unwrap();
        std::fs::write(was.join("s-1.jsonl"), "{}\n").unwrap();
        std::fs::write(was.join("s-1/subagents/a.jsonl"), "{}\n").unwrap();
        carry_session(&claude, "s-1", &new).unwrap();
        let now = claude.join("projects").join(project_name(&new.canonicalize().unwrap()));
        assert_eq!(std::fs::read_to_string(now.join("s-1.jsonl")).unwrap(), "{}\n");
        assert!(now.join("s-1/subagents/a.jsonl").is_file());
        /* Twice is fine; a session nowhere is an error, and so is one that isn't an id. */
        carry_session(&claude, "s-1", &new).unwrap();
        assert!(carry_session(&claude, "s-2", &new).is_err());
        assert!(carry_session(&claude, "../s-1", &new).is_err());
        assert_eq!(
            project_name(Path::new("/home/me/copland/work/COPL-1")),
            "-home-me-copland-work-COPL-1"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

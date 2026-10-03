//! A coding task's workspace (COPL-79): where its runs do their work.
//!
//! A task on a board with a repo connected gets one workspace, kept across
//! runs: a crashed, resumed or fix-up run continues the same branch. Locally
//! that is a git worktree. One clone per repo, shared by every task and agent
//! on this machine, and one worktree per task beside it:
//!
//! ```text
//! ~/copland/repos/berker-z/copland     the clone
//! ~/copland/work/COPL-79               the task's worktree, on copl-79-<slug>
//! ```
//!
//! A new worktree starts from the head of the repo's default branch as it is
//! right then, the task's base. A later run finds the worktree and carries on;
//! a worktree that was removed but whose branch still exists (here or on the
//! remote) is made again on that branch. Nothing here knows which runtime will
//! work in it: the daemon hands it the directory and the branch, and the
//! guide on Copland's side says how coding work is finished.
//!
//! It is all plain `git` (worktrees need 2.5). Cloning goes over https, so
//! pushing from the worktree uses whatever credential helper the machine has
//! (`gh auth setup-git`, for one).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use tokio::process::Command;

/// A realized workspace, for the runtime's environment and the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// "owner/name".
    pub repo: String,
    pub key: String,
    /// The worktree.
    pub dir: PathBuf,
    /// The clone it belongs to; its `.git` is where commits land.
    pub clone: PathBuf,
    pub branch: String,
    /// The commit the branch started from, or the merge base with the default branch for one made before.
    pub base: String,
    /// "origin/main".
    pub target: String,
    /// Made by this call, rather than found from an earlier run.
    pub fresh: bool,
}

/// Where a repo's clone and a task's worktree live under the code directory.
pub fn paths(code_dir: &Path, repo: &str, key: &str) -> Result<(PathBuf, PathBuf)> {
    if !valid_repo(repo) {
        bail!("{repo:?} is not a repo name");
    }
    if !valid_key(key) {
        bail!("{key:?} is not a task key");
    }
    Ok((code_dir.join("repos").join(repo), code_dir.join("work").join(key)))
}

/// "owner/name" with GitHub's characters, and neither part a dot path.
fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let ok = |s: &str| {
        !s.is_empty() && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "-._".contains(c))
    };
    ok(owner) && ok(name)
}

/// "COPL-79": letters and digits, a dash, a number.
fn valid_key(key: &str) -> bool {
    match key.split_once('-') {
        Some((board, n)) => {
            !board.is_empty()
                && board.chars().all(|c| c.is_ascii_alphanumeric())
                && !n.is_empty()
                && n.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// How long a branch's slug may be: whole words, up to this many characters.
const SLUG_MAX: usize = 40;

/// The branch a task's work goes on: its key, lowercased, then its title as a slug of whole
/// words, so Copland's webhook finds the task by the key and a person can tell branches apart.
pub fn branch_name(key: &str, title: &str) -> String {
    let mut slug = String::new();
    let mut word = String::new();
    for c in title.chars().flat_map(char::to_lowercase).chain([' ']) {
        if c.is_ascii_alphanumeric() {
            word.push(c);
            continue;
        }
        if word.is_empty() {
            continue;
        }
        let joined = if slug.is_empty() {
            word.len()
        } else {
            slug.len() + 1 + word.len()
        };
        if joined > SLUG_MAX {
            /* A first word longer than the whole slug is cut; any later one ends it. */
            if slug.is_empty() {
                slug = word[..SLUG_MAX].to_string();
            }
            break;
        }
        if !slug.is_empty() {
            slug.push('-');
        }
        slug.push_str(&word);
        word.clear();
    }
    let slug = slug.as_str();
    let key = key.to_lowercase();
    if slug.is_empty() { key } else { format!("{key}-{slug}") }
}

/// The repo over https, which the machine's git credential helper can push to.
pub fn github_remote(repo: &str) -> String {
    format!("https://github.com/{repo}.git")
}

/// Make the task's workspace, or find the one an earlier run left. `remote` is where to clone from.
pub async fn realize(code_dir: &Path, remote: &str, repo: &str, key: &str, title: &str) -> Result<Workspace> {
    let (clone, dir) = paths(code_dir, repo, key)?;
    if clone.join(".git").exists() {
        git(&clone, &["fetch", "--prune", "--quiet", "origin"]).await?;
    } else {
        let parent = clone.parent().expect("a clone path has a parent");
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating {}", parent.display()))?;
        let dest = clone.to_string_lossy().to_string();
        git(parent, &["clone", "--quiet", remote, &dest]).await?;
    }
    let target = default_branch(&clone).await?;

    if dir.join(".git").exists() {
        let branch = git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
        let base = git(&dir, &["merge-base", "HEAD", &target]).await?;
        return Ok(Workspace {
            repo: repo.into(),
            key: key.into(),
            dir,
            clone,
            branch,
            base,
            target,
            fresh: false,
        });
    }
    /* A stale entry for a worktree whose directory is gone would refuse the add. */
    git(&clone, &["worktree", "prune"]).await?;
    tokio::fs::create_dir_all(dir.parent().expect("a worktree path has a parent")).await?;
    let path = dir.to_string_lossy().to_string();

    /* The task's branch from before (the title may have changed since): the key is what matters. */
    if let Some(branch) = existing_branch(&clone, key).await? {
        if git(
            &clone,
            &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")],
        )
        .await
        .is_ok()
        {
            git(&clone, &["worktree", "add", "--quiet", &path, &branch]).await?;
        } else {
            git(
                &clone,
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    "--track",
                    "-b",
                    &branch,
                    &path,
                    &format!("origin/{branch}"),
                ],
            )
            .await?;
        }
        let base = git(&dir, &["merge-base", "HEAD", &target]).await?;
        return Ok(Workspace {
            repo: repo.into(),
            key: key.into(),
            dir,
            clone,
            branch,
            base,
            target,
            fresh: false,
        });
    }

    let branch = branch_name(key, title);
    let base = git(&clone, &["rev-parse", &target]).await?;
    git(
        &clone,
        &["worktree", "add", "--quiet", "--no-track", "-b", &branch, &path, &base],
    )
    .await?;
    Ok(Workspace {
        repo: repo.into(),
        key: key.into(),
        dir,
        clone,
        branch,
        base,
        target,
        fresh: true,
    })
}

/// Remove the task's worktree and its local branch once the task is closed. The remote branch is GitHub's
/// to delete (on merge). Nothing to do when there is none.
pub async fn remove(code_dir: &Path, repo: &str, key: &str) -> Result<bool> {
    let (clone, dir) = paths(code_dir, repo, key)?;
    if !dir.exists() {
        return Ok(false);
    }
    let branch = git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await.ok();
    let path = dir.to_string_lossy().to_string();
    if let Err(e) = git(&clone, &["worktree", "remove", "--force", &path]).await {
        /* Agents share the code directory: another one's sweep got there first. */
        if !dir.exists() {
            return Ok(false);
        }
        return Err(e);
    }
    if let Some(branch) = branch {
        let _ = git(&clone, &["branch", "-D", &branch]).await;
    }
    Ok(true)
}

/// The worktrees under the code directory, as (key, repo), by key: each directory of `work/` that is
/// named like a task key and is a worktree of one of the clones beside it. Anything else is left alone.
pub fn worktrees(code_dir: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(code_dir.join("work")) else {
        return Vec::new();
    };
    let mut found: Vec<(String, String)> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|key| valid_key(key))
        .filter_map(|key| repo_of(code_dir, &key).map(|repo| (key, repo)))
        .collect();
    found.sort();
    found
}

/// The repo a task's worktree belongs to, from its `.git` file, which names the clone
/// ("gitdir: <code_dir>/repos/<owner>/<name>/.git/worktrees/<key>"). None when it isn't one of ours.
fn repo_of(code_dir: &Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(code_dir.join("work").join(key).join(".git")).ok()?;
    let gitdir = PathBuf::from(text.strip_prefix("gitdir:")?.trim());
    let worktrees = gitdir.parent()?;
    let dot_git = worktrees.parent()?;
    if worktrees.file_name()? != "worktrees" || dot_git.file_name()? != ".git" {
        return None;
    }
    let clone = dot_git.parent()?;
    let repo = format!(
        "{}/{}",
        clone.parent()?.file_name()?.to_str()?,
        clone.file_name()?.to_str()?
    );
    /* By name rather than by prefix, so a code_dir reached through a symlink still matches. */
    let (expected, _) = paths(code_dir, &repo, key).ok()?;
    expected.join(".git").is_dir().then_some(repo)
}

/// "origin/main", from the clone's idea of the remote's HEAD.
async fn default_branch(clone: &Path) -> Result<String> {
    if let Ok(head) = git(clone, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).await {
        return Ok(head);
    }
    git(clone, &["remote", "set-head", "origin", "--auto"]).await?;
    git(clone, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).await
}

/// A branch, local or on origin, named for this task: its lowercased key, alone or followed by a dash.
async fn existing_branch(clone: &Path, key: &str) -> Result<Option<String>> {
    let prefix = key.to_lowercase();
    let refs = git(
        clone,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes/origin",
        ],
    )
    .await?;
    let mut remote = None;
    for r in refs.lines() {
        let (name, local) = match (r.strip_prefix("refs/heads/"), r.strip_prefix("refs/remotes/origin/")) {
            (Some(n), _) => (n, true),
            (_, Some(n)) => (n, false),
            _ => continue,
        };
        if name == prefix || name.starts_with(&format!("{prefix}-")) {
            if local {
                return Ok(Some(name.to_string()));
            }
            remote.get_or_insert_with(|| name.to_string());
        }
    }
    Ok(remote)
}

/// Run git in `dir`; its trimmed stdout, or an error with its stderr.
async fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .with_context(|| format!("running git {}", args.join(" ")))?;
    if !out.status.success() {
        return Err(anyhow!(
            "git {} in {}: {}",
            args.join(" "),
            dir.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_names_start_with_the_key() {
        assert_eq!(
            branch_name("COPL-79", "Daemon: realize a task's workspace"),
            "copl-79-daemon-realize-a-task-s-workspace"
        );
        assert_eq!(branch_name("COPL-1", "  ...  "), "copl-1");
        /* Whole words: the one that would pass 40 characters is left out, not cut. */
        assert_eq!(
            branch_name("COPL-81", "Level pill: the level's colour on its leftmost filled dot"),
            "copl-81-level-pill-the-level-s-colour-on-its"
        );
        assert_eq!(branch_name("A-1", &"x".repeat(60)), format!("a-1-{}", "x".repeat(40)));
        assert_eq!(branch_name("A-2", "Ünïcode & émoji 🎉 ok"), "a-2-n-code-moji-ok");
        assert!(branch_name("COPL-3", &"word ".repeat(30)).len() <= "copl-3-".len() + 40);
        assert!(!branch_name("COPL-3", &"word ".repeat(30)).ends_with('-'));
    }

    #[test]
    fn paths_refuse_what_could_escape() {
        let root = Path::new("/c");
        assert_eq!(
            paths(root, "berker-z/copland", "COPL-79").unwrap(),
            (
                PathBuf::from("/c/repos/berker-z/copland"),
                PathBuf::from("/c/work/COPL-79")
            )
        );
        assert!(paths(root, "../etc", "COPL-1").is_err());
        assert!(paths(root, "a/..", "COPL-1").is_err());
        assert!(paths(root, "a/b/c", "COPL-1").is_err());
        assert!(paths(root, "a/b", "../x").is_err());
        assert!(paths(root, "a/b", "COPL-1/x").is_err());
        assert!(paths(root, "a/b", "COPL").is_err());
    }

    /// A bare repo with one commit on main, standing in for GitHub.
    async fn origin(root: &Path) -> String {
        let seed = root.join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        for args in [
            vec!["init", "--quiet", "-b", "main"],
            vec![
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "first",
            ],
        ] {
            git(&seed, &args).await.unwrap();
        }
        let bare = root.join("origin.git").to_string_lossy().to_string();
        git(root, &["clone", "--quiet", "--bare", &seed.to_string_lossy(), &bare])
            .await
            .unwrap();
        bare
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-ws-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_task_gets_a_worktree_once_and_keeps_it() {
        let root = scratch("keep");
        let remote = origin(&root).await;
        let code = root.join("code");

        let first = realize(&code, &remote, "o/r", "COPL-5", "Do the thing").await.unwrap();
        assert!(first.fresh);
        assert_eq!(first.branch, "copl-5-do-the-thing");
        assert_eq!(first.target, "origin/main");
        assert_eq!(first.dir, code.join("work/COPL-5"));
        let head = git(&first.dir, &["rev-parse", "HEAD"]).await.unwrap();
        assert_eq!(head, first.base);

        /* A run commits; the next run finds the same worktree, branch and base, with the commit. */
        git(
            &first.dir,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "work",
            ],
        )
        .await
        .unwrap();
        let again = realize(&code, &remote, "o/r", "COPL-5", "A new title").await.unwrap();
        assert!(!again.fresh);
        assert_eq!(again.branch, first.branch);
        assert_eq!(again.base, first.base);
        assert_ne!(git(&again.dir, &["rev-parse", "HEAD"]).await.unwrap(), first.base);

        /* Two tasks share the clone, each with its own worktree. */
        let other = realize(&code, &remote, "o/r", "COPL-6", "Other").await.unwrap();
        assert_eq!(other.clone, first.clone);
        assert_ne!(other.dir, first.dir);

        /* Removed, then wanted again: back on the same branch, commit and all. */
        assert!(remove(&code, "o/r", "COPL-6").await.unwrap());
        assert!(!other.dir.exists());
        assert!(!remove(&code, "o/r", "COPL-6").await.unwrap());
        /* The sweep's list: worktrees only, by key, with the repo each belongs to. */
        std::fs::create_dir_all(code.join("work/notes")).unwrap();
        std::fs::create_dir_all(code.join("work/COPL-8")).unwrap();
        assert_eq!(worktrees(&code), vec![("COPL-5".to_string(), "o/r".to_string())]);
        assert!(worktrees(&root.join("nowhere")).is_empty());
        std::fs::remove_dir_all(&first.dir).unwrap();
        let back = realize(&code, &remote, "o/r", "COPL-5", "Whatever").await.unwrap();
        assert!(!back.fresh);
        assert_eq!(back.branch, "copl-5-do-the-thing");
        assert_eq!(git(&back.dir, &["log", "-1", "--format=%s"]).await.unwrap(), "work");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_branch_pushed_from_elsewhere_is_picked_up() {
        let root = scratch("pushed");
        let remote = origin(&root).await;
        let elsewhere = root.join("elsewhere");
        git(&root, &["clone", "--quiet", &remote, &elsewhere.to_string_lossy()])
            .await
            .unwrap();
        for args in [
            vec!["switch", "--quiet", "-c", "copl-7-started-elsewhere"],
            vec![
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "theirs",
            ],
            vec!["push", "--quiet", "origin", "copl-7-started-elsewhere"],
        ] {
            git(&elsewhere, &args).await.unwrap();
        }
        /* Not COPL-70's branch: whole keys only. */
        let code = root.join("code");
        let ws = realize(&code, &remote, "o/r", "COPL-7", "Started elsewhere")
            .await
            .unwrap();
        assert!(!ws.fresh);
        assert_eq!(ws.branch, "copl-7-started-elsewhere");
        assert_eq!(git(&ws.dir, &["log", "-1", "--format=%s"]).await.unwrap(), "theirs");
        let seventy = realize(&code, &remote, "o/r", "COPL-70", "Seventy").await.unwrap();
        assert!(seventy.fresh);
        assert_eq!(seventy.branch, "copl-70-seventy");
        let _ = std::fs::remove_dir_all(&root);
    }
}

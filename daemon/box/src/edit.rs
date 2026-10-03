//! Changing the agents in a `daemon.toml` that is already there, for the
//! agents screen: another runtime for one, one more, one fewer. The file is
//! edited as text, one `[[agent]]` table at a time, so whatever else is in it
//! (comments, other keys, a command widened by hand for another agent) stays
//! as it was. Only the lines that say what changes are rewritten, the way
//! setup writes them (`setup::render_binding`, `setup::render_agent`).
//!
//! There is no TOML editor among the box's dependencies, and they are frozen,
//! so this reads just enough TOML to find statements: a line that starts one
//! outside any string or array, which is how tables and keys begin. Each
//! agent's table is then read with `toml` itself to know which agent it is.

use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use copland_daemon_core::Config;

use crate::runtime::Runtime;
use crate::setup::{self, render_binding};

/// One statement: a table header, a key (to the end of its value, however many lines), or a
/// comment or blank line. Byte ranges into the text, whole lines with their newline.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Stmt {
    range: Range<usize>,
    kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    /// `[[agent]]`, `[x]`: the text between the outer brackets, trimmed.
    Header(String),
    /// `key = …`: the bare key.
    Key(String),
    Other,
}

/// Where each line starts and whether it starts outside any string, array or inline table.
fn line_starts(text: &str) -> Vec<(usize, bool)> {
    #[derive(PartialEq)]
    enum S {
        Normal,
        Comment,
        Basic,
        Literal,
        MlBasic,
        MlLiteral,
    }
    let b = text.as_bytes();
    let mut out = vec![(0, true)];
    let (mut s, mut depth, mut i) = (S::Normal, 0i32, 0usize);
    while i < b.len() {
        let c = b[i];
        let at = |p: &str| text[i..].starts_with(p);
        match s {
            S::Normal => match c {
                b'#' => s = S::Comment,
                b'"' if at("\"\"\"") => {
                    s = S::MlBasic;
                    i += 2;
                }
                b'"' => s = S::Basic,
                b'\'' if at("'''") => {
                    s = S::MlLiteral;
                    i += 2;
                }
                b'\'' => s = S::Literal,
                b'[' | b'{' => depth += 1,
                b']' | b'}' => depth -= 1,
                _ => {}
            },
            S::Comment if c == b'\n' => s = S::Normal,
            S::Basic | S::MlBasic if c == b'\\' => i += 1,
            S::Basic if c == b'"' || c == b'\n' => s = S::Normal,
            S::Literal if c == b'\'' || c == b'\n' => s = S::Normal,
            S::MlBasic if at("\"\"\"") => {
                s = S::Normal;
                i += 2;
            }
            S::MlLiteral if at("'''") => {
                s = S::Normal;
                i += 2;
            }
            _ => {}
        }
        if i < b.len() && b[i] == b'\n' {
            out.push((i + 1, depth <= 0 && (s == S::Normal || s == S::Comment)));
        }
        i += 1;
    }
    out.retain(|&(at, _)| at < text.len());
    out
}

fn statements(text: &str) -> Vec<Stmt> {
    let starts = line_starts(text);
    let mut out: Vec<Stmt> = Vec::new();
    for (n, &(at, top)) in starts.iter().enumerate() {
        let end = starts.get(n + 1).map_or(text.len(), |&(next, _)| next);
        if !top {
            if let Some(last) = out.last_mut() {
                last.range.end = end;
                continue;
            }
        }
        let line = text[at..end].trim();
        let kind = if let Some(rest) = line.strip_prefix('[') {
            let inner = rest.trim_start_matches('[');
            let name = inner.split(']').next().unwrap_or("").trim();
            Kind::Header(name.to_string())
        } else if let Some((key, _)) = line.split_once('=') {
            let key = key.trim();
            if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                Kind::Key(key.to_string())
            } else {
                Kind::Other
            }
        } else {
            Kind::Other
        };
        out.push(Stmt { range: at..end, kind });
    }
    out
}

/// An `[[agent]]` table in the file: where it is, and which agent it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentBlock {
    /// From its header to the next table's (or the end), trailing blank lines and comments included.
    pub range: Range<usize>,
    pub url: String,
    pub handle: String,
}

/// An agent across the file and the daemon: its instance and handle, case aside.
pub fn same_agent(url_a: &str, handle_a: &str, url_b: &str, handle_b: &str) -> bool {
    let n = |u: &str| u.trim().trim_end_matches('/').to_ascii_lowercase();
    let h = |h: &str| h.trim().trim_start_matches('@').to_ascii_lowercase();
    n(url_a) == n(url_b) && h(handle_a) == h(handle_b)
}

/// Every `[[agent]]` table, in order.
pub fn agent_blocks(text: &str) -> Result<Vec<AgentBlock>> {
    let stmts = statements(text);
    let mut out = Vec::new();
    for (n, s) in stmts.iter().enumerate() {
        if s.kind != Kind::Header("agent".into()) || !text[s.range.clone()].trim_start().starts_with("[[") {
            continue;
        }
        let end = stmts[n + 1..]
            .iter()
            .find(|t| matches!(t.kind, Kind::Header(_)))
            .map_or(text.len(), |t| t.range.start);
        let range = s.range.start..end;
        #[derive(serde::Deserialize)]
        struct One {
            agent: Vec<toml::Table>,
        }
        let one: One =
            toml::from_str(&text[range.clone()]).with_context(|| format!("reading agent table {}", out.len() + 1))?;
        let t = one.agent.into_iter().next().unwrap_or_default();
        let field = |k: &str| t.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        out.push(AgentBlock {
            range,
            url: field("url"),
            handle: field("handle"),
        });
    }
    Ok(out)
}

fn find(text: &str, url: &str, handle: &str) -> Result<AgentBlock> {
    agent_blocks(text)?
        .into_iter()
        .find(|b| same_agent(&b.url, &b.handle, url, handle))
        .with_context(|| format!("@{handle} isn't in daemon.toml any more"))
}

fn is_untested_note(line: &str) -> bool {
    let l = line.trim();
    l.starts_with(setup::UNTESTED_START) && l.contains(" template hasn't been run against Copland yet")
}

/// The agent's `client` and `command` replaced by `runtime`'s, where they were; the rest of
/// its table as it was.
pub fn set_runtime(text: &str, url: &str, handle: &str, runtime: Runtime) -> Result<String> {
    let block = find(text, url, handle)?;
    let body = &text[block.range.clone()];
    let stmts = statements(body);
    let Some(at) = stmts.iter().position(|s| s.kind == Kind::Key("command".into())) else {
        bail!("@{handle} has no command in daemon.toml");
    };
    let mut out = String::new();
    for (n, s) in stmts.iter().enumerate() {
        let piece = &body[s.range.clone()];
        match &s.kind {
            Kind::Key(k) if k == "client" => {}
            Kind::Other if is_untested_note(piece) => {}
            Kind::Key(k) if k == "command" && n == at => {
                let mut binding = render_binding(runtime);
                /* A command written on one line, with something after it on that line, keeps its newline. */
                if !piece.ends_with('\n') {
                    binding.pop();
                }
                out.push_str(&binding);
            }
            _ => out.push_str(piece),
        }
    }
    Ok(format!(
        "{}{}{}",
        &text[..block.range.start],
        out,
        &text[block.range.end..]
    ))
}

/// The agent's table taken out, with the blank line before it when there is one.
pub fn remove_agent(text: &str, url: &str, handle: &str) -> Result<String> {
    let block = find(text, url, handle)?;
    let mut start = block.range.start;
    /* One blank line between tables either way: the one before it goes when it has none after. */
    if text[..start].ends_with("\n\n") && !text[block.range.clone()].ends_with("\n\n") {
        start -= 1;
    }
    let mut out = format!("{}{}", &text[..start], &text[block.range.end..]);
    if !out.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    Ok(out)
}

/// `table` (an `[[agent]]` as `setup::render_agent` writes it) added at the end.
pub fn add_agent(text: &str, table: &str) -> String {
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }
    out.push_str(table);
    out
}

/// Write `text` as the config, once the daemon would take it: the file before it is kept as
/// a backup (`daemon.toml.bak`, or `.bak.2`…, never over an older one), the new one written
/// whole with mode 0600. Gives back the config as read, and the backup's path.
pub fn save(config: &Path, text: &str) -> Result<(Config, PathBuf)> {
    let parsed = Config::parse(text, |p| fs::read_to_string(p)).context("the changed daemon.toml")?;
    let backup = setup::backup_path(config);
    fs::copy(config, &backup).with_context(|| format!("keeping {} as {}", config.display(), backup.display()))?;
    setup::private_write(config, text)?;
    Ok((parsed, backup))
}

/// An agent's token, from a device code, in a file of its own beside the config (0600): its
/// name, or its name and a number when that file is taken.
pub fn save_agent_token(config: &Path, handle: &str, token: &str) -> Result<PathBuf> {
    let dir = config
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    setup::private_dir(dir)?;
    let base = setup::agent_name(handle);
    let path = (1..)
        .map(|n| if n == 1 { base.clone() } else { format!("{base}-{n}") })
        .filter(|n| n != "me")
        .map(|n| dir.join(format!("{n}.token")))
        .find(|p| !p.exists())
        .expect("some free name");
    setup::private_write(&path, &format!("{token}\n"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::setup::{Choice, Saved, SavedAgent, render_agent, render_config};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-edit-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A config as setup writes it, for two agents, with token files that exist.
    fn written(dir: &Path) -> String {
        for n in ["dev", "review", "me"] {
            fs::write(dir.join(format!("{n}.token")), "cpl_x\n").unwrap();
        }
        let saved = Saved {
            url: "http://localhost:5173".into(),
            owner: "me".into(),
            owner_token_file: dir.join("me.token"),
            agents: ["dev", "review"]
                .iter()
                .map(|n| SavedAgent {
                    handle: format!("me/{n}"),
                    token_file: dir.join(format!("{n}.token")),
                })
                .collect(),
        };
        let choice = Choice {
            runtime: Runtime::ClaudeCode,
            workdir: dir.display().to_string(),
        };
        render_config(&saved, &[choice.clone(), choice])
    }

    fn parse(text: &str) -> Config {
        Config::parse(text, |p| fs::read_to_string(p)).unwrap()
    }

    #[test]
    fn finds_statements_outside_strings_and_arrays() {
        let text = "a = 1 # [x]\ncommand = [\n  \"[[agent]]\",\n  '''\nx = 2\n''',\n]\n[[agent]] # c\nb = \"\"\"\n[y]\n\"\"\"\n";
        let kinds: Vec<Kind> = statements(text).into_iter().map(|s| s.kind).collect();
        assert_eq!(
            kinds,
            [
                Kind::Key("a".into()),
                Kind::Key("command".into()),
                Kind::Header("agent".into()),
                Kind::Key("b".into()),
            ]
        );
    }

    #[test]
    fn finds_each_agents_table() {
        let dir = scratch("blocks");
        let text = written(&dir);
        let blocks = agent_blocks(&text).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(
            (blocks[0].url.as_str(), blocks[0].handle.as_str()),
            ("http://localhost:5173", "me/dev")
        );
        assert_eq!(blocks[1].handle, "me/review");
        assert!(text[blocks[0].range.clone()].starts_with("[[agent]]\n"));
        assert_eq!(blocks[1].range.end, text.len());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn changes_one_agents_runtime_and_nothing_else() {
        let dir = scratch("runtime");
        let mut text = written(&dir);
        /* A hand edit elsewhere: a widened command for review and a comment of the person's own. */
        let narrow = "\"--tools\",\n  \"\",";
        let at = text.rfind(narrow).unwrap();
        text.replace_range(at..at + narrow.len(), "\"--tools\",\n  \"Bash\",");
        text.push_str("# mine, keep me\n");
        let codex = set_runtime(&text, "http://localhost:5173/", "@ME/dev", Runtime::Codex).unwrap();
        let c = parse(&codex);
        assert_eq!(c.agents[0].command, Runtime::Codex.command());
        assert_eq!(c.agents[0].client, "Codex");
        assert_eq!(c.agents[1].command, parse(&text).agents[1].command);
        assert!(codex.contains("Codex template hasn't been run"));
        assert!(codex.ends_with("# mine, keep me\n"));
        /* Only dev's table changed. */
        let (b0, b1) = (agent_blocks(&text).unwrap(), agent_blocks(&codex).unwrap());
        assert_eq!(text[..b0[0].range.start], codex[..b1[0].range.start]);
        assert_eq!(text[b0[1].range.clone()], codex[b1[1].range.clone()]);

        /* And back: the note goes, and the file is what it was. */
        let back = set_runtime(&codex, "http://localhost:5173", "me/dev", Runtime::ClaudeCode).unwrap();
        assert_eq!(back, text);
        assert!(set_runtime(&text, "http://localhost:5173", "me/nobody", Runtime::Codex).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rewrites_a_hand_written_one_line_command() {
        let dir = scratch("oneline");
        let text = format!(
            "poll_interval = 30\n\n[[agent]]\nurl = \"http://x\"\nhandle = \"me/dev\"\ntoken = \"cpl_a\"\ncommand = [\"sh\", \"-c\", \"echo ] {{prompt}}\"] # mine\nworkdir = \"{}\"\n",
            dir.display()
        );
        let out = set_runtime(&text, "http://x", "me/dev", Runtime::ClaudeCode).unwrap();
        let c = parse(&out);
        assert_eq!(c.agents[0].command, Runtime::ClaudeCode.command());
        assert_eq!(c.agents[0].client, "Claude Code");
        assert_eq!(c.poll_interval.as_secs(), 30);
        assert!(out.contains("workdir = "));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn adds_and_removes_agents() {
        let dir = scratch("addremove");
        let text = written(&dir);
        fs::write(dir.join("new.token"), "cpl_new\n").unwrap();
        let table = render_agent(
            "http://localhost:5173",
            "me/new",
            &dir.join("new.token"),
            &Choice {
                runtime: Runtime::Codex,
                workdir: dir.display().to_string(),
            },
        );
        let added = add_agent(&text, &table);
        let c = parse(&added);
        assert_eq!(c.agents.len(), 3);
        assert_eq!(c.agents[2].handle, "me/new");
        assert_eq!(c.agents[2].token.expose(), "cpl_new");
        assert!(added.starts_with(&text));

        let removed = remove_agent(&added, "http://localhost:5173", "me/new").unwrap();
        assert_eq!(removed, text);
        let one = remove_agent(&text, "http://localhost:5173", "me/dev").unwrap();
        let c = parse(&one);
        assert_eq!(c.agents.len(), 1);
        assert_eq!(c.agents[0].handle, "me/review");
        assert!(c.owner.is_some());
        /* The last one can't go: the daemon would refuse the file. */
        let none = remove_agent(&one, "http://localhost:5173", "me/review").unwrap();
        assert!(Config::parse(&none, |p| fs::read_to_string(p)).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saves_with_a_backup_and_refuses_what_the_daemon_would() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = scratch("save");
        let config = dir.join("daemon.toml");
        let text = written(&dir);
        fs::write(&config, &text).unwrap();
        let changed = set_runtime(&text, "http://localhost:5173", "me/dev", Runtime::Codex).unwrap();
        let (c, backup) = save(&config, &changed).unwrap();
        assert_eq!(c.agents[0].client, "Codex");
        assert_eq!(backup, dir.join("daemon.toml.bak"));
        assert_eq!(fs::read_to_string(&backup).unwrap(), text);
        assert_eq!(fs::read_to_string(&config).unwrap(), changed);
        assert_eq!(fs::metadata(&config).unwrap().permissions().mode() & 0o777, 0o600);
        /* A second save keeps the first backup. */
        let (_, second) = save(&config, &text).unwrap();
        assert_eq!(second, dir.join("daemon.toml.bak.2"));
        /* What the daemon wouldn't read is not written. */
        assert!(save(&config, "nonsense = [").is_err());
        assert_eq!(fs::read_to_string(&config).unwrap(), text);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_token_never_overwrites_a_file() {
        let dir = scratch("token");
        let config = dir.join("daemon.toml");
        fs::write(dir.join("dev.token"), "old\n").unwrap();
        let p = save_agent_token(&config, "me/dev", "cpl_new").unwrap();
        assert_eq!(p, dir.join("dev-2.token"));
        assert_eq!(fs::read_to_string(dir.join("dev.token")).unwrap(), "old\n");
        assert_eq!(fs::read_to_string(&p).unwrap(), "cpl_new\n");
        assert_eq!(
            save_agent_token(&config, "me/me", "cpl_x").unwrap(),
            dir.join("me-2.token")
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}

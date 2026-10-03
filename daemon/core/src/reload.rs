//! What a reload does: the agents running now against the agents a changed
//! `daemon.toml` asks for, as which loops go on untouched, which get a new
//! binding, which start and which stop. Pure, so it is tested on its own;
//! `Daemon::reload` carries it out.
//!
//! An agent is the same agent across the two when its instance and handle
//! (as configured, case aside) are. Anything else about it differing (its
//! command, workdir, client, token) is a rebind; so is every agent, when the
//! poll interval changed.

use crate::config::AgentConfig;

/// Indexes into the old and new lists of agents.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Plan {
    /// (old, new): the same in both; its loop goes on as it is.
    pub keep: Vec<(usize, usize)>,
    /// (old, new): the same agent with something changed; its loop ends (after its run, if one
    /// is going) and starts again with the new binding.
    pub rebind: Vec<(usize, usize)>,
    /// New: not running now.
    pub start: Vec<usize>,
    /// Old: gone from the config; its loop ends (after its run, if one is going).
    pub stop: Vec<usize>,
}

impl Plan {
    /// Nothing to do.
    pub fn is_empty(&self) -> bool {
        self.rebind.is_empty() && self.start.is_empty() && self.stop.is_empty()
    }
}

/// Who an agent is, for matching across a reload.
pub fn key(a: &AgentConfig) -> (String, String) {
    (
        a.url.trim_end_matches('/').to_ascii_lowercase(),
        a.handle.trim_start_matches('@').to_ascii_lowercase(),
    )
}

/// Match `new` against `old`. An agent listed twice is matched in order, one to one.
pub fn plan(old: &[AgentConfig], new: &[AgentConfig], poll_changed: bool) -> Plan {
    let mut taken = vec![false; old.len()];
    let mut out = Plan::default();
    for (n, agent) in new.iter().enumerate() {
        let k = key(agent);
        match (0..old.len()).find(|&o| !taken[o] && key(&old[o]) == k) {
            Some(o) => {
                taken[o] = true;
                if !poll_changed && old[o] == *agent {
                    out.keep.push((o, n));
                } else {
                    out.rebind.push((o, n));
                }
            }
            None => out.start.push(n),
        }
    }
    out.stop = (0..old.len()).filter(|&o| !taken[o]).collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Secret;

    fn agent(handle: &str, command: &str) -> AgentConfig {
        AgentConfig {
            url: "http://x".into(),
            handle: handle.into(),
            token: Secret::new("cpl_t"),
            command: vec![command.into()],
            workdir: "/tmp".into(),
            client: "Claude Code".into(),
            code_command: None,
            writable: Vec::new(),
            code_dir: "/tmp/copland-code".into(),
            max_runs: 10,
        }
    }

    #[test]
    fn keeps_what_did_not_change() {
        let old = [agent("me/dev", "claude"), agent("me/review", "claude")];
        let p = plan(&old, &old.clone(), false);
        assert_eq!(p.keep, [(0, 0), (1, 1)]);
        assert!(p.is_empty());
    }

    #[test]
    fn rebinds_a_changed_runtime_and_starts_and_stops_the_rest() {
        let old = [
            agent("me/dev", "claude"),
            agent("me/gone", "claude"),
            agent("me/review", "claude"),
        ];
        let mut codex = agent("ME/Review", "codex");
        codex.client = "Codex".into();
        let new = [agent("me/new", "claude"), codex, agent("me/dev", "claude")];
        let p = plan(&old, &new, false);
        assert_eq!(p.keep, [(0, 2)]);
        assert_eq!(p.rebind, [(2, 1)]);
        assert_eq!(p.start, [0]);
        assert_eq!(p.stop, [1]);
        assert!(!p.is_empty());
    }

    #[test]
    fn a_new_token_workdir_or_instance_counts() {
        let old = [agent("me/dev", "claude")];
        let mut token = agent("me/dev", "claude");
        token.token = Secret::new("cpl_new");
        assert_eq!(plan(&old, &[token], false).rebind, [(0, 0)]);
        let mut dir = agent("me/dev", "claude");
        dir.workdir = "/var".into();
        assert_eq!(plan(&old, &[dir], false).rebind, [(0, 0)]);
        /* Another instance is another agent, even under the same handle. */
        let mut elsewhere = agent("me/dev", "claude");
        elsewhere.url = "http://y".into();
        let p = plan(&old, &[elsewhere], false);
        assert_eq!((p.start, p.stop), (vec![0], vec![0]));
    }

    #[test]
    fn a_new_poll_interval_rebinds_everyone() {
        let old = [agent("me/dev", "claude"), agent("me/review", "claude")];
        let p = plan(&old, &old.clone(), true);
        assert_eq!(p.rebind, [(0, 0), (1, 1)]);
        assert!(p.keep.is_empty());
    }

    #[test]
    fn duplicates_pair_off_in_order() {
        let old = [agent("me/dev", "a"), agent("me/dev", "b")];
        let new = [agent("me/dev", "b")];
        let p = plan(&old, &new, false);
        assert_eq!(p.rebind, [(0, 0)]);
        assert_eq!(p.stop, [1]);
    }
}

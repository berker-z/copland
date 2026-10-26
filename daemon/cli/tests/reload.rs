//! The headless daemon reads its config again on SIGHUP and on `copland-daemon reload` (COPL-197),
//! and goes on as it was when the file doesn't load.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_copland-daemon");

fn toml(dir: &Path, handles: &[&str]) -> String {
    /* Nothing listens on port 9: each loop's first call fails and it waits to poll again. */
    handles
        .iter()
        .map(|h| {
            format!(
                "[[agent]]\nurl=\"http://127.0.0.1:9\"\nhandle=\"{h}\"\ntoken=\"cpl_t\"\ncommand=[\"claude\"]\nworkdir=\"{}\"\n",
                dir.display()
            )
        })
        .collect()
}

fn run(dir: &Path, config: &Path, args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .arg("--config")
        .arg(config)
        .env("XDG_RUNTIME_DIR", dir)
        .output()
        .unwrap()
}

/// The handles `status --json` lists, once the daemon answers.
fn agents(dir: &Path, config: &Path) -> Option<Vec<String>> {
    let out = run(dir, config, &["status", "--json"]);
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).unwrap();
    /* No JSON crate here: the configured handles, in order. */
    Some(
        text.split("\"configured\":\"")
            .skip(1)
            .map(|s| s[..s.find('"').unwrap()].to_string())
            .collect(),
    )
}

fn until(what: &str, mut ok: impl FnMut() -> bool) {
    let start = Instant::now();
    while !ok() {
        assert!(start.elapsed() < Duration::from_secs(10), "never: {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn sighup_and_reload_read_the_config_again() {
    /* /tmp, not $TMPDIR: macOS's is long enough to push the socket past SUN_LEN. */
    let dir = PathBuf::from("/tmp").join(format!("copland-cli-reload-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let config = dir.join("daemon.toml");
    std::fs::write(&config, toml(&dir, &["me/dev"])).unwrap();
    let daemon = Daemon(
        Command::new(BIN)
            .arg("--config")
            .arg(&config)
            .env("XDG_RUNTIME_DIR", &dir)
            .env("XDG_STATE_HOME", &dir)
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    until("the daemon serves its status", || {
        agents(&dir, &config) == Some(vec!["me/dev".into()])
    });

    /* SIGHUP: an agent added to the file starts. */
    std::fs::write(&config, toml(&dir, &["me/dev", "me/new"])).unwrap();
    let hup = Command::new("kill")
        .args(["-HUP", &daemon.0.id().to_string()])
        .status()
        .unwrap();
    assert!(hup.success());
    until("SIGHUP started me/new", || {
        agents(&dir, &config) == Some(vec!["me/dev".into(), "me/new".into()])
    });

    /* `reload` with a file that doesn't load: exit 1, and nothing changed. */
    std::fs::write(&config, "[[agent]\n").unwrap();
    let out = run(&dir, &config, &["reload"]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("loading the config"), "{err}");
    assert_eq!(agents(&dir, &config), Some(vec!["me/dev".into(), "me/new".into()]));

    /* `reload` once it's fixed: says what changed. */
    std::fs::write(&config, toml(&dir, &["me/dev"])).unwrap();
    let out = run(&dir, &config, &["reload"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        format!(
            "reloaded {}\nstopped (after its runs): @me/new\nas they were: @me/dev\n",
            config.display()
        )
    );
    until("me/new gone", || agents(&dir, &config) == Some(vec!["me/dev".into()]));
    drop(daemon);
    let _ = std::fs::remove_dir_all(&dir);
}

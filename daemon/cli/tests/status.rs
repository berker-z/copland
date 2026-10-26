//! `copland-daemon status`, `hold` and `release` with no daemon running the config exit 3
//! (COPL-185, COPL-186); the rest is tested against a served socket in core's `client`.

use std::process::Command;

#[test]
fn status_with_no_daemon_exits_3() {
    /* /tmp, not $TMPDIR: macOS's is long enough to push the socket past SUN_LEN. */
    let dir = std::path::PathBuf::from("/tmp").join(format!("copland-cli-status-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let config = dir.join("daemon.toml");
    for args in [
        &["status"][..],
        &["status", "--json"],
        &["status", "--watch", "--json"],
        &["hold", "me/dev"],
        &["release", "@me/dev"],
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_copland-daemon"))
            .args(args)
            .arg("--config")
            .arg(&config)
            .env("XDG_RUNTIME_DIR", &dir)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(3), "{args:?}: {out:?}");
        assert!(out.stdout.is_empty(), "{args:?}: {out:?}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains("no daemon is running"), "{err}");
        assert!(err.contains("copland-daemon --config"), "{err}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

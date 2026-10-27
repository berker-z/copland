//! Under Nix the service is the home-manager module's (COPL-218): `--install-service` and
//! `--uninstall-service` on a daemon in the store write and remove nothing, and print the module
//! to add instead. The store here is a scratch one (`NIX_STORE`), with a copy of the daemon in it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const BIN: &str = env!("CARGO_BIN_EXE_copland-daemon");

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("copland-nix-cli-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// The daemon copied into `store`, as a package's bin would have it.
fn in_store(store: &Path) -> PathBuf {
    let program = store.join("abc-copland-0.5.0/bin/copland-daemon");
    fs::create_dir_all(program.parent().unwrap()).unwrap();
    fs::copy(BIN, &program).unwrap();
    program
}

fn run(program: &Path, dir: &Path, args: &[&str]) -> Output {
    Command::new(program)
        .args(args)
        .env("NIX_STORE", dir.join("store"))
        .env("HOME", dir.join("home"))
        .env("XDG_CONFIG_HOME", dir.join("config"))
        .env("XDG_RUNTIME_DIR", dir.join("run"))
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .output()
        .unwrap()
}

/// Every file under `dir`, to see that nothing was added or removed.
fn files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(files(&p));
        } else {
            out.push(p);
        }
    }
    out.sort();
    out
}

#[test]
fn install_and_uninstall_under_nix_write_nothing_and_print_the_module() {
    let dir = scratch();
    let program = in_store(&dir.join("store"));
    let config = dir.join("config/copland/daemon.toml");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, "").unwrap();

    let out = run(&program, &dir, &["--install-service"]);
    let said = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{said}");
    assert!(
        said.contains("is from the Nix store, so its service is home-manager's: nothing was written"),
        "{said}"
    );
    assert!(
        said.contains("  imports = [ inputs.copland.homeManagerModules.default ];\n"),
        "{said}"
    );
    assert!(said.contains("  services.copland.enable = true;\n"), "{said}");
    /* The default config isn't named, and with no display there's no tray line. */
    assert!(!said.contains("configFile") && !said.contains("tray.enable"), "{said}");
    assert_eq!(
        files(&dir.join("config")),
        std::slice::from_ref(&config),
        "no unit written"
    );

    /* A config of its own is named in the module. */
    let other = dir.join("other.toml");
    fs::write(&other, "").unwrap();
    let out = run(
        &program,
        &dir,
        &["--install-service", "--config", other.to_str().unwrap()],
    );
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(
        said.contains(&format!(
            "services.copland.configFile = \"{}\";",
            fs::canonicalize(&other).unwrap().display()
        )),
        "{said}"
    );

    /* A unit an earlier install wrote stays, and is said to be in the way. */
    let unit = dir.join("config/systemd/user/copland-daemon.service");
    fs::create_dir_all(unit.parent().unwrap()).unwrap();
    fs::write(
        &unit,
        "[Service]\nExecStart=/nix/store/old/bin/copland-daemon --headless\n",
    )
    .unwrap();
    let out = run(&program, &dir, &["--uninstall-service"]);
    let said = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{said}");
    assert!(said.contains("nothing was stopped or removed"), "{said}");
    assert!(said.contains("was written by an earlier --install-service"), "{said}");
    assert!(unit.exists(), "not removed");
    let out = run(&program, &dir, &["--install-service"]);
    assert!(String::from_utf8_lossy(&out.stdout).contains(&format!("rm {}", unit.display())));
    assert_eq!(
        fs::read_to_string(&unit).unwrap(),
        "[Service]\nExecStart=/nix/store/old/bin/copland-daemon --headless\n",
        "not rewritten"
    );
    fs::remove_dir_all(&dir).unwrap();
}

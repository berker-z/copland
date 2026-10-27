//! Starting a program at login through an XDG autostart entry (COPL-65, moved here by COPL-201),
//! and finding the programs shipped beside this one. The box writes its own entry from its menu,
//! and the tray's from the same menu; `copland-daemon --setup` offers the tray's. Linux and the
//! other XDG desktops only: macOS has login items instead.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};

use crate::stable::{Places, Unstable};

/// The tray's binary, and its app id.
pub const TRAY: &str = "copland-tray";

/// `$XDG_CONFIG_HOME/autostart` (`~/.config/autostart`), from the environment it is given.
pub fn dir(xdg_config_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    match xdg_config_home.filter(|p| p.is_absolute()) {
        Some(c) => Some(c.join("autostart")),
        None => home.map(|h| h.join(".config").join("autostart")),
    }
}

/// The autostart entry for `app_id`, in this process's environment.
pub fn file(app_id: &str) -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    dir(xdg.as_deref(), home.as_deref()).map(|d| d.join(format!("{app_id}.desktop")))
}

/// What an entry runs, and anything worth saying about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exec {
    pub program: String,
    /// Set when the program is a path that the next upgrade will leave behind, or isn't found.
    pub caveat: Option<String>,
    /// Set when the program is somewhere it won't stay (COPL-219): `set` writes no entry for it.
    pub unstable: Option<Unstable>,
}

/// The program `name` to start at login. On PATH first, as found there, not resolved: a Nix
/// profile's `bin/copland-box` is a link that moves to each new build, where the store path it
/// points at stays the old one. A PATH directory that won't stay (`stable::why` on `places`: a
/// tarball's versioned dir, a download or temporary one) is passed over. Without it on PATH,
/// `fallback` (this binary, or the one beside it), said plainly when it is a store path (a later
/// build won't be the one that starts), and refused (`unstable`) when it won't stay; without
/// that either, `name` by name.
pub fn exec(name: &str, path_var: Option<&str>, fallback: Option<&Path>, places: &Places) -> Exec {
    let on_path = path_var.into_iter().flat_map(|p| p.split(':')).find_map(|dir| {
        let c = Path::new(dir).join(name);
        (!dir.is_empty()
            && Path::new(dir).is_absolute()
            && is_executable(&c)
            && crate::stable::why(&c, places).is_none())
        .then_some(c)
    });
    if let Some(p) = on_path {
        return Exec {
            program: p.display().to_string(),
            caveat: None,
            unstable: None,
        };
    }
    let Some(cur) = fallback else {
        return Exec {
            program: name.into(),
            caveat: Some(format!("not on PATH; the entry runs {name} by name")),
            unstable: None,
        };
    };
    let s = cur.display().to_string();
    if s.starts_with("/nix/store/") {
        return Exec {
            program: s,
            caveat: Some("this exact build, from the Nix store: install it in a profile to follow upgrades".into()),
            unstable: None,
        };
    }
    match crate::stable::on_disk(cur, places) {
        Ok(()) => Exec {
            program: s,
            caveat: None,
            unstable: None,
        },
        Err(u) => Exec {
            program: s,
            caveat: Some(format!("{}: install it to ~/.local/bin first", u.why)),
            unstable: Some(u),
        },
    }
}

/// `name` beside `exe` (the running binary), when it is there and executable: the tarball's
/// bin/, the Nix package's bin/ and a build's target/ all ship the programs together.
pub fn beside(exe: Option<&Path>, name: &str) -> Option<PathBuf> {
    exe.and_then(Path::parent)
        .map(|d| d.join(name))
        .filter(|p| is_executable(p))
}

/// Exec for `name` from this process: on PATH, else beside the running binary, else by name.
pub fn here(name: &str) -> Exec {
    let current = std::env::current_exe().ok();
    exec(
        name,
        std::env::var("PATH").ok().as_deref(),
        beside(current.as_deref(), name).as_deref(),
        &Places::here(),
    )
}

/// `name` as this process would find it: on PATH, else beside the running binary. None when it
/// is in neither.
pub fn find(name: &str) -> Option<PathBuf> {
    let e = here(name);
    e.program.contains('/').then(|| PathBuf::from(e.program))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// One argument of `Exec=`, quoted when it must be (the desktop entry spec's rules).
pub fn quote(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+=:,@".contains(c));
    if plain {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    for c in arg.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    /* `%` is a field code in Exec, so a literal one is doubled. */
    out.replace('%', "%%")
}

/// What an entry says beyond what it runs.
#[derive(Debug, Clone, Copy)]
pub struct About<'a> {
    pub name: &'a str,
    pub comment: &'a str,
    pub icon: &'a str,
    /// Who wrote it and what removes it, as a comment in the file.
    pub written_by: &'a str,
}

/// The box's entry.
pub const BOX: About<'static> = About {
    name: "Copland",
    comment: "Your Copland agents, on this machine",
    icon: "copland-box",
    written_by: "copland-box (menu › settings › start at login); that switch removes it",
};

/// The tray's entry.
pub const TRAY_ENTRY: About<'static> = About {
    name: "Copland tray",
    comment: "What your Copland agents are doing, in the system tray",
    icon: "copland-box",
    written_by: "copland-box (menu › settings › tray at login) or copland-daemon --setup; that switch removes it",
};

/// The entry: the program, and `--config` when it isn't the default.
pub fn entry(about: &About, program: &str, config: Option<&Path>) -> String {
    let mut exec = quote(program);
    if let Some(c) = config {
        exec.push_str(" --config ");
        exec.push_str(&quote(&c.display().to_string()));
    }
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={}\n\
         Comment={}\n\
         Exec={exec}\n\
         Icon={}\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n\
         # Written by {}.\n",
        about.name, about.comment, about.icon, about.written_by
    )
}

/// Write the entry at `file`, or remove it (removing what isn't there is fine). Refused, writing
/// nothing, for a program somewhere it won't stay (`Exec::unstable`), saying how to install it.
pub fn set(file: &Path, on: bool, about: &About, config: Option<&Path>, exec: &Exec) -> Result<()> {
    if !on {
        return match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(e).with_context(|| format!("removing {}", file.display()))
            }
            _ => Ok(()),
        };
    }
    if let Some(u) = &exec.unstable {
        return Err(u.clone().into());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
    }
    std::fs::write(file, entry(about, &exec.program, config)).with_context(|| format!("writing {}", file.display()))
}

/// `config` for an entry's `--config`: None when it is the default one.
pub fn non_default(config: &Path) -> Option<&Path> {
    (config != crate::config::default_config_path()).then_some(config)
}

/// Whether this session has a display a tray could show on.
pub fn graphical(display: Option<&str>, wayland_display: Option<&str>) -> bool {
    display.is_some_and(|d| !d.is_empty()) || wayland_display.is_some_and(|d| !d.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_where_the_entry_goes_and_what_it_runs() {
        assert_eq!(
            dir(Some(Path::new("/x/conf")), Some(Path::new("/home/me"))),
            Some(PathBuf::from("/x/conf/autostart"))
        );
        assert_eq!(
            dir(Some(Path::new("relative")), Some(Path::new("/home/me"))),
            Some(PathBuf::from("/home/me/.config/autostart"))
        );
        assert_eq!(dir(None, None), None);

        let scratch = std::env::temp_dir().join(format!("copland-autostart-core-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        let bin = scratch.join("profile/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = format!("/nonexistent:{}", bin.display());
        /* The scratch dir is a temporary one, so the places here leave temporary dirs out. */
        let places = Places {
            home: Some("/home/me".into()),
            ..Places::default()
        };
        /* Not on PATH: the fallback, with what's odd about it. */
        let e = exec(
            "copland-box",
            Some(&path),
            Some(Path::new("/nix/store/abc-copland-box/bin/copland-box")),
            &places,
        );
        assert_eq!(e.program, "/nix/store/abc-copland-box/bin/copland-box");
        assert!(e.caveat.unwrap().contains("Nix store"));
        assert!(
            exec(
                "copland-box",
                None,
                Some(Path::new("/usr/local/bin/copland-box")),
                &places
            )
            .caveat
            .is_none()
        );
        /* Somewhere it won't stay (COPL-219): refused, with how to install it. */
        let build = exec(
            TRAY,
            None,
            Some(Path::new("/src/daemon/target/release/copland-tray")),
            &places,
        );
        assert!(build.caveat.as_deref().unwrap().contains("target/"));
        assert_eq!(build.unstable.as_ref().unwrap().why, crate::stable::Why::Build);
        let tarball = exec(
            TRAY,
            None,
            Some(Path::new("/home/me/copland-box-0.5.0-linux-x86_64/bin/copland-tray")),
            &places,
        );
        assert!(tarball.unstable.unwrap().fix.contains("install -m 755"));
        /* Nowhere: by name, saying so. */
        assert_eq!(
            exec(TRAY, Some(&path), None, &places),
            Exec {
                program: TRAY.into(),
                caveat: Some("not on PATH; the entry runs copland-tray by name".into()),
                unstable: None,
            }
        );
        /* On PATH (a profile's link): that, unresolved. */
        let tray = bin.join(TRAY);
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::write(&tray, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&tray, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let e = exec(
            TRAY,
            Some(&path),
            Some(Path::new("/nix/store/abc/bin/copland-tray")),
            &places,
        );
        assert_eq!(
            e,
            Exec {
                program: tray.display().to_string(),
                caveat: None,
                unstable: None,
            }
        );
        /* A PATH dir that won't stay is passed over. */
        let temp = Places {
            temp: vec![scratch.clone()],
            ..places.clone()
        };
        assert_eq!(exec(TRAY, Some(&path), None, &temp).program, TRAY);
        /* Beside a binary: only when it is there. */
        assert_eq!(beside(Some(&bin.join("copland-box")), TRAY), Some(tray.clone()));
        assert_eq!(beside(Some(&bin.join("copland-box")), "copland-nope"), None);
        assert_eq!(beside(None, TRAY), None);

        /* Written and removed, under a scratch directory only. */
        let file = scratch.join("autostart").join(format!("{TRAY}.desktop"));
        set(
            &file,
            true,
            &TRAY_ENTRY,
            Some(Path::new("/tmp/my conf/daemon.toml")),
            &e,
        )
        .unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("[Desktop Entry]\nType=Application\nName=Copland tray\n"));
        assert!(text.contains(&format!(
            "Exec={} --config \"/tmp/my conf/daemon.toml\"\n",
            tray.display()
        )));
        set(&file, false, &TRAY_ENTRY, None, &e).unwrap();
        assert!(!file.exists());
        set(&file, false, &TRAY_ENTRY, None, &e).unwrap();
        /* An unstable program gets no entry; turning it off still removes one. */
        let err = set(&file, true, &TRAY_ENTRY, None, &build).unwrap_err();
        assert!(err.to_string().contains("nothing was written"), "{err}");
        assert!(!file.exists());
        set(&file, false, &TRAY_ENTRY, None, &build).unwrap();
        std::fs::remove_dir_all(&scratch).unwrap();
        assert_eq!(quote("a$b"), "\"a\\$b\"");
        assert_eq!(quote("50%"), "\"50%%\"");
    }

    #[test]
    fn the_box_entry_is_what_it_was() {
        assert_eq!(
            entry(&BOX, "/usr/bin/copland-box", None),
            "[Desktop Entry]\nType=Application\nName=Copland\nComment=Your Copland agents, on this machine\n\
             Exec=/usr/bin/copland-box\nIcon=copland-box\nTerminal=false\nX-GNOME-Autostart-enabled=true\n\
             # Written by copland-box (menu › settings › start at login); that switch removes it.\n"
        );
    }

    #[test]
    fn a_session_is_graphical_with_either_display() {
        assert!(graphical(Some(":0"), None));
        assert!(graphical(None, Some("wayland-1")));
        assert!(!graphical(Some(""), None));
        assert!(!graphical(None, None));
    }
}

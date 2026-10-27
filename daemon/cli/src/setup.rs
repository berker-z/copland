//! `copland-daemon --setup`: the box's setup on a terminal (COPL-177), with plain
//! prompts on stdin and stdout. The address, approving this machine in the
//! browser (a device code), a runtime and a workdir per agent, whether to start
//! the tray at login (COPL-201; not asked under Nix, where it ends with the
//! home-manager module instead, COPL-218), then daemon.toml written and the
//! preflight run on it, offering the fixes it can run. The
//! parts are core's (`copland_daemon_core::setup`), the same the box's wizard
//! drives, so the config and the resume note are the box's too.

use std::io::{self, BufRead, IsTerminal as _, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use copland_daemon_core::api::{Api, ApiError, DevicePoll};
use copland_daemon_core::autostart::{self, Exec, TRAY};
use copland_daemon_core::runtime::{self, Found};
use copland_daemon_core::service::{self, NixManaged, Service};
use copland_daemon_core::setup::{self, Choice, Saved};
use copland_daemon_core::{Config, preflight};

/// What the daemon calls itself on the approval page and in the notes it writes.
pub const CLIENT: &str = "copland-daemon";
/// RFC 8628's step when the server says to slow down, as in the box.
const SLOW_DOWN: u64 = 5;

pub async fn run(config: &Path, url: Option<&str>) -> Result<()> {
    if !io::stdin().is_terminal() {
        bail!(
            "--setup asks its questions on a terminal, and stdin isn't one: run \
             `copland-daemon --setup [--config FILE] [--url ADDRESS]` in one, \
             or write daemon.toml by hand as daemon/README.md says"
        );
    }
    let mut input = io::stdin().lock();
    let mut out = io::stdout();
    let saved = match resume(config) {
        Resume::Saved(saved) => {
            writeln!(
                out,
                "Picking up the setup approved as @{} at {} ({}).",
                saved.owner,
                saved.url,
                setup::pending_path(config).display()
            )?;
            saved
        }
        Resume::Fresh(note) => {
            if let Some(note) = note {
                writeln!(out, "{note}; starting over.")?;
            }
            if config.exists() {
                writeln!(
                    out,
                    "{} is there already: it is kept as a backup when the new one is written.",
                    config.display()
                )?;
            }
            approve(&mut input, &mut out, config, url).await?
        }
    };
    if saved.agents.is_empty() {
        bail!(
            "no agents to run: make one in Copland (settings › agents), then delete {} and run {CLIENT} --setup again",
            setup::pending_path(config).display()
        );
    }

    writeln!(out, "\nLooking for runtimes on PATH…")?;
    let found = runtime::detect().await;
    if found.is_empty() {
        let hints: Vec<String> = runtime::Runtime::ALL
            .iter()
            .map(|r| format!("{} ({})", r.name(), r.install_hint()))
            .collect();
        bail!(
            "no runtime on PATH; install one of {}, then run {CLIENT} --setup again: it picks up from here",
            hints.join(" or ")
        );
    }
    let choices = choose(&mut input, &mut out, &saved, &found)?;
    let graphical = autostart::graphical(
        std::env::var("DISPLAY").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
    );
    /* Under Nix the service and the tray at login are the home-manager module's (COPL-218):
    nothing is asked or written, the end says what to add. */
    let program = std::env::current_exe().context("finding this binary")?;
    let nix = service::nix_managed(&program);
    /* Only where there is a tray to start: it ships beside the daemon on Linux. */
    let tray = match (
        cfg!(target_os = "linux") && !nix,
        autostart::find(TRAY),
        autostart::file(TRAY),
    ) {
        (true, Some(_), Some(file)) => Some((ask_tray(&mut input, &mut out, graphical)?, file)),
        _ => None,
    };
    drop(input);

    if let Some(b) = setup::write_config(config, CLIENT, &saved, &choices)? {
        writeln!(out, "Kept the old config as {}.", b.display())?;
    }
    writeln!(out, "Wrote {}.\n", config.display())?;
    if let Some((on, file)) = tray {
        /* A tray somewhere it won't stay gets no entry (COPL-219): said, and setup goes on. */
        match tray_at_login(&file, on, config, &autostart::here(TRAY)) {
            Ok(said) => writeln!(out, "{said}")?,
            Err(e) => writeln!(out, "{TRAY} won't start at login: {e:#}")?,
        }
    }
    let loaded = Config::load(config).context("reading back the config just written")?;
    let failed = check(&loaded, true).await?;
    writeln!(
        out,
        "\nConnect your own Claude Code or claude.ai to {}/mcp and pick \"you\" when it asks who.",
        saved.url
    )?;
    if failed > 0 {
        writeln!(
            out,
            "{failed} check(s) still fail; `{CLIENT} --check --fix` offers the fixes again."
        )?;
    }
    if nix {
        let service = service::installed();
        let nix = NixManaged::here(&program, Some(config), graphical);
        write!(out, "{}", nix_ending(service.as_ref(), &nix))?;
    } else {
        writeln!(
            out,
            "Start the daemon with `{CLIENT}`, or run it as a service with `{CLIENT} --install-service`."
        )?;
    }
    Ok(())
}

/// How setup ends when this daemon is Nix's: the module's service started again on the new
/// config when there is one, else the module to add.
pub fn nix_ending(service: Option<&Service>, nix: &NixManaged) -> String {
    match service {
        Some(s) => format!(
            "The service is home-manager's ({}): `systemctl --user restart {}` starts it on this config.\n",
            s.file.display(),
            service::UNIT
        ),
        None => format!(
            "This {CLIENT} is from the Nix store, so home-manager runs it as a service, and the tray at login. {}",
            nix.add_module()
        ),
    }
}

/// Where setup starts.
#[derive(Debug)]
pub enum Resume {
    /// Approved before, tokens on disk, the config not written yet: at the runtimes.
    Saved(Saved),
    /// From the address, with why when a note was there but couldn't be read.
    Fresh(Option<String>),
}

pub fn resume(config: &Path) -> Resume {
    match setup::load_pending(config) {
        Some(Ok(saved)) => Resume::Saved(saved),
        Some(Err(e)) => Resume::Fresh(Some(format!("{e:#}"))),
        None => Resume::Fresh(None),
    }
}

/// Print `prompt`, read a line, trimmed. The end of input is an error: nobody is there to answer.
pub fn ask(input: &mut impl BufRead, out: &mut impl Write, prompt: &str) -> Result<String> {
    write!(out, "{prompt}")?;
    out.flush()?;
    let mut line = String::new();
    if input.read_line(&mut line)? == 0 {
        bail!("stopped: no more input");
    }
    Ok(line.trim().to_string())
}

/// The address, then the device code approved in the browser, and its tokens saved.
async fn approve(input: &mut impl BufRead, out: &mut impl Write, config: &Path, url: Option<&str>) -> Result<Saved> {
    let mut url = url.map(str::to_string);
    let host = setup::hostname();
    loop {
        let typed = match url.take() {
            Some(u) => u,
            None => ask(input, out, "Your Copland's address: ")?,
        };
        let at = match setup::normalize_url(&typed) {
            Ok(u) => u,
            Err(e) => {
                writeln!(out, "  {e}")?;
                continue;
            }
        };
        let api = Api::new(&at).map_err(|e| anyhow::anyhow!("{e:#}"))?;
        let start = match api.device_start(CLIENT, &host, &[], false).await {
            Ok(s) => s,
            Err(ApiError::Status { status: 404 | 405, .. }) => {
                writeln!(
                    out,
                    "  {at} has no device setup: not a Copland, or one older than this daemon"
                )?;
                continue;
            }
            Err(e) => {
                writeln!(out, "  {at}: {e}")?;
                continue;
            }
        };
        writeln!(
            out,
            "\nApprove this machine in Copland: open\n\n  {}\n",
            start.verify_url
        )?;
        writeln!(out, "and check it shows the code  {}\n", start.user_code)?;
        writeln!(out, "Waiting for the approval (ctrl+c stops)…")?;
        match wait(&api, &start.device_code, start.interval, start.expires_in).await? {
            Some((url, owner, agents)) => {
                let saved = setup::save_tokens(config, CLIENT, &url, &owner, &agents).context("saving the tokens")?;
                writeln!(
                    out,
                    "Approved as @{}: {} agent(s), tokens saved beside {}.",
                    saved.owner,
                    saved.agents.len(),
                    config.display()
                )?;
                return Ok(saved);
            }
            None => {
                if !ask(input, out, "Try again? [Y/n] ")?
                    .to_ascii_lowercase()
                    .starts_with('n')
                {
                    url = Some(at);
                    continue;
                }
                bail!("setup stopped before the approval");
            }
        }
    }
}

type Approved = (
    String,
    copland_daemon_core::api::DeviceIdentity,
    Vec<copland_daemon_core::api::DeviceIdentity>,
);

/// Poll every `interval` seconds until the code is answered or lapses, as the box's wizard does.
/// None, having said why, when it was denied or expired.
async fn wait(api: &Api, code: &str, interval: u64, expires_in: u64) -> Result<Option<Approved>> {
    let deadline = Instant::now() + Duration::from_secs(expires_in.max(1));
    let mut every = Duration::from_secs(interval.clamp(1, 60));
    let mut noted = false;
    loop {
        tokio::time::sleep(every).await;
        if Instant::now() >= deadline {
            println!("The code expired.");
            return Ok(None);
        }
        match api.device_poll(code).await {
            Ok(DevicePoll::Pending { slow_down }) => {
                if slow_down {
                    every += Duration::from_secs(SLOW_DOWN);
                }
                if noted {
                    println!("  reached Copland again; still waiting");
                    noted = false;
                }
            }
            Ok(DevicePoll::Denied) => {
                println!("The code was denied.");
                return Ok(None);
            }
            Ok(DevicePoll::Expired) => {
                println!("The code expired.");
                return Ok(None);
            }
            Ok(DevicePoll::Approved {
                url,
                owner: Some(owner),
                agents,
            }) => return Ok(Some((url, owner, agents))),
            /* Setup never names agents, so the server always sends the owner's token here. */
            Ok(DevicePoll::Approved { owner: None, .. }) => {
                bail!("the approval came without a token for you; run --setup again")
            }
            Err(e) if e.is_refusal() => bail!("{e}"),
            /* The network, say: it may pass, so polling goes on. */
            Err(e) => {
                println!("  {e}; trying again");
                noted = true;
            }
        }
    }
}

/// Per agent, a runtime from those found (Enter takes the first, Claude Code before Codex, as
/// the box does) and a workdir (Enter takes `~/agents/<name>`).
pub fn choose(input: &mut impl BufRead, out: &mut impl Write, saved: &Saved, found: &[Found]) -> Result<Vec<Choice>> {
    writeln!(out, "Runtimes found:")?;
    for (i, f) in found.iter().enumerate() {
        let version = f.version.as_deref().map(|v| format!(" {v}")).unwrap_or_default();
        writeln!(out, "  {}) {}{version}  {}", i + 1, f.runtime.name(), f.path.display())?;
    }
    let mut choices = Vec::new();
    for a in &saved.agents {
        writeln!(out, "\n@{}", a.handle)?;
        let runtime = loop {
            let answer = ask(input, out, &format!("  runtime [1 {}]: ", found[0].runtime.name()))?;
            match pick_runtime(&answer, found) {
                Ok(r) => break r,
                Err(e) => writeln!(out, "  {e}")?,
            }
        };
        let default = setup::default_workdir(&setup::agent_name(&a.handle));
        let answer = ask(input, out, &format!("  workdir [{default}]: "))?;
        choices.push(Choice {
            runtime,
            workdir: if answer.is_empty() { default } else { answer },
        });
    }
    Ok(choices)
}

/// Whether to start the tray at login. Enter takes yes in a graphical session and no without
/// one (a server, over ssh), where a tray has nowhere to show.
pub fn ask_tray(input: &mut impl BufRead, out: &mut impl Write, graphical: bool) -> Result<bool> {
    let prompt = if graphical {
        format!("\nStart {TRAY} (the daemon in your bar's tray) at login? [Y/n] ")
    } else {
        format!("\nNo display here. Start {TRAY} (the daemon in a desktop's tray) at login anyway? [y/N] ")
    };
    loop {
        match ask(input, out, &prompt)?.to_ascii_lowercase().as_str() {
            "" => return Ok(graphical),
            "y" | "yes" => return Ok(true),
            "n" | "no" => return Ok(false),
            _ => writeln!(out, "  y or n")?,
        }
    }
}

/// Write the tray's autostart entry at `file` for `config` (named only when it isn't the
/// default), or remove it. What it did, to print.
pub fn tray_at_login(file: &Path, on: bool, config: &Path, exec: &Exec) -> Result<String> {
    autostart::set(file, on, &autostart::TRAY_ENTRY, autostart::non_default(config), exec)?;
    Ok(if on {
        format!(
            "Wrote {}: {} starts at login{}.",
            file.display(),
            exec.program,
            exec.caveat.as_deref().map(|c| format!(" ({c})")).unwrap_or_default()
        )
    } else {
        format!("{TRAY} won't start at login.")
    })
}

/// A runtime answer: empty for the first found, its number in the list, or its name or program
/// ("codex", "Claude Code", "claude"), case aside.
pub fn pick_runtime(answer: &str, found: &[Found]) -> Result<runtime::Runtime> {
    let a = answer.trim();
    if a.is_empty() {
        return found.first().map(|f| f.runtime).context("no runtime found");
    }
    if let Ok(n) = a.parse::<usize>() {
        return found
            .get(n.wrapping_sub(1))
            .map(|f| f.runtime)
            .with_context(|| format!("pick 1 to {}", found.len()));
    }
    found
        .iter()
        .map(|f| f.runtime)
        .find(|r| r.name().eq_ignore_ascii_case(a) || r.program().eq_ignore_ascii_case(a))
        .with_context(|| {
            let names: Vec<_> = found.iter().map(|f| f.runtime.program()).collect();
            format!("{a:?} isn't one found here: {}", names.join(", "))
        })
}

/// The preflight on `config`, printed; with `fix`, offer each failing check's fix (y/N) and, when
/// one ran, check again. How many still fail.
pub async fn check(config: &Config, fix: bool) -> Result<usize> {
    println!("{}", preflight::found_on_path(&config.agents));
    let mut checks = preflight::run(config).await;
    print!("{}", preflight::render(&checks));
    if fix && preflight::worst(&checks) != preflight::Status::Ok {
        let ran = tokio::task::block_in_place(|| preflight::terminal::offer_fixes(&checks))?;
        if ran > 0 {
            println!("\nchecking again:");
            checks = preflight::run(config).await;
            print!("{}", preflight::render(&checks));
        }
    }
    Ok(preflight::failures(&checks))
}

#[cfg(test)]
mod tests {
    use super::*;
    use copland_daemon_core::api::DeviceIdentity;
    use copland_daemon_core::config::Secret;
    use copland_daemon_core::runtime::Runtime;
    use std::path::PathBuf;

    fn found(rs: &[Runtime]) -> Vec<Found> {
        rs.iter()
            .map(|&runtime| Found {
                runtime,
                path: PathBuf::from(format!("/bin/{}", runtime.program())),
                version: Some("1.0.0".into()),
            })
            .collect()
    }

    #[test]
    fn under_nix_setup_ends_with_the_module_or_restarting_its_service() {
        let nix = NixManaged {
            program: "/nix/store/x/bin/copland-daemon".into(),
            config: None,
            tray: true,
            leftover: None,
        };
        let says = nix_ending(None, &nix);
        assert!(says.starts_with("This copland-daemon is from the Nix store"), "{says}");
        assert!(says.contains("  services.copland.tray.enable = true;\n"), "{says}");
        assert!(!says.contains("--install-service"), "{says}");
        let hm = Service {
            file: "/home/me/.config/systemd/user/copland-daemon.service".into(),
            enabled: true,
            running: Some(false),
            nix: true,
            program: None,
        };
        assert_eq!(
            nix_ending(Some(&hm), &nix),
            "The service is home-manager's (/home/me/.config/systemd/user/copland-daemon.service): \
             `systemctl --user restart copland-daemon.service` starts it on this config.\n"
        );
    }

    #[test]
    fn reads_a_runtime_by_number_or_name() {
        let both = found(&[Runtime::ClaudeCode, Runtime::Codex]);
        assert_eq!(pick_runtime("", &both).unwrap(), Runtime::ClaudeCode);
        assert_eq!(pick_runtime(" 2 ", &both).unwrap(), Runtime::Codex);
        assert_eq!(pick_runtime("1", &both).unwrap(), Runtime::ClaudeCode);
        assert_eq!(pick_runtime("codex", &both).unwrap(), Runtime::Codex);
        assert_eq!(pick_runtime("Claude Code", &both).unwrap(), Runtime::ClaudeCode);
        assert_eq!(pick_runtime("CLAUDE", &both).unwrap(), Runtime::ClaudeCode);
        assert!(pick_runtime("0", &both).is_err());
        assert!(pick_runtime("3", &both).is_err());
        assert!(pick_runtime("vim", &both).is_err());
        /* Only what was found: Codex alone here, so Claude Code is refused and Enter is Codex. */
        let codex = found(&[Runtime::Codex]);
        assert_eq!(pick_runtime("", &codex).unwrap(), Runtime::Codex);
        assert!(pick_runtime("claude", &codex).is_err());
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("copland-cli-setup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn id(handle: &str, token: &str) -> DeviceIdentity {
        DeviceIdentity {
            handle: handle.into(),
            token: Secret::new(token),
            scope: None,
        }
    }

    #[test]
    fn asks_each_agent_with_defaults_and_asks_again_on_a_bad_answer() {
        let dir = scratch("choose");
        let config = dir.join("daemon.toml");
        let saved = setup::save_tokens(
            &config,
            CLIENT,
            "http://x",
            &id("me", "cpl_o"),
            &[id("me/dev", "cpl_a"), id("me/ops", "cpl_b")],
        )
        .unwrap();
        let both = found(&[Runtime::ClaudeCode, Runtime::Codex]);
        let mut input = io::Cursor::new("\n\nnope\ncodex\n/srv/ops\n");
        let mut out = Vec::new();
        let choices = choose(&mut input, &mut out, &saved, &both).unwrap();
        assert_eq!(
            choices,
            [
                Choice {
                    runtime: Runtime::ClaudeCode,
                    workdir: "~/agents/dev".into()
                },
                Choice {
                    runtime: Runtime::Codex,
                    workdir: "/srv/ops".into()
                },
            ]
        );
        let shown = String::from_utf8(out).unwrap();
        assert!(shown.contains("1) Claude Code 1.0.0  /bin/claude"));
        assert!(shown.contains("@me/ops"));
        assert!(shown.contains("\"nope\" isn't one found here: claude, codex"));
        /* Input running out stops setup rather than taking defaults for nobody. */
        assert!(choose(&mut io::Cursor::new("\n"), &mut Vec::new(), &saved, &both).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn asks_about_the_tray_with_a_default_for_the_session() {
        let mut out = Vec::new();
        assert!(ask_tray(&mut io::Cursor::new("\n"), &mut out, true).unwrap());
        assert!(String::from_utf8(out).unwrap().contains("[Y/n]"));
        let mut out = Vec::new();
        assert!(!ask_tray(&mut io::Cursor::new("\n"), &mut out, false).unwrap());
        assert!(String::from_utf8(out).unwrap().contains("No display here"));
        assert!(ask_tray(&mut io::Cursor::new("maybe\nY\n"), &mut Vec::new(), false).unwrap());
        assert!(!ask_tray(&mut io::Cursor::new("no\n"), &mut Vec::new(), true).unwrap());
        assert!(ask_tray(&mut io::Cursor::new(""), &mut Vec::new(), true).is_err());

        let dir = scratch("tray");
        let file = dir.join("autostart").join(format!("{TRAY}.desktop"));
        let exec = Exec {
            program: "/opt/bin/copland-tray".into(),
            caveat: None,
            unstable: None,
        };
        let said = tray_at_login(&file, true, &dir.join("daemon.toml"), &exec).unwrap();
        assert!(said.contains("/opt/bin/copland-tray starts at login"), "{said}");
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains(&format!(
            "Exec=/opt/bin/copland-tray --config {}\n",
            dir.join("daemon.toml").display()
        )));
        assert_eq!(
            tray_at_login(&file, false, &dir.join("daemon.toml"), &exec).unwrap(),
            "copland-tray won't start at login."
        );
        assert!(!file.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn picks_up_a_setup_left_at_the_runtimes() {
        let dir = scratch("resume");
        let config = dir.join("daemon.toml");
        assert!(matches!(resume(&config), Resume::Fresh(None)));

        /* Approved, tokens saved, then stopped: next time starts at the runtimes with them. */
        let saved = setup::save_tokens(
            &config,
            CLIENT,
            "http://x/",
            &id("me", "cpl_o"),
            &[id("me/dev", "cpl_a")],
        )
        .unwrap();
        let Resume::Saved(again) = resume(&config) else {
            panic!("not resumed")
        };
        assert_eq!(again, saved);
        let note = std::fs::read_to_string(setup::pending_path(&config)).unwrap();
        assert!(note.starts_with("# copland-daemon --setup was approved"));

        /* Writing the config ends it; the notes name the daemon. */
        let choices = choose(
            &mut io::Cursor::new(format!("\n{}\n", dir.join("w").display())),
            &mut Vec::new(),
            &again,
            &found(&[Runtime::ClaudeCode]),
        )
        .unwrap();
        setup::write_config(&config, CLIENT, &again, &choices).unwrap();
        assert!(matches!(resume(&config), Resume::Fresh(None)));
        assert!(
            std::fs::read_to_string(&config)
                .unwrap()
                .starts_with("# Written by copland-daemon --setup.")
        );
        let c = Config::load(&config).unwrap();
        assert_eq!(
            (c.agents[0].handle.as_str(), c.agents[0].token.expose()),
            ("me/dev", "cpl_a")
        );

        /* A note that can't be read starts over, saying why. */
        std::fs::write(setup::pending_path(&config), "url = 3").unwrap();
        assert!(matches!(resume(&config), Resume::Fresh(Some(_))));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

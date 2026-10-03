//! Floating the box on Hyprland without a window rule.
//!
//! Hyprland floats a toplevel by itself when its min and max size are equal (a fixed-size
//! window) or when it has a parent. GPUI 0.2.2 sends only `xdg_toplevel.set_min_size` on
//! Wayland (from `WindowOptions::window_min_size`); `is_resizable` does nothing on Linux and
//! there is no max size, so the box would be tiled. Until GPUI can say so itself, the box
//! asks Hyprland over its IPC socket, for its own window only (by pid): float it, give it its
//! size and centre it. A window that is already floating when it appears is left alone, since
//! then a rule placed it and its size and place are the rule's.
//!
//! Pinning (on top, on every workspace) stays the user's choice, through a rule:
//! `copland-box --hyprland-rule` prints one. Wayland has no always-on-top request.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::APP_ID;

/// How long to wait for the window to show up in Hyprland's clients.
const WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(20);

/// Hyprland's request socket, when the box runs under Hyprland.
fn socket() -> Option<PathBuf> {
    let sig = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    /* Since 0.40 under $XDG_RUNTIME_DIR/hypr, before that under /tmp/hypr. */
    runtime
        .map(|r| r.join("hypr"))
        .into_iter()
        .chain([PathBuf::from("/tmp/hypr")])
        .map(|d| d.join(&sig).join(".socket.sock"))
        .find(|p| p.exists())
}

/// One request, one answer: Hyprland closes the connection after answering.
fn request(sock: &PathBuf, what: &str) -> std::io::Result<String> {
    let mut s = UnixStream::connect(sock)?;
    s.set_read_timeout(Some(Duration::from_secs(2)))?;
    s.write_all(what.as_bytes())?;
    let mut out = String::new();
    s.read_to_string(&mut out)?;
    Ok(out)
}

/// Whether Hyprland floats the mapped window of `pid`, from `j/clients`; `None` while there is none.
pub fn floating(clients: &str, pid: u32) -> Option<bool> {
    let compact: String = clients.chars().filter(|c| !c.is_whitespace()).collect();
    let at = compact.find(&format!("\"pid\":{pid},"))?;
    /* Each client starts with its address; its other fields come before the pid. */
    let client = &compact[compact[..at].rfind("\"address\":")?..at];
    client
        .contains("\"mapped\":true")
        .then(|| client.contains("\"floating\":true"))
}

/// The dispatches that float, size and centre the window of `pid`: Lua (Hyprland 0.55 and
/// later with `hyprland.lua`) and the older dispatcher syntax, as one batch.
pub fn dispatches(pid: u32, w: u32, h: u32) -> ([String; 3], String) {
    let win = format!("window = \"pid:{pid}\"");
    (
        [
            format!("dispatch hl.dsp.window.float({{ action = \"on\", {win} }})"),
            format!("dispatch hl.dsp.window.resize({{ x = {w}, y = {h}, {win} }})"),
            format!("dispatch hl.dsp.window.center({{ {win} }})"),
        ],
        format!(
            "[[BATCH]]dispatch setfloating pid:{pid};dispatch resizewindowpixel exact {w} {h},pid:{pid};dispatch centerwindow"
        ),
    )
}

/// The dispatches that float the window of `pid` and give it `w`×`h` where it is (compact mode
/// switched, COPL-65): no centring, so a window a rule placed stays in its corner.
pub fn resizes(pid: u32, w: u32, h: u32) -> ([String; 2], String) {
    let win = format!("window = \"pid:{pid}\"");
    (
        [
            format!("dispatch hl.dsp.window.float({{ action = \"on\", {win} }})"),
            format!("dispatch hl.dsp.window.resize({{ x = {w}, y = {h}, {win} }})"),
        ],
        format!("[[BATCH]]dispatch setfloating pid:{pid};dispatch resizewindowpixel exact {w} {h},pid:{pid}"),
    )
}

/// Send the Lua dispatches, or the old batch when a config refuses those: a Lua config
/// answers "ok" to its own syntax and an error to the old one. Whether it took.
fn dispatch(sock: &PathBuf, lua: &[String], old: &str) -> bool {
    let mut ok = true;
    for d in lua {
        ok &= request(sock, d).is_ok_and(|r| r.trim() == "ok");
    }
    ok || request(sock, old).is_ok_and(|r| r.split_whitespace().all(|r| r == "ok"))
}

/// Under Hyprland, give the box's window `w`×`h` now, floating, where it is. Off the main
/// thread; does nothing anywhere else.
pub fn resize(w: f32, h: f32) {
    let Some(sock) = socket() else {
        return;
    };
    let pid = std::process::id();
    let (w, h) = (w.round() as u32, h.round() as u32);
    let spawned = std::thread::Builder::new().name("hyprland".into()).spawn(move || {
        let (lua, old) = resizes(pid, w, h);
        if dispatch(&sock, &lua, &old) {
            tracing::debug!(w, h, "hyprland: resized the window");
        } else {
            tracing::warn!("hyprland didn't resize the window");
        }
    });
    if let Err(e) = spawned {
        tracing::warn!("hyprland: {e}");
    }
}

/// Under Hyprland, float the box's window at `w`×`h` once it is mapped, unless a rule already
/// floats it; then, with `resize_floating` (compact mode), only its size is changed. Off the
/// main thread; does nothing anywhere else.
pub fn float_when_mapped(w: f32, h: f32, resize_floating: bool) {
    let Some(sock) = socket() else {
        return;
    };
    let pid = std::process::id();
    let (w, h) = (w.round() as u32, h.round() as u32);
    let spawned = std::thread::Builder::new().name("hyprland".into()).spawn(move || {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            match request(&sock, "j/clients").ok().and_then(|c| floating(&c, pid)) {
                Some(true) => {
                    tracing::debug!("hyprland: a rule floats the window already");
                    if resize_floating {
                        let (lua, old) = resizes(pid, w, h);
                        dispatch(&sock, &lua, &old);
                    }
                    return;
                }
                Some(false) => {
                    let (lua, old) = dispatches(pid, w, h);
                    let ok = dispatch(&sock, &lua, &old);
                    if ok {
                        tracing::debug!(w, h, "hyprland: floated the window");
                    } else {
                        tracing::warn!(
                            "hyprland didn't float the window; copland-box --hyprland-rule prints a rule that does"
                        );
                    }
                    return;
                }
                None => std::thread::sleep(POLL),
            }
        }
        tracing::debug!("hyprland: the window never showed up among its clients");
    });
    if let Err(e) = spawned {
        tracing::warn!("hyprland: {e}");
    }
}

/// A window rule for the box at `w`×`h`: floating, pinned, in the bottom-right corner, with no
/// border. For `hyprland.lua` (0.55 and later) and for an older `hyprland.conf`.
pub fn rule(w: f32, h: f32) -> String {
    let (w, h) = (w.round() as u32, h.round() as u32);
    let (right, bottom) = (w + 24, h + 48);
    let class = format!("^({APP_ID})$");
    format!(
        "-- hyprland.lua (Hyprland 0.55 and later)
hl.window_rule({{
\tmatch = {{ class = \"{class}\" }},
\tfloat = true,
\tpin = true,
\tsize = {{ {w}, {h} }},
\tmove = {{ \"monitor_w-{right}\", \"monitor_h-{bottom}\" }},
\tborder_size = 0,
\trounding = 0,
\tno_shadow = true,
}})

# hyprland.conf (older Hyprland)
windowrulev2 = float, class:{class}
windowrulev2 = pin, class:{class}
windowrulev2 = size {w} {h}, class:{class}
windowrulev2 = move 100%-{right} 100%-{bottom}, class:{class}
windowrulev2 = noborder, class:{class}
windowrulev2 = rounding 0, class:{class}
windowrulev2 = noshadow, class:{class}
"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLIENTS: &str = r#"[{
    "address": "0x1",
    "mapped": true,
    "at": [0, 0],
    "size": [1402, 1396],
    "floating": false,
    "class": "kitty",
    "pid": 41,
    "xwayland": false
},{
    "address": "0x2",
    "mapped": true,
    "size": [1402, 1396],
    "floating": false,
    "class": "copland-box",
    "pid": 4242,
    "xwayland": false
},{
    "address": "0x3",
    "mapped": true,
    "floating": true,
    "class": "copland-box",
    "pid": 7,
    "xwayland": false
}]"#;

    #[test]
    fn finds_its_own_window_by_pid() {
        assert_eq!(floating(CLIENTS, 4242), Some(false));
        assert_eq!(floating(CLIENTS, 7), Some(true));
        assert_eq!(floating(CLIENTS, 42), None);
        assert_eq!(floating(CLIENTS, 4), None);
        assert_eq!(
            floating(&CLIENTS.replace("true,\n    \"size\"", "false,\n    \"size\""), 4242),
            None
        );
    }

    #[test]
    fn asks_for_its_own_window_only() {
        let (lua, old) = dispatches(9, 548, 196);
        assert!(lua.iter().all(|d| d.contains("window = \"pid:9\"")));
        assert!(lua[1].contains("x = 548, y = 196"));
        assert!(old.contains("resizewindowpixel exact 548 196,pid:9"));
    }

    #[test]
    fn resizes_its_own_window_where_it_is() {
        let (lua, old) = resizes(9, 548, 26);
        assert!(lua.iter().all(|d| d.contains("window = \"pid:9\"")));
        assert!(lua[1].contains("x = 548, y = 26"));
        assert!(!old.contains("centerwindow") && old.contains("resizewindowpixel exact 548 26,pid:9"));
    }

    #[test]
    fn the_rule_is_for_the_size_it_is_given() {
        let r = rule(548.0, 196.0);
        assert!(r.contains("size = { 548, 196 }"));
        assert!(r.contains("\"monitor_w-572\", \"monitor_h-244\""));
        assert!(r.contains("windowrulev2 = move 100%-572 100%-244, class:^(copland-box)$"));
    }
}

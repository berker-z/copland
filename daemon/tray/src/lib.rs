//! `copland-tray` (COPL-198): a tray icon for the daemon running a config, from its status socket.
//! `view` and `follow` are the same on every platform; `sni` draws them as a
//! StatusNotifierItem on Linux, and `open` starts the box from its menu (COPL-201).

pub mod follow;
pub mod icons;
#[cfg(unix)]
pub mod open;
#[cfg(target_os = "linux")]
pub mod sni;
pub mod view;

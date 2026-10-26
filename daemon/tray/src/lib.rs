//! `copland-tray` (COPL-198): a tray icon for the daemon running a config, from its status socket.
//! `view` and `watcher` are the same on every platform; `sni` draws them as a
//! StatusNotifierItem on Linux.

pub mod icons;
#[cfg(target_os = "linux")]
pub mod sni;
pub mod view;
pub mod watcher;

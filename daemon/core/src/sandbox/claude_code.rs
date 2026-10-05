//! Claude Code's own sandbox, as a backend for its coding runs (COPL-140). Not checked yet, so it
//! has none and its runs get the platform's fallback.

use super::{Backend, Platform};

/// Claude Code's own backend on `platform`, once there is one.
pub fn backend(_platform: Platform) -> Option<&'static dyn Backend> {
    None
}

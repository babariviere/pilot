//! The chat side panel's read-only workspace file view. Refresh is explicit.
use super::*;
#[path = "session_file_view_native.rs"]
mod session_file_view_native;
#[cfg(feature = "native-probes")]
#[path = "session_file_view_probe.rs"]
pub(crate) mod session_file_view_probe;
use crate::ui::{self, Action, Text, Tone};
use gpui_kit::{FocusHandle, StatefulInteractiveElement};
pub(crate) use session_file_view_native::FilePane;
gpui_kit::actions!(session_file, [Close]);

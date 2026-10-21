//! Standalone fixture view, shared by the runnable binary and focused tests.
mod chat_editor;
mod delivery_store;
mod interaction;
mod local_client;
mod local_model;
mod local_view;
mod model;
mod tool_presentation;
mod transcript_view;
mod work_view;

pub use local_client::{LocalOptions, check_local_read, read_local_capture};
pub use local_view::{LocalViewer, PreviewState};
pub use model::{fence_fixture, giant_fixture};
pub use transcript_view::TranscriptView;
mod appearance;
#[cfg(test)]
mod visual_runtime;
#[cfg(test)]
mod visual_scene;
#[cfg(test)]
mod visual_session;
#[cfg(test)]
mod visual_wire;
pub use appearance::{ChromeAssets, follow_appearance, init_appearance};

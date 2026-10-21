//! Standalone fixture view, shared by the runnable binary and focused tests.
mod local_client;
mod local_model;
mod local_view;
mod model;
mod transcript_view;

pub use local_client::{LocalOptions, check_local_read};
pub use local_view::LocalViewer;
pub use model::{fence_fixture, giant_fixture};
pub use transcript_view::TranscriptView;

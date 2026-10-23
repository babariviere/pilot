//! Standalone fixture view, shared by the runnable binary and focused tests.
mod chat_editor;
mod delivery_store;
mod interaction;
mod local_client;
mod local_model;
mod local_view;
mod model;
mod navigation;
mod tool_presentation;
mod transcript_view;
mod work_view;

#[cfg(feature = "native-probes")]
pub use artifact_view::slider_probe::run_slider_probe;
pub use local_client::{LocalOptions, check_local_read, read_local_capture};
#[cfg(feature = "native-probes")]
pub use local_view::disclosure_probe::run_disclosure_probe;
#[cfg(feature = "native-probes")]
pub use local_view::history_probe::run_history_probe;
#[cfg(feature = "native-probes")]
pub use local_view::inbox_probe::run_inbox_probe;
#[cfg(feature = "native-probes")]
pub use local_view::navigation_probe::run_navigation_probe;
#[cfg(feature = "native-probes")]
pub use local_view::shell_probe::run_shell_probe;
#[cfg(feature = "native-probes")]
pub use local_view::style_probe::run_style_probe;
pub use local_view::{LocalViewer, PreviewState};
pub use model::{fence_fixture, giant_fixture};
pub use transcript_view::TranscriptView;
mod app_shell;
mod appearance;
mod artifact_model;
mod artifact_view;
mod artifact_worker;
mod attention;
mod dither;
mod dither_view;
mod inbox;
mod visual_canvas_plan;
mod visual_canvas_view;
mod visual_chart;
mod visual_chart_view;
mod visual_drawing;
mod visual_runtime;
mod visual_scene;
mod visual_session;
mod visual_slider;
mod visual_wire;
pub use appearance::{ChromeAssets, follow_appearance, init_appearance};

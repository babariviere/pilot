//! Standalone fixture view, shared by the runnable binary and focused tests.
pub mod bundled_runtime;
mod bundled_runtime_view;
pub use bundled_runtime_view::BundledRuntimeView;
#[cfg(feature = "native-probes")]
mod catalog_probe;
mod chat_actions;
#[cfg(any(test, feature = "native-probes"))]
mod chat_actions_fixture;
#[cfg(feature = "native-probes")]
pub use local_view::chat_actions_probe::run_chat_actions_probe;
mod chat_actions_view;
mod chat_actions_worker;
mod chat_editor;
#[cfg(feature = "native-probes")]
pub use chat_editor::composer_probe::run_composer_probe;
#[cfg(feature = "native-probes")]
pub use chat_editor::delivery_probe::run_delivery_probe;
mod chat_model_reader;
mod chat_models;
#[cfg(any(test, feature = "native-probes"))]
mod chat_models_fixture;
#[cfg(feature = "native-probes")]
pub use chat_editor::project_creation_probe::run_project_creation_probe;
mod delivery_store;
mod interaction;
mod jump;
mod jump_view;
mod local_client;
mod local_model;
mod local_view;
mod mission_activity;
mod mission_activity_reader;
mod mission_activity_view;
#[cfg(feature = "native-probes")]
pub use mission_browser_view::mission_activity_probe::run_mission_activity_probe;
mod mission_browser;
#[cfg(any(test, feature = "native-probes"))]
mod mission_browser_fixture;
mod mission_browser_view;
mod mission_conversion;
#[cfg(any(test, feature = "native-probes"))]
mod mission_fixture;
mod mission_inspector;
mod mission_inspector_view;
mod mission_reader;
mod mission_tasks;
#[cfg(feature = "native-probes")]
mod mission_tasks_probe;
mod mission_tasks_reader;
mod mission_tasks_view;
#[cfg(feature = "native-probes")]
pub use mission_tasks_probe::run_mission_tasks_probe;
mod mission_transport;
mod mission_view;
mod model;
mod navigation;
mod project_add_view;
mod project_registration;
#[cfg(any(test, feature = "native-probes"))]
mod project_registration_fixture;
mod question;
#[cfg(feature = "native-probes")]
pub use chat_editor::question_probe::run_question_probe;
mod scoped_models;
#[cfg(any(test, feature = "native-probes"))]
mod scoped_models_fixture;
mod scoped_models_view;
mod scoped_models_worker;
mod settings_state;
mod settings_view;
mod settings_worker;
#[cfg(feature = "native-probes")]
pub use local_view::chat_model_probe::run_chat_model_probe;
#[cfg(feature = "native-probes")]
pub use local_view::mission_browser_probe::run_mission_browser_probe;
#[cfg(feature = "native-probes")]
pub use local_view::mission_inspector_probe::run_mission_inspector_probe;
#[cfg(feature = "native-probes")]
pub use local_view::mission_probe::run_mission_probe;
#[cfg(feature = "native-probes")]
pub use local_view::project_add_probe::run_project_add_probe;
#[cfg(feature = "native-probes")]
pub use local_view::scoped_models_probe::run_scoped_models_probe;
#[cfg(feature = "native-probes")]
pub use local_view::settings_probe::run_settings_probe;
#[cfg(test)]
mod reader_identity_tests;
mod tool_presentation;
mod transcript_view;
/// App-owned presentation contracts over Kit. See docs/design-system.md.
pub mod ui;
mod work_view;
#[cfg(feature = "native-probes")]
pub use catalog_probe::run_catalog_probe;

#[cfg(feature = "native-probes")]
pub use artifact_view::gallery::probe::run_artifact_gallery_probe;
#[cfg(feature = "native-probes")]
pub use artifact_view::image_probe::run_artifact_image_probe;
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
pub use local_view::jump_probe::run_jump_probe;
#[cfg(feature = "native-probes")]
pub use local_view::motion_probe::run_motion_probe;
#[cfg(feature = "native-probes")]
pub use local_view::navigation_probe::run_navigation_probe;
#[cfg(feature = "native-probes")]
pub use local_view::shell_probe::run_shell_probe;
#[cfg(feature = "native-probes")]
pub use local_view::style_probe::run_style_probe;
#[cfg(feature = "native-probes")]
pub use local_view::workbench_probe::run_workbench_probe;
pub use local_view::{LocalViewer, PreviewState};
pub use model::{fence_fixture, giant_fixture};
pub use transcript_view::TranscriptView;
mod app_icon;
mod app_shell;
#[cfg(feature = "native-probes")]
mod icon_probe;
#[cfg(feature = "native-probes")]
pub use icon_probe::run_icon_probe;
mod appearance;
mod artifact_gallery;
mod artifact_gallery_worker;
mod artifact_image;
mod artifact_image_view;
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

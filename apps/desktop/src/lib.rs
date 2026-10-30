//! Standalone fixture view, shared by the runnable binary and focused tests.
#[cfg(target_os = "macos")]
pub mod app_menu;
pub mod bundled_runtime;
pub mod diagnostics;
mod diagnostics_view;
mod image_attachments;
mod image_clipboard;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod running_identity;
#[cfg(feature = "native-probes")]
pub use diagnostics_view::probe::run_diagnostics_probe;
mod bundled_runtime_view;
#[cfg(all(
    feature = "native-probes",
    any(target_os = "macos", target_os = "linux")
))]
mod daemon_upgrade_probe;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod daemon_upgrade_view;
pub mod desktop_entry;
mod update_hold;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod updates_view;
pub use bundled_runtime_view::BundledRuntimeView;
#[cfg(all(
    feature = "native-probes",
    any(target_os = "macos", target_os = "linux")
))]
pub use daemon_upgrade_probe::run_daemon_upgrade_probe;
#[cfg(all(
    feature = "native-probes",
    any(target_os = "macos", target_os = "linux")
))]
pub use local_view::daemon_upgrade_lifecycle_probe::run_daemon_upgrade_lifecycle_probe;
#[cfg(feature = "native-probes")]
mod catalog_probe;
mod chat_actions;
mod chat_order;
mod context_meter;
mod context_usage;
mod path_completion;
mod path_completion_reader;
#[cfg(feature = "native-probes")]
pub use local_view::path_completion_probe::run_path_completion_probe;
mod automatic_input;
mod message_time;
mod provider_refresh;
#[cfg(feature = "native-probes")]
mod provider_refresh_probe;
mod provider_refresh_reader;
mod provider_refresh_view;
mod provider_usage;
#[cfg(feature = "native-probes")]
mod provider_usage_probe;
mod provider_usage_view;
mod session_jobs;
mod session_subagents;
#[cfg(any(test, feature = "native-probes"))]
mod session_subagents_fixture;
#[cfg(feature = "native-probes")]
pub use local_view::session_subagents_probe::run_session_subagents_probe;
#[cfg(any(test, feature = "native-probes"))]
mod session_jobs_fixture;
mod session_jobs_log;
mod session_todos;
mod session_todos_view;
mod subscription_pause;
#[cfg(feature = "native-probes")]
pub use local_view::session_jobs_probe::run_session_jobs_probe;
#[cfg(feature = "native-probes")]
pub use local_view::session_todos_probe::run_session_todos_probe;
#[cfg(feature = "native-probes")]
pub use provider_usage_probe::run_provider_usage_probe;
mod chat_links;
#[cfg(any(test, feature = "native-probes"))]
mod chat_links_fixture;
#[cfg(feature = "native-probes")]
pub use local_view::chat_links_probe::run_chat_links_probe;
mod conversation_links;
#[cfg(target_os = "macos")]
mod desktop_app_link;
mod external_links;
mod session_clipboard;
mod session_failure;
mod session_file_view;
mod session_file_view_reader;
mod workspace_changes;
mod workspace_changes_reader;
#[cfg(feature = "native-probes")]
pub use local_view::context_usage_probe::run_context_usage_probe;
#[cfg(feature = "native-probes")]
pub use local_view::conversation_links_probe::run_conversation_links_probe;
#[cfg(feature = "native-probes")]
pub use local_view::run_session_file_view_probe;
#[cfg(feature = "native-probes")]
pub use local_view::session_failure_probe::run_session_failure_probe;
#[cfg(feature = "native-probes")]
pub use local_view::workspace_changes_probe::run_workspace_changes_probe;
mod chat_rename;
mod chat_rename_view;
mod project_settings;
#[cfg(any(test, feature = "native-probes"))]
mod project_settings_fixture;
mod project_settings_transport;
mod project_settings_view;
#[cfg(feature = "native-probes")]
pub use local_view::chat_rename_probe::run_chat_rename_probe;
#[cfg(feature = "native-probes")]
pub use local_view::project_settings_probe::run_project_settings_probe;
#[cfg(any(test, feature = "native-probes"))]
mod chat_actions_fixture;
#[cfg(any(test, feature = "native-probes"))]
mod chat_rename_fixture;
#[cfg(feature = "native-probes")]
pub use local_view::chat_actions_probe::run_chat_actions_probe;
mod chat_actions_view;
mod chat_actions_worker;
mod chat_editor;
mod composer_height;
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
mod mission_update;
#[cfg(any(test, feature = "native-probes"))]
mod mission_update_fixture;
#[cfg(feature = "native-probes")]
mod mission_update_probe;
mod mission_update_transport;
mod mission_update_view;
mod transition;
#[cfg(feature = "native-probes")]
pub use mission_browser_view::mission_activity_probe::run_mission_activity_probe;
#[cfg(feature = "native-probes")]
pub use mission_update_probe::run_mission_update_probe;
mod mission_brief;
mod mission_metadata;
#[cfg(any(test, feature = "native-probes"))]
mod mission_metadata_fixture;
#[cfg(feature = "native-probes")]
mod mission_metadata_probe;
mod mission_metadata_transport;
mod mission_metadata_view;
#[cfg(feature = "native-probes")]
pub use mission_metadata_probe::run_mission_metadata_probe;
#[cfg(any(test, feature = "native-probes"))]
mod mission_brief_fixture;
#[cfg(feature = "native-probes")]
mod mission_brief_probe;
mod mission_brief_reader;
mod mission_brief_view;
#[cfg(feature = "native-probes")]
pub use mission_brief_probe::run_mission_brief_probe;
mod mission_browser;
mod mission_comments;
mod mission_decisions;
#[cfg(feature = "native-probes")]
pub use mission_browser_view::mission_comments_view::probe::run_mission_comments_probe;
#[cfg(feature = "native-probes")]
pub use mission_browser_view::mission_decisions_view::probe::run_mission_decisions_probe;
#[cfg(any(test, feature = "native-probes"))]
mod mission_browser_fixture;
mod mission_browser_view;
mod mission_conversion;
mod mission_create;
#[cfg(any(test, feature = "native-probes"))]
mod mission_create_fixture;
#[cfg(feature = "native-probes")]
mod mission_create_probe;
mod mission_create_transport;
mod mission_create_view;
#[cfg(feature = "native-probes")]
pub use mission_create_probe::run_mission_create_probe;
#[cfg(any(test, feature = "native-probes"))]
mod mission_fixture;
mod mission_inspector;
mod mission_inspector_view;
mod mission_phases;
mod mission_reader;
mod native_review;
#[cfg(feature = "native-probes")]
mod native_review_probe;
mod native_review_reader;
mod native_review_view;
#[cfg(feature = "native-probes")]
pub use native_review_probe::run_native_review_probe;
mod mission_task_create;
#[cfg(any(test, feature = "native-probes"))]
mod mission_task_create_fixture;
#[cfg(feature = "native-probes")]
mod mission_task_create_probe;
mod mission_task_create_transport;
mod mission_task_create_view;
mod mission_tasks;
#[cfg(feature = "native-probes")]
mod mission_tasks_probe;
mod mission_tasks_reader;
mod mission_tasks_view;
#[cfg(any(test, feature = "native-probes"))]
mod native_review_fixture;
#[cfg(test)]
mod native_review_tests;
mod task_status;
#[cfg(any(test, feature = "native-probes"))]
mod task_status_fixture;
#[cfg(feature = "native-probes")]
mod task_status_probe;
mod task_status_transport;
mod task_status_view;
#[cfg(feature = "native-probes")]
pub use mission_task_create_probe::run_mission_task_create_probe;
#[cfg(feature = "native-probes")]
pub use mission_tasks_probe::run_mission_tasks_probe;
#[cfg(feature = "native-probes")]
pub use task_status_probe::run_task_status_probe;
mod compaction_event;
mod github_event;
mod mission_transport;
mod mission_view;
mod model;
mod navigation;
mod project_add_view;
mod project_registration;
#[cfg(any(test, feature = "native-probes"))]
mod project_registration_fixture;
mod question;
mod question_entry;
#[cfg(feature = "native-probes")]
pub use chat_editor::question_probe::run_question_probe;
#[cfg(feature = "native-probes")]
pub use transcript_view::compaction_event_view::probe::run_compaction_event_probe;
#[cfg(feature = "native-probes")]
pub use transcript_view::github_event_view::probe::run_github_event_probe;
#[cfg(feature = "native-probes")]
pub use transcript_view::question_entry_view::probe::run_question_entry_probe;
mod chat_settings;
#[cfg(any(test, feature = "native-probes"))]
mod chat_settings_fixture;
mod chat_settings_view;
#[cfg(feature = "native-probes")]
mod fonts_probe;
mod scoped_models;
#[cfg(any(test, feature = "native-probes"))]
mod scoped_models_fixture;
mod scoped_models_view;
mod scoped_models_worker;
mod settings_fonts;
mod settings_state;
#[cfg(feature = "native-probes")]
pub use fonts_probe::run_fonts_probe;
mod settings_view;
mod settings_worker;
#[cfg(feature = "native-probes")]
pub use local_view::chat_model_probe::run_chat_model_probe;
#[cfg(feature = "native-probes")]
pub use local_view::chat_settings_probe::run_chat_settings_probe;
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
#[cfg(feature = "native-probes")]
pub use local_view::subscription_limit_probe::run_subscription_limit_probe;
mod nested_scroll;
mod project_memory;
mod project_memory_reader;
#[cfg(any(test, feature = "native-probes"))]
mod project_memory_tests;
#[cfg(feature = "native-probes")]
mod project_memory_probe;
#[cfg(feature = "native-probes")]
pub use project_memory_probe::run_project_memory_probe;
mod project_memory_view;
#[cfg(test)]
mod reader_identity_tests;
mod tool_presentation;
mod transcript_view;
mod typography;
/// App-owned presentation contracts over Kit. See docs/design-system.md.
pub mod ui;
mod usage_overview;
mod usage_overview_chart;
#[cfg(any(test, feature = "native-probes"))]
mod usage_overview_fixture;
#[cfg(feature = "native-probes")]
mod usage_overview_probe;
mod usage_overview_reader;
mod usage_overview_view;
mod work_view;
#[cfg(feature = "native-probes")]
pub use catalog_probe::run_catalog_probe;
#[cfg(feature = "native-probes")]
pub use usage_overview_probe::run_usage_overview_probe;

#[cfg(feature = "native-probes")]
pub use artifact_view::chart_keyboard_probe::run_chart_keyboard_probe;
#[cfg(feature = "native-probes")]
pub use artifact_view::gallery::probe::run_artifact_gallery_probe;
#[cfg(feature = "native-probes")]
pub use artifact_view::image_probe::run_artifact_image_probe;
#[cfg(feature = "native-probes")]
pub use artifact_view::mermaid_probe::run_native_mermaid_probe;
#[cfg(feature = "native-probes")]
pub use artifact_view::slider_probe::run_slider_probe;
pub use local_client::{LocalOptions, check_local_read, read_local_capture};
#[cfg(feature = "native-probes")]
pub use local_view::disclosure_probe::run_disclosure_probe;
#[cfg(feature = "native-probes")]
pub use local_view::glass_probe::run_glass_probe;
#[cfg(feature = "native-probes")]
pub use local_view::history_probe::run_history_probe;
#[cfg(feature = "native-probes")]
pub use local_view::inbox_probe::run_inbox_probe;
#[cfg(feature = "native-probes")]
pub use local_view::jump_probe::run_jump_probe;
#[cfg(feature = "native-probes")]
pub use local_view::motion_probe::run_motion_probe;
#[cfg(feature = "native-probes")]
pub use local_view::native_mermaid_root_probe::run_native_mermaid_root_probe;
#[cfg(feature = "native-probes")]
pub use local_view::navigation_probe::run_navigation_probe;
#[cfg(feature = "native-probes")]
pub use local_view::shell_probe::run_shell_probe;
#[cfg(feature = "native-probes")]
pub use local_view::side_panel_probe::run_side_panel_probe;
#[cfg(feature = "native-probes")]
pub use local_view::sidebar_scroll_native::run as run_native_sidebar_scroll_probe;
#[cfg(feature = "native-probes")]
pub use local_view::sidebar_scroll_native::run_visible as run_visible_sidebar_scroll_probe;
#[cfg(feature = "native-probes")]
pub use local_view::sidebar_sections_probe::run_sidebar_sections_probe;
#[cfg(feature = "native-probes")]
pub use local_view::style_probe::run_style_probe;
#[cfg(feature = "native-probes")]
mod scrollbar_track_probe;
#[cfg(feature = "native-probes")]
pub use local_view::workbench_probe::run_workbench_probe;
pub use local_view::{LocalViewer, PreviewState};
pub use model::{fence_fixture, giant_fixture};
#[cfg(feature = "native-probes")]
pub use scrollbar_track_probe::run_scrollbar_track_probe;
pub use transcript_view::TranscriptView;
mod app_icon;
mod app_shell;
mod home_sky;
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
mod reader_zoom;
#[cfg(feature = "native-probes")]
pub use transcript_view::inline_visual::probe::run_inline_visual_probe;
#[cfg(feature = "native-probes")]
pub use transcript_view::inline_visual::probe::scroll::native::run as run_native_artifact_scroll_probe;
mod artifact_worker;
mod attention;
mod inbox;
mod markdown_mermaid;
mod markdown_service_links;
mod native_mermaid;
mod native_mermaid_view;
mod sidebar_folders;
mod sidebar_memory;
mod sidebar_tree;
mod state_mark;
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
pub use appearance::{
    ChromeAssets, enable_glass, follow_appearance, init_appearance, window_background,
};

mod queued_message;
#[cfg(any(test, feature = "native-probes"))]
mod queued_message_fixture;
#[cfg(feature = "native-probes")]
pub use local_view::queued_message_view::probe::run_queued_message_probe;
mod queued_message_transport;
mod task_edit;
#[cfg(any(test, feature = "native-probes"))]
mod task_edit_fixture;
#[cfg(feature = "native-probes")]
mod task_edit_probe;
mod task_edit_transport;
mod task_edit_view;
mod task_model;
#[cfg(any(test, feature = "native-probes"))]
mod task_model_fixture;
#[cfg(feature = "native-probes")]
mod task_model_probe;
#[cfg(feature = "native-probes")]
pub use task_model_probe::run_task_model_probe;
mod task_model_transport;
mod task_model_view;
#[cfg(feature = "native-probes")]
pub use task_edit_probe::run_task_edit_probe;

mod mission_lifecycle;
#[cfg(any(test, feature = "native-probes"))]
mod mission_lifecycle_fixture;
#[cfg(feature = "native-probes")]
mod mission_lifecycle_probe;
mod mission_lifecycle_transport;
mod mission_lifecycle_view;
#[cfg(feature = "native-probes")]
pub use mission_lifecycle_probe::run_mission_lifecycle_probe;

mod conversation_images;

#[cfg(feature = "native-probes")]
pub use transcript_view::conversation_images_view::probe::native::run as run_native_image_scroll_probe;
#[cfg(feature = "native-probes")]
pub use transcript_view::conversation_images_view::probe::run_conversation_images_probe;

#[cfg(feature = "native-probes")]
pub use local_view::transcript_find_probe::run_transcript_find_probe;
mod tool_diff_preview;
#[cfg(feature = "native-probes")]
pub use local_view::tool_diff_preview_probe::run_tool_diff_preview_probe;

mod message_fold;
#[cfg(feature = "native-probes")]
pub use local_view::markdown_mermaid_probe::run_markdown_mermaid_probe;
#[cfg(feature = "native-probes")]
pub use local_view::message_fold_probe::run_message_fold_probe;
#[cfg(feature = "native-probes")]
pub use local_view::message_footer_probe::run_message_footer_probe;

#[cfg(feature = "native-probes")]
pub use local_view::new_chat_view_probe::run_new_chat_view_probe;

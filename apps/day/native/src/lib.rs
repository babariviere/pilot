//! Pilot Day for the Native Shell TSX app. Rust owns the Today read
//! model and the rules for changing it ([`desk::Desk`]). Missions are
//! projected ([`project`]) from the daemon's v1 contracts ([`contract`]). The connected
//! app reaches the native host only through the JSON bridge ([`bridge`]); TSX has no
//! transport of its own, and the app's capabilities deny network, sockets,
//! files and processes. The isolated connected runner grants only the exact
//! native methods in [`bridge::METHODS`]; the development config grants none.
//! App-owned export asks the user for a destination with the system Save dialog.
//! Captured engines have neither that native class nor filesystem grants.
//! The mock worlds ([`fixture`] and the scenario feeds) are test support for
//! the headless fixture entries; the connected host never reads them.

#[path = "attention/actions.rs"]
pub mod actions;
#[cfg(unix)]
#[path = "artifacts/artifact_check.rs"]
pub mod artifact_check;
#[path = "artifacts/artifact_export.rs"]
pub mod artifact_export;
#[cfg(unix)]
#[path = "artifacts/artifact_library.rs"]
pub mod artifact_library;
#[cfg(unix)]
#[path = "artifacts/artifact_runtime.rs"]
pub mod artifact_runtime;
#[cfg(unix)]
#[path = "artifacts/artifact_source.rs"]
pub mod artifact_source;
#[path = "attention/attention_host.rs"]
pub mod attention_host;
#[path = "attention/attention_interview.rs"]
mod attention_interview;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
#[path = "window/bootstrap.rs"]
pub mod bootstrap;
pub mod bridge;
#[path = "changes/changes.rs"]
pub mod changes;
#[path = "changes/changes_contract.rs"]
pub mod changes_contract;
#[path = "changes/changes_desk.rs"]
pub mod changes_desk;
#[path = "changes/changes_feed.rs"]
pub mod changes_feed;
#[path = "changes/changes_project.rs"]
pub mod changes_project;
#[path = "today/contract.rs"]
pub mod contract;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
#[path = "updates/daemon_handoff.rs"]
pub mod daemon_handoff;
#[cfg(unix)]
#[path = "diagnostics/day_log.rs"]
pub mod day_log;
#[path = "today/desk.rs"]
pub mod desk;
#[path = "today/feed.rs"]
pub mod feed;
#[path = "testing/fixture.rs"]
pub mod fixture;
#[path = "updates/handoff.rs"]
mod handoff;
pub mod host;
#[path = "intake/intake.rs"]
pub mod intake;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
#[path = "window/macos_app.rs"]
pub mod macos_app;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
#[path = "artifacts/macos_artifact.rs"]
pub mod macos_artifact;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
#[path = "window/macos_capture.rs"]
mod macos_capture;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
#[path = "window/macos_host.rs"]
pub mod macos_host;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
#[path = "screen_agent/macos_screen.rs"]
mod macos_screen;
#[path = "missions/mission_work.rs"]
mod mission_work;
#[path = "today/model.rs"]
pub mod model;
#[path = "chats/new_chat.rs"]
pub mod new_chat;
#[path = "planning/plan.rs"]
pub mod plan;
#[path = "planning/plan_activity.rs"]
pub mod plan_activity;
#[path = "planning/plan_desk.rs"]
pub mod plan_desk;
#[path = "planning/plan_feed.rs"]
pub mod plan_feed;
#[path = "planning/plan_host.rs"]
pub mod plan_host;
#[path = "planning/plan_revision_host.rs"]
pub mod plan_revision_host;
#[path = "planning/plan_revisit.rs"]
pub mod plan_revisit;
#[path = "planning/plan_world.rs"]
pub mod plan_world;
#[path = "today/project.rs"]
pub mod project;
#[path = "ritual/ritual.rs"]
pub mod ritual;
#[path = "ritual/ritual_feed.rs"]
pub mod ritual_feed;
#[path = "ritual/ritual_results.rs"]
mod ritual_results;
#[path = "window/root.rs"]
pub mod root;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
#[path = "service/service_start.rs"]
mod service_start;
#[path = "updates/update.rs"]
pub mod update;
#[path = "updates/update_feed.rs"]
pub mod update_feed;

use nsh_core::prelude::*;

pub use crate::{
    changes_feed::ChangesFeed, feed::TodayFeed, model::*, plan_feed::PlanFeed,
    update_feed::UpdateFeed,
};

/// The read models and intents the Today screen imports from
/// `pilot-day/native`.
#[native_module("pilot-day/native")]
fn native(registry: &mut Registry) {
    registry
        .class::<artifact_export::ArtifactExport>()
        .class::<TodayFeed>()
        .class::<PlanFeed>()
        .class::<ChangesFeed>()
        .class::<ritual_feed::RitualFeed>()
        .class::<UpdateFeed>();
}

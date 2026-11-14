//! Pilot Day for the Native Shell TSX app. Rust owns the Today read
//! model and the rules for changing it ([`desk::Desk`]). Missions are
//! projected ([`project`]) from the daemon's v1 contracts ([`contract`]). TSX receives typed
//! read models and sends typed intents through [`TodayFeed`]; it has no
//! transport of its own, and the app's capabilities deny network, sockets,
//! files and processes. The isolated connected runner grants only the exact
//! native methods in [`bridge::METHODS`]; the development config grants none.
//! The mock worlds ([`fixture`] and the scenario feeds) are test support for
//! the headless fixture entries; the connected host never reads them.

pub mod actions;
#[cfg(unix)]
pub mod artifact_runtime;
#[cfg(unix)]
pub mod artifact_source;
mod attention_feed;
pub mod attention_host;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
pub mod bootstrap;
pub mod bridge;
pub mod changes;
pub mod changes_contract;
pub mod changes_desk;
pub mod changes_feed;
pub mod changes_project;
pub mod contract;
pub mod desk;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
pub mod daemon_handoff;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
mod service_start;
#[cfg(unix)]
pub mod day_log;
pub mod feed;
pub mod fixture;
mod handoff;
pub mod host;
pub mod intake;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
pub mod macos_app;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
pub mod macos_artifact;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
mod macos_capture;
#[cfg(all(target_os = "macos", feature = "macos-host"))]
pub mod macos_host;
pub mod model;
pub mod new_chat;
pub mod plan;
pub mod plan_activity;
pub mod plan_desk;
pub mod plan_feed;
pub mod plan_host;
pub mod plan_revision_host;
pub mod plan_revisit;
pub mod plan_world;
pub mod project;
pub mod ritual;
pub mod ritual_feed;
mod ritual_results;
pub mod root;
pub mod update;
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
        .class::<TodayFeed>()
        .class::<PlanFeed>()
        .class::<ChangesFeed>()
        .class::<ritual_feed::RitualFeed>()
        .class::<UpdateFeed>();
}

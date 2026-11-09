//! Mock Pilot Day for the Native Shell TSX spike. Rust owns the Today read
//! model and the rules for changing it ([`desk::Desk`]). TSX receives typed
//! read models and sends typed intents through [`TodayFeed`]; it has no
//! transport of its own, and the app's capabilities deny network, sockets,
//! files, processes and host calls.

pub mod desk;
pub mod feed;
pub mod fixture;
pub mod model;

use nsh_core::prelude::*;

pub use crate::{feed::TodayFeed, model::*};

/// The read models and intents the Today screen imports from
/// `pilot-day/native`.
#[native_module("pilot-day/native")]
fn native(registry: &mut Registry) {
    registry.class::<TodayFeed>();
}

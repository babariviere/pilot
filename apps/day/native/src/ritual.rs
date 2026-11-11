//! Saved ritual progress. These are explicit user marks, never work completion.
use nsh_core::prelude::*;
use serde::{Deserialize, Serialize};

use crate::model::{DayPart, DoneEntry, Visit};

/// Whether the native source can confirm this read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RitualAvailability {
    /// No qualified source, or a read cannot be made.
    #[default]
    Unavailable,
    /// The local journal confirmed the progress.
    Available,
    /// A write entered storage but its result could not be confirmed. Do not resend.
    Unknown,
}

/// One of the two daily rituals.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RitualKind {
    #[default]
    Start,
    End,
}

/// An explicit user choice, not an inference from navigation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RitualMark {
    #[default]
    Unmarked,
    Done,
    Skipped,
}

/// The last confirmed mark and resume position for one ritual.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RitualProgress {
    pub mark: RitualMark,
    /// A UI-owned position, limited to 0..=32. Never means done.
    pub step: u32,
}

/// Narrow read model. Identity and clock authority stay in Rust.
/// The connected window's JSON calls carry the same fields (camel case).
#[derive(Debug, Clone, Default, PartialEq, JsObject, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RitualSnapshot {
    pub availability: RitualAvailability,
    /// Opaque native selection token. Changes on date, zone or profile changes.
    pub context: String,
    pub revision: u32,
    pub date: String,
    pub time_zone: String,
    pub part: DayPart,
    pub visit: Visit,
    /// Epoch milliseconds as exact decimal text, empty when unknown.
    pub last_looked_at: String,
    pub start: RitualProgress,
    pub end: RitualProgress,
    /// Independent of local progress: unavailable is not zero results.
    pub results_availability: RitualAvailability,
    /// Qualified kept-change results only, not all work in the project.
    pub results: Vec<DoneEntry>,
    /// The read covers only the newest 20 kept snapshots, not all project work.
    pub results_limited: bool,
}

/// One explicit progress save. Escape must not call this method.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct RitualWrite {
    pub context: String,
    pub revision: u32,
    pub ritual: RitualKind,
    /// Unmarked saves a resume position only. It cannot erase a final mark.
    pub mark: RitualMark,
    pub step: u32,
}

/// Explicit presentation acknowledgement. Reads alone never record a visit.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct RitualVisit {
    pub context: String,
    pub revision: u32,
}

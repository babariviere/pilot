//! Mock Pilot Day Today, written in Rust only, for the stack comparison
//! with the TSX app (`apps/day`). It renders the same read model
//! (`pilot_day_native::fixture`), changes it with the same rules
//! (`pilot_day_native::desk::Desk`) and the same mock coordinator latency,
//! and matches the TSX screen's layout, copy, controls and update workload.
//! It runs with no JS VM, and it connects to no daemon or user data.

mod card;
mod day;
mod screen;
mod ui;

use nsh_core::{element::Root, prelude::*};
use pilot_day_native::model::Scenario;

pub use crate::day::Day;

/// The app's UI set. Nothing here is meant for TSX; the roots are listed
/// so `registry()` documents them for tests.
#[native_module("pilot-day-rust/native")]
fn native(registry: &mut Registry) {
    registry
        .register::<TodayApp>()
        .register::<QuietApp>()
        .register::<TroubleApp>()
        .register::<LargeApp>()
        .register::<PulseApp>()
        .register::<TodayRoot>();
}

/// The props of [`TodayRoot`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TodayRootProps {
    /// The mock world to start from.
    #[prop(default)]
    pub scenario: Prop<Scenario>,
    /// Runs the shared update workload (`Desk::pulse`) with its defaults.
    #[prop(default)]
    pub pulse: Prop<bool>,
}

/// Today for a chosen world, with or without the update workload. The
/// hidden probe host makes this root from its arguments.
#[component]
pub fn TodayRoot(props: TodayRootProps) -> impl IntoElement {
    // A root's props are read once: the world is chosen at launch.
    screen::today(props.scenario.get_untracked(), props.pulse.get_untracked())
}

/// The decisions world (as `App.tsx`): `nsh.json`'s root.
#[component]
pub fn TodayApp() -> impl IntoElement {
    screen::today(Scenario::Decisions, false)
}

/// Nothing waits (as `Quiet.tsx`).
#[component]
pub fn QuietApp() -> impl IntoElement {
    screen::today(Scenario::Quiet, false)
}

/// A lost confirmation and an unconfirmed push (as `Trouble.tsx`).
#[component]
pub fn TroubleApp() -> impl IntoElement {
    screen::today(Scenario::Trouble, false)
}

/// 203 missions and 123 results (as `Large.tsx`).
#[component]
pub fn LargeApp() -> impl IntoElement {
    screen::today(Scenario::Large, false)
}

/// The large world with the update workload running (as `Pulse.tsx`).
#[component]
pub fn PulseApp() -> impl IntoElement {
    screen::today(Scenario::Large, true)
}

/// The theme both screens use (`apps/day/theme.json`), as tokens for a root.
pub fn theme_tokens() -> Tokens {
    nsh_base::Theme::from_json(include_str!("../../../theme.json"))
        .expect("theme.json is a valid theme")
        .into_tokens()
}

/// The root for `scenario`, themed, for hosts and tests.
pub fn root(scenario: Scenario, pulse: bool) -> Root {
    Root::new::<TodayRoot>(move || TodayRootProps {
        scenario: Prop::from(scenario),
        pulse: Prop::from(pulse),
    })
    .tokens(theme_tokens())
    .app_id("dev.pilot.day.spike.rust")
}

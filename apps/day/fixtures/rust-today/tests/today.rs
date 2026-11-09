//! The Today flows as a user takes them, on the Rust-only screen. Each test
//! is the Rust twin of a test in the TSX app's `App.test.tsx`, with the
//! same window, selectors, steps and expected texts, so a pass on both
//! sides shows the two screens behave alike.

use std::time::Duration;

use nsh_core::{
    Size,
    geometry::Points,
    platform::{Environment, Idiom, Os},
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;
use pilot_day_native::model::Scenario;

/// The decision card's own commit, not a mission row's link to it.
const DECIDE: &str = "id:decision >> role:button[Decide]";

/// Today for `scenario` in a 1100 × 900 macOS window, as the TSX tests
/// open it (`{ platform: "macos", width: 1100, height: 900 }`).
fn open(scenario: Scenario) -> Headless {
    open_with(scenario, false)
}

fn open_with(scenario: Scenario, pulse: bool) -> Headless {
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(Points(1100.0), Points(900.0)),
        environment: Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            ..Environment::default()
        },
        ..EngineConfig::new(pilot_day_rust::root(scenario, pulse))
    })
    .expect("the engine starts");
    // `open` in nsh/test resolves after the first render; so does this.
    app.wait_for("Mock data").expect("Today renders");
    app
}

#[test]
fn today_shows_decisions_first_then_moving_and_waiting_missions() -> Result<(), String> {
    let mut app = open(Scenario::Decisions);
    app.wait_for("Three short things need you.")?;
    for text in [
        "How should finished work reach you?",
        "1 of 3",
        "Up next: Open a test copy of Pilot on your Mac?",
        "Moving  1",
        "Not moving  2",
        "Waiting for you",
        "Done since you looked",
        "Coming up",
        "Mock data",
    ] {
        assert!(
            app.shows(text),
            "missing {text:?} in {:?}",
            app.screen().texts()
        );
    }
    Ok(())
}

#[test]
fn deciding_sends_the_recommended_option_and_moves_the_mission() -> Result<(), String> {
    let mut app = open(Scenario::Decisions);
    app.press(DECIDE)?;
    app.wait_for("Quieter notifications has your answer: One summary at 18:00.")?;
    app.wait_for("Two things left.")?;
    assert!(app.shows("Open a test copy of Pilot on your Mac?"));
    assert!(app.shows("Moving  2"));
    Ok(())
}

#[test]
fn a_picked_option_is_the_one_sent() -> Result<(), String> {
    let mut app = open(Scenario::Decisions);
    app.press("Only failures and questions")?;
    app.press(DECIDE)?;
    app.wait_for("Quieter notifications has your answer: Only failures and questions.")?;
    Ok(())
}

#[test]
fn an_answer_on_its_way_settles_after_another_decision_comes_to_the_front() -> Result<(), String> {
    let mut app = open(Scenario::Decisions);
    app.press(DECIDE)?;
    app.wait_for("Sending your answer…")?;
    // The sending card leaves the front (the Native desktop app row's
    // Decide link); its send still settles once.
    app.press("role:button[Decide] >> nth=1")?;
    app.wait_for("role:button[Confirm]")?;
    app.wait_for("Quieter notifications has your answer: One summary at 18:00.")?;
    app.wait_for("Two things left.")?;
    Ok(())
}

#[test]
fn later_moves_a_decision_back_without_answering_it() -> Result<(), String> {
    let mut app = open(Scenario::Decisions);
    app.press("role:button[Later]")?;
    app.wait_for("role:button[Confirm]")?;
    assert!(app.shows("Up next: How should finished work reach you?"));
    assert!(!app.shows("has your answer"));
    Ok(())
}

#[test]
fn help_gives_simpler_words_more_context_and_a_question_answered_in_the_card() -> Result<(), String>
{
    let mut app = open(Scenario::Decisions);
    app.press("Say it simpler")?;
    app.wait_for(
        "Pilot sends too many notifications. Choose when it should tell you about finished work.",
    )?;
    app.press("More context")?;
    app.wait_for("Questions and failures still notify you right away with every option.")?;
    app.press("Ask a question")?;
    app.type_text("id:question", "What happens after 18:00?")?;
    app.press("role:button[Ask]")?;
    app.wait_for(
        "Anything that finishes after 18:00 waits for the next day's summary. Questions and failures still reach you right away.",
    )?;
    assert!(app.shows("What happens after 18:00?"));
    assert_eq!(app.screen().input_text("id:question")?, Some(""));
    Ok(())
}

#[test]
fn a_lost_confirmation_stays_unknown_and_is_only_checked_never_resent() -> Result<(), String> {
    let mut app = open(Scenario::Trouble);
    app.wait_for("2 integration tests fail on Linux")?;
    app.press(DECIDE)?;
    app.wait_for(
        "Pilot sent your answer but heard nothing back. It will not send it again until it checks.",
    )?;
    assert!(!app.screen().matches(DECIDE)?);
    app.press("role:button[Check again]")?;
    app.wait_for("Checked Faster search: Your answer arrived.")?;
    app.wait_for("Push not confirmed")?;
    Ok(())
}

#[test]
fn nothing_waiting_is_said_calmly() -> Result<(), String> {
    let mut app = open(Scenario::Quiet);
    app.wait_for("No decisions waiting. Pilot keeps going on its own.")?;
    assert!(app.shows("You were reading the history slice in Native desktop app."));
    Ok(())
}

#[test]
fn a_large_world_keeps_today_limited() -> Result<(), String> {
    let mut app = open(Scenario::Large);
    app.wait_for("103 earlier results are not shown here.")?;
    Ok(())
}

#[test]
fn the_update_workload_reaches_the_screen() -> Result<(), String> {
    let mut app = open_with(Scenario::Large, true);
    app.wait_for("Working on update 4.")?;
    app.wait_for("Update 4 landed with its checks.")?;
    app.wait_for("104 earlier results are not shown here.")?;
    Ok(())
}

#[test]
fn a_question_typed_while_one_is_on_its_way_is_kept() -> Result<(), String> {
    let mut app = open(Scenario::Decisions);
    app.press("Ask a question")?;
    app.type_text("id:question", "First?")?;
    app.press("role:button[Ask]")?;
    app.wait_for("role:button[Asking…]")?;
    app.type_text("id:question", " And second?")?;
    app.wait_for_gone("role:button[Asking…]", Duration::from_secs(2))?;
    assert!(app.shows("First?"));
    assert_eq!(
        app.screen().input_text("id:question")?,
        Some("First? And second?")
    );
    Ok(())
}

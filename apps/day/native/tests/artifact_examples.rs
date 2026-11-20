#![cfg(unix)]
//! The bundled examples, run the way Day's preview runs a saved revision: the same trusted chunks, theme, deny-all
//! policy and limits (`artifact_runtime::config`). Headless: behaviour and layout, not appearance.
use nsh_core::{Points, Size, platform::ColorScheme};
use nsh_testing::Headless;
use pilot_day_native::{artifact_runtime, artifact_source::CapturedSource};
use sha2::{Digest, Sha256};

macro_rules! example {
    ($name:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/kernel/skills/pilot-artifacts/nsh/examples/",
            $name,
            ".tsx"
        ))
    };
}

fn open_sized(source: &str, width: f32, scheme: ColorScheme) -> Headless {
    let captured = CapturedSource {
        artifact_id: "11111111-1111-1111-1111-111111111111".into(),
        source_session_id: "owner".into(),
        revision: 1,
        entry: "Artifact.tsx".into(),
        source: source.into(),
        source_sha256: format!("{:x}", Sha256::digest(source.as_bytes())),
        source_bytes: source.len(),
    };
    let mut config = artifact_runtime::config(captured).unwrap_or_else(|error| panic!("{error}"));
    config.viewport = Size::new(Points(width), Points(1400.0));
    config.environment.color_scheme = scheme;
    Headless::start(config).expect("separate artifact engine")
}

fn open(source: &str) -> Headless {
    open_sized(source, 1000.0, ColorScheme::Light)
}

fn assert_shows(app: &Headless, texts: &[&str]) {
    for text in texts {
        assert!(app.shows(text), "{text}: {:?}", app.screen().texts());
    }
}

#[test]
fn summary_shows_every_figure_and_the_comparison() {
    let mut app = open(example!("summary"));
    app.wait_for("Search index rebuild").expect("rendered");
    assert_shows(
        &app,
        &[
            "4.2 M",
            "47 min",
            "Shadow index",
            "Recommended",
            "Switch alias back",
            "1–2 weeks",
        ],
    );
}

#[test]
fn charts_write_their_numbers_and_states_as_text() {
    let mut app = open(example!("charts"));
    app.wait_for("Test suite health").expect("rendered");
    assert_shows(
        &app,
        &[
            "212 s",
            "6.5 s",
            "Low 8.8 min · High 14.1 min · Latest 8.8 min",
            "30 Oct",
            "12 Nov",
            "Now",
            "Done",
        ],
    );
    assert_eq!(app.screen().matches("label:daemon: 212 s"), Ok(true));
}

#[test]
fn the_mockup_changes_only_its_own_local_state_and_reopens_fresh() {
    let mut app = open(example!("mockup"));
    app.wait_for("Showing list; no item open.")
        .expect("rendered");
    app.press("role:tab[Grouped]").expect("layout tab");
    app.wait_for("Showing grouped; no item open.")
        .expect("switched");
    assert_shows(&app, &["Code · 2", "Tests · 1"]);
    app.press("text:Fix the flaky upload test").expect("a row");
    app.wait_for("Timeout raised; root cause unknown.")
        .expect("opened");
    assert!(app.shows("Showing grouped; one item open."));
    assert!(app.screen().opened_urls().is_empty());
    let mut again = open(example!("mockup"));
    again
        .wait_for("Showing list; no item open.")
        .expect("a reopened mockup starts fresh");
}

#[test]
fn the_prototype_switches_variant_and_situation_and_starts_each_case_over() {
    let mut app = open(example!("prototype"));
    app.wait_for("A: one banner above the list. The list stays as it was.")
        .expect("rendered");
    app.press("role:tab[B · Inline row]").expect("variant");
    app.wait_for("B: the failed row opens in place with what happened.")
        .expect("second variant");
    assert!(!app.shows("A: one banner above the list. The list stays as it was."));
    app.press("role:tab[3 · Works when pressed]")
        .expect("situation");
    app.press("role:button[Try again]")
        .expect("the variant's action");
    app.wait_for("Synced at 09:14. 4 files are up to date.")
        .expect("pressed");
    // Another situation starts its case over.
    app.press("role:tab[2 · Failed again]").expect("situation");
    app.wait_for("Third failure since 08:50. The server is down for maintenance until 10:00.")
        .expect("case over");
    assert_eq!(app.screen().matches("role:button[Try again]"), Ok(true));
    app.press("role:tab[C · Side panel]").expect("variant");
    app.wait_for("C: a panel beside the list holds the details and the action.")
        .expect("third variant");
    assert_shows(&app, &["Payroll export", "Try again"]);
}

#[test]
fn the_pilot_page_answers_its_question_locally() {
    let mut app = open(example!("page"));
    app.wait_for("How should 2.4 ship the new billing page?")
        .expect("rendered");
    assert_shows(
        &app,
        &[
            "Release 2.4",
            "Thursday 14 November",
            "Working",
            "Move the billing tables",
            "3/6",
        ],
    );
    app.press("text:Wait for 2.5").expect("an option");
    app.press("role:button[Decide]").expect("the commit");
    app.wait_for("Decided: Wait for 2.5. Nothing was sent; this is a preview.")
        .expect("answered");
    app.press("role:tab >> nth=1").expect("the Done tab");
    app.wait_for("Faster search results").expect("switched");
}

#[test]
fn diagrams_draw_in_both_appearances_and_scroll_when_narrow() {
    for scheme in [ColorScheme::Light, ColorScheme::Dark] {
        let mut app = open_sized(example!("flow"), 1000.0, scheme);
        app.wait_for("Build in a workspace").expect("rendered");
        assert_shows(
            &app,
            &[
                "Request",
                "From Today or a mission",
                "Checks",
                "Ready for you to check",
                "pass",
                "fix",
            ],
        );
        assert_eq!(app.screen().matches("id:flow-diagram"), Ok(true));
    }
    let mut app = open(example!("sequence"));
    app.wait_for("Background service").expect("rendered");
    assert_shows(
        &app,
        &[
            "You",
            "Press Update",
            "Save open drafts",
            "Running tools stop at a safe point",
            "Restart with drafts kept",
        ],
    );
    assert_eq!(app.screen().matches("id:sequence-diagram"), Ok(true));
    let mut narrow = open_sized(example!("flow"), 360.0, ColorScheme::Light);
    narrow.wait_for("Ready for you to check").expect("rendered");
    narrow
        .scroll("id:flow-diagram", Points(400.0))
        .expect("a wide diagram scrolls sideways");
    assert!(narrow.shows("Ready for you to check"));
}

#[test]
fn a_throwing_artifact_shows_its_error_and_refused_data_says_why() {
    let mut broken = open(
        "export default function Artifact(): never { throw new Error('rows is not iterable'); }",
    );
    broken
        .wait_for("This artifact stopped with an error.")
        .expect("the error boundary");
    assert!(broken.shows("rows is not iterable"));
    let refused = r#"
import {BarChart, ComparisonTable, FlowDiagram, type FlowSpec, Page, SequenceDiagram, TrendChart} from 'pilot-artifact/ui';
const tooMany: FlowSpec = {nodes: Array.from({length: 41}, (_, i) => ({id: `n${i}`, label: `Step ${i}`}))};
export default function Refused() {
  return <Page title="Refused data">
    <FlowDiagram spec={{nodes: [{id: 'a', label: 'Start'}], edges: [{from: 'a', to: 'missing'}]}} />
    <FlowDiagram spec={tooMany} />
    <SequenceDiagram spec={{participants: [{id: 'a', label: 'A'}], steps: [{from: 'a', to: 'b', label: 'hi'}]}} />
    <BarChart spec={{bars: [{label: 'Loss', value: -3}]}} />
    <TrendChart spec={{points: [{label: 'only', value: 1}]}} />
    <ComparisonTable spec={{columns: ['A', 'B'], rows: [{label: 'Cost', cells: ['1']}]}} />
    <FlowDiagram spec={JSON.parse('{"nodes":"not a list"}')} />
  </Page>;
}"#;
    let mut app = open(refused);
    app.wait_for("Refused data").expect("rendered");
    assert_shows(
        &app,
        &[
            "A link names \"missing\", which is not a step.",
            "nodes has 41; the limit is 40.",
            "steps[0].to names \"b\", which is not a participant.",
            "Bar \"Loss\" is negative; bars start at zero.",
            "points needs at least 2.",
            "Row \"Cost\" cells needs at least 2.",
            "nodes must be a list.",
        ],
    );
    assert!(!app.shows("Start") && !app.shows("Step 0"));
    assert_eq!(
        app.screen().count("text:This diagram can't be drawn."),
        Ok(4)
    );
}

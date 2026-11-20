#![cfg(unix)]
//! Day's component library inside an artifact preview: `pilot-day/ui` links, draws with Day's theme, and the
//! older `pilot-artifact/ui` names keep working on top of it.
use nsh_core::{Color, Points, Size, platform::ColorScheme};
use nsh_testing::Headless;
use pilot_day_native::{
    artifact_check, artifact_library, artifact_runtime,
    artifact_source::{CapturedSource, compile_source},
};
use sha2::{Digest, Sha256};

fn captured(source: &str) -> CapturedSource {
    CapturedSource {
        artifact_id: "11111111-1111-1111-1111-111111111111".into(),
        source_session_id: "owner".into(),
        revision: 1,
        entry: "Artifact.tsx".into(),
        source: source.into(),
        source_sha256: format!("{:x}", Sha256::digest(source.as_bytes())),
        source_bytes: source.len(),
    }
}

fn start(source: &str, scheme: ColorScheme) -> Headless {
    let mut config =
        artifact_runtime::config(captured(source)).unwrap_or_else(|error| panic!("{error}"));
    config.environment.color_scheme = scheme;
    config.viewport = Size::new(Points(900.0), Points(650.0));
    Headless::start(config).expect("separate artifact engine")
}

const PILOT_PAGE: &str = r#"
import {Scroll, signal} from 'nsh';
import {Body, Button, Column, Icon, Notice, Page, PageHead, Panel, Question, Row, Rows, Section, State, Tab, Tabs} from 'pilot-day/ui';
export default function Artifact() {
  const tab = signal('open');
  const answered = signal(false);
  return <Scroll class="flex-1"><Page>
    <PageHead title="Release 2.4" state={<State kind="needs" />} text="One decision waits."
      actions={<Button label="Share" icon="share" onPress={() => {}} />} />
    <Panel
      tabs={<Tabs>
        <Tab label="Open" selected={tab() === 'open'} onPress={() => tab.set('open')} />
        <Tab label="Done" count={2} selected={tab() === 'done'} onPress={() => tab.set('done')} />
      </Tabs>}
      notice={<Notice text="Checks are slow today" detail="About 20 min a run." placement="panel" />}>
      <Column>
        <Section title="Needs you" count={1}>
          <Question title="Ship behind a flag?" foot={<Button kind="primary" label="Decide" onPress={() => answered.set(true)} />}>
            <Body>{answered() ? 'Decided here only.' : 'Support has not seen it yet.'}</Body>
          </Question>
        </Section>
        <Section title={tab() === 'open' ? 'Working' : 'Done'}>
          <Rows><Row mark="working" title="Move the billing tables" meta="Billing" trailing={<Icon name="check" />} /></Rows>
        </Section>
      </Column>
    </Panel>
  </Page></Scroll>;
}"#;

#[test]
fn a_pilot_page_from_the_library_renders_and_switches_tabs() {
    let mut app = start(PILOT_PAGE, ColorScheme::Light);
    app.wait_for("Ship behind a flag?")
        .expect("the page renders");
    for text in [
        "Release 2.4",
        "Needs you",
        "Share",
        "Checks are slow today",
        "Working",
        "Move the billing tables",
    ] {
        assert!(app.shows(text), "{text}");
    }
    app.press("role:tab >> nth=1").expect("a library tab");
    app.wait_for_gone("Working", std::time::Duration::from_secs(2))
        .expect("the tab switched");
    app.press("role:button[Decide]").expect("a library button");
    app.wait_for("Decided here only.")
        .expect("local state changed");
    let checked =
        artifact_check::run(compile_source(PILOT_PAGE, "Artifact.tsx").expect("compiles"))
            .expect("the publish check runs it");
    assert_eq!(checked.no_room_count, 0, "{checked:?}");
    assert_eq!(
        checked.pressed, 1,
        "the check presses the other tab once: {checked:?}"
    );
}

#[test]
fn previews_draw_with_day_s_theme_and_fonts() {
    let source = r#"
import {Text, View, token} from 'nsh';
import {Body, State} from 'pilot-day/ui';
export default function Artifact() {
  return <View>
    <State kind="needs" />
    <Text>{'soft ' + String(token('needs-soft'))}</Text>
    <Text>{'radius ' + String(token('radius-panel'))}</Text>
    <Body>Body text</Body>
  </View>;
}"#;
    for (scheme, ink, soft) in [
        (ColorScheme::Light, 0x8a5a_00ff, "soft #fbf3e0ff"),
        (ColorScheme::Dark, 0xf0c5_6dff, "soft #3a3324ff"),
    ] {
        let mut app = start(source, scheme);
        app.wait_for("Needs you").expect("rendered");
        // `text-needs-ink` resolves to theme.json's value, not NSH's default theme.
        let style = app
            .screen()
            .span_style("text:Needs you")
            .expect("state words");
        assert_eq!(style.color, Color(ink), "{scheme:?}");
        assert!(app.shows(soft), "{scheme:?}: {:?}", app.screen().texts());
        let body = app.screen().span_style("text:Body text").expect("body");
        let family = body.font_family.map(|family| family.name().to_string());
        assert!(
            family
                .as_deref()
                .is_some_and(|family| family.starts_with("Geist")),
            "{family:?}"
        );
    }
}

#[test]
fn every_library_export_links_and_the_registry_is_refused() {
    let names: Vec<&str> = artifact_library::exports()
        .values
        .iter()
        .map(String::as_str)
        .collect();
    let source = format!(
        "import {{Text}} from 'nsh';\nimport {{{list}}} from 'pilot-day/ui';\nconst all = [{list}];\nexport default () => <Text>{{all.every((x) => x !== undefined) ? 'linked ' + all.length : 'missing'}}</Text>;",
        list = names.join(", ")
    );
    let mut app = start(&source, ColorScheme::Light);
    app.wait_for(&format!("linked {}", names.len()))
        .expect("every export of pilot-day/ui links");
    for (source, error) in [
        (
            "import {snapshot} from 'pilot-day/ui'; export default () => null;",
            "pilot-day/ui has no snapshot",
        ),
        (
            "import {act} from 'pilot-day/ui'; export default () => null;",
            "pilot-day/ui has no act",
        ),
        (
            "import {snapshot} from 'pilot-day/ui/agent'; export default () => null;",
            "imports from \"pilot-day/ui/agent\" are refused: import Pilot's parts from \"pilot-day/ui\"",
        ),
        (
            "import {Clipboard} from 'nsh'; import {Page} from 'pilot-day/ui'; export default () => Page;",
            "Clipboard from \"nsh\" is refused",
        ),
    ] {
        let refused = compile_source(source, "Artifact.tsx").unwrap_err();
        assert!(refused.contains(error), "{refused}");
    }
    let typed = "import type {IconName, ButtonKind} from 'pilot-day/ui'; import {MarkKind} from 'pilot-day/ui'; export default (a: IconName, b: ButtonKind, c: MarkKind) => null;";
    compile_source(typed, "Artifact.tsx").expect("types are erased");
}

#[test]
fn every_pilot_artifact_ui_name_still_compiles_and_renders() {
    // An artifact as agents wrote them before `pilot-day/ui`: every name the kit exported, with their props.
    let source = r#"
import {Text, View, signal} from 'nsh';
import {
  BarChart, type BarSpec, CHART_LIMITS, type EventState, Timeline, type TimelineEvent, TrendChart, type TrendSpec,
  FlowDiagram, SequenceDiagram, FLOW_LIMITS, type FlowEdge, type FlowNode, FlowSpec, type Tone,
  SEQUENCE_LIMITS, type SequenceMessage, type SequenceNote, type SequenceParticipant, type SequenceSpec, type SequenceStep,
  Card, type ChoiceOption, Choices, type ComparisonRow, type ComparisonSpec, ComparisonTable, DataProblem,
  Page, Section, Stat, TABLE_LIMITS,
} from 'pilot-artifact/ui';
const bars: BarSpec = {bars: [{label: 'daemon', value: 212}], unit: 's'};
const trend: TrendSpec = {points: [{label: 'Mon', value: 3}, {label: 'Tue', value: 5}]};
const state: EventState = 'done';
const events: TimelineEvent[] = [{when: '12 Nov', title: 'Cut', state}];
const tone: Tone = 'accent';
const nodes: FlowNode[] = [{id: 'a', label: 'Start', tone}, {id: 'b', label: 'End'}];
const edges: FlowEdge[] = [{from: 'a', to: 'b', label: 'go'}];
const flow: FlowSpec = {nodes, edges};
const people: SequenceParticipant[] = [{id: 'u', label: 'You'}, {id: 'p', label: 'Pilot'}];
const message: SequenceMessage = {from: 'u', to: 'p', label: 'Ask'};
const note: SequenceNote = {note: 'Thinks', over: 'p'};
const steps: SequenceStep[] = [message, note];
const sequence: SequenceSpec = {participants: people, steps};
const options: ChoiceOption<'a' | 'b'>[] = [{id: 'a', label: 'A · List'}, {id: 'b', label: 'B · Cards'}];
const rows: ComparisonRow[] = [{label: 'Cost', cells: ['Low', 'High']}];
const table: ComparisonSpec = {columns: ['One', 'Two'], rows, recommended: 0};
const limits = [CHART_LIMITS, FLOW_LIMITS, SEQUENCE_LIMITS, TABLE_LIMITS].length;
export default function Artifact() {
  const v = signal<'a' | 'b'>('a');
  return <Page title="Every kit name" subtitle={'Limits: ' + limits}>
    <Choices label="Layout" options={options} value={v()} onChange={v.set} />
    <Text>{'Showing ' + v()}</Text>
    <View class="flex-row flex-wrap gap-3">
      <Stat label="Open" value="12" />
      <Stat label="Ready" value="3" note="Checked today" />
    </View>
    <Section title="Charts">
      <BarChart spec={bars} />
      <TrendChart spec={trend} />
      <Timeline spec={{events}} />
    </Section>
    <Card title="Diagrams" class="w-full">
      <FlowDiagram spec={flow} />
      <SequenceDiagram spec={sequence} />
    </Card>
    <Card><ComparisonTable spec={table} /></Card>
    <DataProblem what="chart" problem="An example of a refusal." />
  </Page>;
}"#;
    let checked =
        artifact_check::run(compile_source(source, "Artifact.tsx").expect("old names compile"))
            .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(checked.no_room_count, 0, "{checked:?}");
    assert_eq!(
        checked.pressed, 1,
        "Choices is still a variant switch: {checked:?}"
    );
    let mut app = start(source, ColorScheme::Light);
    app.wait_for("Every kit name").expect("rendered");
    for text in [
        "Limits: 4",
        "Open",
        "Checked today",
        "212 s",
        "Start",
        "Ask",
        "Recommended",
        "This chart can't be drawn.",
    ] {
        assert!(app.shows(text), "{text}: {:?}", app.screen().texts());
    }
    app.press("role:tab[B · Cards]").expect("a Choices option");
    app.wait_for("Showing b").expect("switched");
}

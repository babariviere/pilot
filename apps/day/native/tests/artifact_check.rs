#![cfg(unix)]
//! The publish-time check runs an entry as Day's preview would and reports what went wrong.
use pilot_day_native::{artifact_check, artifact_source::compile_source};

fn run(source: &str) -> Result<artifact_check::Rendered, String> {
    artifact_check::run(compile_source(source, "Artifact.tsx")?)
}

#[test]
fn every_bundled_example_runs_and_has_room_for_its_text() {
    for (name, source, title) in [
        (
            "summary",
            include_str!(
                "../../../../packages/kernel/skills/pilot-artifacts/nsh/examples/summary.tsx"
            ),
            "Search index rebuild",
        ),
        (
            "charts",
            include_str!(
                "../../../../packages/kernel/skills/pilot-artifacts/nsh/examples/charts.tsx"
            ),
            "Test suite health",
        ),
        (
            "mockup",
            include_str!(
                "../../../../packages/kernel/skills/pilot-artifacts/nsh/examples/mockup.tsx"
            ),
            "Inbox layout",
        ),
        (
            "prototype",
            include_str!(
                "../../../../packages/kernel/skills/pilot-artifacts/nsh/examples/prototype.tsx"
            ),
            "A: one banner above the list. The list stays as it was.",
        ),
        (
            "flow",
            include_str!(
                "../../../../packages/kernel/skills/pilot-artifacts/nsh/examples/flow.tsx"
            ),
            "Build in a workspace",
        ),
        (
            "sequence",
            include_str!(
                "../../../../packages/kernel/skills/pilot-artifacts/nsh/examples/sequence.tsx"
            ),
            "Background service",
        ),
    ] {
        let rendered = run(source).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(rendered.no_room_count, 0, "{name}: {:?}", rendered.no_room);
        assert!(
            rendered.texts > 0 && rendered.shows.len() <= 30,
            "{name}: {rendered:?}"
        );
        assert!(
            rendered.shows.iter().any(|text| text == title)
                || rendered.texts > rendered.shows.len(),
            "{name}: {rendered:?}"
        );
    }
}

#[test]
fn runtime_errors_are_refused_with_their_message() {
    let startup = run("throw Error('fails at load'); export default () => null;").unwrap_err();
    assert_eq!(startup, "The preview could not start: Error: fails at load");
    let render = run(
        "import {Text, signal} from 'nsh'; export default function A() { const s = signal(1); return <Text>{s.get()}</Text>; }",
    )
    .unwrap_err();
    assert_eq!(render, "The preview stopped with an error: not a function");
}

#[test]
fn each_variant_switch_is_pressed_once_and_its_errors_are_refused() {
    let prototype = run(include_str!(
        "../../../../packages/kernel/skills/pilot-artifacts/nsh/examples/prototype.tsx"
    ))
    .expect("the prototype's variants and situations all render");
    assert!(prototype.pressed >= 4, "{prototype:?}");
    assert_eq!(prototype.unpressed, 0);
    // A Choices option whose variant throws: the first screen renders, the variant does not.
    let choices = run(
        r#"import {Text, signal} from 'nsh';
import {Choices, Page} from 'pilot-artifact/ui';
const rows = {a: ['One']};
export default function A() {
  const v = signal<'a' | 'b'>('a');
  return <Page title="Plan">
    <Choices label="Layout" options={[{id: 'a', label: 'A · List'}, {id: 'b', label: 'B · Cards'}]} value={v()} onChange={v.set} />
    <Text>{rows[v()].join(', ')}</Text>
  </Page>;
}"#,
    )
    .unwrap_err();
    assert!(
        choices.starts_with("The preview stopped with an error after pressing \"B · Cards\": "),
        "{choices}"
    );
    // A tab whose panel throws.
    let tabs = run(r#"import {Text, View, signal} from 'nsh';
import {Tab, Tabs} from 'nsh/base';
import {Page} from 'pilot-artifact/ui';
export default function A() {
  const tab = signal('one');
  return <Page title="Plan">
    <Tabs><Tab selected={tab() === 'one'} onPress={() => tab.set('one')}><Text>One</Text></Tab>
      <Tab selected={tab() === 'two'} onPress={() => tab.set('two')}><Text>Two</Text></Tab></Tabs>
    <If when={tab() === 'two'}><View>{(undefined as any).boom}</View></If>
  </Page>;
}"#)
    .unwrap_err();
    assert!(
        tabs.starts_with("The preview stopped with an error after pressing \"Two\": "),
        "{tabs}"
    );
    // A variant that only hides its text is published, with the text named.
    let hidden = run(
        r#"import {Scroll, Text, signal} from 'nsh';
import {Choices, Page} from 'pilot-artifact/ui';
export default function A() {
  const v = signal('a');
  return <Page title="Plan">
    <Choices label="Size" options={[{id: 'a', label: 'Small'}, {id: 'b', label: 'Boxed'}]} value={v()} onChange={v.set} />
    <If when={v() === 'b'}><Scroll class="flex-1"><Text>Boxed text</Text></Scroll></If>
  </Page>;
}"#,
    )
    .expect("renders");
    assert_eq!((hidden.pressed, hidden.no_room_count), (1, 1));
    assert_eq!(hidden.no_room, ["Boxed text"]);
}

#[test]
fn newly_allowed_components_run_in_the_same_runtime_as_day() {
    // artifact_check uses artifact_runtime::config_for, the config Day's preview starts.
    let rendered = run(
        r#"import {Animated, createAnimatedValue, createMotion, keymap, LayoutAnimation, PanResponder, Text, View, signal, cleanup} from 'nsh';
import {Editor} from 'nsh/base';
import {Line, Plot} from 'nsh/base/plot';
import {Choices, Page} from 'pilot-artifact/ui';
export default function A() {
  const open = signal('list');
  const x = createAnimatedValue(0);
  const motion = createMotion();
  const pan = PanResponder.create({onMoveShouldSetPanResponder: () => true});
  cleanup(keymap.bind('cmd+shift+l', () => open.set('list')));
  return <Page title="Everything">
    <Choices label="View" options={[{id: 'list', label: 'List'}, {id: 'chart', label: 'Chart'}]} value={open()}
      onChange={(id) => { LayoutAnimation.configureNext({duration: 120, update: {type: 'easeInEaseOut'}}); open.set(id); motion.play('fadeIn'); }} />
    <View style={motion.style} {...pan.panHandlers} onLayout={() => Animated.timing(x, {toValue: 1, duration: 100}).start()}><Text>Animated</Text></View>
    <If when={open() === 'chart'} else={<Editor defaultValue="let a = 1;" language="ts" readOnly />}>
      <View class="h-40"><Plot data={[{x: 1, y: 2}, {x: 2, y: 3}]} x="x" y="y"><Line /></Plot></View>
    </If>
  </Page>;
}"#,
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(rendered.pressed, 1, "{rendered:?}");
    assert!(
        rendered.shows.iter().any(|text| text == "Animated"),
        "{rendered:?}"
    );
}

#[test]
fn text_inside_a_scroll_with_no_height_has_no_room() {
    // Seen in saved mockups: a Scroll with flex-1 inside Page gets no height, so Day showed only the header.
    let rendered = run(
        r#"import {Scroll, Text, View} from 'nsh';
import {Page} from 'pilot-artifact/ui';
export default function A() {
  return <Page title="Plan"><Text>Top</Text>
    <Scroll class="flex-1"><View class="gap-2 p-4"><Text>Inside one</Text><Text>Inside two</Text></View></Scroll>
    <View class="h-0 overflow-hidden"><Text>Clipped</Text></View>
    <View class="h-0"><Text>Overflows</Text></View>
  </Page>;
}"#,
    )
    .expect("runs");
    assert_eq!(rendered.shows, ["Plan", "Top", "Overflows"]);
    assert_eq!(rendered.no_room, ["Inside one", "Inside two", "Clipped"]);
    assert_eq!(rendered.no_room_count, 3);
}

#[test]
fn a_refused_import_is_named_with_why() {
    let error = compile_source(
        "import {Clipboard} from 'nsh'; export default () => null;",
        "Artifact.tsx",
    )
    .unwrap_err();
    assert!(
        error.contains(
            "Clipboard from \"nsh\" is refused: it reads and writes the computer's clipboard"
        ),
        "{error}"
    );
    let error = compile_source(
        "import {useState} from 'react'; export default () => null;",
        "Artifact.tsx",
    )
    .unwrap_err();
    assert!(
        error.contains(
            "imports from \"react\" are refused: a preview has no other packages or files"
        ),
        "{error}"
    );
    let error = compile_source(
        "import {Text} from 'nsh'; mountArtifact(() => <Text>x</Text>);",
        "Artifact.tsx",
    )
    .unwrap_err();
    assert!(error.contains("export the component as default"), "{error}");
}

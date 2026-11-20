//! One headless run of an NSH artifact before the artifact tool publishes it.
//! It starts the compiled entry the way Day's preview does
//! (`artifact_runtime::config_for`: the same kit, bootstrap, deny-all policy,
//! UI sets and limits) on NSH's headless engine, then reports a runtime error,
//! or what the page shows and which texts have no room. It presses each
//! variant switch once (`SWITCHES`) and checks every state it reaches the same
//! way. No window, GPU or native views: it checks errors and layout, not
//! appearance.
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use nsh_core::{Bounds, NodeId, Points, ROOT_ID, Size, ViewKind, platform::Os};
use nsh_testing::{Headless, LayoutNode};
use serde::Serialize;

/// Day's preview on a laptop: the full window is about this size, and the
/// inline pane is as wide and 384 points tall, which only changes how far a
/// reader scrolls.
const VIEWPORT: (f32, f32) = (900.0, 650.0);
/// Texts the report quotes, and characters per text. The report goes into the
/// tool result, which the model reads again on later turns, so it stays near
/// 3 KB: enough to see the title, the controls and the first content.
const SHOWN_TEXTS: usize = 30;
const TEXT_CHARS: usize = 100;
/// Texts with no room the report quotes; the count covers all of them.
const NO_ROOM_EXAMPLES: usize = 5;
/// How much of an error the report keeps. Headless errors list the texts on
/// screen after the message, which the agent does not need in full.
const ERROR_CHARS: usize = 1500;
/// The variant switches the check presses: each `nsh/base` `Tab` (which
/// `pilot-day/ui`'s `Tab` and `Choices` options are) and each button in a radio
/// group (`Choices` before it drew tabs). Other buttons may stand for actions in
/// the mock, so they are left alone.
const SWITCHES: &[&str] = &["role:radiogroup >> role:button", "role:tab"];
/// No press starts later than this after the run starts. A press may still take
/// the 1 s call limit and the 2 s settle, so the run ends within 9 s, under the
/// helper's 10 s deadline (`nsh-host.ts`).
const PRESS_UNTIL: Duration = Duration::from_secs(6);
/// At most this many presses. The largest saved prototypes have 9 to 12
/// options; 40 leaves room for a few more groups and keeps the run short.
const MAX_PRESSES: usize = 40;

/// What one run showed.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    /// Texts with room to show on the first screen, in page order, the first `SHOWN_TEXTS`.
    pub shows: Vec<String>,
    /// How many texts have room to show on the first screen.
    pub texts: usize,
    /// Texts that have no room in any state reached, the first
    /// `NO_ROOM_EXAMPLES`: a parent that clips (a `Scroll`, `overflow-hidden`)
    /// has no height or width there.
    pub no_room: Vec<String>,
    /// How many different texts have no room in any state reached.
    pub no_room_count: usize,
    /// Variant switches pressed, each once.
    pub pressed: usize,
    /// Variant switches found but not pressed: the time or press limit came first.
    pub unpressed: usize,
}

fn cut(text: &str, chars: usize) -> String {
    if text.chars().count() <= chars {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(chars).collect();
    cut.push('…');
    cut
}

/// Starts `code` (an entry `compile_source` returned) once, waits for its
/// first render to settle and reads what it shows, then presses each variant
/// switch once and checks the state it shows. Call off any UI thread: it takes
/// 9 s at most.
///
/// # Errors
/// The engine stopped, or the entry threw while loading, rendering or handling
/// a press (Day's error boundary shows it, or the error was uncaught).
pub fn run(code: String) -> Result<Rendered, String> {
    let started = Instant::now();
    let mut config = crate::artifact_runtime::config_for(code)?;
    config.environment.os = Os::MacOs;
    config.viewport = Size::new(Points(VIEWPORT.0), Points(VIEWPORT.1));
    let mut app = Headless::start(config)
        .map_err(|error| format!("The preview engine did not start: {error}"))?;
    if let Err(error) = app.first_render() {
        // Measuring views and system dialogs need a real platform. Day has one, so this is no failure.
        if !error.contains("which only a real platform answers") {
            return Err(format!("The preview failed: {}", cut(&error, ERROR_CHARS)));
        }
    }
    stopped(&app, "")?;
    let first = rendered(&app.screen().layout_nodes());
    let mut out = Rendered {
        shows: first.shows,
        texts: first.texts,
        ..Rendered::default()
    };
    // Distinct texts with no room, in the order the states showed them.
    let mut no_room: Vec<String> = Vec::new();
    let mut add = |texts: Vec<String>| {
        for text in texts {
            if !no_room.contains(&text) {
                no_room.push(text);
            }
        }
    };
    add(first.no_room);
    for selector in SWITCHES {
        let mut at = 0;
        loop {
            let count = app.screen().count(selector)?;
            if at >= count {
                break;
            }
            if out.pressed >= MAX_PRESSES || started.elapsed() >= PRESS_UNTIL {
                out.unpressed += count - at;
                break;
            }
            let one = format!("{selector} >> nth={at}");
            at += 1;
            // Disabled, or the state it shows is the one already checked.
            let Ok(Some(id)) = app.screen().press_target(&one) else {
                continue;
            };
            if app.screen().selected(&one) == Ok(true) {
                continue;
            }
            let name = name_of(&app.screen().layout_nodes(), id);
            let after = format!(" after pressing {name:?}");
            match app.press(&one) {
                Ok(()) => {}
                Err(error) if error.contains("the app threw") => {
                    return Err(format!(
                        "The preview failed{after}: {}",
                        cut(&error, ERROR_CHARS)
                    ));
                }
                // Covered by another view, or it needs a real platform: a reader in Day could still use it.
                Err(_) => continue,
            }
            out.pressed += 1;
            stopped(&app, &after)?;
            add(rendered(&app.screen().layout_nodes()).no_room);
        }
    }
    out.no_room_count = no_room.len();
    out.no_room = no_room
        .iter()
        .take(NO_ROOM_EXAMPLES)
        .map(|text| cut(text, TEXT_CHARS))
        .collect();
    Ok(out)
}

/// Refuses a state where Day's error boundary shows: the entry threw while it
/// loaded or rendered. `after` names the press that led there, if any.
fn stopped(app: &Headless, after: &str) -> Result<(), String> {
    let texts: Vec<&str> = app.screen().texts();
    if let Some(at) = texts
        .iter()
        .position(|text| *text == "This artifact stopped with an error.")
    {
        let message = texts.get(at + 1).copied().unwrap_or_default();
        return Err(format!(
            "The preview stopped with an error{after}: {}",
            cut(message, ERROR_CHARS)
        ));
    }
    if let Some(text) = texts
        .iter()
        .find(|text| text.starts_with("This artifact could not start: "))
    {
        return Err(format!(
            "The preview could not start: {}",
            cut(&text[31..], ERROR_CHARS)
        ));
    }
    Ok(())
}

/// The texts inside the view `id`, joined: what a reader sees on a button.
fn name_of(nodes: &[LayoutNode], id: NodeId) -> String {
    let mut inside = HashSet::from([id]);
    let mut texts = Vec::new();
    for node in nodes {
        if node.id == id || inside.contains(&node.parent) {
            inside.insert(node.id);
            if let Some(text) = &node.text {
                texts.push(text.text.text.trim().to_owned());
            }
        }
    }
    cut(&texts.join(" "), TEXT_CHARS)
}

/// The texts of one state, sorted by whether they have room.
#[derive(Default)]
struct Sorted {
    /// The first `SHOWN_TEXTS` with room, cut to `TEXT_CHARS`.
    shows: Vec<String>,
    /// How many have room.
    texts: usize,
    /// All without room, whole.
    no_room: Vec<String>,
}

/// Sorts the texts of `nodes` (in tree order, parents first) into those with
/// room and those without. A text has no room when it has no area, or when a
/// view around it that clips (`overflow-hidden`) leaves none of it. A scroll
/// view hides what it holds only when its own viewport has no height or width:
/// otherwise the reader can scroll to the rest. Other views let what they hold
/// overflow them.
fn rendered(nodes: &[LayoutNode]) -> Sorted {
    // For each view: the area it leaves visible to what it holds, None when it leaves none.
    let mut visible: HashMap<NodeId, Option<Bounds<Points>>> = HashMap::new();
    let mut out = Sorted::default();
    let everywhere = Bounds::new(Default::default(), Size::new(Points(1e9), Points(1e9)));
    for node in nodes {
        let inherited = if node.parent == ROOT_ID {
            Some(everywhere)
        } else {
            visible.get(&node.parent).copied().flatten()
        };
        let shown =
            inherited.filter(|area| !node.hidden && !area.intersect(&node.bounds).is_empty());
        let scrolls = node.kind == ViewKind::Scroll || node.scroll.is_some();
        let leaves = if node.hidden {
            None
        } else if scrolls {
            shown.and(inherited)
        } else if node.clips {
            shown.map(|area| area.intersect(&node.bounds))
        } else {
            inherited
        };
        visible.insert(node.id, leaves);
        let Some(text) = &node.text else { continue };
        let text = text.text.text.trim();
        if text.is_empty() {
            continue;
        }
        if shown.is_some() {
            out.texts += 1;
            if out.shows.len() < SHOWN_TEXTS {
                out.shows.push(cut(text, TEXT_CHARS));
            }
        } else {
            out.no_room.push(text.to_owned());
        }
    }
    out
}

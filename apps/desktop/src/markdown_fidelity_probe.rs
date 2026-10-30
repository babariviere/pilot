//! Ordinary Markdown in the actual hidden production root, with native shaping.
use super::*;
use crate::local_model::LiveTranscript;
use gpui_kit::{
    AnyWindowHandle, Bounds, ClipboardItem, HeadlessAppContext, WindowBounds, WindowOptions,
    base::TextSelection,
    point, size,
    test::{TestEventExt, TestWindowExt},
};
use serde_json::json;
use unicode_segmentation::UnicodeSegmentation;

#[path = "markdown_reconstruction_probe.rs"]
mod reconstruction;

const CODE: &str = "  <b title=\"&amp;\">literal</b> & < > \\\\ * _ ` if (a < b && c > d) { x &= y; }\n\t日本語 👩🏽‍💻 e\u{301} 🇫🇷\n\n";
const LIST: &str = "3. **First** café\n   - child 👩🏽‍💻\n     1. deep e\u{301}\n     2. next 🇫🇷\n   - sibling `a_b`\n4. Last\n";
const LIST_TEXT: &str = "First café\nchild 👩🏽‍💻\ndeep e\u{301}\nnext 🇫🇷\nsibling a_b\nLast\n";
const TABLE: &str = "| Left | Center | Right |\n| :--- | :---: | ---: |\n| **café** | 👩🏽‍💻 e\u{301} | `x<y & z` |\n| long cell wraps naturally without deleting words 日本語 日本語 日本語 | a\\|b | 42 |\n";
const TABLE_TEXT: &str = "Left Center Right\ncafé 👩🏽‍💻 e\u{301} x<y & z\nlong cell wraps naturally without deleting words 日本語 日本語 日本語 a|b 42\n\n";

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}

fn entry(id: u64, source: &str) -> serde_json::Value {
    json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":source}]}]})
}

fn publish(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    model: &mut LiveTranscript,
    reset: bool,
) {
    let rows = model.rows();
    cx.update_window(h, |_, _, cx| {
        let transcript = v.read(cx).transcript.clone();
        transcript.update(cx, |t, cx| {
            t.replace_readonly(rows, reset, cx);
            if reset {
                t.restore_reading(
                    crate::navigation::ReadingMark {
                        message: t.rows()[0].reader_key(),
                        offset: 0.,
                        following: false,
                    },
                    cx,
                );
            }
        });
    })
    .unwrap();
    settle(cx, h);
}

fn text_state(
    cx: &mut HeadlessAppContext,
    v: &Entity<LocalViewer>,
    id: u64,
) -> Entity<gpui_kit::component::text::TextViewState> {
    cx.update(|cx| v.read(cx).transcript.read(cx).history_probe_row(id))
}

fn copy(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> String {
    cx.update_window(h, |_, w, cx| {
        cx.write_to_clipboard(ClipboardItem::new_string("sentinel".into()));
        w.press("secondary-c", cx);
        cx.read_from_clipboard().unwrap().text().unwrap()
    })
    .unwrap()
}

pub fn run_markdown_fidelity_probe(cx: &mut HeadlessAppContext) {
    let fenced = format!("```text\n{CODE}```\n");
    // The fence consumes one final line ending, not whitespace within its body.
    let code_text = CODE.to_string();
    let mixed = format!(
        "Start **bold** &amp; \\*literal\\*.\n\n{fenced}\n{LIST}\n{TABLE}\nEnd 👩🏽‍💻 e\u{301}.\n"
    );
    let mixed_text =
        format!("Start bold & *literal*.\n{code_text}{LIST_TEXT}{TABLE_TEXT}End 👩🏽‍💻 e\u{301}.\n");
    let mut heights = Vec::new();
    for width in [680., 1100.] {
        for dark in [false, true] {
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let (writer, _writes) = Interaction::recording();
            let (client, _commands) = LocalClient::synthetic_commands();
            let (h, v) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(1200.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut view = LocalViewer::preview(PreviewState::Conversation, w, cx);
                            view.client = Some(client);
                            view.editor
                                .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                            view
                        })
                    },
                )
                .unwrap()
            });
            let mut model = LiveTranscript::default();
            for (name, source, expected) in [
                ("code", fenced.as_str(), code_text.as_str()),
                ("lists", LIST, LIST_TEXT),
                ("table", TABLE, TABLE_TEXT),
                ("boundaries", mixed.as_str(), mixed_text.as_str()),
            ] {
                model.apply(&json!({"type":"snapshot","entries":[entry(20, source)]}));
                publish(cx, h, &v, &mut model, true);
                let row = cx.update(|cx| v.read(cx).transcript.read(cx).rows()[0].clone());
                let id = row.id();
                let text = text_state(cx, &v, id);
                let height = cx
                    .update_window(h, |_, w, cx| {
                        assert_eq!(cx.theme().mode.is_dark(), dark);
                        let state = text.read(cx);
                        assert_eq!(state.rendered_text().source(), source, "{name}");
                        assert_eq!(state.rendered_text().as_str(), expected, "{name}");
                        let b = state.bounds();
                        let viewport = w.find("viewport").bounds();
                        assert!(b.size.width > px(200.) && b.right() <= viewport.right());
                        assert!(
                            b.top() >= viewport.top() && b.bottom() <= viewport.bottom(),
                            "{name}: {b:?} {viewport:?}"
                        );
                        // Actual pointer focus then actual keyboard Select All/Copy.
                        w.pointer_down(
                            b.origin + point(px(3.), px(10.)),
                            gpui_kit::MouseButton::Left,
                            cx,
                        );
                        w.pointer_up(
                            b.origin + point(px(3.), px(10.)),
                            gpui_kit::MouseButton::Left,
                            cx,
                        );
                        w.press("secondary-a", cx);
                        f32::from(b.size.height)
                    })
                    .unwrap();
                heights.push((width, dark, name, height));
                settle(cx, h);
                assert_eq!(
                    copy(cx, h),
                    if name == "code" {
                        CODE.strip_suffix('\n').unwrap()
                    } else {
                        expected.trim_end_matches('\n')
                    },
                    "select all {name} {width} {dark}"
                );
                cx.update_window(h, |_, w, cx| {
                    crate::transcript_view::click_copy(w, id, cx);
                    assert_eq!(
                        cx.read_from_clipboard().unwrap().text().unwrap(),
                        source,
                        "source-owned {name}"
                    );
                })
                .unwrap();
                // A real forward and reverse drag crosses all mounted block seams.
                let b = cx.update(|cx| text.read(cx).bounds());
                // List markers are not selectable text. Start in its first
                // item's body, not the hanging marker gutter.
                let start = b.origin
                    + match name {
                        "lists" => point(px(20.), px(5.)),
                        "table" => point(px(12.), px(16.)),
                        _ => point(px(1.), px(5.)),
                    };
                let end = point(b.right() - px(1.), b.bottom() - px(5.));
                cx.update_window(h, |_, w, cx| w.drag(start, end, cx))
                    .unwrap();
                settle(cx, h);
                let selected = copy(cx, h);
                let range = cx.update(|cx| {
                    text.read(cx).selected_source_range().unwrap_or_else(|| {
                        panic!("mapped native selection {name} {width} dark={dark}: {b:?}")
                    })
                });
                assert!(!selected.is_empty(), "{name}");
                if name == "code" {
                    assert_eq!(selected, source[range.clone()], "literal code selection");
                }
                if name == "boundaries" {
                    assert_eq!(
                        selected,
                        expected.trim_end_matches('\n'),
                        "native cross-block serialization"
                    );
                }
                for endpoint in [range.start, range.end] {
                    assert!(
                        endpoint == source.len()
                            || source.grapheme_indices(true).any(|(ix, _)| ix == endpoint),
                        "{name} grapheme endpoint {endpoint}"
                    );
                }
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(
                        TextSelection::selected_text(w, cx),
                        text.read(cx).selected_text()
                    );
                    // A table drag stays in its starting cell. Reverse inside
                    // that same first cell, not from a different anchor cell.
                    let reverse_start = if name == "table" {
                        b.origin + point(px(60.), px(16.))
                    } else {
                        end
                    };
                    w.drag(reverse_start, start, cx);
                })
                .unwrap();
                settle(cx, h);
                if name == "table" {
                    // The forward drag ran beyond the cell but stayed confined.
                    assert_eq!(selected, "Left");
                }
                assert_eq!(copy(cx, h), selected, "reverse {name}");
                assert_eq!(
                    cx.update(|cx| text.read(cx).selected_source_range()),
                    Some(range)
                );
                println!(
                    "Markdown fidelity {name} {width} dark={dark}: source={} rendered={} selected={}",
                    source.len(),
                    expected.len(),
                    selected.len()
                );
                if let Some(dir) = std::env::var_os("PILOT_NEXT_MARKDOWN_FIDELITY_DIR") {
                    let dir = std::path::PathBuf::from(dir);
                    std::fs::create_dir_all(&dir).unwrap();
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(dir.join(format!("{name}-{width}-{dark}.png")))
                        .unwrap();
                }
            }
            reconstruction::run(cx, h, &v, &mixed, &mixed_text);
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    for dark in [false, true] {
        for name in ["code", "table", "boundaries"] {
            let height = |width| {
                heights
                    .iter()
                    .find(|(w, d, n, _)| *w == width && *d == dark && *n == name)
                    .unwrap()
                    .3
            };
            assert!(
                height(680.) > height(1100.),
                "native narrow wrapping {name}"
            );
        }
    }
}

//! Pointer/keyboard copy of container code in the production native transcript.
use super::*;

pub(super) fn run(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    width: f32,
    dark: bool,
) {
    for case in nested_corpus::cases() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot","entries":[entry(40,&case.source)]}));
        publish(cx, h, v, &mut model, true);
        let id = cx.update(|cx| v.read(cx).transcript.read(cx).rows()[0].id());
        let text = text_state(cx, v, id);
        cx.update_window(h, |_, w, cx| {
            let state = text.read(cx);
            let rendered = state.rendered_text();
            assert_eq!(rendered.source(), case.source);
            assert_eq!(
                rendered.as_str(),
                format!("{}{}{}", case.before, case.code, case.separator),
                "{}",
                case.name
            );
            state.focus_handle().clone().focus(w, cx);
            w.press("secondary-a", cx);
        })
        .unwrap();
        settle(cx, h);
        assert_eq!(
            copy(cx, h),
            if case.before.is_empty() {
                case.code.to_string()
            } else {
                format!("{}{}", case.before, case.code).trim().to_string()
            },
            "nested Select All {} {width} {dark}",
            case.name
        );
        cx.update(|cx| {
            let rendered = text.read(cx).rendered_text();
            let first = case.segments.first().unwrap().0.start;
            let last = case.segments.last().unwrap().0.end;
            let mapped = rendered.range_for_source(first..last).unwrap();
            assert_eq!(
                &rendered.as_str()[mapped],
                case.code,
                "canonical body {}",
                case.name
            );
            for (source, literal) in &case.segments {
                let mapped = rendered.range_for_source(source.clone()).unwrap();
                assert_eq!(
                    &rendered.as_str()[mapped],
                    &case.code[literal.clone()],
                    "{} literal line map",
                    case.name
                );
                let line_start = case.source[..source.start].rfind('\n').map_or(0, |n| n + 1);
                assert!(
                    rendered
                        .range_for_source(line_start..source.start)
                        .is_none(),
                    "{} gutter is not code",
                    case.name
                );
            }
        });
        if let Some(dir) = std::env::var_os("PILOT_NEXT_MARKDOWN_FIDELITY_DIR") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            cx.capture_screenshot(h)
                .unwrap()
                .save(dir.join(format!("{}-{width}-{dark}.png", case.name)))
                .unwrap();
        }
        let b = cx.update(|cx| text.read(cx).bounds());
        let start = b.origin + point(px(30.), px(case.code_y));
        let end = start + point(px(190.), px(0.));
        cx.update_window(h, |_, w, cx| w.drag(start, end, cx))
            .unwrap();
        settle(cx, h);
        let selected = copy(cx, h);
        let range = cx.update(|cx| {
            text.read(cx).selected_source_range().unwrap_or_else(|| {
                panic!(
                    "{} native partial: {b:?}, {start:?} → {end:?}, copied {selected:?}",
                    case.name
                )
            })
        });
        assert!(!selected.is_empty(), "{} partial native hit", case.name);
        assert_eq!(
            selected,
            case.selected(range.clone()),
            "{} source-backed partial {range:?}",
            case.name
        );
        assert!(
            selected.starts_with(' '),
            "{} selects literal indentation: {selected:?}",
            case.name
        );
        for endpoint in [range.start, range.end] {
            assert!(
                case.source
                    .grapheme_indices(true)
                    .any(|(i, _)| i == endpoint)
                    || endpoint == case.source.len()
            );
        }
        cx.update_window(h, |_, w, cx| w.drag(end, start, cx))
            .unwrap();
        settle(cx, h);
        assert_eq!(copy(cx, h), selected, "{} reverse partial", case.name);
        assert_eq!(
            cx.update(|cx| text.read(cx).selected_source_range()),
            Some(range)
        );
        let end = point(b.right() - px(10.), b.bottom() - px(14.));
        cx.update_window(h, |_, w, cx| w.drag(start, end, cx))
            .unwrap();
        settle(cx, h);
        let selected = copy(cx, h);
        let range = cx.update(|cx| text.read(cx).selected_source_range().unwrap());
        assert!(
            selected.contains("👩🏽‍💻") && selected.contains("e\u{301}") && selected.contains("🇫🇷"),
            "{} Unicode body: {selected:?}",
            case.name
        );
        assert!(
            selected.contains("\n\n"),
            "{} interior blank line",
            case.name
        );
        assert_eq!(
            selected,
            case.selected(range.clone()),
            "{} multiline literal",
            case.name
        );
        cx.update_window(h, |_, w, cx| w.drag(end, start, cx))
            .unwrap();
        settle(cx, h);
        assert_eq!(copy(cx, h), selected, "{} reverse multiline", case.name);

        let prefix = if case.name.starts_with("quote") {
            "> "
        } else {
            "  "
        };
        let adjacent = format!("{}{prefix}\n{prefix}{}", case.source, nested_corpus::AFTER);
        model.apply(&json!({"type":"snapshot","entries":[entry(40,&adjacent)]}));
        publish(cx, h, v, &mut model, false);
        let adjacent_text = text_state(cx, v, id);
        // Prose in the SAME container must not force a code-only gesture to trim.
        cx.update_window(h, |_, w, cx| {
            w.drag(start, start + point(px(190.), px(0.)), cx)
        })
        .unwrap();
        settle(cx, h);
        let range = cx.update(|cx| adjacent_text.read(cx).selected_source_range().unwrap());
        assert_eq!(
            copy(cx, h),
            case.selected(range),
            "{} code-only beside prose",
            case.name
        );
        cx.update_window(h, |_, w, cx| {
            adjacent_text.read(cx).focus_handle().clone().focus(w, cx);
            w.press("secondary-a", cx);
        })
        .unwrap();
        settle(cx, h);
        assert_eq!(
            copy(cx, h),
            format!("{}{}\nAfter bold & *.", case.before, case.code).trim(),
            "{} mixed trim unchanged",
            case.name
        );
        cx.update_window(h, |_, w, cx| {
            crate::transcript_view::click_copy(w, id, cx);
            assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), adjacent);
        })
        .unwrap();
        println!(
            "Nested Markdown {} {width} dark={dark}: literal Select All, partial/multiline forward/reverse, canonical map, mixed/source negatives",
            case.name
        );
        stream(cx, h, v, &case);
    }
}

fn stream(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    case: &nested_corpus::Case,
) {
    use gpui_kit::{EntityInputHandler, Focusable};
    let mut model = LiveTranscript::default();
    let cut = case.segments[0].0.end - 1;
    model.apply(&json!({"type":"run_start"}));
    model.apply(&json!({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":&case.source[..cut]}]}}));
    publish(cx, h, v, &mut model, true);
    let id = cx.update(|cx| v.read(cx).transcript.read(cx).rows()[0].id());
    let text = text_state(cx, v, id);
    cx.update_window(h, |_, w, cx| {
        let b = text.read(cx).bounds();
        let start = b.origin + point(px(30.), px(case.code_y));
        w.drag(start, start + point(px(190.), px(0.)), cx);
    })
    .unwrap();
    settle(cx, h);
    let copied = copy(cx, h);
    let range = cx.update(|cx| text.read(cx).selected_source_range().unwrap());
    assert!(copied.starts_with(' '));
    assert_eq!(copied, case.selected(range.clone()));
    let input = cx.update(|cx| v.read(cx).editor.read(cx).shell_probe().0);
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| {
            i.focus(w, cx);
            i.replace_text_in_range(None, "Keep nested 👩🏽‍💻 draft", w, cx);
            i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
        })
    })
    .unwrap();
    let draft = cx.update(|cx| input.read(cx).value());
    model.apply(&json!({"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":&case.source[cut..]}]}));
    publish(cx, h, v, &mut model, false);
    model.apply(&json!({"type":"message_end","entry":entry(50,&case.source)}));
    publish(cx, h, v, &mut model, false);
    assert_eq!(
        text_state(cx, v, id),
        text,
        "{} canonical alias retains parser",
        case.name
    );
    assert_eq!(
        cx.update(|cx| text.read(cx).selected_source_range()),
        Some(range.clone())
    );
    let mut entries = vec![entry(50, &case.source)];
    for n in 60..84 {
        entries.push(entry(n, &"Recycling context 日本語\n\n".repeat(8)));
    }
    model.apply(&json!({"type":"snapshot","entries":entries}));
    publish(cx, h, v, &mut model, false);
    let transcript = cx.update(|cx| v.read(cx).transcript.clone());
    let last = cx.update(|cx| transcript.read(cx).rows().last().unwrap().reader_key());
    cx.update(|cx| {
        transcript.update(cx, |t, cx| {
            t.restore_reading(
                crate::navigation::ReadingMark {
                    message: last,
                    offset: 0.,
                    following: false,
                },
                cx,
            )
        })
    });
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(
            w.try_find(("copy-source", id)).is_none(),
            "{} actually recycled",
            case.name
        );
        assert_eq!(text.read(cx).selected_source_range(), Some(range.clone()));
        input.update(cx, |i, cx| {
            assert_eq!(i.value(), draft);
            assert!(i.marked_text_range(w, cx).is_some());
            assert!(i.focus_handle(cx).is_focused(w));
        });
    })
    .unwrap();
    let first = cx.update(|cx| transcript.read(cx).rows()[0].reader_key());
    cx.update(|cx| {
        transcript.update(cx, |t, cx| {
            t.restore_reading(
                crate::navigation::ReadingMark {
                    message: first,
                    offset: 0.,
                    following: false,
                },
                cx,
            )
        })
    });
    settle(cx, h);
    assert_eq!(text_state(cx, v, id), text);
    cx.update_window(h, |_, w, cx| {
        assert!(
            w.try_find(("copy-source", id)).is_some(),
            "{} remounted",
            case.name
        );
        input.update(cx, |i, cx| {
            assert_eq!(i.value(), draft);
            assert!(i.marked_text_range(w, cx).is_some());
            i.unmark_text(w, cx);
        });
        text.read(cx).focus_handle().clone().focus(w, cx);
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(
        copy(cx, h),
        copied,
        "{} stream/commit/recycle literal copy",
        case.name
    );
    assert_eq!(
        cx.update(|cx| text.read(cx).selected_source_range()),
        Some(range)
    );
}

//! One bounded hidden native selection case per process. No transport or OS clipboard.
use super::*;
use gpui_kit::base::TextSelection;
use gpui_kit::{
    InputEvent, MouseButton,
    component::{Theme, ThemeMode},
    test::TestEventExt,
};
use std::{io::Write, path::PathBuf, time::Instant};
use unicode_segmentation::UnicodeSegmentation;

fn cpu() -> f64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage initializes this aligned out pointer on success.
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
        0
    );
    // SAFETY: successful getrusage initialized usage.
    let usage = unsafe { usage.assume_init() };
    let seconds = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
    seconds(usage.ru_utime) + seconds(usage.ru_stime)
}

fn record(dir: &std::path::Path, value: serde_json::Value) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("stages.ndjson"))
        .unwrap();
    writeln!(file, "{value}").unwrap();
    file.sync_all().unwrap();
}

fn stage<T>(dir: &std::path::Path, name: &str, f: impl FnOnce() -> T) -> T {
    record(dir, json!({"stage":name,"event":"start"}));
    let before = cpu();
    let start = Instant::now();
    let result = f();
    let wall = start.elapsed().as_secs_f64() * 1000.;
    let after = cpu();
    record(
        dir,
        json!({"stage":name,"event":"end","wall_ms":wall,"process_cpu_ms":(after-before)*1000.}),
    );
    result
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let dir = PathBuf::from(std::env::var_os("PILOT_NEXT_TOOL_SELECTION_DIR").unwrap());
    std::fs::create_dir_all(&dir).unwrap();
    let lines: usize = std::env::var("PILOT_NEXT_TOOL_SELECTION_LINES")
        .unwrap_or("64".into())
        .parse()
        .unwrap();
    let width: f32 = std::env::var("PILOT_NEXT_TOOL_SELECTION_WIDTH")
        .unwrap_or("680".into())
        .parse()
        .unwrap();
    let dark = std::env::var_os("PILOT_NEXT_TOOL_SELECTION_DARK").is_some();
    let live = std::env::var_os("PILOT_NEXT_TOOL_SELECTION_LIVE").is_some();
    cx.update(|cx| {
        Theme::change(
            if dark {
                ThemeMode::Dark
            } else {
                ThemeMode::Light
            },
            None,
            cx,
        )
    });
    let source = "// Synthetic 日本語 👩‍💻 e\u{301} <>&\n".repeat(lines);
    record(
        &dir,
        json!({"lines":lines,"bytes":source.len(),"width":width,"dark":dark,"live":live,"pid":std::process::id(),"hidden":true}),
    );
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"selection","name":"codemode","arguments":{"code":source}}]}]}]}));
    let rows = model.rows();
    let group = rows[0].id();
    let (handle, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(width), px(940.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |window, cx| {
                cx.new(|cx| {
                    let v = LocalViewer::synthetic(window, cx);
                    v.transcript
                        .update(cx, |v, cx| v.replace_readonly(rows, true, cx));
                    v
                })
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    cx.update_window(handle, |_, w, cx| {
        w.click(SharedString::from(format!("work-toggle-{group}")), cx)
    })
    .unwrap();
    cx.run_until_parked();
    stage(&dir, "expand", || {
        cx.update_window(handle, |_, w, cx| w.click("step-toggle-call:selection", cx))
            .unwrap();
        cx.run_until_parked();
    });
    if live {
        model.apply(&json!({"type":"run_start"}));
        model.apply(&json!({"type":"message_start","message":{"role":"assistant","content":[{"type":"toolCall","id":"selection","name":"codemode","arguments":{"code":""}}]}}));
        model.apply(&json!({"type":"message_update","changes":[{"type":"toolcall_delta","contentIndex":0,"path":["code"],"delta":source}]}));
        model.apply(
            &json!({"type":"tool_execution_start","toolCallId":"selection","toolName":"codemode"}),
        );
        cx.update_window(handle, |_, _, cx| {
            view.update(cx, |v, cx| {
                v.transcript
                    .update(cx, |v, cx| v.replace_readonly(model.rows(), false, cx))
            })
        })
        .unwrap();
        cx.run_until_parked();
    }
    let text = cx.update(|cx| {
        view.read(cx)
            .transcript
            .read(cx)
            .disclosure_probe_body("selection", "Code", cx)
            .0
    });
    let mut previous_range = None;
    let deltas: &[f32] = if std::env::var_os("PILOT_NEXT_TOOL_SELECTION_TOP_ONLY").is_some() {
        &[0.]
    } else {
        &[0., -240., -1e9]
    };
    for &delta in deltas {
        stage(&dir, "scroll", || {
            cx.update_window(handle, |_, w, cx| {
                let position = w.find("body-call:selection-Code").bounds().center();
                w.dispatch_event(
                    gpui_kit::ScrollEvent {
                        position,
                        delta: ScrollDelta::Pixels(point(px(0.), px(delta))),
                        touch_phase: gpui_kit::TouchPhase::Started,
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
            })
            .unwrap();
            cx.run_until_parked();
        });
        let bounds = cx
            .update_window(handle, |_, w, _| {
                w.find("body-call:selection-Code").bounds()
            })
            .unwrap();
        let start = bounds.origin + point(px(8.), px(12.));
        let end = start + point(px(190.), px(0.));
        assert!(bounds.contains(&start) && bounds.contains(&end));
        stage(&dir, "pointer_down", || {
            cx.update_window(handle, |_, w, cx| {
                w.pointer_down(start, MouseButton::Left, cx)
            })
            .unwrap()
        });
        let mut sampler = std::env::var_os("PILOT_NEXT_TOOL_SELECTION_PROFILE").map(|_| {
            std::process::Command::new("/usr/bin/sample")
                .args([
                    std::process::id().to_string(),
                    "1".into(),
                    "1".into(),
                    "-file".into(),
                    dir.join("sample.txt").display().to_string(),
                ])
                .spawn()
                .unwrap()
        });
        stage(&dir, "pointer_move", || {
            cx.update_window(handle, |_, w, cx| {
                w.pointer_move(end, Some(MouseButton::Left), cx)
            })
            .unwrap()
        });
        stage(&dir, "pointer_up", || {
            cx.update_window(handle, |_, w, cx| w.pointer_up(end, MouseButton::Left, cx))
                .unwrap()
        });
        stage(&dir, "settle", || cx.run_until_parked());
        let selected = stage(&dir, "extract", || {
            cx.update_window(handle, |_, w, cx| TextSelection::selected_text(w, cx))
                .unwrap()
        });
        let range = cx.update(|cx| {
            text.read(cx)
                .selected_source_range()
                .expect("literal source selection")
        });
        assert!(!selected.is_empty());
        // Plain's existing paragraph serializer supplies a terminal newline;
        // the exact source-byte range itself excludes that separator.
        let source_selection = &source[range.clone()];
        assert!(selected == source_selection || selected == format!("{source_selection}\n"));
        assert_eq!(selected, cx.update(|cx| text.read(cx).selected_text()));
        if let Some(previous) = previous_range {
            assert!(
                range.start > previous,
                "selection follows the current inner scroll"
            );
        }
        previous_range = Some(range.start);
        if delta == -1e9 && lines >= 64 {
            assert!(
                range.start > source.len() / 2,
                "end-of-source pointer selection"
            );
        }
        for endpoint in [range.start, range.end] {
            assert!(
                endpoint == source.len()
                    || source.grapheme_indices(true).any(|(ix, _)| ix == endpoint)
            );
        }
        stage(&dir, "keyboard_copy", || {
            cx.update_window(handle, |_, w, cx| {
                w.press("secondary-c", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    source_selection
                );
            })
            .unwrap()
        });
        if let Some(sampler) = &mut sampler {
            assert!(sampler.wait().unwrap().success());
        }
        stage(&dir, "reverse_drag_copy", || {
            cx.update_window(handle, |_, w, cx| {
                w.drag(end, start, cx);
                assert_eq!(text.read(cx).selected_source_range(), Some(range.clone()));
                w.press("secondary-c", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    source_selection
                );
            })
            .unwrap();
        });
        if live {
            model.apply(&json!({"type":"tool_execution_update","toolCallId":"selection","output":{"set":format!("synthetic output at {delta}")}}));
            cx.update_window(handle, |_, _, cx| {
                view.update(cx, |v, cx| {
                    v.transcript
                        .update(cx, |v, cx| v.replace_readonly(model.rows(), false, cx))
                })
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle, |_, w, cx| {
                assert_eq!(
                    view.read(cx)
                        .transcript
                        .read(cx)
                        .disclosure_probe_body("selection", "Code", cx)
                        .0,
                    text
                );
                assert_eq!(text.read(cx).selected_source_range(), Some(range.clone()));
                w.press("secondary-c", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    source_selection
                );
            })
            .unwrap();
        }
        record(
            &dir,
            json!({"scroll_delta":delta,"selected_range":[range.start,range.end],"selected_bytes":selected.len(),"exact_selection_copy":true}),
        );
    }
    stage(&dir, "select_all_copy", || {
        cx.update_window(handle, |_, w, cx| {
            w.press("secondary-a", cx);
            w.press("secondary-c", cx);
            // Existing keyboard select-all copies rendered paragraph text, not
            // the original source's terminal newline. Full-source Copy below
            // remains exact, including that newline; do not change formatting.
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                source.strip_suffix('\n').unwrap()
            );
        })
        .unwrap()
    });
    cx.update_window(handle, |_, w, cx| {
        w.click("copy-call:selection-Code", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), source);
        assert_eq!(text.read(cx).rendered_text().source(), source);
    })
    .unwrap();
    record(
        &dir,
        json!({"passed":true,"full_source_bytes":source.len(),"os_clipboard":false}),
    );
}

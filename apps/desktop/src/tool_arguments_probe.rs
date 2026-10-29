//! Hidden production-root checks of full received arguments, without transport.
use super::*;
use gpui_kit::component::{Theme, ThemeMode};

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let dir = std::path::PathBuf::from(std::env::var_os("PILOT_NEXT_TOOL_ARGUMENTS_DIR").unwrap());
    std::fs::create_dir_all(&dir).unwrap();
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            for (name, field, label) in [
                ("codemode", "code", "Code"),
                ("unknown", "text", "Arguments"),
            ] {
                let source = "// Synthetic 日本語 👩‍💻 e\u{301} <>&\n".repeat(8000);
                let args = json!({field:source});
                let entry = json!({"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"full","name":name,"arguments":args}]}]});
                let mut model = LiveTranscript::default();
                model.apply(&json!({"type":"snapshot","entries":[entry]}));
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
                cx.update_window(handle, |_, window, cx| {
                    window.click(SharedString::from(format!("work-toggle-{group}")), cx);
                })
                .unwrap();
                cx.run_until_parked();
                cx.update_window(handle, |_, window, cx| {
                    window.click("step-toggle-call:full", cx)
                })
                .unwrap();
                cx.run_until_parked();
                for phase in ["history", "live"] {
                    if phase == "live" {
                        model.apply(&json!({"type":"run_start"}));
                        model.apply(&json!({"type":"message_start","message":{"role":"assistant","content":[{"type":"toolCall","id":"full","name":name,"arguments":{field:""}}]}}));
                        model.apply(&json!({"type":"message_update","changes":[{"type":"toolcall_delta","contentIndex":0,"path":[field],"delta":source}]}));
                        model.apply(&json!({"type":"tool_execution_update","toolCallId":"full","output":{"set":"ok"}}));
                        cx.update_window(handle, |_, _, cx| {
                            view.update(cx, |v, cx| {
                                v.transcript
                                    .update(cx, |v, cx| v.replace_readonly(model.rows(), false, cx))
                            })
                        })
                        .unwrap();
                        cx.run_until_parked();
                    }
                    cx.update_window(handle, |_, window, cx| {
                        window.draw(cx).clear(cx);
                        assert!(view.read(cx).transcript.read(cx).disclosure_probe_step("full", cx).0);
                        let body = window.find(SharedString::from(format!("body-call:full-{label}"))).bounds();
                        assert!(body.size.height > px(0.) && body.size.height <= px(260.));
                        assert!(body.right() <= window.find("viewport").bounds().right());
                        window.click(SharedString::from(format!("copy-call:full-{label}")), cx);
                        let expected = if label == "Code" { source.clone() } else { serde_json::to_string_pretty(&args).unwrap() };
                        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), expected);
                        window.scroll(SharedString::from(format!("body-call:full-{label}")), ScrollDelta::Pixels(point(px(0.), px(-240.))), cx);
                        println!("{}", json!({"fixture":"full-tool-arguments", "phase":phase,"width":width,"appearance":mode.name(),"tool":name,"bytes":expected.len(),"exact_copy":true,"synthetic_only":true}));
                    }).unwrap();
                    cx.run_until_parked();
                    cx.capture_screenshot(handle)
                        .unwrap()
                        .save(dir.join(format!(
                            "args-{}-{}-{name}-{phase}.png",
                            width as u32,
                            mode.name()
                        )))
                        .unwrap();
                }
                cx.update_window(handle, |_, window, _| window.remove_window())
                    .unwrap();
                cx.run_until_parked();
            }
        }
    }
}

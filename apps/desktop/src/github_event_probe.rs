//! Actual offscreen production reader. Rows come from the real Local projection
//! of synthetic, Swift-equivalent GitHub audits; no network or daemon.
use super::*;
use crate::local_model::LiveTranscript;
use crate::model::Message;
use gpui_kit::AppContext;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, point, size,
    test::{TestEventExt, TestWindowExt},
};
use serde_json::json;
use std::time::Duration;

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
/// The kernel records a title and number only for `gh pr` commands.
fn action(id: &str, kind: &str, after: u64, exit: serde_json::Value) -> serde_json::Value {
    let mut v = json!({"id":id,"kind":kind,"branch":"babariviere/inline-github-events-日本",
        "summary":"jj git push","description":"pushed","toolCallId":"call","afterEntryId":after,
        "missionId":"mission-A","at":1_793_000_000_000u64,"exitCode":exit});
    if kind.starts_with("pr_") {
        v["prNumber"] = json!(42);
        v["title"] = json!("Show confirmed pushes and PRs inline 👋");
        v["url"] = json!(URL);
    }
    v
}
const URL: &str = "https://github.com/acme/app/pull/42";
fn rows() -> Vec<Message> {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[
        {"id":1,"kind":"pi.user","model":[{"role":"user","timestamp":1_793_000_000_000u64,"content":"Ship it"}]},
        {"id":2,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":1_793_000_000_000u64,"content":[{"type":"text","text":"Pushing and opening the PR."}]}]},
        {"id":3,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":1_793_000_000_000u64,"content":[{"type":"text","text":"Done."}]}]}]}));
    let mut pr = action("pr", "pr_opened", 2, json!(0));
    pr.as_object_mut().unwrap().remove("branch");
    model.apply(&json!({"type":"github_actions_update","actions":[
        action("push", "push", 2, json!(0)), pr, action("failed", "push", 3, json!(1)),
        action("unknown", "push", 3, serde_json::Value::Null)]}));
    model.rows()
}
fn id_of(rows: &[Message], sentence: &str) -> u64 {
    rows.iter()
        .find(|r| r.github_event().is_some_and(|e| e.sentence() == sentence))
        .unwrap_or_else(|| panic!("{sentence} row"))
        .id()
}
fn painted(image: &image::RgbaImage, b: Bounds<gpui_kit::Pixels>, width: f32) -> bool {
    let scale = image.width() as f32 / width;
    let background = image.get_pixel(2, 2).0;
    ((f32::from(b.top()) * scale) as u32..(f32::from(b.bottom()) * scale) as u32).any(|y| {
        ((f32::from(b.left()) * scale) as u32..(f32::from(b.right()) * scale) as u32)
            .any(|x| image.get_pixel(x, y).0 != background)
    })
}

pub fn run_github_event_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_GITHUB_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    let rows = rows();
    let push = id_of(&rows, "Agent pushed");
    let pr = id_of(&rows, "Agent opened PR #42");
    let failed = id_of(&rows, "Agent could not push");
    let unknown = id_of(&rows, "Agent may have pushed");
    let mut backgrounds = Vec::new();
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
            let (h, t) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(600.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| cx.new(|cx| TranscriptView::readonly(w, cx)),
                    )
                })
                .unwrap();
            cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(rows.clone(), true, cx)));
            settle(cx, h);
            let image = cx.capture_screenshot(h).unwrap();
            backgrounds.push(image.get_pixel(2, 2).0);
            if let Some(p) = &captures {
                image
                    .save(p.join(format!("github-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                // Inline lines, in place between the agent's messages.
                let message = |id: u64| w.find(("github-event", id)).bounds();
                assert!(message(push).top() < message(pr).top());
                assert!(message(pr).top() < message(failed).top());
                for id in [push, pr, failed, unknown] {
                    let line = w.find(("github-event", id)).bounds();
                    assert!(line.size.height < px(32.), "one quiet line");
                    assert!(line.right() <= px(width), "fits {width}");
                    assert!(
                        painted(&image, line, width),
                        "paints its glyph and sentence"
                    );
                    assert!(w.find(("github-sentence", id)).visible());
                    // The time is a hover detail; nothing else depends on it.
                    assert!(!w.find(("github-time", id)).visible());
                }
                let branch = w.find(("github-branch", push)).bounds();
                assert!(branch.left() > w.find(("github-sentence", push)).bounds().left());
                assert!(
                    w.find_all(("github-branch", pr)).is_empty(),
                    "no invented branch"
                );
                assert!(w.find(("github-title", pr)).visible());
                assert!(
                    w.find_all(("github-title", push)).is_empty(),
                    "no invented title"
                );
                // Only the confirmed PR offers its exact link; activation copies it.
                assert!(w.find_all(("github-link", push)).is_empty());
                let link = w.find(("github-link", pr));
                assert_eq!(link.label(), Some("Copy PR link"));
                assert!(!link.visible(), "revealed on hover or keyboard focus");
                w.pointer_move(link.bounds().center(), None, cx);
                w.click(("github-link", pr), cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), URL);
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(String::new()));
                // Only a failure offers details; success and unknown don't.
                assert!(w.find_all(("github-show", push)).is_empty());
                assert!(w.find_all(("github-show", unknown)).is_empty());
                assert!(w.find_all(("github-detail", failed)).is_empty());
                w.hover(("github-event", push), cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.find(("github-time", push)).visible(),
                    "hover shows the time"
                );
                assert!(!w.find(("github-time", pr)).visible());
                let show = w.find(("github-show", failed)).bounds();
                w.pointer_move(show.center(), None, cx);
                w.click(("github-show", failed), cx);
            })
            .unwrap();
            settle(cx, h);
            let detail = |cx: &mut HeadlessAppContext| {
                cx.update_window(h, |_, w, _| {
                    !w.find_all(("github-detail", failed)).is_empty()
                })
                .unwrap()
            };
            assert!(detail(cx), "Show reveals the exit status");
            cx.update_window(h, |_, w, _| {
                let line = w.find(("github-event", failed)).bounds();
                assert!(w.find(("github-detail", failed)).bounds().top() >= line.bottom());
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("github-open-{width}-{dark}.png")))
                    .unwrap();
            }
            // Keyboard: Tab reaches Show; Enter and Space toggle it in place.
            cx.update_window(h, |_, w, cx| {
                w.pointer_move(point(px(1.), px(1.)), None, cx);
                if w.focused(cx).is_none() {
                    w.focus_next(cx);
                }
            })
            .unwrap();
            // Keyboard: Tab reaches the PR link first; Enter copies the exact URL.
            let mut on_link = false;
            for _ in 0..40 {
                on_link = cx
                    .update_window(h, |_, w, cx| {
                        w.press("tab", cx);
                        w.find(("github-link", pr)).focused() == Some(true)
                    })
                    .unwrap();
                settle(cx, h);
                if on_link {
                    break;
                }
            }
            assert!(on_link, "Tab must reach the PR link");
            cx.update_window(h, |_, w, cx| {
                assert!(w.find(("github-link", pr)).visible(), "focus reveals it");
                w.press("enter", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), URL);
            })
            .unwrap();
            let mut reached = false;
            for _ in 0..40 {
                reached = cx
                    .update_window(h, |_, w, cx| {
                        w.press("tab", cx);
                        w.find(("github-show", failed)).focused() == Some(true)
                    })
                    .unwrap();
                settle(cx, h);
                if reached {
                    break;
                }
            }
            assert!(reached, "Tab must reach Show");
            for (key, shown) in [("enter", false), ("space", true), ("enter", false)] {
                cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
                settle(cx, h);
                assert_eq!(detail(cx), shown, "{key}");
                cx.update_window(h, |_, w, _| {
                    assert_eq!(w.find(("github-show", failed)).focused(), Some(true))
                })
                .unwrap();
            }
            // A reload with the same audit keeps rows and state; no duplicates.
            cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(rows.clone(), false, cx)));
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find_all(("github-event", push)).len(), 1);
            })
            .unwrap();
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    assert_ne!(
        backgrounds[0], backgrounds[1],
        "light and dark both rendered"
    );
}

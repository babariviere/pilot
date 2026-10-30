//! Shared subscription limits receive summaries while a conversation stays selected.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, size,
    test::TestWindowExt,
};
use serde_json::json;

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
            .unwrap();
    }
}

pub(crate) fn run(cx: &mut HeadlessAppContext) {
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
            let (h, view) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(1000.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            cx.new(|cx| {
                                let v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                                let limits = cx.new(|_| {
                                    crate::provider_refresh_view::Limits::new(
                                        LocalOptions::synthetic(1),
                                    )
                                });
                                v.overview.update(cx, |o, _| o.limits = Some(limits));
                                v
                            })
                        },
                    )
                })
                .unwrap();
            let limits = cx.update(|cx| view.read(cx).overview.read(cx).limits.clone().unwrap());
            // Usage mounts the same retained owner, without starting history/network reads.
            let (usage_h, _) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(1000.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |_, cx| {
                            cx.new(|cx| {
                                let mut usage = crate::usage_overview_view::Usage::new(None, cx);
                                usage.limits = Some(limits.clone());
                                usage
                            })
                        },
                    )
                })
                .unwrap();
            let at = crate::usage_overview::now();
            for (offset, percent) in [(0, 15), (1, 42)] {
                cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| {
                    assert_eq!(v.page, Page::Chat);
                    let mut next = v.state.clone();
                    next.summary_fresh = true;
                    next.chats = Arc::new(vec![crate::local_model::chat(&json!({
                        "id":"synthetic", "title":"Cached subscription", "state":"idle",
                        "usage":{"subscription":{"provider":"anthropic","fetchedAt":at + offset,
                        "windows":[{"label":"5h","usedPercent":percent,"resetsAt":"2099-01-01T00:00:00Z"},
                        {"label":"Week","usedPercent":99}]}}
                    })).unwrap()]);
                    v.accept(next, w, cx);
                })).unwrap();
                settle(cx, h);
                settle(cx, usage_h);
                let snapshots = cx.update(|cx| limits.read(cx).state.snapshots.clone());
                assert_eq!(
                    snapshots.len(),
                    1,
                    "cold and subsequent reports reach Usage without Home or Refresh"
                );
                assert_eq!(snapshots[0].fetched_at, Some(at + offset));
                cx.update_window(usage_h, |_, w, _| {
                    let label = w
                        .find("home-subscription-Claude")
                        .label()
                        .unwrap()
                        .to_owned();
                    assert!(label.contains(&format!("{percent}% used")), "{label}");
                    let bounds = w.find("home-subscriptions").bounds();
                    assert!(bounds.left() >= px(0.) && bounds.right() <= px(width));
                })
                .unwrap();
            }
            cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| v.show_home(w, cx)))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.find("home-subscription-Claude")
                        .label()
                        .unwrap()
                        .contains("42% used")
                )
            })
            .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_PROVIDER_USAGE_CAPTURE_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(usage_h)
                    .unwrap()
                    .save(dir.join(format!("automatic-limits-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(usage_h, |_, w, _| w.remove_window())
                .unwrap();
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
}

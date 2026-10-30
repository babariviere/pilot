//! Real Home, hidden native rendering, synthetic forwarded snapshots only.
use crate::{
    app_shell::{Overview, OverviewInput},
    local_model,
};
use gpui_kit::{
    AppContext, Bounds, HeadlessAppContext, Pixels, WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    px, size,
    test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const HEIGHT: f32 = 1400.;

fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
    }
}
fn input(chats: Vec<local_model::Chat>, project: Option<&str>) -> OverviewInput {
    OverviewInput {
        projects: Arc::new(vec![local_model::Project {
            id: "p".into(),
            name: "Project".into(),
            path: "/synthetic/project".into(),
            ..Default::default()
        }]),
        chats: Arc::new(chats),
        project: project.map(Into::into),
        projects_loaded: true,
        chats_loaded: true,
        error: None,
    }
}
fn chat(v: Value) -> local_model::Chat {
    local_model::chat(&v).unwrap()
}
fn label(w: &gpui_kit::Window, id: &str) -> String {
    w.find(id.to_owned()).label().unwrap_or_default().to_owned()
}
fn popover_quads(w: &gpui_kit::Window, cx: &gpui_kit::App) -> usize {
    let color: gpui_kit::Background = cx.theme().tokens.popover.into();
    w.painted_quads()
        .iter()
        .filter(|q| q.background == color)
        .count()
}
fn sync(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    v: &gpui_kit::Entity<Overview>,
    chats: Vec<local_model::Chat>,
    project: Option<&str>,
) {
    cx.update(|cx| v.update(cx, |v, cx| v.sync(input(chats, project), cx)));
    settle(cx, h);
}
pub fn run_provider_usage_probe(cx: &mut HeadlessAppContext) {
    crate::local_view::provider_usage_delivery_probe::run(cx);
    crate::provider_refresh_probe::run(cx);
    // Long Unicode, provider-specific labels and an extra-spend amount must wrap inside the row.
    let long = "Opus 週間リミット: très longue étiquette spécifique au fournisseur 🚀";
    for width in [420., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let (h, v) = cx.update(|cx| {
                Theme::change(mode, None, cx);
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(HEIGHT)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |_, cx| cx.new(|_| Overview::new()),
                )
                .unwrap()
            });
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find("home-subscriptions").is_none(),
                    "nothing before a snapshot"
                );
            })
            .unwrap();
            let now = crate::usage_overview::now();
            let claude = chat(
                json!({"id":"a","projectId":"p","usage":{"subscription":{"provider":"anthropic","fetchedAt":now,"windows":[
                    {"label":"5h","usedPercent":42,"resetsAt":"2099-01-01T12:00:00Z"},
                    {"label":"Week","usedPercent":96,"resetsAt":"2000-01-01T12:00:00Z"},
                    {"label":long,"usedPercent":81,"resetsAt":"2099-01-02T12:00:00Z"},
                    {"label":"Extra [active] 1234567890.12/9876543210.98","usedPercent":13}
                ]}}}),
            );
            let codex = chat(
                json!({"id":"b","usage":{"subscription":{"provider":"openai","fetchedAt":now-700_000,"windows":[
                    {"label":"5h","usedPercent":0},
                    {"label":"GPT-5-Codex-Mini review","usedPercent":24}
                ]}}}),
            );
            // An older Claude snapshot in another chat must not win over the newest one.
            let older = chat(
                json!({"id":"c","usage":{"subscription":{"provider":"anthropic","fetchedAt":now-300_000,"windows":[{"label":"5h","usedPercent":99}]}}}),
            );
            let chats = vec![claude, codex.clone(), older];
            // A project overview never shows account-wide subscriptions.
            sync(cx, h, &v, chats.clone(), Some("p"));
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find("home-subscriptions").is_none(),
                    "project overview"
                );
            })
            .unwrap();
            // The usual case: two common windows per provider, one compact line each.
            let common = vec![
                chat(
                    json!({"id":"a","usage":{"subscription":{"provider":"anthropic","fetchedAt":now,"windows":[
                        {"label":"5h","usedPercent":34,"resetsAt":"2099-01-01T12:00:00Z"},
                        {"label":"Week","usedPercent":68,"resetsAt":"2099-01-05T12:00:00Z"}
                    ]}}}),
                ),
                chat(
                    json!({"id":"b","usage":{"subscription":{"provider":"openai","fetchedAt":now,"windows":[
                        {"label":"5h","usedPercent":92,"resetsAt":"2099-01-01T15:00:00Z"},
                        {"label":"Week","usedPercent":41,"resetsAt":"2099-01-06T12:00:00Z"}
                    ]}}}),
                ),
            ];
            sync(cx, h, &v, common, None);
            // Hover a usage value for longer than the tooltip delay.
            cx.update_window(h, |_, w, cx| {
                w.hover("home-subscription-Claude-window-0-label", cx)
            })
            .unwrap();
            settle(cx, h);
            let before = cx
                .update_window(h, |_, w, cx| popover_quads(w, cx))
                .unwrap();
            cx.advance_clock(Duration::from_secs(1));
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    popover_quads(w, cx),
                    before,
                    "usage hover must not paint a tooltip"
                )
            })
            .unwrap();
            cx.update_window(h, |_, w, _| {
                for provider in ["Claude", "Codex"] {
                    let row = w.find(format!("home-subscription-{provider}")).bounds();
                    assert!(row.right() <= px(width), "{provider} {row:?} at {width}");
                    assert!(
                        w.try_find(format!("home-subscription-{provider}-status"))
                            .is_none()
                    );
                    if width > 1000. {
                        assert!(row.size.height <= px(28.), "{provider} one line {row:?}");
                    }
                }
                for ix in 0..2 {
                    assert_eq!(
                        w.find(format!("home-subscription-Claude-window-{ix}-meter"))
                            .bounds()
                            .left(),
                        w.find(format!("home-subscription-Codex-window-{ix}-meter"))
                            .bounds()
                            .left(),
                        "column {ix} aligned at {width}"
                    );
                }
            })
            .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_PROVIDER_USAGE_CAPTURE") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("home-subscriptions-common-{width}-{mode:?}.png")))
                    .unwrap();
            }
            sync(cx, h, &v, chats, None);
            cx.update_window(h, |_, w, _| {
                let page = Bounds::new(Default::default(), size(px(width), px(HEIGHT)));
                let inside = |id: &str, outer: Bounds<Pixels>| {
                    let b = w.find(id.to_owned()).bounds();
                    assert!(
                        b.size.width > px(0.)
                            && b.left() >= outer.left()
                            && b.right() <= outer.right(),
                        "{id} {b:?} outside {outer:?} at {width}"
                    );
                };
                inside("home-subscriptions", page);
                for (provider, n) in [("Claude", 4), ("Codex", 2)] {
                    let row = format!("home-subscription-{provider}");
                    inside(&row, page);
                    inside(&format!("{row}-details-toggle"), page);
                    assert!(
                        w.try_find(format!("{row}-details")).is_none(),
                        "details start closed"
                    );
                    for ix in 0..n {
                        let cell = format!("{row}-window-{ix}");
                        inside(&cell, page);
                        let outer = w.find(cell.clone()).bounds();
                        inside(&format!("{cell}-label"), outer);
                        if w.try_find(format!("{cell}-value")).is_some() {
                            inside(&format!("{cell}-value"), outer);
                        }
                    }
                }
                // Compact parity: the summary sits above Projects, no section heading.
                assert!(
                    w.find("home-subscriptions").bounds().bottom()
                        <= w.find("home-projects-heading").bounds().top()
                );
                // Fresh shows nothing extra; stale is said beside the bars.
                assert!(w.try_find("home-subscription-Claude-status").is_none());
                let stale = label(w, "home-subscription-Codex-status");
                assert_eq!(stale, "not recent");
                // Values are percents only; extra usage keeps its full amount.
                assert_eq!(
                    label(w, "home-subscription-Claude-window-0"),
                    "5-hour 42% used"
                );
                assert_eq!(
                    label(w, "home-subscription-Claude-window-3"),
                    "Extra 1234567890.12/9876543210.98 spent"
                );
                let meter = w.find("home-subscription-Claude-window-0-meter").bounds();
                let fill = w.find("home-subscription-Claude-window-0-fill").bounds();
                assert_eq!(meter.size.width, px(48.));
                assert!(
                    (f32::from(fill.size.width) / f32::from(meter.size.width) - 0.42).abs() < 0.01
                );
                assert_eq!(
                    w.find("home-subscription-Codex-window-0-fill")
                        .bounds()
                        .size
                        .width,
                    px(0.)
                );
                // A passed reset shows the old share as history, never as a current meter or zero.
                for part in ["meter", "fill", "value"] {
                    assert!(
                        w.try_find(format!("home-subscription-Claude-window-1-{part}"))
                            .is_none()
                    );
                }
                assert_eq!(
                    label(w, "home-subscription-Claude-window-1"),
                    "Weekly was 96% · awaiting report"
                );
                inside(
                    "home-subscription-Claude-window-1-last",
                    w.find("home-subscription-Claude-window-1").bounds(),
                );
                if width > 1000. {
                    // One line per provider where it fits, with the same column under each other.
                    let row = w.find("home-subscription-Codex").bounds();
                    assert!(row.size.height <= px(28.), "compact Codex row {row:?}");
                    assert_eq!(
                        w.find("home-subscription-Codex-window-0").bounds().top(),
                        w.find("home-subscription-Codex-window-1").bounds().top()
                    );
                    assert_eq!(
                        w.find("home-subscription-Claude-window-0-meter")
                            .bounds()
                            .left(),
                        w.find("home-subscription-Codex-window-0-meter")
                            .bounds()
                            .left()
                    );
                }
            })
            .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_PROVIDER_USAGE_CAPTURE") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("home-subscriptions-{width}-{mode:?}.png")))
                    .unwrap();
            }
            // Keyboard: the first tab stop is Claude's details disclosure; Space toggles it.
            cx.update_window(h, |_, w, cx| w.focus_next(cx)).unwrap();
            cx.update_window(h, |_, w, cx| w.press("space", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(label(w, "home-subscription-Claude-details-toggle").starts_with("Hide"));
                let details = label(w, "home-subscription-Claude-details");
                for part in [
                    "Reported ",
                    "5h: 42% used · Resets",
                    "Week: last report 96% used · reset on",
                    "awaiting report",
                    "loaded Local chat summaries",
                ] {
                    assert!(details.contains(part), "{part} in {details}");
                }
                let row = w.find("home-subscription-Claude").bounds();
                let open = w.find("home-subscription-Claude-details").bounds();
                assert!(open.top() >= row.bottom() && open.right() <= px(width));
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.press("space", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("home-subscription-Claude-details").is_none());
                assert!(label(w, "home-subscription-Claude-details-toggle").starts_with("Show"));
                w.click("home-subscription-Codex-details-toggle", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(label(w, "home-subscription-Codex-details").contains("not recent"));
            })
            .unwrap();
            // A Claude-only forwarded update rerenders Home, keeps Codex and its open details.
            let updated = chat(
                json!({"id":"a","usage":{"subscription":{"provider":"anthropic","fetchedAt":now,"windows":[{"label":"5h","usedPercent":0}]}}}),
            );
            sync(cx, h, &v, vec![updated, codex.clone()], None);
            cx.update_window(h, |_, w, _| {
                assert_eq!(
                    w.find("home-subscription-Claude-window-0-fill")
                        .bounds()
                        .size
                        .width,
                    px(0.)
                );
                assert!(w.try_find("home-subscription-Claude-window-1").is_none());
                assert!(w.try_find("home-subscription-Codex-window-1").is_some());
                assert!(w.try_find("home-subscription-Codex-details").is_some());
            })
            .unwrap();
            let failed = chat(
                json!({"id":"a","usage":{"subscription":{"provider":"anthropic","error":"private provider response","windows":[]}}}),
            );
            sync(cx, h, &v, vec![failed, codex.clone()], None);
            cx.update_window(h, |_, w, _| {
                // The last usable report stays beside a visible error, with its own report time.
                assert_eq!(label(w, "home-subscription-Claude-status"), "update failed");
                assert!(
                    w.try_find("home-subscription-Claude-window-0-meter")
                        .is_some()
                );
                let row = label(w, "home-subscription-Claude");
                assert!(!row.contains("private"), "{row}");
            })
            .unwrap();
            // An authoritative empty report without an error replaces the old windows.
            let empty = chat(
                json!({"id":"a","usage":{"subscription":{"provider":"anthropic","fetchedAt":now,"windows":[]}}}),
            );
            sync(cx, h, &v, vec![empty, codex.clone()], None);
            cx.update_window(h, |_, w, _| {
                assert_eq!(
                    label(w, "home-subscription-Claude-status"),
                    "no usage reported"
                );
                assert!(w.try_find("home-subscription-Claude-window-0").is_none());
            })
            .unwrap();
            // Once Claude is gone, a later failure has nothing to retain.
            let failed = chat(
                json!({"id":"a","usage":{"subscription":{"provider":"anthropic","error":"private provider response","windows":[]}}}),
            );
            sync(cx, h, &v, vec![codex.clone()], None);
            sync(cx, h, &v, vec![failed, codex], None);
            cx.update_window(h, |_, w, _| {
                assert_eq!(
                    label(w, "home-subscription-Claude-status"),
                    "update failed · time unknown"
                );
                assert!(w.try_find("home-subscription-Claude-window-0").is_none());
            })
            .unwrap();
            sync(cx, h, &v, vec![], None);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("home-subscriptions").is_none());
                w.remove_window();
            })
            .unwrap();
            println!(
                "{}",
                json!({"width":width,"theme":mode.name(),"hidden_native_home":true,"compact_rows_columns_details_keyboard_stale_reset_passed_long_extra_error_updates":true,"no_provider_actions":true})
            );
        }
    }
}

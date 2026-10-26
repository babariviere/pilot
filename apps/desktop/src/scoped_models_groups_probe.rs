//! Real Settings section, synthetic catalog injection only. No save/check/network.
use super::*;
use gpui_kit::{
    AnyWindowHandle, HeadlessAppContext, ScrollDelta,
    component::{ActiveTheme, ThemeMode},
    point, px,
    test::TestWindowExt,
};
use std::time::Duration;

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    for _ in 0..16 {
        let clicked = cx
            .update_window(h, |_, w, cx| {
                let target = w.find(id).bounds();
                let viewport = w.find("settings-scroll").bounds();
                if viewport.contains(&target.center()) {
                    w.click(id, cx);
                    true
                } else {
                    w.scroll(
                        "settings-scroll",
                        ScrollDelta::Pixels(point(
                            px(0.),
                            px(if target.center().y > viewport.bottom() {
                                -140.
                            } else {
                                140.
                            }),
                        )),
                        cx,
                    );
                    false
                }
            })
            .unwrap();
        settle(cx, h);
        if clicked {
            return;
        }
    }
    panic!("grouped model target not reachable: {id}");
}
pub(crate) fn run(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    scope: &Entity<ScopedModels>,
    width: f32,
    mode: ThemeMode,
) {
    let original = cx.update(|cx| scope.read(cx).observed.clone().unwrap());
    let literals = "z/*:high\ncustom/unavailable\ncustom/unavailable\nopaque/one:low";
    cx.update_window(h, |_, w, cx| {
        scope.update(cx, |v, cx| {
            let mut snapshot = original.clone();
            snapshot.enabled_models = Some(literals.split('\n').map(str::to_owned).collect());
            snapshot.all_models = false;
            snapshot.scope_hash = crate::scoped_models::hash(&snapshot.enabled_models);
            snapshot.resolution.clear();
            snapshot.candidates = [
                ("opaque/last", "openai-codex", "Shared 日本語"),
                ("opaque/one", "anthropic", "Shared 日本語"),
                ("opaque/two", "anthropic", "Other model"),
            ]
            .into_iter()
            .map(|(id, provider, name)| Candidate {
                id: id.into(),
                provider: provider.into(),
                name: name.into(),
                search_key: format!("{provider} {id} {name}").to_lowercase(),
            })
            .collect();
            v.apply(snapshot.clone(), w, cx);
            v.observed = Some(snapshot);
            cx.notify();
        })
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(
            w.find("scope-provider-title-anthropic").bounds().top()
                < w.find("scope-provider-title-openai-codex").bounds().top()
        );
        assert_eq!(
            w.find("scope-model-opaque/one").checked(),
            Some(false),
            "thinking suffix is not an exact selection"
        );
    })
    .unwrap();
    click(cx, h, "scope-model-opaque/last");
    cx.update(|cx| {
        assert_eq!(
            scope.read(cx).selection(cx).unwrap().last().unwrap(),
            "opaque/last"
        )
    });
    // Focus the actual retained search input, type through native events, then Tab/Space.
    cx.update_window(h, |_, w, cx| {
        scope
            .read(cx)
            .search
            .clone()
            .update(cx, |s, cx| s.focus(w, cx));
        w.input("SHARED 日本語", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(w.try_find("scope-model-opaque/two").is_none());
        assert!(w.try_find("scope-provider-title-anthropic").is_some());
        assert!(w.try_find("scope-provider-title-openai-codex").is_some());
        w.press("tab", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert_eq!(w.find("scope-model-opaque/one").focused(), Some(true));
        w.press("space", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert_eq!(w.find("scope-model-opaque/one").checked(), Some(true))
    })
    .unwrap();
    cx.update(|cx| {
        let mut expected = literals.split('\n').map(str::to_owned).collect::<Vec<_>>();
        expected.extend(["opaque/last".into(), "opaque/one".into()]);
        assert_eq!(scope.read(cx).selection(cx), Some(expected));
    });
    click(cx, h, "scope-model-opaque/last");
    cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
    if let Some(dir) = std::env::var_os("PILOT_NEXT_SCOPE_DIR") {
        cx.capture_screenshot(h)
            .unwrap()
            .save(std::path::PathBuf::from(dir).join(format!(
                "{}-{}-scope-provider-search.png",
                width as u32,
                mode.name()
            )))
            .unwrap();
    }
    // Provider-only search and empty results do not alter any literal selection.
    let selected = cx.update(|cx| scope.read(cx).selection(cx));
    cx.update_window(h, |_, w, cx| {
        scope
            .read(cx)
            .search
            .clone()
            .update(cx, |s, cx| s.focus(w, cx));
        w.press("secondary-a", cx);
        w.input("openai-codex", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(w.try_find("scope-provider-title-anthropic").is_none());
        assert!(w.try_find("scope-provider-title-openai-codex").is_some());
        w.press("secondary-a", cx);
        w.input("no-match", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(w.try_find("scope-provider-title-openai-codex").is_none());
        let search = scope.read(cx).search.clone();
        search.update(cx, |s, cx| {
            s.set_value("", w, cx);
            s.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
        });
        scope.update(cx, |v, cx| v.choose("opaque/one", false, w, cx));
        assert_eq!(scope.read(cx).selection(cx), selected);
        search.update(cx, |s, cx| {
            s.unmark_text(w, cx);
            s.set_value("", w, cx);
        });
    })
    .unwrap();
    settle(cx, h);
    click(cx, h, "scope-model-opaque/one");
    if let Some(dir) = std::env::var_os("PILOT_NEXT_SCOPE_DIR") {
        cx.capture_screenshot(h)
            .unwrap()
            .save(std::path::PathBuf::from(dir).join(format!(
                "{}-{}-scope-providers.png",
                width as u32,
                mode.name()
            )))
            .unwrap();
    }
    cx.update_window(h, |_, w, cx| {
        scope.update(cx, |v, cx| {
            assert!(v.worker.is_some()); // Retained original GET worker, not a new operation.
            assert!(v.pending.is_none());
            v.apply(original.clone(), w, cx);
            v.observed = Some(original);
            cx.notify();
        })
    })
    .unwrap();
    settle(cx, h);
    click(cx, h, "scope-all"); // Revert the scroll position, then restore All for the existing flow.
    click(cx, h, "scope-all");
    cx.update_window(h, |_, _, cx| {
        scope.update(cx, |v, cx| {
            v.edited = false;
            cx.notify();
        })
    })
    .unwrap();
    settle(cx, h);
    println!(
        "{}",
        serde_json::json!({"width":width,"mode":mode.name(),"provider_sections":true,"search_preserves_groups":true,"native_tab_space_selection":true,"literal_order_suffix_duplicates_preserved":true,"search_preedit_guard":true,"live_scope_writes":0})
    );
}

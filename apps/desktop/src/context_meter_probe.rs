//! Mounted production Context control checks, no live clients or actions.
use super::*;

pub(super) fn states(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    captures: Option<&std::path::Path>,
    width: f32,
    dark: bool,
) {
    let mut bounds = None;
    for (name, value, expected) in [
        (
            "reported",
            json!({"context":{"tokens":42600,"contextWindow":200000}}),
            Some("21.3%"),
        ),
        ("unknown", json!({}), None),
        (
            "invalid",
            json!({"context":{"tokens":-4,"contextWindow":200000}}),
            None,
        ),
        ("partial", json!({"context":{"tokens":400}}), None),
        (
            "zero",
            json!({"context":{"tokens":0,"contextWindow":200000}}),
            Some("0.0%"),
        ),
        (
            "overlimit",
            json!({"context":{"tokens":240000,"contextWindow":200000}}),
            Some("120.0%"),
        ),
    ] {
        cx.update_window(h, |_, _, cx| {
            view.update(cx, |v, cx| {
                Arc::make_mut(&mut v.state.chats)[0].context_usage =
                    crate::context_usage::Usage::read(&value);
                cx.notify();
            })
        })
        .unwrap();
        settle(cx, h);
        if let Some(p) = captures {
            cx.capture_screenshot(h)
                .unwrap()
                .save(p.join(format!(
                    "meter-header-{name}-{width}-{}.png",
                    if dark { "dark" } else { "light" }
                )))
                .unwrap();
        }
        cx.update_window(h, |_, w, cx| {
            let control = w.find("context-usage");
            assert!(control.visible());
            assert!(control.bounds().right() <= w.viewport_size().width);
            if let Some(b) = bounds {
                assert_eq!(b, control.bounds(), "usage changes must not reflow header");
            }
            bounds = Some(control.bounds());
            assert!(control.label().unwrap().contains("Freshness unknown"));
            assert_eq!(
                w.try_find("context-meter-ring").is_some(),
                expected.is_some()
            );
            if let Some(percent) = expected {
                assert!(control.label().unwrap().contains(percent));
                let ring = w.find("context-meter-ring").bounds();
                assert_eq!(ring.size, size(px(14.), px(14.)));
                assert!(
                    ring.left() >= control.bounds().left()
                        && ring.right() <= control.bounds().right()
                );
            } else {
                assert!(control.label().unwrap().contains("unknown"));
            }
            w.click("context-usage", cx);
        })
        .unwrap();
        settle(cx, h);
        cx.update_window(h, |_, w, _| assert!(w.find("context-usage-info").visible()))
            .unwrap();
        if let Some(p) = captures {
            cx.capture_screenshot(h)
                .unwrap()
                .save(p.join(format!(
                    "meter-{name}-{width}-{}.png",
                    if dark { "dark" } else { "light" }
                )))
                .unwrap();
        }
        cx.update_window(h, |_, w, cx| w.press("escape", cx))
            .unwrap();
        settle(cx, h);
    }
    // Traverse native tab stops, activate via Enter, then restore that focus.
    let mut reached = false;
    for _ in 0..80 {
        reached = cx
            .update_window(h, |_, w, cx| {
                w.focus_next(cx);
                w.render_frame(cx);
                w.find("context-usage").focused() == Some(true)
            })
            .unwrap();
        if reached {
            break;
        }
    }
    assert!(reached, "Context remains keyboard reachable");
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(w.find("context-usage-info").visible());
        w.press("escape", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert_eq!(w.find("context-usage").focused(), Some(true))
    })
    .unwrap();
    // Same ID after a generation change cannot revive an already-open panel.
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, _, cx| {
        view.update(cx, |v, cx| {
            v.generation += 1;
            cx.notify();
        })
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(w.find("context-usage-changed").visible());
        assert!(w.try_find(("context-usage-line", 0usize)).is_none());
        w.press("escape", cx);
        view.update(cx, |v, cx| {
            v.generation -= 1;
            Arc::make_mut(&mut v.state.chats)[0].context_usage = crate::context_usage::Usage::read(
                &json!({"context":{"tokens":42600,"contextWindow":200000}}),
            );
            cx.notify();
        });
    })
    .unwrap();
    settle(cx, h);
}

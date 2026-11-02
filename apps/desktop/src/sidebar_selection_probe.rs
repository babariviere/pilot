//! Rendered sidebar selection versus hover, with synthetic navigation only.
use super::{open, press, rows, select, settle};
use gpui_kit::{
    AnyWindowHandle, HeadlessAppContext, Pixels,
    component::{ActiveTheme, Theme, ThemeMode},
    px, size,
    test::TestWindowExt,
};

fn background(cx: &mut HeadlessAppContext, h: AnyWindowHandle, key: &str) -> [u8; 4] {
    let (point, width) = cx
        .update_window(h, |_, w, _| {
            let row = w.find(format!("chat-row-{key}")).bounds();
            (
                gpui_kit::point(row.right() - px(58.), row.bottom() - px(3.)),
                w.viewport_size().width,
            )
        })
        .unwrap();
    let shot = cx.capture_screenshot(h).expect("native renderer");
    let scale = shot.width() as f32 / f32::from(width);
    let physical = |p: Pixels| (f32::from(p) * scale) as u32;
    shot.get_pixel(physical(point.x), physical(point.y)).0
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    for mode in [ThemeMode::Light, ThemeMode::Dark] {
        let mut chats = rows();
        for id in ["nix", "m-q"] {
            chats.iter_mut().find(|c| c.id == id).unwrap().attention =
                crate::local_model::chat(&serde_json::json!({"id":id,"state":"idle","attentionReason":{"kind":"asks","detail":"Synthetic question"}})).unwrap().attention;
        }
        let (h, view) = open(cx, 1100., chats, &[]);
        cx.update(|cx| Theme::change(mode, None, cx));
        assert_eq!(
            cx.update(|cx| cx.theme().is_dark()),
            mode == ThemeMode::Dark
        );
        cx.update_window(h, |_, w, cx| {
            w.resize(size(px(1100.), px(1300.)));
            w.bounds_changed(cx);
        })
        .unwrap();
        let (client, reads) = crate::local_client::LocalClient::synthetic_commands();
        cx.update(|cx| view.update(cx, |v, _| v.client = Some(client)));
        settle(cx, h);
        let group = "group:project:pilot";
        let idle = background(cx, h, group);
        // A real group click folds, selects and hovers it; another expands it.
        for _ in 0..2 {
            cx.update_window(h, |_, w, cx| w.click(format!("chat-row-{group}"), cx))
                .unwrap();
            settle(cx, h);
        }
        let active = background(cx, h, group);
        assert_ne!(active, idle, "{mode:?}: selected group paints");
        for id in ["ghostty", "fix"] {
            cx.update_window(h, |_, w, cx| w.click(format!("chat-row-{id}"), cx))
                .unwrap();
            settle(cx, h);
            assert!(
                matches!(reads.try_recv(), Ok(crate::local_client::Command::Open { id: opened, .. }) if opened == id)
            );
            cx.update(|cx| {
                let v = view.read(cx);
                assert_eq!(v.selected.as_deref(), Some(id), "exact chat opens");
                assert_eq!(v.project_scope, None, "group is not a project filter");
            });
            assert_eq!(
                background(cx, h, group),
                idle,
                "{mode:?}: old group clears after {id}"
            );
            assert_eq!(background(cx, h, id), active, "{mode:?}: new chat selected");
        }
        // Opening from the Inbox must not leave the old folder looking selected.
        for id in ["nix", "m-q"] {
            select(&view, group, h, cx);
            cx.update_window(h, |_, w, cx| w.click("nav-inbox", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click(format!("attention-{id}"), cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(
                cx.update(|cx| view.read(cx).selected.clone()).as_deref(),
                Some(id)
            );
            assert!(
                matches!(reads.try_recv(), Ok(crate::local_client::Command::Open { id: opened, .. }) if opened == id)
            );
            assert_eq!(
                background(cx, h, group),
                idle,
                "{mode:?}: Inbox navigation clears old group"
            );
            assert_eq!(
                background(cx, h, id),
                active,
                "{mode:?}: Inbox destination paints"
            );
        }
        // A pointer left on the old label still legitimately hovers it. Its
        // fill must disappear on leaving, not survive as stale selection.
        select(&view, group, h, cx);
        cx.update_window(h, |_, w, cx| w.hover(format!("chat-row-{group}"), cx))
            .unwrap();
        let hover = background(cx, h, group);
        let focus = cx
            .update_window(h, |_, w, cx| {
                let focus = w.focused(cx);
                view.update(cx, |v, cx| {
                    let chat = v
                        .state
                        .chats
                        .iter()
                        .find(|c| c.id == "ghostty")
                        .unwrap()
                        .clone();
                    assert!(v.open(chat, w, cx));
                });
                assert_eq!(w.focused(cx), focus, "navigation keeps real focus");
                focus
            })
            .unwrap();
        settle(cx, h);
        assert!(
            matches!(reads.try_recv(), Ok(crate::local_client::Command::Open { id, .. }) if id == "ghostty")
        );
        assert_eq!(
            background(cx, h, group),
            hover,
            "stationary pointer keeps hover"
        );
        cx.update_window(h, |_, w, cx| w.hover("nav-home", cx))
            .unwrap();
        settle(cx, h);
        assert_eq!(
            background(cx, h, group),
            idle,
            "pointer leave clears old label"
        );
        assert_eq!(
            background(cx, h, "ghostty"),
            active,
            "destination paints without pointer"
        );
        cx.update_window(h, |_, w, cx| assert_eq!(w.focused(cx), focus))
            .unwrap();
        // Keyboard selection is distinct from the opened chat and stays real.
        select(&view, group, h, cx);
        cx.update_window(h, |_, w, cx| w.hover(format!("chat-row-{group}"), cx))
            .unwrap();
        press("right", h, cx);
        cx.update_window(h, |_, w, cx| w.hover("nav-home", cx))
            .unwrap();
        settle(cx, h);
        assert_eq!(
            background(cx, h, group),
            idle,
            "{mode:?}: keyboard leaves group"
        );
        // Background catalogue refresh/reordering retains a legitimate label
        // cursor; only a successful explicit chat open replaces it.
        select(&view, group, h, cx);
        cx.update_window(h, |_, w, cx| {
            w.hover("nav-home", cx);
            view.update(cx, |v, cx| {
                v.state.chats = std::sync::Arc::new((*v.state.chats).clone());
                v.rebuild_nav(w, cx);
            });
        })
        .unwrap();
        settle(cx, h);
        assert_eq!(
            background(cx, h, group),
            active,
            "refresh retains keyboard selection"
        );
        cx.update(|cx| {
            view.read(cx).editor.clone().update(cx, |_, cx| {
                cx.emit(crate::chat_editor::EditorEvent::Sent {
                    chat: "etl".into(),
                    sending: None,
                });
            });
        });
        settle(cx, h);
        assert_eq!(super::selected(&view, cx).as_deref(), Some(group));
        assert_eq!(
            background(cx, h, group),
            active,
            "reorder retains keyboard selection"
        );
        cx.update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| {
                let chat = v
                    .state
                    .chats
                    .iter()
                    .find(|c| c.id == "fix")
                    .unwrap()
                    .clone();
                assert!(v.open(chat, w, cx));
            });
        })
        .unwrap();
        settle(cx, h);
        assert_eq!(
            background(cx, h, group),
            idle,
            "old label clears after reorder and navigation"
        );
        assert_eq!(
            background(cx, h, "fix"),
            active,
            "destination paints after reorder"
        );
        assert!(
            matches!(reads.try_recv(), Ok(crate::local_client::Command::Open { id, .. }) if id == "fix")
        );
        assert!(reads.is_empty(), "exact navigation only");
        println!(
            "{}",
            serde_json::json!({"sidebar_selection_paint":true,"mode":mode.name()})
        );
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.run_until_parked();
    }
}

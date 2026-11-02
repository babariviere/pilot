//! Row moves in the native production sidebar after your sends and data
//! changes: timed intermediate/final painted positions against the List's
//! final layout, reversal from shown positions, entry/exit, mission and
//! collapsed-project moves, folds and presentation rebuilds that snap, reduced
//! motion, resize, selection/keyboard, wheel scrolling and blocked slot clicks.
//! Hidden windows, synthetic chats only. CPU draw timings are offscreen
//! observations, not visible smoothness or performance acceptance.
use super::{LocalViewer, chat, open, rows};
use crate::{chat_editor::EditorEvent, local_model::Chat};
use gpui_kit::{
    AnyWindowHandle, Entity, HeadlessAppContext, ScrollDelta,
    component::{Theme, ThemeMode},
    point, px, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

struct Shown {
    key: String,
    layout: f32,
    shown: Option<f32>,
    offset: f32,
    opacity: f32,
    raised: bool,
}

fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle, ms: u64) -> Duration {
    cx.advance_clock(Duration::from_millis(ms));
    let started = Instant::now();
    cx.update_window(h, |_, w, cx| {
        w.simulate_next_frame(cx);
        w.render_frame(cx);
    })
    .unwrap();
    let spent = started.elapsed();
    cx.run_until_parked();
    spent
}
fn snapshot(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
) -> Vec<Shown> {
    let rows = cx.update(|cx| {
        let d = view.read(cx).chats.read(cx).delegate();
        d.row_layout()
            .into_iter()
            .map(|(key, layout)| {
                let (offset, opacity, raised) = d.row_motion(&key);
                (key, layout, offset, opacity, raised)
            })
            .collect::<Vec<_>>()
    });
    cx.update_window(h, |_, w, _| {
        rows.into_iter()
            .map(|(key, layout, offset, opacity, raised)| Shown {
                shown: w
                    .try_find(key.clone())
                    .map(|e| f32::from(e.bounds().origin.y)),
                key,
                layout,
                offset,
                opacity,
                raised,
            })
            .collect()
    })
    .unwrap()
}
/// Every painted row sits at its final slot plus the model's current offset,
/// from one list origin. Returns that origin.
fn origin(rows: &[Shown], what: &str) -> f32 {
    let mounted: Vec<_> = rows.iter().filter(|r| r.shown.is_some()).collect();
    assert!(mounted.len() > 3, "{what}: real List rows are mounted");
    let origin = mounted[0].shown.unwrap() - mounted[0].layout - mounted[0].offset;
    for row in &mounted {
        let expected = origin + row.layout + row.offset;
        assert!(
            (row.shown.unwrap() - expected).abs() < 0.5,
            "{what}: {} painted at {:?}, expected {expected}",
            row.key,
            row.shown
        );
    }
    origin
}
fn shown(rows: &[Shown], key: &str) -> Option<f32> {
    rows.iter().find(|r| r.key == key).and_then(|r| r.shown)
}
fn at_rest(rows: &[Shown], what: &str) {
    assert!(
        rows.iter().all(|r| r.offset == 0. && r.opacity == 1.),
        "{what}: every row rests in its slot"
    );
    origin(rows, what);
}
/// Rows painted in both frames haven't jumped.
fn continuous(before: &[Shown], after: &[Shown], what: &str) {
    let mut compared = 0;
    for row in after {
        if let (Some(now), Some(then)) = (row.shown, shown(before, &row.key)) {
            assert!(
                (now - then).abs() < 0.5,
                "{what}: {} jumped from {then} to {now}",
                row.key
            );
            compared += 1;
        }
    }
    assert!(compared > 3, "{what}: rows compared");
}
fn send(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>, chat: &str) {
    cx.update(|cx| {
        let editor = view.read(cx).editor.clone();
        editor.update(cx, |_, cx| {
            cx.emit(EditorEvent::Sent {
                chat: chat.to_owned(),
                sending: None,
            })
        });
    });
    cx.run_until_parked();
}
fn replace(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    change: impl FnOnce(&mut Vec<Chat>),
) {
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let mut chats = (*v.state.chats).clone();
            change(&mut chats);
            v.state.chats = Arc::new(chats);
            v.rebuild_nav(w, cx);
            cx.notify();
        })
    })
    .unwrap();
    cx.run_until_parked();
}
fn selected(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>) -> Option<String> {
    cx.update(|cx| {
        let d = view.read(cx).chats.read(cx).delegate();
        d.selected.and_then(|ix| d.key_at(ix))
    })
}
fn order(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>) -> Vec<String> {
    cx.update(|cx| {
        view.read(cx)
            .chats
            .read(cx)
            .delegate()
            .row_layout()
            .into_iter()
            .map(|(key, _)| key)
            .collect()
    })
}
fn scroll_y(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>) -> f32 {
    cx.update(|cx| f32::from(view.read(cx).chats.read(cx).scroll_handle().offset().y))
}
/// A painted moving row whose middle is inside the list's viewport.
fn moving_row(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
) -> Option<String> {
    let viewport = cx.update(|cx| view.read(cx).chats.read(cx).scroll_handle().bounds());
    let (top, bottom) = (f32::from(viewport.top()), f32::from(viewport.bottom()));
    snapshot(cx, h, view)
        .into_iter()
        .find(|r| r.offset.abs() > 8. && r.shown.is_some_and(|y| y > top && y + 20. < bottom))
        .map(|r| r.key)
}
/// A move from one send: frame 0 shows the old positions, 64ms is between,
/// 240ms is the final layout.
fn check_move(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    to: &str,
    mover: &str,
    what: &str,
) -> (f32, f32, f32) {
    let before = snapshot(cx, h, view);
    let from = shown(&before, mover);
    send(cx, view, to);
    frame(cx, h, 0);
    let start = snapshot(cx, h, view);
    continuous(&before, &start, what);
    origin(&start, what);
    let moving = start.iter().find(|r| r.key == mover).unwrap_or_else(|| {
        let keys: Vec<_> = start.iter().map(|r| r.key.as_str()).collect();
        panic!("{what}: {mover} is a row: {keys:?}")
    });
    assert!(moving.offset != 0., "{what}: {mover} moves");
    frame(cx, h, 64);
    let mid = snapshot(cx, h, view);
    let o = origin(&mid, what);
    let (Some(from), Some(now)) = (from, shown(&mid, mover)) else {
        panic!("{what}: {mover} painted before and during its move");
    };
    let to_y = o + mid.iter().find(|r| r.key == mover).unwrap().layout;
    assert!(
        (now - from) * (to_y - from) > 0. && (now - from).abs() < (to_y - from).abs(),
        "{what}: {mover} between {from} and {to_y}: {now}"
    );
    frame(cx, h, 240);
    at_rest(&snapshot(cx, h, view), what);
    (from, now, to_y)
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (h, view) = open(cx, width, rows(), &[]);
            // Tall enough that every row paints before and after each move.
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width), px(1300.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, h, 240);
            let first = snapshot(cx, h, &view);
            at_rest(&first, "first list");
            // A send moves the whole stoik section above pilot; it is the
            // shorter run, so it passes over the rows that slide.
            super::select(&view, "fix", h, cx);
            let scroll = scroll_y(cx, &view);
            let before = order(cx, &view);
            let (from, mid, to) = check_move(cx, h, &view, "etl", "group:project:stoik", "send");
            let after = order(cx, &view);
            assert_ne!(before, after, "the send changed the order");
            assert!(
                after.iter().position(|k| k == "group:project:stoik")
                    < after.iter().position(|k| k == "group:project:pilot"),
                "stoik leads after your send"
            );
            assert_eq!(
                selected(cx, &view).as_deref(),
                Some("fix"),
                "selection keeps its row"
            );
            assert_eq!(scroll_y(cx, &view), scroll, "a move never scrolls");
            if let Some(dir) = std::env::var_os("PILOT_NEXT_STYLE_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                send(cx, &view, "nix");
                frame(cx, h, 0);
                frame(cx, h, 80);
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{width}-{}-reorder-partial.png", mode.name())))
                    .unwrap();
                frame(cx, h, 240);
            }

            // The raised run and the sliding rows.
            send(cx, &view, "sweep");
            send(cx, &view, "fix");
            frame(cx, h, 0);
            let rows_now = snapshot(cx, h, &view);
            let raised: Vec<_> = rows_now
                .iter()
                .filter(|r| r.raised)
                .map(|r| r.key.as_str())
                .collect();
            let sliding = rows_now
                .iter()
                .filter(|r| r.offset != 0. && !r.raised)
                .count();
            assert!(
                !raised.is_empty() && sliding > raised.len(),
                "fewest rows pass over: {raised:?}"
            );

            // Reversal mid-move starts from the shown positions.
            frame(cx, h, 64);
            let midway = snapshot(cx, h, &view);
            send(cx, &view, "etl");
            frame(cx, h, 0);
            let reversed = snapshot(cx, h, &view);
            continuous(&midway, &reversed, "reversal");
            origin(&reversed, "reversal");
            frame(cx, h, 64);
            origin(&snapshot(cx, h, &view), "reversal midway");
            frame(cx, h, 240);
            at_rest(&snapshot(cx, h, &view), "reversal end");

            // Keyboard and clicks mid-move: selection follows the final order;
            // a click on a moving row reaches neither its slot nor another row.
            send(cx, &view, "bg");
            frame(cx, h, 0);
            frame(cx, h, 48);
            let order_now = order(cx, &view);
            let fix = order_now.iter().position(|k| k == "fix").unwrap();
            cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
            frame(cx, h, 0);
            assert_eq!(
                selected(cx, &view),
                order_now.get(fix + 1).cloned(),
                "Down follows the final order"
            );
            let page = cx.update(|cx| view.read(cx).selected.clone());
            let keyed = selected(cx, &view);
            let key = moving_row(cx, h, &view).expect("a painted moving row");
            cx.update_window(h, |_, w, cx| w.click(format!("chat-row-{key}"), cx))
                .unwrap();
            frame(cx, h, 0);
            assert_eq!(
                cx.update(|cx| view.read(cx).selected.clone()),
                page,
                "a moving row's click opens nothing"
            );
            assert_eq!(selected(cx, &view), keyed, "nor selects its slot's row");
            frame(cx, h, 240);
            at_rest(&snapshot(cx, h, &view), "keyboard");

            // A mission thread moves as one; its members slide with it.
            // A parent row's key is its coordinator chat.
            check_move(cx, h, &view, "m-x", "coord", "mission up");
            check_move(cx, h, &view, "fix", "coord", "mission down");

            // Entry fades in place while rows below slide; an exit leaves at
            // once, with no row or target, and its neighbours close the gap.
            let before = snapshot(cx, h, &view);
            replace(cx, h, &view, |chats| {
                chats.push(chat(
                    json!({"id":"fresh","title":"Fresh chat","projectId":"pilot","state":"idle","createdAt":2000.,"lastUserMessageAt":2000.}),
                    None,
                ))
            });
            frame(cx, h, 0);
            let entered = snapshot(cx, h, &view);
            continuous(&before, &entered, "entry");
            origin(&entered, "entry");
            let fresh = entered.iter().find(|r| r.key == "fresh").expect("new row");
            assert!(
                fresh.opacity == 0. && fresh.shown.is_some(),
                "a new row starts clear in its slot"
            );
            frame(cx, h, 64);
            let fading = snapshot(cx, h, &view);
            let opacity = fading.iter().find(|r| r.key == "fresh").unwrap().opacity;
            assert!(opacity > 0. && opacity < 1., "entry fades: {opacity}");
            frame(cx, h, 240);
            at_rest(&snapshot(cx, h, &view), "entry end");
            let before = snapshot(cx, h, &view);
            replace(cx, h, &view, |chats| {
                chats.iter_mut().find(|c| c.id == "fix").unwrap().archived = true;
            });
            frame(cx, h, 0);
            let exited = snapshot(cx, h, &view);
            continuous(&before, &exited, "exit");
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find("chat-row-fix").is_none() && w.try_find("fix").is_none(),
                    "an exit leaves no row or target"
                )
            })
            .unwrap();
            assert!(cx.update(|cx| {
                view.read(cx)
                    .chats
                    .read(cx)
                    .delegate()
                    .index("fix")
                    .is_none()
            }));
            frame(cx, h, 240);
            at_rest(&snapshot(cx, h, &view), "exit end");

            // A collapsed project moves as its label; a fold mid-move snaps.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    v.toggle_sidebar_group("project:dotfiles", w, cx)
                })
            })
            .unwrap();
            frame(cx, h, 0);
            frame(cx, h, 240);
            check_move(
                cx,
                h,
                &view,
                "ghostty",
                "group:project:dotfiles",
                "collapsed project",
            );
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find("ghostty").is_none(),
                    "collapsed rows stay hidden"
                )
            })
            .unwrap();
            send(cx, &view, "sweep");
            frame(cx, h, 0);
            frame(cx, h, 32);
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    v.toggle_sidebar_group("project:dotfiles", w, cx)
                })
            })
            .unwrap();
            frame(cx, h, 0);
            assert!(
                snapshot(cx, h, &view)
                    .iter()
                    .all(|r| r.offset == 0. && r.opacity == 1.),
                "an explicit fold snaps moves"
            );
            frame(cx, h, 240);

            // Presentation rebuilds (search) snap; reduced motion is immediate.
            send(cx, &view, "nix");
            frame(cx, h, 0);
            cx.update_window(h, |_, w, cx| {
                view.read(cx).chats.clone().update(cx, |l, cx| {
                    gpui_kit::component::list::ListDelegate::perform_search(
                        l.delegate_mut(),
                        "",
                        w,
                        cx,
                    )
                    .detach();
                    cx.notify();
                })
            })
            .unwrap();
            frame(cx, h, 0);
            at_rest(&snapshot(cx, h, &view), "presentation rebuild");
            cx.update(|cx| cx.set_reduce_motion(true));
            send(cx, &view, "etl");
            frame(cx, h, 0);
            at_rest(&snapshot(cx, h, &view), "reduced motion");
            cx.update(|cx| cx.set_reduce_motion(false));

            // Resize snaps in the current frame.
            send(cx, &view, "sweep");
            frame(cx, h, 0);
            frame(cx, h, 32);
            cx.update_window(h, |_, w, cx| {
                w.resize(size(px(width - 40.), px(560.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, h, 0);
            at_rest(&snapshot(cx, h, &view), "resize");

            // In a short window the wheel still scrolls over a moving row.
            send(cx, &view, "fresh");
            frame(cx, h, 0);
            frame(cx, h, 32);
            let top = scroll_y(cx, &view);
            let moving = moving_row(cx, h, &view).expect("a painted moving row");
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    moving.clone(),
                    ScrollDelta::Pixels(point(px(0.), px(-60.))),
                    cx,
                )
            })
            .unwrap();
            frame(cx, h, 0);
            assert!(
                scroll_y(cx, &view) < top,
                "the wheel scrolls over a moving row"
            );
            origin(&snapshot(cx, h, &view), "scrolled mid-move");
            frame(cx, h, 240);
            at_rest(&snapshot(cx, h, &view), "scrolled end");

            // Offscreen CPU draw cost: moving frames against resting ones.
            let mut idle = Vec::new();
            for _ in 0..12 {
                idle.push(frame(cx, h, 16));
            }
            let mut moving = Vec::new();
            for target in ["etl", "fresh", "nix", "bg"] {
                send(cx, &view, target);
                for _ in 0..12 {
                    moving.push(frame(cx, h, 16));
                }
            }
            let median = |mut v: Vec<Duration>| {
                v.sort();
                v[v.len() / 2].as_secs_f64() * 1000.
            };
            println!(
                "{}",
                json!({"sidebar_reorder":true,"width":width,"mode":mode.name(),
                "send":{"from":from,"midway":mid,"to":to},"reversal":true,"entry_exit":true,
                "mission":true,"collapsed_project":true,"fold_snaps":true,"search_snaps":true,
                "reduced_motion":true,"resize":true,"wheel":true,"keyboard":true,"click_blocked":true,
                "draw_ms_median":{"idle":median(idle),"moving":median(moving)},
                "timing":"offscreen CPU render_frame, not visible smoothness"})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}

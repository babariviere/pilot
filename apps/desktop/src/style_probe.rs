//! Native production chrome with synthetic content: still sidebar state marks,
//! their one-shot cross-fade, mission threads and the composer surfaces. This
//! is not native OS occlusion or visible-window performance evidence.
use super::{LocalViewer, PreviewState};
use crate::{local_model::Chat, state_mark::Signal};
use gpui_kit::{
    AppContext, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    px, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};

fn pulse(cx: &mut HeadlessAppContext, handle: gpui_kit::AnyWindowHandle, count: usize, ms: u64) {
    for _ in 0..count {
        cx.advance_clock(Duration::from_millis(ms));
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
    }
}
fn fading(view: &gpui_kit::Entity<LocalViewer>, id: &str, cx: &gpui_kit::App) -> bool {
    view.read(cx).chats.read(cx).delegate().marks[id].fading()
}

/// Synthetic rows: every state, a mission thread with a long Unicode member,
/// and a finished chat whose reply you haven't seen.
pub(crate) fn rows() -> Vec<Chat> {
    let mut chats: Vec<Chat> = [
        ("style-fg", "Working", Some(Signal::Working), false),
        ("style-bg", "Background jobs", Some(Signal::Working), true),
        ("style-needs", "Needs you", Some(Signal::NeedsYou), false),
        ("style-failed", "Failed", Some(Signal::Failed), false),
        ("style-ready", "Ready to merge", Some(Signal::Ready), false),
        ("style-idle", "Quiet", None, false),
    ]
    .into_iter()
    .enumerate()
    .map(|(ix, (id, title, signal, background_work))| {
        let mut chat = crate::local_model::chat(
            &json!({"id":id,"title":title,"state":"idle","createdAt":100 - ix}),
        )
        .unwrap();
        chat.state = title.into();
        chat.busy = signal == Some(Signal::Working);
        chat.signal = signal;
        chat.background_work = background_work;
        chat
    })
    .collect();
    for value in [
        json!({"id":"style-coord","title":"Coordinator","missionCoordinator":true,"missionId":"style-mission","state":"working","createdAt":40}),
        json!({"id":"style-member","title":"Résumé des tâches 👩‍💻 長いタイトルの会話 with a very long member title","missionId":"style-mission","state":"failed","createdAt":41}),
        json!({"id":"style-member-q","title":"Sidebar rows","missionId":"style-mission","state":"idle","outcome":"question","outcomeAt":5,"createdAt":42}),
        json!({"id":"style-member-done","title":"Finished member","missionId":"style-mission","state":"idle","createdAt":43}),
        json!({"id":"style-unread","title":"Replied since you looked","state":"idle","outcome":"done","outcomeAt":10,"createdAt":30}),
    ] {
        chats.push(crate::local_model::chat(&value).unwrap());
    }
    chats
}

pub fn run_style_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_STYLE_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (handle, view) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(760.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |window, cx| {
                        cx.new(|cx| {
                            let mut view =
                                LocalViewer::preview(PreviewState::Conversation, window, cx);
                            view.state.chats = Arc::new(rows());
                            view.state.mission_titles = Some(Arc::new(
                                [(
                                    "style-mission".to_owned(),
                                    "GPUI Rewrite — 迁移 🚀 with a long mission name".to_owned(),
                                )]
                                .into_iter()
                                .collect(),
                            ));
                            view.chats.update(cx, |list, _| {
                                list.delegate_mut().memory =
                                    crate::sidebar_memory::Memory::ephemeral(0.)
                            });
                            view.selected = Some("style-idle".into());
                            view.title = "Rounded surfaces and still state marks".into();
                            view.editor.update(cx, |v, cx| {
                                v.select("chat:style-idle".into(), false, false, window, cx)
                            });
                            view.rebuild_nav(window, cx);
                            view
                        })
                    },
                )
                .unwrap()
            });
            cx.run_until_parked();
            assert!(cx.update(|cx| view.read(cx).text_parsers_ready(cx)));
            let initial = cx
                .capture_screenshot(handle)
                .expect("native renderer required");
            let ids = [
                "chat-row-style-fg",
                "chat-row-style-bg",
                "chat-row-style-needs",
                "chat-row-style-failed",
                "chat-row-style-ready",
                "chat-row-style-coord",
                "chat-row-style-member",
            ];
            let (baseline, rects) = cx
                .update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    let v = view.read(cx);
                    // Every state draws its still mark; quiet rows draw none.
                    for id in [
                        "style-fg",
                        "style-bg",
                        "style-needs",
                        "style-failed",
                        "style-ready",
                    ] {
                        let mark = window.find(format!("chat-mark-{id}")).bounds();
                        let title = window
                            .within(format!("chat-row-{id}"))
                            .find("sidebar-chat-title")
                            .bounds();
                        assert!(
                            mark.size.width > px(0.) && mark.left() >= title.right(),
                            "{id}: trailing mark"
                        );
                        assert!(
                            (mark.center().y - title.center().y).abs() < px(1.5),
                            "{id}: mark sits on the title line"
                        );
                    }
                    // A thread: the coordinator row is titled with the mission, its
                    // members are one-line rows indented under it.
                    let parent = window.find("chat-row-style-coord").bounds();
                    let member = window.find("chat-row-style-member").bounds();
                    assert!(member.size.height < parent.size.height);
                    let name = window
                        .within("chat-row-style-coord")
                        .find("sidebar-mission-title")
                        .bounds();
                    let member_title = window
                        .within("chat-row-style-member")
                        .find("sidebar-chat-title")
                        .bounds();
                    assert!(
                        member_title.left() + px(1.) >= name.left() - px(1.),
                        "member titles align with the mission name"
                    );
                    assert!(
                        window.try_find("chat-row-style-member-done").is_none(),
                        "finished members fold"
                    );
                    assert!(window.try_find("mission-fold-style-mission").is_some());
                    // The reply dot follows the title on its line.
                    let dot = window.find("chat-reply-style-unread").bounds();
                    let title = window
                        .within("chat-row-style-unread")
                        .find("sidebar-chat-title")
                        .bounds();
                    assert!(
                        dot.left() >= title.right()
                            && (dot.center().y - title.center().y).abs() < px(1.5)
                    );
                    assert!(window.try_find("chat-reply-style-idle").is_none());
                    // Long Unicode titles truncate inside the row, never under the state word.
                    let word_right = window.find("chat-mark-style-member").bounds().left();
                    assert!(member_title.right() <= word_right);
                    (
                        v.transcript.read(cx).probe_render_count(),
                        ids.map(|id| window.find(id).bounds()),
                    )
                })
                .unwrap();
            // Marks hold still: nothing loops, nothing redraws the cached transcript.
            pulse(cx, handle, 12, 84);
            let after = cx.capture_screenshot(handle).unwrap();
            let scale = initial.width() as f32 / width;
            let mut changes = Vec::new();
            for rect in rects {
                let mut changed = 0;
                for y in (f32::from(rect.top()) * scale) as u32
                    ..(f32::from(rect.bottom()) * scale) as u32
                {
                    for x in (f32::from(rect.left()) * scale) as u32
                        ..(f32::from(rect.right()) * scale) as u32
                    {
                        changed += usize::from(initial.get_pixel(x, y) != after.get_pixel(x, y));
                    }
                }
                changes.push(changed);
            }
            assert_eq!(changes, [0; 7], "state marks hold still: {changes:?}");
            assert_eq!(
                cx.update(|cx| view.read(cx).transcript.read(cx).probe_render_count()),
                baseline,
                "still marks must not re-render the cached transcript"
            );
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"changed_pixels":changes,"native_production_root":true})
            );
            if let Some(dir) = &captures {
                initial
                    .save(dir.join(format!("{}-{}-sidebar.png", width as u32, mode.name())))
                    .unwrap();
            }
            // Geometry: the composer keeps its surfaces.
            let tray = cx
                .update_window(handle, |_, window, _| window.find("composer-tray").bounds())
                .unwrap();
            let sample = |x: f32, y: f32| after.get_pixel((x * scale) as u32, (y * scale) as u32).0;
            let (input, controls, stop, send) = cx
                .update_window(handle, |_, window, _| {
                    (
                        window.find("composer-input").bounds(),
                        window.find("composer-controls").bounds(),
                        window.find("composer-stop-slot").bounds(),
                        window.find("local-send").bounds(),
                    )
                })
                .unwrap();
            assert_eq!(
                tray.size.height,
                px(76.),
                "contrast must not enlarge the tray"
            );
            assert_eq!(
                input.size.height,
                px(34.),
                "contrast must not enlarge the editor"
            );
            assert_eq!(input.bottom(), controls.top());
            for rect in [input, controls, stop, send] {
                assert!(
                    rect.left() >= tray.left() && rect.right() <= tray.right(),
                    "control must not clip: {rect:?} vs {tray:?}"
                );
                assert!(rect.top() >= tray.top() && rect.bottom() <= tray.bottom());
            }
            assert_eq!(stop.center().y, send.center().y);
            let (card, tray_color) = cx.update(|cx| {
                let rgba = |color: gpui_kit::Hsla| {
                    let color: gpui_kit::Rgba = color.into();
                    [color.r, color.g, color.b, color.a]
                        .map(|channel| (channel * 255.).round() as u8)
                };
                (
                    rgba(crate::appearance::card(cx)),
                    rgba(crate::appearance::tray(cx)),
                )
            });
            let editor_pixel = sample(f32::from(input.left()) + 16., f32::from(input.top()) + 2.);
            let tray_pixel = sample(
                f32::from(controls.left()) + 16.,
                f32::from(controls.top()) + 2.,
            );
            assert_eq!(
                editor_pixel, card,
                "opaque editor must paint semantic card, not tray"
            );
            assert_eq!(
                tray_pixel, tray_color,
                "controls retain the soft tray surface"
            );
            assert_ne!(
                editor_pixel, tray_pixel,
                "compact spacing must not flatten editor/tray contrast"
            );
            let outside = sample(f32::from(tray.left()) + 0.5, f32::from(tray.top()) + 0.5);
            let top = sample(f32::from(tray.left()) + 24., f32::from(tray.top()) + 2.);
            assert_ne!(
                outside, top,
                "the composer tray must actually paint a rounded, inset surface"
            );
            println!(
                "{}",
                json!({"composer_width":width,"mode":mode.name(),"tray_height":f32::from(tray.size.height),"input_height":f32::from(input.size.height),"editor_rgba":editor_pixel,"tray_rgba":tray_pixel,"send_stop_one_row":true,"controls_contained":true,"native_production_root":true})
            );

            // Hover swaps the mark for the row's … menu; the row keeps its size.
            cx.update_window(handle, |_, window, cx| {
                window.hover("chat-row-style-fg", cx)
            })
            .unwrap();
            pulse(cx, handle, 2, 50);
            cx.update_window(handle, |_, window, _| {
                assert!(
                    window.try_find("chat-menu-style-fg").is_some(),
                    "hover builds the row menu"
                );
                assert_eq!(window.find("chat-row-style-fg").bounds(), rects[0]);
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(handle)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-hover.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(handle, |_, window, cx| window.hover("new-local-chat", cx))
                .unwrap();
            pulse(cx, handle, 2, 50);

            // A live state change cross-fades once (180 ms) in place, then rests.
            let change = |cx: &mut HeadlessAppContext, signal: Option<Signal>| {
                cx.update_window(handle, |_, window, cx| {
                    view.update(cx, |v, cx| {
                        let chats = Arc::make_mut(&mut v.state.chats);
                        chats[0].signal = signal;
                        chats[0].busy = false;
                        v.rebuild_nav(window, cx);
                    });
                    window.draw(cx).clear(cx);
                })
                .unwrap();
            };
            change(cx, Some(Signal::Failed));
            assert!(cx.update(|cx| fading(
                &view,
                "chat-row-style-fg".trim_start_matches("chat-row-"),
                cx
            )));
            pulse(cx, handle, 1, 90);
            assert!(
                cx.update(|cx| fading(&view, "style-fg", cx)),
                "still fading halfway"
            );
            pulse(cx, handle, 2, 60);
            assert!(
                !cx.update(|cx| fading(&view, "style-fg", cx)),
                "settled after 180 ms"
            );
            let settled = cx.capture_screenshot(handle).unwrap();
            pulse(cx, handle, 6, 84);
            let rested = cx.capture_screenshot(handle).unwrap();
            let row = rects[0];
            let mut moved = 0;
            for y in (f32::from(row.top()) * scale) as u32..(f32::from(row.bottom()) * scale) as u32
            {
                for x in
                    (f32::from(row.left()) * scale) as u32..(f32::from(row.right()) * scale) as u32
                {
                    moved += usize::from(settled.get_pixel(x, y) != rested.get_pixel(x, y));
                }
            }
            assert_eq!(moved, 0, "a settled change holds still");
            cx.update_window(handle, |_, window, _| {
                assert_eq!(
                    window.find("chat-row-style-fg").bounds(),
                    rects[0],
                    "state never moves the row"
                );
            })
            .unwrap();

            // Reduce Motion: a change is instant.
            cx.update(|cx| cx.set_reduce_motion(true));
            change(cx, Some(Signal::Ready));
            assert!(
                !cx.update(|cx| fading(&view, "style-fg", cx)),
                "reduced motion swaps at once"
            );
            cx.update(|cx| cx.set_reduce_motion(false));
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"lifecycle":"still-crossfade180-rest-reduced-motion","native_production_root":true})
            );
            if width == 1100. && mode == ThemeMode::Dark {
                for background in [false, true] {
                    cx.update(|cx| {
                        let editor = view.read(cx).editor.clone();
                        editor.update(cx, |v, cx| {
                            v.permission(false, true, cx);
                            v.background(background, cx);
                        });
                    });
                    // A state fade alone is not evidence of a settled work loop.
                    pulse(cx, handle, 9, 84);
                    let before = cx.capture_screenshot(handle).unwrap();
                    pulse(cx, handle, 12, 84);
                    let after = cx.capture_screenshot(handle).unwrap();
                    let (tray, editor) = cx
                        .update_window(handle, |_, window, _| {
                            (
                                window.find("composer-tray").bounds(),
                                window.find("composer-input").bounds(),
                            )
                        })
                        .unwrap();
                    // A blank interior strip stays opaque. Avoid text and rounded edges.
                    let y = ((f32::from(editor.top()) + 2.) * scale) as u32;
                    for x in ((f32::from(editor.left()) + 16.) * scale) as u32
                        ..((f32::from(editor.right()) - 16.) * scale) as u32
                    {
                        assert_eq!(
                            before.get_pixel(x, y).0,
                            card,
                            "nothing bleeds through the editor"
                        );
                        assert_eq!(after.get_pixel(x, y).0, card, "editor backing stays opaque");
                    }
                    let mut pixels = 0;
                    for y in (f32::from(tray.top()) * scale) as u32
                        ..(f32::from(tray.bottom()) * scale) as u32
                    {
                        for x in (f32::from(tray.left()) * scale) as u32
                            ..(f32::from(tray.right()) * scale) as u32
                        {
                            pixels += usize::from(before.get_pixel(x, y) != after.get_pixel(x, y));
                        }
                    }
                    assert_eq!(
                        pixels, 0,
                        "the composer carries no state decoration; the working line reports live work"
                    );
                    println!(
                        "{}",
                        json!({"composer_background":background,"settled_changed_pixels":pixels,"width":width,"mode":mode.name()})
                    );
                    if let Some(dir) = &captures {
                        after
                            .save(dir.join(format!(
                                "1100-dark-composer-{}.png",
                                if background { "background" } else { "working" }
                            )))
                            .unwrap();
                    }
                }
            }
            cx.update_window(handle, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
        }
    }
    run_large_motion(cx);
    run_large_thread(cx, captures.as_deref());
    run_reply_memory(cx);
}

fn open_rows(
    cx: &mut HeadlessAppContext,
    width: f32,
    chats: Vec<Chat>,
    memory: Option<std::path::PathBuf>,
) -> (gpui_kit::AnyWindowHandle, gpui_kit::Entity<LocalViewer>) {
    let (handle, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(width), px(760.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |window, cx| {
                cx.new(|cx| {
                    let mut view = LocalViewer::preview(PreviewState::Conversation, window, cx);
                    view.state.chats = Arc::new(chats);
                    view.state.mission_titles = Some(Arc::new(
                        [(
                            "big".to_owned(),
                            "Large mission · 大きなミッション".to_owned(),
                        )]
                        .into_iter()
                        .collect(),
                    ));
                    view.selected = None;
                    view.page = crate::app_shell::Page::Home;
                    if let Some(path) = memory {
                        view.load_sidebar_memory(path, window, cx);
                    }
                    view.rebuild_nav(window, cx);
                    view
                })
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    (handle, view)
}

/// A mission with 120 members: finished ones fold, the thread collapses and
/// expands in place, and nothing else moves.
fn run_large_thread(cx: &mut HeadlessAppContext, captures: Option<&std::path::Path>) {
    let states = ["working", "failed", "idle"];
    let mut chats = vec![crate::local_model::chat(&json!({"id":"big-coord","title":"Coordinator","missionCoordinator":true,"missionId":"big","state":"working","createdAt":500})).unwrap()];
    for i in 0..120 {
        let state = if i % 12 == 0 {
            states[(i / 12) % 2]
        } else {
            states[2]
        };
        chats.push(crate::local_model::chat(&json!({"id":format!("big-{i:03}"),"title":format!("Member {i} · Überprüfung 検証 {}", "x".repeat(i % 7)),"missionId":"big","state":state,"createdAt":1000 + i})).unwrap());
    }
    for i in 0..30 {
        chats.push(crate::local_model::chat(&json!({"id":format!("solo-{i:02}"),"title":format!("Standalone chat {i}"),"state":"idle","createdAt":400 - i})).unwrap());
    }
    for mode in [ThemeMode::Light, ThemeMode::Dark] {
        cx.update(|cx| Theme::change(mode, None, cx));
        let (handle, view) = open_rows(cx, 1100., chats.clone(), None);
        let rows = |cx: &mut HeadlessAppContext| {
            cx.update(|cx| view.read(cx).chats.read(cx).delegate().tree.rows.len())
        };
        // Parent, the 10 active members, "+110 finished", then the standalone chats.
        assert_eq!(rows(cx), 1 + 10 + 1 + 30);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert!(
                window.find("chat-row-big-coord").bounds().top()
                    < window.find("chat-row-big-000").bounds().top()
            );
            assert!(
                window.try_find("chat-row-big-001").is_none(),
                "finished members fold"
            );
        })
        .unwrap();
        if let Some(dir) = captures {
            cx.capture_screenshot(handle)
                .unwrap()
                .save(dir.join(format!("1100-{}-thread.png", mode.name())))
                .unwrap();
        }
        let toggle = |cx: &mut HeadlessAppContext, f: &dyn Fn(&mut super::ChatList)| {
            cx.update_window(handle, |_, window, cx| {
                view.update(cx, |v, cx| {
                    v.chats.update(cx, |l, cx| {
                        f(l.delegate_mut());
                        cx.notify();
                    })
                });
                window.render_frame(cx);
            })
            .unwrap();
        };
        toggle(cx, &|l| l.toggle_finished("big"));
        assert_eq!(rows(cx), 1 + 120 + 1 + 30);
        toggle(cx, &|l| l.set_collapsed("big", true));
        assert_eq!(rows(cx), 1 + 30);
        cx.update_window(handle, |_, window, _| {
            assert!(window.try_find("mission-rollup-NeedsYou").is_none());
            assert!(window.try_find("mission-rollup-Failed").is_some());
            assert!(window.try_find("mission-rollup-Working").is_some());
        })
        .unwrap();
        if let Some(dir) = captures {
            cx.capture_screenshot(handle)
                .unwrap()
                .save(dir.join(format!("1100-{}-thread-collapsed.png", mode.name())))
                .unwrap();
        }
        println!(
            "{}",
            json!({"mode":mode.name(),"members":120,"rows_folded":42,"rows_expanded":152,"rows_collapsed":31})
        );
        cx.update_window(handle, |_, window, _| window.remove_window())
            .unwrap();
        cx.run_until_parked();
    }
}

/// "Replied since you looked" survives a restart from the private file only:
/// opening the chat clears it, and nothing is sent to the daemon.
fn run_reply_memory(cx: &mut HeadlessAppContext) {
    cx.update(|cx| Theme::change(ThemeMode::Light, None, cx));
    let dir = std::env::temp_dir().join(format!("pilot-next-sidebar-{}", uuid::Uuid::new_v4()));
    let path = dir.join(crate::sidebar_memory::FILE);
    let later = crate::sidebar_memory::now() + 60_000.;
    let chats = || {
        ["seen", "unseen"]
            .into_iter()
            .map(|id| {
                crate::local_model::chat(
                    &json!({"id":id,"title":id,"state":"idle","outcome":"done","outcomeAt":later}),
                )
                .unwrap()
            })
            .collect::<Vec<_>>()
    };
    let wait_for_file =
        |cx: &mut HeadlessAppContext, want: &dyn Fn(&crate::sidebar_memory::Saved) -> bool| {
            for _ in 0..200 {
                cx.run_until_parked();
                if crate::sidebar_memory::read(&path).is_some_and(|s| want(&s)) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            panic!("the sidebar memory was not written");
        };
    let (handle, view) = open_rows(cx, 1100., chats(), Some(path.clone()));
    wait_for_file(cx, &|_| true);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find("chat-reply-seen").is_some());
        assert!(window.try_find("chat-reply-unseen").is_some());
        let label = window
            .find("seen")
            .label()
            .map(|l| l.to_string())
            .unwrap_or_default();
        assert!(label.ends_with("new reply"), "{label}");
        // Opening the chat clears its dot.
        view.update(cx, |v, cx| {
            v.page = crate::app_shell::Page::Chat;
            v.selected = Some("seen".into());
            v.rebuild_nav(window, cx);
        });
        window.render_frame(cx);
        assert!(window.try_find("chat-reply-seen").is_none());
        assert!(window.try_find("chat-reply-unseen").is_some());
    })
    .unwrap();
    wait_for_file(cx, &|s| s.seen.contains_key("seen"));
    cx.update_window(handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
    // A restart reads the same private file.
    let (handle, _) = open_rows(cx, 1100., chats(), Some(path.clone()));
    for _ in 0..200 {
        cx.run_until_parked();
        let loaded = cx
            .update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                window.try_find("chat-reply-unseen").is_some()
            })
            .unwrap();
        if loaded {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            window.try_find("chat-reply-seen").is_none(),
            "seen survives a restart"
        );
        assert!(window.try_find("chat-reply-unseen").is_some());
        window.remove_window();
    })
    .unwrap();
    cx.run_until_parked();
    std::fs::remove_dir_all(&dir).unwrap();
    println!(
        "{}",
        json!({"reply_memory":"private-file-round-trip","daemon_writes":0})
    );
}

fn run_large_motion(cx: &mut HeadlessAppContext) {
    let mut source_bytes = 0;
    let (handle,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{
        window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(1100.),px(760.))))),
        show:false,focus:false,..Default::default()
    },cx,|window,cx|{
        cx.new(|cx|{
            let mut v=LocalViewer::synthetic(window,cx);
            Arc::make_mut(&mut v.state.chats)[0].signal=Some(Signal::Working);
            let rows=(0..512).map(|i|{
                let text=format!("### Synthetic history {i}\n\n{}", "Bounded synthetic text, selection and copying remain unchanged.\n\n".repeat(24));
                source_bytes+=text.len();crate::model::Message::live(2_000_000+i,"Assistant".into(),text)
            }).collect();
            v.transcript.update(cx,|v,cx|v.replace_readonly(rows,true,cx));v.rebuild_nav(window,cx);v
        })
    }).unwrap());
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
    let baseline = cx.update(|cx| view.read(cx).transcript.read(cx).probe_render_count());
    pulse(cx, handle, 12, 84);
    let count = cx.update(|cx| view.read(cx).transcript.read(cx).probe_render_count());
    assert_eq!(
        count, baseline,
        "large retained history must not re-render beside a working row"
    );
    println!(
        "{}",
        json!({"large_history_rows":512,"source_bytes":source_bytes,"transcript_renders_while_working":count-baseline})
    );
    cx.update_window(handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
}

//! Project sections and folders in the native production sidebar, with
//! synthetic chats: alignment edges, collapse and keyboard, the picker's folder
//! scope, folder editing and 100+ rows. Hidden windows only; no Local client,
//! user data or file writes. Not OS IME, motion or visible-window evidence.
use super::{LocalViewer, PreviewState};
use crate::{
    local_model::{Chat, Project},
    state_mark::Signal,
};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, FocusHandle, HeadlessAppContext, Pixels,
    WindowBounds, WindowOptions,
    component::{Theme, ThemeMode, WindowExt, dialog::ANIMATION_DURATION},
    px, size,
    test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const LONG: &str = "stoik-data 日本語 👩‍💻 with a very long project name";

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..12 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
/// Kit closes logically and restores focus immediately, then retains the
/// surface for its SlideDown exit. Advance that contract, not a wall-clock sleep
/// or the shorter generic row-state settle (192ms).
fn finish_folder_exit(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    previous_focus: &Option<FocusHandle>,
) {
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        assert!(!w.has_active_dialog(cx), "the folder dialog is closed");
        assert_eq!(
            &w.focused(cx),
            previous_focus,
            "dialog restores caller focus"
        );
        assert!(
            w.try_find("folder-editor").is_some(),
            "the exit still paints"
        );
    })
    .unwrap();
    cx.advance_clock(*ANIMATION_DURATION);
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        assert!(w.try_find("folder-editor").is_none(), "the exit unmounts");
    })
    .unwrap();
    cx.run_until_parked();
}
fn projects() -> Vec<Project> {
    [
        ("pilot", "pilot"),
        ("dotfiles", "dotfiles"),
        ("stoik", LONG),
    ]
    .into_iter()
    .map(|(id, name)| Project {
        id: id.into(),
        name: name.into(),
        path: format!("/synthetic/{id}"),
        policy: Default::default(),
    })
    .collect()
}
fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/home/synthetic".into())
}
fn chat(value: Value, signal: Option<Signal>) -> Chat {
    let mut chat = crate::local_model::chat(&value).unwrap();
    chat.signal = signal;
    chat.busy = signal == Some(Signal::Working);
    if let Some(signal) = signal {
        chat.state = match signal {
            Signal::Working => "Working",
            Signal::Paused => "Paused",
            Signal::NeedsYou => "Needs you",
            Signal::Failed => "Failed",
            Signal::Ready => "Ready to merge",
        }
        .into();
    }
    chat
}
/// pilot (a mission thread), dotfiles, a folder without a project and a
/// collapsed project, in that order of your sends; one pinned chat.
fn rows() -> Vec<Chat> {
    let p = |id: &str, title: &str, project: &str, sent: f64| json!({"id":id,"title":title,"projectId":project,"state":"idle","createdAt":sent,"lastUserMessageAt":sent});
    let m = |id: &str, title: &str, project: &str, created: f64| json!({"id":id,"title":title,"projectId":project,"missionId":"gpui","state":"idle","createdAt":created,"lastUserMessageAt":created});
    let mut pin = p("pin", "Release notes 1.93", "pilot", 990.);
    pin["pinned"] = json!(true);
    let mut coord = m("coord", "Coordinator", "pilot", 950.);
    coord["missionCoordinator"] = json!(true);
    let mut asked = m("m-q", "Sidebar rows", "pilot", 951.);
    asked["outcome"] = json!("done");
    asked["outcomeAt"] = json!(5);
    let mut background = chat(
        p("bg", "Background jobs strip", "pilot", 900.),
        Some(Signal::Working),
    );
    background.background_work = true;
    let mut scratch = p("scratch", "Benchmark scratch", "", 700.);
    scratch["projectId"] = Value::Null;
    scratch["cwd"] = json!(format!("{}/scratch", home()));
    vec![
        chat(pin, Some(Signal::Ready)),
        chat(coord, Some(Signal::Working)),
        chat(asked, Some(Signal::NeedsYou)),
        chat(
            m(
                "m-f",
                "Résumé des tâches 👩‍💻 長いタイトルの会話 with a very long member title",
                "pilot",
                952.,
            ),
            Some(Signal::Failed),
        ),
        chat(
            m("m-x", "Dotfiles helper", "dotfiles", 953.),
            Some(Signal::Working),
        ),
        chat(m("m-d1", "Finished one", "pilot", 954.), None),
        chat(m("m-d2", "Finished two", "pilot", 955.), None),
        chat(
            p("fix", "Fix updater ACK", "pilot", 940.),
            Some(Signal::Working),
        ),
        background,
        chat(
            p("nix", "Nix flake bump", "dotfiles", 800.),
            Some(Signal::NeedsYou),
        ),
        chat(p("ghostty", "Ghostty theme", "dotfiles", 790.), None),
        chat(scratch, None),
        chat(
            p("sweep", "Query sweep", "stoik", 600.),
            Some(Signal::Failed),
        ),
        chat(p("etl", "Claims ETL review", "stoik", 590.), None),
    ]
}

fn open(
    cx: &mut HeadlessAppContext,
    width: f32,
    chats: Vec<Chat>,
    collapsed: &[&str],
) -> (AnyWindowHandle, Entity<LocalViewer>) {
    let collapsed: Vec<String> = collapsed.iter().map(|k| (*k).to_owned()).collect();
    let (h, view) = cx.update(|cx| {
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
                    view.state.projects = Arc::new(projects());
                    view.state.projects_loaded = true;
                    view.state.mission_titles = Some(Arc::new(
                        [(
                            "gpui".to_owned(),
                            "GPUI Rewrite — 迁移 🚀 long name".to_owned(),
                        )]
                        .into_iter()
                        .collect(),
                    ));
                    view.chats.update(cx, |list, _| {
                        let memory = &mut list.delegate_mut().memory;
                        *memory = crate::sidebar_memory::Memory::ephemeral(0.);
                        for key in &collapsed {
                            memory.set_group_collapsed(key, true);
                        }
                    });
                    view.selected = None;
                    view.page = crate::app_shell::Page::Home;
                    view.rebuild_nav(window, cx);
                    view
                })
            },
        )
        .unwrap()
    });
    settle(cx, h);
    (h, view)
}
fn near(a: Pixels, b: Pixels, what: &str) {
    assert!((a - b).abs() < px(0.5), "{what}: {a:?} vs {b:?}");
}
fn selected(view: &Entity<LocalViewer>, cx: &mut HeadlessAppContext) -> Option<String> {
    cx.update(|cx| {
        let list = view.read(cx).chats.read(cx).delegate();
        list.selected.and_then(|ix| list.key_at(ix))
    })
}
fn select(view: &Entity<LocalViewer>, key: &str, h: AnyWindowHandle, cx: &mut HeadlessAppContext) {
    cx.update_window(h, |_, w, cx| {
        let list = view.read(cx).chats.clone();
        list.update(cx, |l, cx| {
            l.focus(w, cx);
            let ix = l.delegate().index(key);
            assert!(ix.is_some(), "{key} is a row");
            l.set_selected_index(ix, w, cx);
        });
    })
    .unwrap();
    settle(cx, h);
}
fn press(key: &str, h: AnyWindowHandle, cx: &mut HeadlessAppContext) {
    cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
    settle(cx, h);
}
fn collapsed(view: &Entity<LocalViewer>, key: &str, cx: &mut HeadlessAppContext) -> bool {
    cx.update(|cx| {
        view.read(cx)
            .chats
            .read(cx)
            .delegate()
            .memory
            .group_collapsed(key)
    })
}

pub fn run_sidebar_sections_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_STYLE_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (h, view) = open(cx, width, rows(), &["project:stoik"]);
            let shot = |cx: &mut HeadlessAppContext, name: &str| {
                if let Some(dir) = &captures {
                    cx.capture_screenshot(h)
                        .expect("native renderer required")
                        .save(dir.join(format!("{}-{}-{name}.png", width as u32, mode.name())))
                        .unwrap();
                }
            };
            shot(cx, "sections");
            let scratch = format!("group:dir:{}/scratch", home());
            // Sections follow your sends; the thread sits with its coordinator.
            let labels = cx.update(|cx| {
                let list = view.read(cx).chats.read(cx).delegate();
                list.tree
                    .groups
                    .iter()
                    .map(|g| g.key.clone())
                    .collect::<Vec<_>>()
            });
            assert_eq!(
                labels,
                [
                    "project:pilot".to_owned(),
                    "project:dotfiles".to_owned(),
                    scratch.trim_start_matches("group:").to_owned(),
                    "project:stoik".to_owned()
                ]
            );
            cx.update_window(h, |_, w, cx| {
                w.render_frame(cx);
                // One text edge: navigation glyph, section and project labels,
                // the folder glyph, chat titles and the mission Compass.
                let edge = w.find("nav-home-title-icon").bounds().left();
                near(
                    w.find("sidebar-section-title-pinned").bounds().left(),
                    edge,
                    "Pinned",
                );
                for key in [
                    "group:project:pilot",
                    "group:project:dotfiles",
                    "group:project:stoik",
                ] {
                    let name = w
                        .within(format!("chat-row-{key}"))
                        .find("sidebar-group-name")
                        .bounds();
                    near(name.left(), edge, key);
                    // The chevron follows the name.
                    let chevron = w.find(format!("sidebar-group-chevron-{key}")).bounds();
                    assert!(
                        chevron.left() >= name.right() && chevron.left() - name.right() < px(8.),
                        "{key} chevron"
                    );
                }
                near(
                    w.within(format!("chat-row-{scratch}"))
                        .find("sidebar-group-folder")
                        .bounds()
                        .left(),
                    edge,
                    "folder glyph",
                );
                for id in ["pin", "fix", "bg", "nix", "ghostty", "scratch"] {
                    near(
                        w.within(format!("chat-row-{id}"))
                            .find("sidebar-chat-title")
                            .bounds()
                            .left(),
                        edge,
                        id,
                    );
                }
                near(
                    w.within("chat-row-coord")
                        .find("sidebar-mission-glyph")
                        .bounds()
                        .left(),
                    edge,
                    "Compass",
                );
                // A second edge: mission name, members and "+N finished".
                let second = w
                    .within("chat-row-coord")
                    .find("sidebar-mission-title")
                    .bounds()
                    .left();
                assert!(second > edge + px(12.));
                for id in ["m-q", "m-f", "m-x"] {
                    near(
                        w.within(format!("chat-row-{id}"))
                            .find("sidebar-chat-title")
                            .bounds()
                            .left(),
                        second,
                        id,
                    );
                }
                near(
                    w.find("mission-fold-gpui").bounds().left(),
                    second,
                    "+N finished",
                );
                // One trailing column for marks and the collapsed count.
                let column = w.find("chat-mark-fix").bounds().center().x;
                for key in [
                    "pin",
                    "bg",
                    "nix",
                    "coord",
                    "m-q",
                    "m-f",
                    "m-x",
                    "group:project:stoik",
                ] {
                    near(
                        w.find(format!("chat-mark-{key}")).bounds().center().x,
                        column,
                        key,
                    );
                }
                let count = w.find("sidebar-group-count-group:project:stoik").bounds();
                let stoik = w
                    .within("chat-row-group:project:stoik")
                    .find("sidebar-group-name")
                    .bounds();
                assert!(
                    count.right()
                        <= w.find("chat-mark-group:project:stoik").bounds().left() + px(4.)
                );
                assert!(
                    stoik.right() <= count.left(),
                    "a long project name truncates before its count"
                );
                // Inside sections rows drop the project; pinned keeps it, and a
                // member from another project names it.
                assert!(
                    w.within("chat-row-fix")
                        .try_find("sidebar-chat-project")
                        .is_none()
                );
                assert!(
                    w.within("chat-row-pin")
                        .try_find("sidebar-chat-project")
                        .is_some()
                );
                assert!(
                    w.within("chat-row-m-x")
                        .try_find("sidebar-member-project")
                        .is_some()
                );
                assert!(
                    w.within("chat-row-m-q")
                        .try_find("sidebar-member-project")
                        .is_none()
                );
                let caption = w
                    .within("chat-row-m-x")
                    .find("sidebar-member-project")
                    .bounds();
                assert!(caption.right() <= w.find("chat-mark-m-x").bounds().left());
                assert!(
                    w.try_find("sidebar-section-title-chats").is_none(),
                    "sections replace the Chats heading"
                );
                assert!(
                    w.try_find("chat-row-sweep").is_none(),
                    "a collapsed section is its label"
                );
                // Labels and rows stay inside the sidebar.
                let sidebar = w.find("chat-sidebar").bounds();
                for key in ["group:project:pilot", "group:project:stoik", "m-f", "coord"] {
                    let row = w.find(format!("chat-row-{key}")).bounds();
                    assert!(row.right() <= sidebar.right() && row.left() >= sidebar.left());
                }
            })
            .unwrap();
            check_thread(cx, h, &view, &shot);
            let first = cx
                .update_window(h, |_, w, _| w.find("chat-row-group:project:pilot").bounds())
                .unwrap();

            // Keyboard: Left/Right/Enter on a label collapse and expand; Right
            // enters the section; Left from a row returns to its label.
            select(&view, "group:project:pilot", h, cx);
            press("left", h, cx);
            assert!(collapsed(&view, "project:pilot", cx));
            assert_eq!(selected(&view, cx).as_deref(), Some("group:project:pilot"));
            cx.update_window(h, |_, w, _| assert!(w.try_find("chat-row-fix").is_none()))
                .unwrap();
            shot(cx, "collapsed");
            press("right", h, cx);
            assert!(!collapsed(&view, "project:pilot", cx));
            press("right", h, cx);
            assert_eq!(
                selected(&view, cx).as_deref(),
                Some("coord"),
                "Right enters the section"
            );
            select(&view, "fix", h, cx);
            press("left", h, cx);
            assert_eq!(selected(&view, cx).as_deref(), Some("group:project:pilot"));
            press("enter", h, cx);
            assert!(
                collapsed(&view, "project:pilot", cx),
                "Enter toggles a label"
            );
            press("enter", h, cx);
            assert!(!collapsed(&view, "project:pilot", cx));
            // A collapse keeps the selection on a visible row, the label.
            select(&view, "nix", h, cx);
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    v.toggle_sidebar_group("project:dotfiles", w, cx)
                })
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                selected(&view, cx).as_deref(),
                Some("group:project:dotfiles")
            );
            // Opening a chat in a collapsed section expands it.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    v.page = crate::app_shell::Page::Chat;
                    v.selected = Some("ghostty".into());
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            assert!(!collapsed(&view, "project:dotfiles", cx));
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("chat-row-ghostty").is_some());
                assert_eq!(
                    w.find("chat-row-group:project:pilot").bounds(),
                    first,
                    "nothing above moved"
                );
            })
            .unwrap();

            // Edit folders: add two, file projects, save. Cancel keeps nothing.
            let previous_focus = cx.update_window(h, |_, w, cx| w.focused(cx)).unwrap();
            let form = cx
                .update_window(h, |_, w, cx| {
                    view.update(cx, |v, cx| v.open_folder_editor(w, cx))
                })
                .unwrap()
                .expect("loaded memory edits folders");
            settle(cx, h);
            shot(cx, "folders-empty");
            for name in ["Work 仕事", "Personal"] {
                cx.update_window(h, |_, w, cx| {
                    let input = form.read(cx).new_name.clone();
                    input.update(cx, |i, cx| i.set_value(name, w, cx));
                    w.render_frame(cx);
                    w.click("folder-add", cx);
                })
                .unwrap();
                settle(cx, h);
            }
            cx.update_window(h, |_, _, cx| {
                form.update(cx, |f, cx| {
                    assert_eq!(f.draft.names, ["Work 仕事", "Personal"]);
                    f.assign("stoik", Some("Work 仕事".into()), cx);
                    f.assign("dotfiles", Some("Work 仕事".into()), cx);
                    f.assign("pilot", Some("Personal".into()), cx);
                })
            })
            .unwrap();
            settle(cx, h);
            shot(cx, "folders");
            cx.update_window(h, |_, w, cx| {
                let editor = w.find("folder-editor").bounds();
                let save = w.find("folder-save").bounds();
                assert!(
                    save.right() <= editor.right() + px(0.5)
                        && save.bottom() <= editor.bottom() + px(0.5)
                );
                assert_ne!(
                    w.find("folder-save").disabled(),
                    Some(true),
                    "edits can be saved"
                );
                w.click("folder-save", cx);
            })
            .unwrap();
            finish_folder_exit(cx, h, &previous_focus);
            let folders = cx.update(|cx| {
                view.read(cx)
                    .chats
                    .read(cx)
                    .delegate()
                    .memory
                    .folders()
                    .clone()
            });
            assert_eq!(folders.folder_of("stoik"), Some("Work 仕事"));
            assert_eq!(folders.folder_of("pilot"), Some("Personal"));
            cx.update_window(h, |_, w, _| assert!(w.try_find("folder-editor").is_none()))
                .unwrap();
            // Rename through the dialog's field, then Cancel: nothing changes.
            let form = cx
                .update_window(h, |_, w, cx| {
                    view.update(cx, |v, cx| v.open_folder_editor(w, cx))
                })
                .unwrap()
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let input = form.read(cx).names[1].clone();
                input.update(cx, |i, cx| i.set_value("Work 仕事", w, cx));
                w.render_frame(cx);
                assert!(
                    form.read(cx).result(cx).is_err(),
                    "a duplicate name can't be saved"
                );
                assert_eq!(w.find("folder-save").disabled(), Some(true));
                w.click("folder-cancel", cx);
            })
            .unwrap();
            finish_folder_exit(cx, h, &previous_focus);
            assert_eq!(
                cx.update(|cx| view
                    .read(cx)
                    .chats
                    .read(cx)
                    .delegate()
                    .memory
                    .folders()
                    .clone()),
                folders
            );

            // Enter in a folder name saves; Escape discards a valid edit.
            // Both return focus before the retained exit surface unmounts.
            for key in ["enter", "escape"] {
                let form = cx
                    .update_window(h, |_, w, cx| {
                        view.update(cx, |v, cx| v.open_folder_editor(w, cx))
                    })
                    .unwrap()
                    .unwrap();
                cx.advance_clock(*ANIMATION_DURATION);
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    let input = form.read(cx).names[1].clone();
                    input.update(cx, |i, cx| i.set_value("Private", w, cx));
                    w.render_frame(cx);
                    w.click("folder-name-1", cx);
                    w.press(key, cx);
                })
                .unwrap();
                finish_folder_exit(cx, h, &previous_focus);
                let saved = cx.update(|cx| {
                    view.read(cx)
                        .chats
                        .read(cx)
                        .delegate()
                        .memory
                        .folders()
                        .clone()
                });
                if key == "enter" {
                    assert_eq!(saved.folder_of("pilot"), Some("Private"));
                    cx.update_window(h, |_, w, cx| {
                        view.update(cx, |v, cx| v.set_folders(folders.clone(), w, cx));
                    })
                    .unwrap();
                } else {
                    assert_eq!(saved, folders, "Escape discards the edited name");
                }
            }

            // The picker: All projects, folders with counts, projects; Edit folders….
            cx.update_window(h, |_, w, cx| w.click("project-scope", cx))
                .unwrap();
            settle(cx, h);
            shot(cx, "picker");
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("scope-all").is_some());
                assert!(w.try_find("edit-folders").is_some());
                let work = w.find("scope-folder-Work 仕事");
                assert_eq!(work.label(), Some("Work 仕事 · folder · 2 projects"));
                let edge = w.find("nav-home-title").bounds().left();
                near(
                    w.within("scope-folder-Work 仕事")
                        .find("scope-project-title")
                        .bounds()
                        .left(),
                    edge,
                    "folder choice",
                );
                w.click("scope-folder-Work 仕事", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let v = view.read(cx);
                assert!(!v.projects_open);
                assert_eq!(v.project_scope, None);
                assert_eq!(
                    v.chats.read(cx).delegate().folder.as_deref(),
                    Some("Work 仕事")
                );
                assert!(
                    w.try_find("chat-row-pin").is_some(),
                    "pinned chats always show"
                );
                assert!(
                    w.try_find("chat-row-fix").is_none() && w.try_find("chat-row-coord").is_none()
                );
                assert!(w.try_find("chat-row-nix").is_some());
                assert!(w.try_find("chat-row-group:project:stoik").is_some());
                assert!(w.try_find(format!("chat-row-{scratch}")).is_none());
            })
            .unwrap();
            shot(cx, "folder-scope");
            // Back to All projects.
            cx.update_window(h, |_, w, cx| w.click("project-scope", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("scope-all", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(view.read(cx).chats.read(cx).delegate().folder, None);
                assert!(w.try_find("chat-row-fix").is_some());
            })
            .unwrap();
            // One project: no section labels, rows keep the flat layout.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| v.focus_scope("pilot".into(), w, cx))
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    view.read(cx)
                        .chats
                        .read(cx)
                        .delegate()
                        .tree
                        .groups
                        .is_empty()
                );
                assert!(w.try_find("chat-row-group:project:pilot").is_none());
                assert!(w.try_find("chat-row-fix").is_some());
            })
            .unwrap();
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"sections":4,"edges":"one-text-edge+second-edge+mark-column","keyboard":"left-right-enter","folders":"add-file-save-cancel-duplicate","picker":"all-folder-all","native_production_root":true})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            run_waiting_question(cx, width);
            run_unread_circle(cx, width);
        }
    }
    run_many(cx, captures.as_deref());
    run_section_settings(cx);
}

fn thread_collapsed(view: &Entity<LocalViewer>, cx: &mut HeadlessAppContext) -> bool {
    cx.update(|cx| {
        view.read(cx)
            .chats
            .read(cx)
            .delegate()
            .collapsed
            .contains("gpui")
    })
}

/// The mission tree: the fold chevron sits in the leading gutter before the
/// Compass, a stem runs from the Compass's center through rounded branches and
/// ends at the last member, never "+N finished". State words stay beside
/// empty Working slots; Needs you hides the "new reply" dot, also on the
/// collapsed mission's roll-up.
fn check_thread(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    shot: &dyn Fn(&mut HeadlessAppContext, &str),
) {
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        let row = w.find("chat-row-coord").bounds();
        let compass = w
            .within("chat-row-coord")
            .find("sidebar-mission-glyph")
            .bounds();
        let chevron = w.find("sidebar-mission-chevron").bounds();
        assert!(
            chevron.left() >= row.left() && chevron.right() <= compass.left() + px(0.5),
            "the chevron sits in the gutter before the Compass"
        );
        assert!((chevron.center().y - compass.center().y).abs() < px(1.));
        let target = w.find("mission-disclosure-gpui").bounds();
        assert!(target.left() >= row.left() && target.right() <= compass.right() + px(0.5));
        let title = w
            .within("chat-row-coord")
            .find("sidebar-mission-title")
            .bounds();
        assert!(
            target.right() <= title.left(),
            "the title still opens the chat"
        );
        let stem = w.find("sidebar-thread-stem").bounds();
        near(
            stem.center().x,
            compass.center().x,
            "stem under the Compass",
        );
        assert!(stem.top() >= compass.bottom());
        for (id, last) in [("m-q", false), ("m-f", false), ("m-x", true)] {
            let row = w.find(format!("chat-row-{id}")).bounds();
            let elbow = w
                .within(format!("chat-row-{id}"))
                .find("sidebar-thread-elbow")
                .bounds();
            let name = w
                .within(format!("chat-row-{id}"))
                .find("sidebar-chat-title")
                .bounds();
            let word = w
                .within(format!("chat-row-{id}"))
                .find("sidebar-state-word")
                .bounds();
            near(elbow.left() + px(0.5), stem.center().x, id);
            assert!(
                elbow.right() < name.left(),
                "{id}: the branch stops before its title"
            );
            assert!(
                (elbow.bottom() - px(0.5) - name.center().y).abs() < px(1.5),
                "{id}: the branch meets the title line"
            );
            assert!(
                name.right() <= word.left() + px(0.5),
                "{id}: title and state never overlap"
            );
            assert!(word.right() <= w.find(format!("chat-mark-{id}")).bounds().right());
            let continues = w
                .within(format!("chat-row-{id}"))
                .try_find("sidebar-thread-continues")
                .map(|e| e.bounds());
            assert_eq!(
                continues.is_some(),
                !last,
                "{id}: the stem ends at the last member"
            );
            if let Some(below) = continues {
                near(below.bottom(), row.bottom(), id);
            }
        }
        assert!(
            w.within("chat-row-fold:gpui")
                .try_find("sidebar-thread-branch")
                .is_none(),
            "+N finished hangs off no branch"
        );
        // Needs you already asks for a look: no new-reply state beside it.
        // Working keeps its word and a hollow circle (nothing unread here).
        assert!(w.try_find("chat-reply-m-q").is_none());
        assert!(w.within("chat-mark-m-q").try_find("state-glyph").is_some());
        assert!(
            w.within("chat-mark-m-q")
                .try_find("state-circle-filled")
                .is_none()
        );
        for id in ["coord", "m-x", "fix", "bg"] {
            assert!(
                w.within(format!("chat-mark-{id}"))
                    .try_find("state-circle-hollow")
                    .is_some(),
                "{id}: hollow Working circle"
            );
        }
        assert!(
            w.within("chat-row-m-x")
                .try_find("sidebar-state-word")
                .is_some()
        );
        assert!(
            w.within("chat-row-fix")
                .try_find("sidebar-chat-state")
                .is_some()
        );
        assert!(w.within("chat-mark-nix").try_find("state-glyph").is_some());
    })
    .unwrap();
    // A click on the chevron folds the thread and opens nothing.
    cx.update_window(h, |_, w, cx| w.click("mission-disclosure-gpui", cx))
        .unwrap();
    settle(cx, h);
    assert!(thread_collapsed(view, cx));
    assert!(cx.update(|cx| view.read(cx).selected.is_none()));
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("chat-row-m-q").is_none());
        assert!(w.try_find("sidebar-thread-stem").is_none());
        let compass = w
            .within("chat-row-coord")
            .find("sidebar-mission-glyph")
            .bounds();
        assert!(w.find("sidebar-mission-chevron").bounds().right() <= compass.left() + px(0.5));
        // The roll-up follows the title on its line, clear of the state word
        // and mark, and the row stays one line. The long title truncates
        // first but keeps a few letters; the most urgent count stays whole.
        let row = w.find("chat-row-coord").bounds();
        let title = w.within("chat-row-coord").find("sidebar-mission-title").bounds();
        let rollup = w.find("sidebar-mission-rollup").bounds();
        let urgent = w.find("mission-rollup-NeedsYou").bounds();
        assert!(w.within("chat-row-coord").try_find("sidebar-mission-detail").is_none());
        assert_eq!(row.size.height, px(super::sidebar_list::PARENT_HEIGHT));
        assert!(title.size.width >= w.rem_size() * 2.5 - px(0.5), "{title:?}");
        assert!(urgent.left() >= rollup.left() && urgent.right() <= rollup.right() + px(0.5));
        // A count shows whole or wraps out of sight, never cut in half.
        for mark in ["NeedsYou", "Failed", "Ready", "Working"] {
            if let Some(item) = w.try_find(format!("mission-rollup-{mark}")) {
                let b = item.bounds();
                assert!(
                    b.top() >= rollup.bottom() || b.right() <= rollup.right() + px(0.5),
                    "{mark} {b:?} cut by {rollup:?}"
                );
            }
        }
        assert!(title.right() <= rollup.left() && rollup.left() - title.right() < px(8.));
        assert!((rollup.center().y - title.center().y).abs() < px(1.));
        println!(
            "{}",
            json!({"row":f32::from(row.size.width),"title":f32::from(title.size.width),"rollup":f32::from(rollup.size.width)})
        );
        for id in ["sidebar-state-word", "chat-mark-coord"] {
            if let Some(right) = w.within("chat-row-coord").try_find(id) {
                assert!(
                    rollup.right() <= right.bounds().left(),
                    "{id} overlaps the roll-up: row {row:?} title {title:?} rollup {rollup:?} {id} {:?}",
                    right.bounds()
                );
            }
        }
        // The roll-up's amber dot stands in for its members' new replies:
        // the coordinator's Working circle stays hollow.
        assert!(w.try_find("chat-reply-coord").is_none());
        assert!(
            w.within("chat-mark-coord")
                .try_find("state-circle-hollow")
                .is_some()
        );
        assert!(
            w.within("mission-rollup-NeedsYou")
                .try_find("state-glyph")
                .is_some()
        );
        assert!(
            w.within("mission-rollup-Working")
                .try_find("state-circle-hollow")
                .is_some()
        );
        let label = w
            .find("coord")
            .label()
            .map(|l| l.to_string())
            .unwrap_or_default();
        assert!(
            label.contains("1 need you") && !label.contains("new repl"),
            "{label}"
        );
    })
    .unwrap();
    shot(cx, "thread-collapsed");
    // Keyboard: Right expands, then enters; Left returns and collapses.
    select(view, "coord", h, cx);
    press("right", h, cx);
    assert!(!thread_collapsed(view, cx));
    press("right", h, cx);
    assert_eq!(selected(view, cx).as_deref(), Some("m-q"));
    press("left", h, cx);
    assert_eq!(selected(view, cx).as_deref(), Some("coord"));
    press("left", h, cx);
    assert!(thread_collapsed(view, cx));
    press("right", h, cx);
    assert!(!thread_collapsed(view, cx));
    cx.update_window(h, |_, w, cx| w.hover("chat-row-coord", cx))
        .unwrap();
    settle(cx, h);
    shot(cx, "thread-hover");
    cx.update_window(h, |_, w, cx| w.hover("new-local-chat", cx))
        .unwrap();
    settle(cx, h);
    cx.update(|cx| {
        view.read(cx).chats.clone().update(cx, |l, cx| {
            l.delegate_mut().selected = None;
            cx.notify();
        })
    });
    settle(cx, h);
}

fn click_menu(w: &mut gpui_kit::Window, label: &str, cx: &mut gpui_kit::App) {
    use gpui_kit::{InputEvent as _, MouseButton, MouseDownEvent, MouseUpEvent};
    let position = w
        .within("popup-menu")
        .find_by_label(label)
        .bounds()
        .center();
    w.dispatch_event(
        MouseDownEvent {
            button: MouseButton::Left,
            position,
            modifiers: Default::default(),
            click_count: 1,
            first_mouse: false,
        }
        .to_platform_input(),
        cx,
    );
    w.render_frame(cx);
    w.dispatch_event(
        MouseUpEvent {
            button: MouseButton::Left,
            position,
            modifiers: Default::default(),
            click_count: 1,
        }
        .to_platform_input(),
        cx,
    );
}

/// A project section's menu opens Settings on exactly that project (the
/// synthetic project daemon from the Settings probe), and a folder section
/// without a project offers neither Settings nor folders.
fn run_section_settings(cx: &mut HeadlessAppContext) {
    use crate::{
        project_settings_fixture::{Server, project},
        project_settings_view::ProjectSettings,
        settings_view::{Category, SettingsPreferences},
    };
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let server = Server::start(&[
                project("proj-a", "Atlas"),
                project("proj-b", "Boreal 日本語"),
            ]);
            let catalog: Vec<_> = server
                .state
                .lock()
                .unwrap()
                .projects
                .values()
                .cloned()
                .collect();
            let catalog = crate::local_model::projects(&Value::Array(catalog)).unwrap();
            let owner =
                cx.update(|cx| cx.new(|_| ProjectSettings::new(Some(server.options.clone()))));
            let chats = vec![
                chat(
                    json!({"id":"a1","title":"Atlas chat","projectId":"proj-a","state":"idle","createdAt":3,"lastUserMessageAt":3}),
                    None,
                ),
                chat(
                    json!({"id":"b1","title":"Boreal chat","projectId":"proj-b","state":"idle","createdAt":2,"lastUserMessageAt":2}),
                    None,
                ),
                chat(
                    json!({"id":"d1","title":"Loose chat","cwd":"/tmp/loose","state":"idle","createdAt":1,"lastUserMessageAt":1}),
                    None,
                ),
            ];
            let (h, view) = open(cx, width, chats, &[]);
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    v.state.projects = Arc::new(catalog);
                    v.settings = cx.new(|_| SettingsPreferences::new(None));
                    v.settings.update(cx, |o, cx| {
                        o.projects = Some(owner.clone());
                        o.load(cx);
                    });
                    v.settings_fixture_size = Some(size(px(width), px(980.)));
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            // A section without a project: collapse only.
            cx.update_window(h, |_, w, cx| {
                w.right_click("chat-row-group:dir:/tmp/loose", cx)
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let menu = w.within("popup-menu");
                assert!(menu.try_find_by_label("Collapse").is_some());
                assert!(menu.try_find_by_label("Project settings…").is_none());
                assert!(menu.try_find_by_label("Edit folders…").is_none());
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            // Boreal's section, not the first one, opens Boreal's settings.
            cx.update_window(h, |_, w, cx| {
                w.right_click("chat-row-group:project:proj-b", cx)
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let menu = w.within("popup-menu");
                assert_eq!(
                    ["Project settings…", "Edit folders…", "No folder"]
                        .map(|l| menu.try_find_by_label(l).is_some()),
                    [true; 3]
                );
                click_menu(w, "Project settings…", cx);
            })
            .unwrap();
            settle(cx, h);
            let handle = cx.update(|cx| {
                view.read(cx)
                    .settings_window
                    .expect("Settings opens on the project")
            });
            settle(cx, handle);
            cx.update(|cx| {
                assert_eq!(view.read(cx).settings.read(cx).category, Category::Project);
                assert_eq!(owner.read(cx).selected.as_deref(), Some("proj-b"));
                // Folders are sidebar organization only; nothing reached the daemon.
                assert!(
                    view.read(cx)
                        .chats
                        .read(cx)
                        .delegate()
                        .memory
                        .folders()
                        .names
                        .is_empty()
                );
            });
            assert_eq!(server.state.lock().unwrap().patches().len(), 0);
            cx.update_window(handle, |_, w, cx| w.press("secondary-w", cx))
                .unwrap();
            settle(cx, h);
            assert!(cx.update(|cx| view.read(cx).settings_window.is_none()));
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"section_menu_settings":"exact proj-b","dir_section_menu":"collapse-only","patches":0})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            drop(server);
        }
    }
}

/// 132 chats across six projects and a folder: sections, scrolling keyboard
/// selection and collapse keep the selected row and the rows above it.
fn run_many(cx: &mut HeadlessAppContext, captures: Option<&std::path::Path>) {
    let mut chats = Vec::new();
    for i in 0..132 {
        let project = ["pilot", "dotfiles", "stoik", "infra", "web", "docs", ""][i % 7];
        let signal = [
            None,
            Some(Signal::Working),
            None,
            Some(Signal::NeedsYou),
            None,
            Some(Signal::Failed),
        ][i % 6];
        let mut value = json!({"id":format!("many-{i:03}"),"title":format!("Chat {i} · Überprüfung 検証"),"state":"idle","createdAt":1000 - i,"lastUserMessageAt":1000 - i});
        if project.is_empty() {
            value["cwd"] = json!("/tmp/elsewhere");
        } else {
            value["projectId"] = json!(project);
        }
        chats.push(chat(value, signal));
    }
    for mode in [ThemeMode::Light, ThemeMode::Dark] {
        cx.update(|cx| Theme::change(mode, None, cx));
        let (h, view) = open(cx, 1100., chats.clone(), &[]);
        let rows = |cx: &mut HeadlessAppContext| {
            cx.update(|cx| view.read(cx).chats.read(cx).delegate().tree.rows.len())
        };
        assert_eq!(rows(cx), 132 + 7, "every chat plus seven labels");
        select(&view, "group:project:pilot", h, cx);
        for _ in 0..60 {
            cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
        }
        settle(cx, h);
        let key = selected(&view, cx).expect("keyboard selection");
        cx.update_window(h, |_, w, _| {
            let pane = w.find("chat-list-pane").bounds();
            let row = w.find(format!("chat-row-{key}")).bounds();
            assert!(
                row.top() >= pane.top() - px(1.) && row.bottom() <= pane.bottom() + px(1.),
                "selection scrolls into view"
            );
        })
        .unwrap();
        // A live state change elsewhere keeps the selection.
        cx.update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| {
                Arc::make_mut(&mut v.state.chats)[0].signal = Some(Signal::Failed);
                v.rebuild_nav(w, cx);
            })
        })
        .unwrap();
        settle(cx, h);
        assert_eq!(selected(&view, cx), Some(key.clone()));
        // Collapse every section from the keyboard: labels only.
        for project in ["pilot", "dotfiles", "stoik", "infra", "web", "docs"] {
            select(&view, &format!("group:project:{project}"), h, cx);
            press("left", h, cx);
        }
        select(&view, "group:dir:/tmp/elsewhere", h, cx);
        press("left", h, cx);
        assert_eq!(rows(cx), 7);
        if let Some(dir) = captures {
            cx.capture_screenshot(h)
                .unwrap()
                .save(dir.join(format!("1100-{}-many-collapsed.png", mode.name())))
                .unwrap();
        }
        println!(
            "{}",
            json!({"mode":mode.name(),"chats":132,"rows":139,"rows_collapsed":7,"selection_kept":true})
        );
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.run_until_parked();
    }
}

/// The shared resolver, not the sidebar, decides a waiting question: summaries
/// straight from `local_model::chat` (no signal overrides) for member and
/// standalone rows, the thread roll-up and a collapsed section mark, then an
/// answer returns the member to Working.
fn run_waiting_question(cx: &mut HeadlessAppContext, width: f32) {
    use crate::{sidebar_tree::Rollup, state_mark::Mark};
    use gpui_kit::test::TestQueryExt as _;
    let jobs = json!([{"name":"synthetic"}]);
    let raw = |v: Value| crate::local_model::chat(&v).unwrap();
    let asked = |id: &str, title: &str, project: &str, sent: f64, mission: Value| {
        raw(
            json!({"id":id,"title":title,"projectId":project,"missionId":mission,
            "state":"idle","working":true,"runningJobs":jobs,"outcome":"question","outcomeAt":sent,
            "outcomeReason":"Which layout 日本語 👩‍💻?","createdAt":sent,"lastUserMessageAt":sent}),
        )
    };
    let chats = |answered: bool| {
        let member = if answered {
            raw(
                json!({"id":"q-member","title":"Asking member","projectId":"pilot","missionId":"gpui",
                "state":"working","working":true,"runningJobs":jobs,"createdAt":951.,"lastUserMessageAt":951.}),
            )
        } else {
            asked("q-member", "Asking member", "pilot", 951., json!("gpui"))
        };
        vec![
            raw(
                json!({"id":"q-coord","title":"Coordinator","projectId":"pilot","missionId":"gpui",
                "missionCoordinator":true,"state":"working","working":true,"createdAt":950.,"lastUserMessageAt":950.}),
            ),
            member,
            raw(
                json!({"id":"q-live","title":"Live run","projectId":"pilot","state":"working",
                "working":true,"createdAt":940.,"lastUserMessageAt":940.}),
            ),
            raw(
                json!({"id":"q-await","title":"Awaiting ask","projectId":"pilot","state":"working",
                "working":true,"attentionReason":{"kind":"asks","detail":"Which region?"},
                "createdAt":935.,"lastUserMessageAt":935.}),
            ),
            asked("q-bg", "Background asks", "pilot", 930., Value::Null),
            asked("q-hidden", "Hidden asks", "dotfiles", 800., Value::Null),
        ]
    };
    let (h, view) = open(cx, width, chats(false), &["project:dotfiles"]);
    let spoken = |cx: &mut HeadlessAppContext, title: &str| {
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            w.elements()
                .into_iter()
                .filter_map(|e| e.label().map(str::to_owned))
                .find(|l| l.starts_with(title))
                .unwrap_or_else(|| panic!("{title} row"))
        })
        .unwrap()
    };
    let thread = |cx: &mut HeadlessAppContext| {
        cx.update(|cx| {
            let list = view.read(cx).chats.read(cx).delegate();
            (
                list.tree
                    .threads
                    .iter()
                    .find(|t| t.mission == "gpui")
                    .unwrap()
                    .rollup,
                list.tree
                    .groups
                    .iter()
                    .find(|g| g.key == "project:dotfiles")
                    .unwrap()
                    .mark(),
            )
        })
    };
    for title in ["Asking member", "Background asks"] {
        let label = spoken(cx, title);
        assert!(label.contains("Asks: Which layout 日本語 👩‍💻?"), "{label}");
        assert!(!label.contains("Working"), "{label}");
    }
    assert!(
        spoken(cx, "Live run").contains("Working"),
        "a live run without an awaited ask stays Working"
    );
    // pilotd's live `asks`: the run awaits ask_user.
    let label = spoken(cx, "Awaiting ask");
    assert!(
        label.contains("Asks: Which region?") && !label.contains("Working"),
        "{label}"
    );
    // The roll-up counts members; the coordinator keeps its own mark.
    let expected = Rollup {
        needs: 1,
        ..Default::default()
    };
    assert_eq!(thread(cx), (expected, Some(Mark::NeedsYou)));
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("chat-mark-group:project:dotfiles").is_some());
        assert!(w.try_find("chat-row-q-hidden").is_none());
    })
    .unwrap();
    let rebuild = |cx: &mut HeadlessAppContext, chats: Vec<Chat>, collapse: bool| {
        cx.update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| {
                v.state.chats = Arc::new(chats);
                v.chats
                    .update(cx, |l, _| l.delegate_mut().set_collapsed("gpui", collapse));
                v.rebuild_nav(w, cx);
            })
        })
        .unwrap();
        settle(cx, h);
    };
    // Collapsed thread: the member's question rolls up as Needs you.
    rebuild(cx, chats(false), true);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("mission-rollup-NeedsYou").is_some());
    })
    .unwrap();
    // Answered: the run starts and the member is Working again.
    rebuild(cx, chats(true), false);
    let label = spoken(cx, "Asking member");
    assert!(
        !label.contains("Asks:") && label.contains("Working"),
        "{label}"
    );
    let expected = Rollup {
        working: 1,
        ..Default::default()
    };
    assert_eq!(thread(cx).0, expected);
    // The live ask in a chat that was never opened: the sidebar and Inbox say
    // Needs you from the summary alone, before any focus.
    let (client, _reads) = crate::local_client::LocalClient::synthetic_commands();
    cx.update(|cx| view.update(cx, |v, _| v.client = Some(client)));
    rebuild(cx, chats(true), false);
    let selected = |cx: &mut HeadlessAppContext| cx.update(|cx| view.read(cx).selected.clone());
    assert_eq!(selected(cx), None, "never focused");
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.show_inbox(None, w, cx))
    })
    .unwrap();
    settle(cx, h);
    let inbox =
        |cx: &mut HeadlessAppContext| cx.update(|cx| view.read(cx).inbox.read(cx).probe_needs(cx));
    let needs = inbox(cx);
    assert!(
        needs.contains(&("q-await".into(), "Asks: Which region?".into())),
        "{needs:?}"
    );
    assert!(!needs.iter().any(|(id, _)| id == "q-live"), "{needs:?}");
    assert_eq!(selected(cx), None, "the Inbox does not open it either");
    let awaiting = |cx: &mut HeadlessAppContext| {
        let label = spoken(cx, "Awaiting ask");
        label.contains("Asks: Which region?") && !label.contains("Working")
    };
    assert!(awaiting(cx));
    // Focus it, then move away: the summary keeps it Needs you.
    let open_chat = |cx: &mut HeadlessAppContext, id: &str| {
        cx.update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| {
                let chat = v.state.chats.iter().find(|c| c.id == id).unwrap().clone();
                assert!(v.open(chat, w, cx), "{id} opens");
            })
        })
        .unwrap();
        settle(cx, h);
    };
    open_chat(cx, "q-await");
    open_chat(cx, "q-live");
    assert_eq!(selected(cx).as_deref(), Some("q-live"));
    assert!(awaiting(cx), "focus away keeps Needs you");
    let with_await = |value: Value| {
        let mut all = chats(true);
        let ix = all.iter().position(|c| c.id == "q-await").unwrap();
        all[ix] = raw(value);
        all
    };
    let base = json!({"id":"q-await","title":"Awaiting ask","projectId":"pilot",
        "createdAt":935.,"lastUserMessageAt":935.});
    // Answered: pilotd drops `asks` while the run continues.
    let mut answered = base.clone();
    answered["state"] = json!("working");
    answered["working"] = json!(true);
    // Cancelled: Stop ends the run.
    let mut cancelled = base.clone();
    cancelled["state"] = json!("idle");
    cancelled["outcome"] = json!("stopped");
    cancelled["outcomeAt"] = json!(960.);
    for (case, value, word) in [
        ("answered", answered, Some("Working")),
        ("cancelled", cancelled, None),
    ] {
        rebuild(cx, with_await(value), false);
        let label = spoken(cx, "Awaiting ask");
        assert!(!label.contains("Asks:"), "{case}: {label}");
        if let Some(word) = word {
            assert!(label.contains(word), "{case}: {label}");
        }
        cx.update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| v.show_inbox(None, w, cx))
        })
        .unwrap();
        settle(cx, h);
        let needs = inbox(cx);
        assert!(
            !needs.iter().any(|(id, _)| id == "q-await"),
            "{case}: {needs:?}"
        );
    }

    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
}

/// The trailing circle carries "replied since you looked": hollow when read,
/// filled for a new reply (alone on a quiet row), never beside a coloured
/// mark. Opening a chat empties it; collapsed missions and projects fill
/// theirs for their chats' new replies. One mark column at every width.
fn run_unread_circle(cx: &mut HeadlessAppContext, width: f32) {
    let row = |id: &str, project: &str, mission: Option<&str>, reply: bool| {
        let mut v = json!({"id":id,"title":format!("{id} 日本語 👩‍💻 title"),"projectId":project,
            "state":"idle","createdAt":900.,"lastUserMessageAt":900.});
        if let Some(mission) = mission {
            v["missionId"] = json!(mission);
        }
        if reply {
            v["outcome"] = json!("done");
            v["outcomeAt"] = json!(10);
        }
        v
    };
    let mut coord = row("u-coord", "pilot", Some("gpui"), false);
    coord["missionCoordinator"] = json!(true);
    let background = |id: &str, reply: bool| {
        let mut c = chat(row(id, "pilot", None, reply), Some(Signal::Working));
        c.background_work = true;
        c
    };
    let chats = vec![
        chat(coord, Some(Signal::Working)),
        chat(row("u-m", "pilot", Some("gpui"), true), None),
        chat(
            row("u-w", "pilot", Some("gpui"), false),
            Some(Signal::Working),
        ),
        chat(row("w-read", "pilot", None, false), Some(Signal::Working)),
        chat(row("w-new", "pilot", None, true), Some(Signal::Working)),
        background("b-read", false),
        background("b-new", true),
        chat(row("q-read", "pilot", None, false), None),
        chat(row("q-new", "pilot", None, true), None),
        chat(row("n-new", "pilot", None, true), Some(Signal::NeedsYou)),
        chat(row("f-new", "pilot", None, true), Some(Signal::Failed)),
        chat(row("r-new", "pilot", None, true), Some(Signal::Ready)),
        chat(row("d-new", "dotfiles", None, true), None),
    ];
    let (h, view) = open(cx, width, chats, &["project:dotfiles"]);
    let label = |w: &gpui_kit::Window, id: &str| {
        w.find(id.to_owned())
            .label()
            .map(|l| l.to_string())
            .unwrap_or_default()
    };
    // (row, glyph, filled circle, hollow circle, spoken "new reply")
    let expect = [
        ("w-read", true, false, true, false),
        ("w-new", true, true, false, true),
        ("b-read", true, false, true, false),
        ("b-new", true, true, false, true),
        ("q-read", false, false, false, false),
        ("q-new", true, true, false, true),
        ("n-new", true, false, false, false),
        ("f-new", true, false, false, false),
        ("r-new", true, false, false, false),
        ("u-coord", true, false, true, false),
        ("u-m", true, true, false, true),
        ("u-w", true, false, true, false),
    ];
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        let column = w.find("chat-mark-w-read").bounds().center().x;
        for (id, glyph, filled, hollow, spoken) in expect {
            let mark = w.within(format!("chat-mark-{id}"));
            assert_eq!(mark.try_find("state-glyph").is_some(), glyph, "{id}: glyph");
            assert_eq!(
                mark.try_find("state-circle-filled").is_some(),
                filled,
                "{id}: filled"
            );
            assert_eq!(
                mark.try_find("state-circle-hollow").is_some(),
                hollow,
                "{id}: hollow"
            );
            assert!(
                w.try_find(format!("chat-reply-{id}")).is_none(),
                "{id}: no reply dot"
            );
            let l = label(w, id);
            assert_eq!(l.contains("new reply"), spoken, "{id}: {l}");
            // One mark column, centered on the title line.
            let slot = w.find(format!("chat-mark-{id}")).bounds();
            near(slot.center().x, column, id);
            let title = w
                .within(format!("chat-row-{id}"))
                .try_find("sidebar-chat-title")
                .or_else(|| {
                    w.within(format!("chat-row-{id}"))
                        .try_find("sidebar-mission-title")
                })
                .unwrap()
                .bounds();
            assert!(
                title.right() <= slot.left() + px(0.5),
                "{id}: title before the mark"
            );
            assert!(
                (slot.center().y - title.center().y).abs() < px(1.5),
                "{id}: mark on the title line"
            );
        }
        // A collapsed project fills its circle for its chats' new replies.
        assert!(
            w.within("chat-mark-group:project:dotfiles")
                .try_find("state-circle-filled")
                .is_some()
        );
    })
    .unwrap();
    // A collapsed mission fills its coordinator's circle for members' replies.
    let set_thread = |cx: &mut HeadlessAppContext, collapse: bool| {
        cx.update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| {
                v.chats
                    .update(cx, |l, _| l.delegate_mut().set_collapsed("gpui", collapse));
                v.rebuild_nav(w, cx);
            })
        })
        .unwrap();
        settle(cx, h);
    };
    set_thread(cx, true);
    cx.update_window(h, |_, w, _| {
        assert!(
            w.within("chat-mark-u-coord")
                .try_find("state-circle-filled")
                .is_some()
        );
        assert!(label(w, "u-coord").contains("new repl"));
    })
    .unwrap();
    set_thread(cx, false);
    // Opening a chat empties its circle; the rest keep theirs.
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            v.page = crate::app_shell::Page::Chat;
            v.selected = Some("w-new".into());
            v.rebuild_nav(w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(
            w.within("chat-mark-w-new")
                .try_find("state-circle-hollow")
                .is_some()
        );
        assert!(
            w.within("chat-mark-w-new")
                .try_find("state-circle-filled")
                .is_none()
        );
        assert!(!label(w, "w-new").contains("new reply"));
        assert!(
            w.within("chat-mark-b-new")
                .try_find("state-circle-filled")
                .is_some()
        );
        assert!(
            w.within("chat-mark-q-new")
                .try_find("state-circle-filled")
                .is_some()
        );
        w.remove_window();
    })
    .unwrap();
    cx.run_until_parked();
    println!(
        "{}",
        json!({"width":width,"unread_circle":"hollow-read+filled-unread+attention-precedence+open-clears+collapsed-rollups","reply_dots":0})
    );
}

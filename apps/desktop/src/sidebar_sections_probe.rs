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
    AnyWindowHandle, AppContext, Bounds, Entity, HeadlessAppContext, Pixels, WindowBounds,
    WindowOptions,
    component::{Theme, ThemeMode},
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
            settle(cx, h);
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
            settle(cx, h);
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
        }
    }
    run_many(cx, captures.as_deref());
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

//! Quiet entry points. Existing navigation, list and reader owners keep authority.
use super::*;
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};

impl LocalViewer {
    fn set_archived(
        &mut self,
        scope: &Option<String>,
        value: bool,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if &self.project_scope != scope || !self.project_choices_ready(w, cx) {
            return;
        }
        self.chats.update(cx, |list, cx| {
            let selected = list
                .delegate()
                .selected
                .and_then(|ix| list.delegate().at(ix))
                .map(|c| c.id.clone());
            list.delegate_mut().archived = value;
            list.delegate_mut().filter();
            let ix = selected.and_then(|id| list.delegate().index(&id));
            list.set_selected_index(ix, w, cx);
            cx.notify();
        });
        self.save_scope(cx);
        cx.notify();
    }
    pub(super) fn chat_filter(&self, cx: &Context<Self>) -> impl IntoElement {
        let weak = cx.weak_entity();
        let scope = self.project_scope.clone();
        let archived = self.chats.read(cx).delegate().archived;
        div()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if !v.project_choices_ready(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(
                crate::ui::icon_action(
                    "chat-filters",
                    "Chat filters",
                    AppIcon::Filter,
                    crate::ui::Action::Quiet,
                )
                .size_8()
                .selected(archived)
                .dropdown_menu(move |menu, _, _| {
                    let weak = weak.clone();
                    let scope = scope.clone();
                    menu.item(
                        PopupMenuItem::new("Include archived")
                            .checked(archived)
                            .on_click(move |_, w, cx| {
                                let _ = weak
                                    .update(cx, |v, cx| v.set_archived(&scope, !archived, w, cx));
                            }),
                    )
                }),
            )
    }
    pub(super) fn history_menu(&self, cx: &Context<Self>) -> impl IntoElement {
        let weak = cx.weak_entity();
        let source = self.selected.clone();
        let generation = self.generation;
        let older = self.state.cursor.is_some()
            && !self.state.page_busy
            && !self.refreshing
            && self.earlier_request.is_none();
        // Make a mission… lives here (and in the chat row menu), not as a permanent button.
        let can_mission = self.can_make_mission(cx);
        // The header always names the selected chat; copy only its cached summary.
        let copy = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .cloned();
        let mission_label = if self
            .selected
            .as_ref()
            .is_some_and(|id| self.mission.read(cx).has_attempt(id))
        {
            "Mission…"
        } else {
            "Make a mission…"
        };
        div()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if !v.project_choices_ready(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(
                crate::ui::icon_action(
                    "history-menu",
                    "More",
                    AppIcon::More,
                    crate::ui::Action::Quiet,
                )
                .dropdown_menu(move |menu, _, _| {
                    let a = weak.clone();
                    let old_source = source.clone();
                    let b = weak.clone();
                    let new_source = source.clone();
                    let c = weak.clone();
                    menu.item(
                        PopupMenuItem::new("Load earlier messages")
                            .disabled(!older)
                            .on_click(move |_, w, cx| {
                                let _ = a.update(cx, |v, cx| {
                                    if v.selected == old_source
                                        && v.generation == generation
                                        && v.project_choices_ready(w, cx)
                                    {
                                        v.earlier(true, cx);
                                    }
                                });
                            }),
                    )
                    .item(
                        PopupMenuItem::new("Return to latest").on_click(move |_, w, cx| {
                            let _ = b.update(cx, |v, cx| {
                                if v.selected == new_source
                                    && v.generation == generation
                                    && v.project_choices_ready(w, cx)
                                {
                                    v.latest(cx);
                                }
                            });
                        }),
                    )
                    .item(
                        PopupMenuItem::new(mission_label)
                            .disabled(!can_mission)
                            .on_click(move |_, w, cx| {
                                let _ = c.update(cx, |v, cx| v.open_mission(w, cx));
                            }),
                    )
                    .map(|menu| crate::session_clipboard::items(menu, copy.as_ref()))
                }),
            )
    }
}
/// Open the header … menu and choose Make a mission… through the real native menu.
#[cfg(feature = "native-probes")]
pub(super) fn probe_make_mission(
    cx: &mut gpui_kit::HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
) {
    use gpui_kit::test::TestWindowExt;
    let settle = |cx: &mut gpui_kit::HeadlessAppContext| {
        for _ in 0..3 {
            cx.run_until_parked();
            cx.advance_clock(std::time::Duration::from_millis(16));
            cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
        }
    };
    cx.update_window(h, |_, w, cx| w.click("history-menu", cx))
        .unwrap();
    settle(cx);
    cx.update_window(h, |_, w, cx| w.within("popup-menu").click(2usize, cx))
        .unwrap();
    settle(cx);
    // A guarded (disabled) choice leaves the menu open; dismiss it like a user would.
    if cx
        .update_window(h, |_, w, _| w.try_find("popup-menu").is_some())
        .unwrap()
    {
        cx.update_window(h, |_, w, cx| w.press("escape", cx))
            .unwrap();
        settle(cx);
    }
}
impl LocalViewer {
    pub(super) fn sync_history_controls(&mut self, cx: &mut Context<Self>) {
        let presentation = crate::transcript_view::HistoryControls {
            behind: self.state.behind,
            refreshing: self.refreshing,
            failed: self.refreshing && self.state.chat_issue,
            recovery: self.nav_error.is_some(),
        };
        self.transcript
            .update(cx, |v, cx| v.set_history_controls(presentation, cx));
    }
}
/// Exercise the real native menu, including dismissal and its normal item names.
#[cfg(feature = "native-probes")]
pub(super) fn probe_menu_choice(
    cx: &mut gpui_kit::HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    trigger: &'static str,
    item: usize,
    keyboard: bool,
) {
    use gpui_kit::test::TestWindowExt;
    fn settle(cx: &mut gpui_kit::HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
        for _ in 0..3 {
            cx.run_until_parked();
            cx.advance_clock(std::time::Duration::from_millis(16));
            cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
        }
    }
    cx.update_window(h, |_, w, cx| w.click(trigger, cx))
        .unwrap();
    settle(cx, h);
    let (width, dark, active) = cx
        .update_window(h, |_, w, cx| {
            let menu = w.find("popup-menu");
            let bounds = menu.bounds();
            assert!(
                bounds.left() >= px(0.)
                    && bounds.top() >= px(0.)
                    && bounds.right() <= w.viewport_size().width
                    && bounds.bottom() <= w.viewport_size().height,
                "history/filter menu must fit: {bounds:?}"
            );
            assert!(
                w.within("popup-menu").find(item).label().is_some(),
                "native menu item retains its name"
            );
            (
                f32::from(w.viewport_size().width) as u32,
                cx.theme().is_dark(),
                w.try_find("archives-active").is_some(),
            )
        })
        .unwrap();
    if let Some(dir) = std::env::var_os("PILOT_NEXT_CONTEXTUAL_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(format!(
                "{width}-{}-{trigger}-{item}-{}.png",
                if dark { "dark" } else { "light" },
                if active { "active" } else { "plain" }
            )))
            .unwrap();
    }
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    if keyboard {
        // Escape restores the dropdown's trigger scope. Tab reaches the actual
        // native button inside that scope before keyboard activation.
        for _ in 0..48 {
            if cx
                .update_window(h, |_, w, _| w.find(trigger).focused() == Some(true))
                .unwrap()
            {
                break;
            }
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            settle(cx, h);
        }
        cx.update_window(h, |_, w, _| {
            assert_eq!(w.find(trigger).focused(), Some(true))
        })
        .unwrap();
    }
    cx.update_window(h, |_, w, cx| {
        assert!(w.try_find("popup-menu").is_none());
        if keyboard {
            w.press("enter", cx);
        } else {
            w.click(trigger, cx);
        }
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(
            w.try_find("popup-menu").is_some(),
            "keyboard must open the menu before item navigation"
        )
    })
    .unwrap();
    if keyboard {
        // Reopening can retain a hover-selected row. Drive the real highlight,
        // rather than assuming the menu always starts without a selection.
        for _ in 0..3 {
            if cx
                .update_window(h, |_, w, _| {
                    w.within("popup-menu").find(item).selected() == Some(true)
                })
                .unwrap()
            {
                break;
            }
            cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
            settle(cx, h);
        }
        cx.update_window(h, |_, w, cx| {
            let row = w.within("popup-menu").find(item);
            assert_eq!(row.selected(), Some(true));
            assert_ne!(row.disabled(), Some(true));
            w.press("enter", cx);
        })
        .unwrap();
    } else {
        cx.update_window(h, |_, w, cx| w.within("popup-menu").click(item, cx))
            .unwrap();
    }
    settle(cx, h);
    cx.update_window(h, |_, w, _| assert!(w.try_find("popup-menu").is_none()))
        .unwrap();
}
#[cfg(test)]
#[path = "history_latest_tests.rs"]
mod history_latest_tests;
#[cfg(test)]
#[path = "session_clipboard_view_tests.rs"]
mod session_clipboard_view_tests;
#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{EntityInputHandler, TestAppContext, WindowOptions};
    fn setup(cx: &mut TestAppContext) -> (gpui_kit::AnyWindowHandle, Entity<LocalViewer>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
            LocalViewer::bind_keys(cx);
        });
        cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    show: false,
                    ..Default::default()
                },
                cx,
                |w, cx| cx.new(|cx| LocalViewer::preview(PreviewState::Conversation, w, cx)),
            )
            .unwrap()
        })
    }
    #[gpui_kit::test]
    fn native_filter_menu_has_tab_enter_and_escape_path(cx: &mut TestAppContext) {
        use gpui_kit::test::TestWindowExt;
        let (h, v) = setup(cx);
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            w.blur(cx);
            w.click("chat-filters", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            assert!(w.try_find("popup-menu").is_some());
            w.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        for _ in 0..48 {
            let focused = cx
                .update_window(h, |_, w, cx| {
                    w.render_frame(cx);
                    if w.find("chat-filters").focused() == Some(true) {
                        true
                    } else {
                        w.press("tab", cx);
                        false
                    }
                })
                .unwrap();
            cx.run_until_parked();
            if focused {
                break;
            }
        }
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            assert_eq!(w.find("chat-filters").focused(), Some(true));
            w.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            assert!(w.try_find("popup-menu").is_some());
            w.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        v.read_with(cx, |v, cx| assert!(!v.chats.read(cx).delegate().archived));
    }
    #[gpui_kit::test]
    fn menu_dismissal_keeps_focus_moved_to_another_input(cx: &mut TestAppContext) {
        use gpui_kit::{Focusable, test::TestWindowExt};
        let (h, v) = setup(cx);
        let query = v.read_with(cx, |v, cx| v.chats.read(cx).query_input());
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            w.click("chat-filters", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            assert!(w.try_find("popup-menu").is_some());
            query.update(cx, |q, cx| q.focus(w, cx));
            w.within("popup-menu").click(0usize, cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            assert!(w.try_find("popup-menu").is_none());
            assert!(query.read(cx).focus_handle(cx).is_focused(w));
        })
        .unwrap();
        v.read_with(cx, |v, cx| assert!(v.chats.read(cx).delegate().archived));
    }
    #[gpui_kit::test]
    fn archive_filter_preserves_canonical_selection_and_refuses_stale_scope_or_preedit(
        cx: &mut TestAppContext,
    ) {
        let (h, v) = setup(cx);
        cx.update_window(h,|_,w,cx|v.update(cx,|v,cx|{
            v.state.chats=Arc::new(vec![crate::local_model::chat(&serde_json::json!({"id":"archived","title":"Archived","archivedAt":1,"state":"idle"})).unwrap(),crate::local_model::chat(&serde_json::json!({"id":"active","title":"Active","state":"idle"})).unwrap()]);v.rebuild_nav(w,cx);
            v.chats.update(cx,|l,cx|{let ix=l.delegate().index("active");l.set_selected_index(ix,w,cx)});
            let selected=v.selected.clone();let transcript=v.transcript.clone();let editor=v.editor.clone();
            v.set_archived(&None,true,w,cx);
            let l=v.chats.read(cx);assert_eq!(l.delegate().at(l.delegate().selected.unwrap()).unwrap().id,"active");
            assert_eq!(v.selected,selected);assert_eq!(v.transcript,transcript);assert_eq!(v.editor,editor);
            assert!(!v.navigation.can_move(false)&&!v.navigation.can_move(true),"a filter must not create a history entry");
            v.set_archived(&Some("stale".into()),false,w,cx);assert!(v.chats.read(cx).delegate().archived);
            let query=v.chats.read(cx).query_input();query.update(cx,|q,cx|q.replace_and_mark_text_in_range(None,"にほん",Some(3..3),w,cx));
            v.set_archived(&None,false,w,cx);assert!(v.chats.read(cx).delegate().archived);assert!(query.update(cx,|q,cx|q.marked_text_range(w,cx).is_some()));
        })).unwrap();
    }
    #[gpui_kit::test]
    fn latest_event_keeps_generation_fences_and_behind_reload_semantics(cx: &mut TestAppContext) {
        let (_, v) = setup(cx);
        let (client, reads) = LocalClient::synthetic_commands();
        v.update(cx, |v, cx| {
            v.client = Some(client);
            v.state.behind = true;
            v.selected = Some("source".into());
            v.generation = 10;
            v.transcript.update(cx, |_, cx| {
                cx.emit(crate::transcript_view::LatestRequested(9))
            });
        });
        cx.run_until_parked();
        assert!(reads.is_empty());
        v.update(cx, |v, cx| {
            v.transcript.update(cx, |_, cx| {
                cx.emit(crate::transcript_view::LatestRequested(10))
            })
        });
        cx.run_until_parked();
        assert!(matches!(reads.try_recv(),Ok(Command::Open{id,generation:11})if id=="source"));
        assert!(reads.is_empty());
        v.read_with(cx, |v, _| assert!(v.refreshing));
    }
    #[gpui_kit::test]
    fn sidebar_threads_missions_in_your_order_and_keeps_selection_across_live_updates(
        cx: &mut TestAppContext,
    ) {
        use gpui_kit::test::TestWindowExt;
        use serde_json::json;
        let (h, v) = setup(cx);
        let chats = |values: Vec<serde_json::Value>| {
            let mut chats: Vec<_> = values
                .iter()
                .map(|v| crate::local_model::chat(v).unwrap())
                .collect();
            crate::chat_order::sort(&mut chats);
            Arc::new(chats)
        };
        let base = || {
            vec![
                json!({"id":"recent-old","title":"Recent old","state":"idle","createdAt":10}),
                json!({"id":"recent-new","title":"Recent new","state":"idle","createdAt":90}),
                json!({"id":"question","title":"Question","state":"idle","outcome":"question","outcomeAt":20,"createdAt":20}),
                json!({"id":"failed","title":"Failed","state":"failed","createdAt":5}),
                json!({"id":"coord","title":"Coordinator chat","state":"working","missionCoordinator":true,"missionId":"m1","createdAt":50}),
                json!({"id":"member-a","title":"Member A","state":"working","missionId":"m1","createdAt":51}),
                json!({"id":"member-b","title":"Member B","state":"idle","missionId":"m1","createdAt":52}),
                json!({"id":"pinned","title":"Pinned","state":"idle","pinned":true}),
                json!({"id":"archived","title":"Archived","state":"idle","archivedAt":3}),
            ]
        };
        let top = |w: &Window, id: &str| w.find(SharedString::from(id.to_owned())).bounds().top();
        let selected_id = |v: &LocalViewer, cx: &App| {
            let l = v.chats.read(cx).delegate();
            l.selected.and_then(|ix| l.key_at(ix))
        };
        let order = [
            "sidebar-section-pinned",
            "chat-row-pinned",
            "sidebar-section-chats",
            "chat-row-recent-new",
            "chat-row-coord",
            "chat-row-member-a",
            "chat-row-fold:m1",
            "chat-row-question",
            "chat-row-recent-old",
            "chat-row-failed",
        ];
        let assert_order = |w: &Window| {
            for pair in order.windows(2) {
                assert!(
                    top(w, pair[0]) < top(w, pair[1]),
                    "{} above {}",
                    pair[0],
                    pair[1]
                );
            }
        };
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                v.state.chats = chats(base());
                v.rebuild_nav(w, cx);
                v.chats.update(cx, |l, cx| {
                    let ix = l.delegate().index("question");
                    l.set_selected_index(ix, w, cx)
                });
            });
            w.render_frame(cx);
            assert_order(w);
            // Members are one line under their mission; finished ones fold.
            assert!(
                w.find("chat-row-member-a").bounds().size.height
                    < w.find("chat-row-coord").bounds().size.height
            );
            assert!(
                w.find("chat-row-member-a").bounds().left()
                    == w.find("chat-row-coord").bounds().left()
            );
            for absent in [
                "sidebar-section-drafts",
                "sidebar-section-needs-you",
                "sidebar-section-working",
                "sidebar-section-archived",
                "chat-row-archived",
                "chat-row-member-b",
            ] {
                assert!(w.try_find(absent).is_none(), "{absent} is hidden");
            }
        })
        .unwrap();
        let (opened, transcript, editor) = v.read_with(cx, |v, _| {
            (v.selected.clone(), v.transcript.clone(), v.editor.clone())
        });
        // Agent activity: the selected question starts working (an automatic
        // notice stamps lastUserMessageAt), an old chat finishes and the
        // coordinator fails. Nothing moves; selection follows the id.
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                let mut next = base();
                next[2] = json!({"id":"question","title":"Question","state":"working","updatedAt":200,"lastUserMessageAt":199,"createdAt":20});
                next[0] = json!({"id":"recent-old","title":"Recent old","state":"idle","outcome":"done","outcomeAt":150,"createdAt":10});
                next[4] = json!({"id":"coord","title":"Coordinator chat","state":"failed","missionCoordinator":true,"missionId":"m1","createdAt":50,"lastUserMessageAt":300});
                v.state.chats = chats(next);
                v.rebuild_nav(w, cx);
                assert_eq!(selected_id(v, cx).as_deref(), Some("question"));
            });
            w.render_frame(cx);
            assert_order(w);
        })
        .unwrap();
        v.read_with(cx, |v, _| {
            assert_eq!(v.selected, opened);
            assert_eq!(v.transcript, transcript);
            assert_eq!(v.editor, editor);
        });
        // Left/Right through the search field: collapse, expand, child, parent.
        let select = |cx: &mut TestAppContext, key: &str| {
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.chats.update(cx, |l, cx| {
                        let ix = l.delegate().index(key);
                        l.set_selected_index(ix, w, cx);
                        l.focus(w, cx);
                    })
                });
                w.render_frame(cx);
            })
            .unwrap();
        };
        let press = |cx: &mut TestAppContext, key: &str| {
            cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
            cx.run_until_parked();
            cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
        };
        let shown = |cx: &mut TestAppContext, id: &str| {
            cx.update_window(h, |_, w, _| {
                w.try_find(SharedString::from(id.to_owned())).is_some()
            })
            .unwrap()
        };
        select(cx, "coord");
        press(cx, "left");
        assert!(!shown(cx, "chat-row-member-a"), "Left collapses the thread");
        v.read_with(cx, |v, cx| {
            assert_eq!(selected_id(v, cx).as_deref(), Some("coord"))
        });
        cx.update_window(h, |_, w, _| {
            assert!(
                w.try_find("mission-rollup-Working").is_some(),
                "a collapsed parent rolls up its members"
            );
        })
        .unwrap();
        press(cx, "right");
        assert!(shown(cx, "chat-row-member-a"), "Right expands it");
        press(cx, "right");
        v.read_with(cx, |v, cx| {
            assert_eq!(selected_id(v, cx).as_deref(), Some("member-a"))
        });
        press(cx, "left");
        v.read_with(cx, |v, cx| {
            assert_eq!(selected_id(v, cx).as_deref(), Some("coord"))
        });
        // A standalone row passes the arrows on to the search field.
        select(cx, "question");
        press(cx, "left");
        v.read_with(cx, |v, cx| {
            assert_eq!(selected_id(v, cx).as_deref(), Some("question"))
        });
        // Enter on the fold shows finished members; Enter again hides them.
        select(cx, "fold:m1");
        press(cx, "enter");
        assert!(shown(cx, "chat-row-member-b"));
        press(cx, "enter");
        assert!(!shown(cx, "chat-row-member-b"));
        // Opening a member of a collapsed thread expands it and shows the member.
        select(cx, "coord");
        press(cx, "left");
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                v.page = crate::app_shell::Page::Chat;
                v.selected = Some("member-b".into());
                v.rebuild_nav(w, cx);
            });
            w.render_frame(cx);
            assert!(w.try_find("chat-row-member-b").is_some());
            assert!(w.try_find("chat-row-member-a").is_some());
        })
        .unwrap();
        // The Archived filter adds its own section last, newest archive first.
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| v.set_archived(&None, true, w, cx));
            w.render_frame(cx);
            assert!(top(w, "chat-row-failed") < top(w, "sidebar-section-archived"));
            assert!(top(w, "sidebar-section-archived") < top(w, "chat-row-archived"));
        })
        .unwrap();
    }
}

//! Explicit per-draft Local project choice. No path-to-project inference.
use super::*;
use crate::{
    local_model::Project,
    ui::{FieldRow, Notice, Tone},
};
use gpui_kit::StatefulInteractiveElement;
use gpui_kit::component::FocusableExt;
use gpui_kit::component::select::{SearchableVec, Select, SelectEvent, SelectItem, SelectState};
use std::sync::Arc;

#[derive(Default)]
pub(super) struct Catalog {
    rows: Arc<Vec<Project>>,
    loaded: bool,
    error: Option<&'static str>,
}
#[derive(Clone)]
struct Choice {
    id: String,
    title: SharedString,
    unavailable: bool,
}
impl SelectItem for Choice {
    type Value = String;
    fn value(&self) -> &String {
        &self.id
    }
    fn title(&self) -> SharedString {
        self.title.clone()
    }
    fn disabled(&self) -> bool {
        self.unavailable
    }
    fn render(&self, _: &mut Window, _: &mut gpui_kit::App) -> impl IntoElement {
        let row = div()
            .id(SharedString::from(format!("new-project-{}", self.id)))
            .w_full()
            .min_w_0()
            .truncate()
            .aria_label(self.title.clone())
            .child(self.title.clone());
        #[cfg(any(test, feature = "native-probes"))]
        let row = row.test_support();
        row
    }
}
pub(super) struct Picker {
    source: String,
    state: Entity<SelectState<SearchableVec<Choice>>>,
    catalog: Arc<Vec<Project>>,
    selected: Option<String>,
    _subscriptions: Vec<Subscription>,
}
impl ChatEditor {
    #[cfg(feature = "native-probes")]
    pub(crate) fn project_query(&self, cx: &gpui_kit::App) -> Option<Entity<InputState>> {
        self.project_picker
            .as_ref()
            .map(|p| p.state.read(cx).query_input(cx))
    }
    pub(crate) fn projects(
        &mut self,
        rows: Arc<Vec<Project>>,
        loaded: bool,
        error: Option<&'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let changed = !Arc::ptr_eq(&rows, &self.project_catalog.rows)
            || loaded != self.project_catalog.loaded
            || error != self.project_catalog.error;
        self.project_catalog = Catalog {
            rows,
            loaded,
            error,
        };
        self.sync_project_picker(window, cx);
        if changed {
            cx.notify();
        }
    }
    pub(super) fn project_query_marked(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.project_picker.as_ref().is_some_and(|picker| {
            picker
                .state
                .read(cx)
                .query_input(cx)
                .update(cx, |q, cx| q.marked_text_range(window, cx).is_some())
        })
    }
    pub(super) fn retire_project_picker(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.project_picker.as_ref().is_none_or(|picker| {
            picker
                .state
                .update(cx, |p, cx| p.prepare_navigation(window, cx))
        })
    }
    pub(super) fn project_problem(&self, draft: &Draft) -> Option<&'static str> {
        if !self.project_catalog.loaded {
            return Some("Loading Local projects…");
        }
        if self.project_catalog.error.is_some() {
            return Some("Local projects are unavailable. Draft and selection are retained.");
        }
        let Some(id) = draft.project_id.as_ref() else {
            return Some(if self.project_catalog.rows.is_empty() {
                "No configured Local projects. Add a project in Pilot first."
            } else {
                "Choose a Local project before creating this chat."
            });
        };
        (!self
            .project_catalog
            .rows
            .iter()
            .any(|p| &p.id == id && p.path == draft.cwd))
        .then_some("The selected project or folder changed. Choose the project again.")
    }
    pub(super) fn sync_project_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = self.selected.clone().filter(|key| key.starts_with("new:")) else {
            self.project_picker = None;
            return;
        };
        let Some(draft) = self.cache.get(&key) else {
            return;
        };
        let selected = draft.project_id.clone();
        if self.project_picker.as_ref().is_none_or(|p| p.source != key) {
            let state = cx.new(|cx| {
                SelectState::new(SearchableVec::new(Vec::<Choice>::new()), None, window, cx)
                    .searchable(true)
            });
            let source = key.clone();
            let confirm = cx.subscribe_in(
                &state,
                window,
                move |view, _, event: &SelectEvent<SearchableVec<Choice>>, window, cx| {
                    if let SelectEvent::Confirm(Some(id)) = event {
                        view.choose_project(&source, id, window, cx);
                    }
                },
            );
            let query = state.read(cx).query_input(cx);
            let changed = cx.subscribe_in(&query, window, |view, _, event, window, cx| {
                if matches!(event, InputEvent::Change) {
                    view.sync_project_picker(window, cx);
                }
            });
            self.project_picker = Some(Picker {
                source: key,
                state,
                catalog: Arc::default(),
                selected: None,
                _subscriptions: vec![confirm, changed],
            });
        }
        if self.project_query_marked(window, cx) {
            return;
        }
        let picker = self.project_picker.as_mut().unwrap();
        if Arc::ptr_eq(&picker.catalog, &self.project_catalog.rows) && picker.selected == selected {
            return;
        }
        let mut choices: Vec<_> = self
            .project_catalog
            .rows
            .iter()
            .map(|p| Choice {
                id: p.id.clone(),
                title: format!("{} · {}", p.name, p.id).into(),
                unavailable: false,
            })
            .collect();
        if let Some(id) = &selected
            && !choices.iter().any(|p| &p.id == id)
        {
            choices.push(Choice {
                id: id.clone(),
                title: format!("Project unavailable · {id}").into(),
                unavailable: true,
            });
        }
        picker.state.update(cx, |p, cx| {
            p.prepare_navigation(window, cx);
            p.set_items(SearchableVec::new(choices), window, cx);
            if let Some(id) = &selected {
                p.set_selected_value(id, window, cx);
            } else {
                p.set_selected_index(None, window, cx);
            }
        });
        picker.catalog = self.project_catalog.rows.clone();
        picker.selected = selected;
    }
    fn choose_project(
        &mut self,
        source: &str,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.selected.as_deref() != Some(source)
            || !self.ready()
            || !self.writable
            || self.waiting()
            || self.marked(window, cx)
            || !self.project_catalog.loaded
            || self.project_catalog.error.is_some()
            || !self.draft().is_some_and(Draft::editable)
            || self.project_picker.as_ref().is_none_or(|p| {
                p.source != source || !Arc::ptr_eq(&p.catalog, &self.project_catalog.rows)
            })
        {
            return;
        }
        let Some(project) = self
            .project_catalog
            .rows
            .iter()
            .find(|p| p.id == id)
            .cloned()
        else {
            return;
        };
        self.changed(cx); // Capture current native text before changing destination.
        let draft = self.cache.get_mut(source).unwrap();
        if draft.project_id.as_deref() == Some(id) && draft.cwd == project.path {
            return;
        }
        draft.project_id = Some(project.id);
        self.cwd
            .update(cx, |v, cx| v.set_value(project.path, window, cx));
        self.record_edit(true, cx);
        self.sync_project_picker(window, cx);
    }
    pub(super) fn project_field(
        &self,
        draft: &Draft,
        _window: &mut Window,
        _cx: &Context<Self>,
    ) -> impl IntoElement {
        let editable = self.ready()
            && self.writable
            && !self.waiting()
            && draft.editable()
            && self.project_catalog.loaded
            && !self.project_catalog.rows.is_empty()
            && self.project_catalog.error.is_none();
        let description = match &draft.project_id {
            Some(id) => format!("Local project {id} · {}", draft.cwd),
            None => {
                if draft.pending.is_some() {
                    "Existing delivery keeps its original destination.".into()
                } else {
                    "Choose a project. Its configured directory is used; chat permissions stay unchanged.".into()
                }
            }
        };
        div()
            .v_flex()
            .gap_1()
            .min_w_0()
            .children(self.project_picker.as_ref().map(|picker| {
                FieldRow::new(
                    "new-project-row",
                    "Project",
                    Select::new(&picker.state)
                        .id("new-chat-project")
                        .small()
                        .w_full()
                        .focus_ring(false)
                        .menu_max_h(px(260.))
                        .disabled(!editable)
                        .accessibility_label("New chat project")
                        .search_placeholder("Find a Local project…"),
                )
                .description(SharedString::from(description))
            }))
            .children(
                if draft.editable() {
                    self.project_problem(draft)
                } else {
                    None
                }
                .map(|error| {
                    Notice::new(error).tone(if self.project_catalog.loaded {
                        Tone::Warning
                    } else {
                        Tone::Quiet
                    })
                }),
            )
            .child(
                crate::ui::action(
                    "new-chat-add-project",
                    "Add project…",
                    crate::ui::Action::Quiet,
                )
                .on_click(_cx.listener(|_, _, _, cx| cx.emit(EditorEvent::AddProject))),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_editor::tests::setup;
    use gpui_kit::TestAppContext;
    fn rows() -> Arc<Vec<Project>> {
        Arc::new(vec![
            Project {
                id: "a".into(),
                name: "Same title 日本語".into(),
                path: "/tmp/shared".into(),
            },
            Project {
                id: "ab".into(),
                name: "Same title 日本語".into(),
                path: "/tmp/shared".into(),
            },
        ])
    }
    #[gpui_kit::test]
    fn explicit_project_identity_preserves_live_text_and_legacy_cwd_never_infers_choice(
        cx: &mut TestAppContext,
    ) {
        let (handle, editor, commands) = setup(cx);
        cx.update_window(handle, |_, w, cx| {
            editor.update(cx, |e, cx| {
                e.projects(rows(), true, None, w, cx);
                e.new_draft("/tmp/shared".into(), w, cx);
                let key = e.selected.clone().unwrap();
                e.text
                    .update(cx, |t, cx| t.set_value("Uncaptured 私 👩‍💻", w, cx));
                assert!(e.draft().unwrap().project_id.is_none());
                e.submit(false, w, cx);
                assert!(commands.try_recv().is_err());
                e.choose_project(&key, "ab", w, cx);
                assert_eq!(e.draft().unwrap().project_id.as_deref(), Some("ab"));
                assert_eq!(e.draft().unwrap().cwd, "/tmp/shared");
                assert_eq!(e.draft().unwrap().text, "Uncaptured 私 👩‍💻");
                e.select("chat:a".into(), true, false, w, cx);
                e.select(key.clone(), true, false, w, cx);
                assert_eq!(
                    e.project_picker
                        .as_ref()
                        .unwrap()
                        .state
                        .read(cx)
                        .selected_value()
                        .map(String::as_str),
                    Some("ab")
                );
                e.submit(false, w, cx);
            })
        })
        .unwrap();
        let WriteCommand::Submit { draft, .. } = commands.try_recv().unwrap() else {
            panic!("one explicit create")
        };
        assert_eq!(draft.project_id.as_deref(), Some("ab"));
        assert!(commands.try_recv().is_err());
    }
    #[gpui_kit::test]
    fn removed_or_changed_catalog_blocks_send_until_explicit_reselection(cx: &mut TestAppContext) {
        let (handle, editor, commands) = setup(cx);
        cx.update_window(handle, |_, w, cx| {
            editor.update(cx, |e, cx| {
                e.projects(rows(), true, None, w, cx);
                e.new_draft(String::new(), w, cx);
                let key = e.selected.clone().unwrap();
                e.choose_project(&key, "ab", w, cx);
                e.text.update(cx, |t, cx| t.set_value("Keep me", w, cx));
                let mut changed = (*rows()).clone();
                changed[1].path = "/tmp/moved".into();
                e.projects(Arc::new(changed), true, None, w, cx);
                assert_eq!(e.draft().unwrap().cwd, "/tmp/shared");
                e.submit(false, w, cx);
                assert!(commands.try_recv().is_err());
                e.choose_project(&key, "ab", w, cx);
                assert_eq!(e.draft().unwrap().cwd, "/tmp/moved");
                assert!(e.project_problem(e.draft().unwrap()).is_none());
                e.projects(Arc::default(), true, None, w, cx);
                e.submit(false, w, cx);
                assert!(commands.try_recv().is_err());
                assert_eq!(e.draft().unwrap().project_id.as_deref(), Some("ab"));
                assert_eq!(e.draft().unwrap().text, "Keep me");
                e.projects(rows(), false, None, w, cx);
                assert!(
                    e.project_problem(e.draft().unwrap())
                        .unwrap()
                        .starts_with("Loading")
                );
                e.projects(rows(), true, Some("Disconnected"), w, cx);
                e.submit(false, w, cx);
                assert!(commands.try_recv().is_err());
            })
        })
        .unwrap();
    }
    #[gpui_kit::test]
    fn old_picker_events_cannot_retarget_new_draft_and_pending_cannot_change_project(
        cx: &mut TestAppContext,
    ) {
        let (handle, editor, commands) = setup(cx);
        let old = cx
            .update_window(handle, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.projects(rows(), true, None, w, cx);
                    e.new_draft(String::new(), w, cx);
                    let old = e.project_picker.as_ref().unwrap().state.clone();
                    e.text.update(cx, |t, cx| t.set_value("Retain old", w, cx));
                    e.changed(cx);
                    e.new_draft(String::new(), w, cx);
                    old
                })
            })
            .unwrap();
        cx.update_window(handle, |_, _, cx| {
            old.update(cx, |_, cx| cx.emit(SelectEvent::Confirm(Some("ab".into()))))
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, w, cx| {
            editor.update(cx, |e, cx| {
                assert!(e.draft().unwrap().project_id.is_none());
                let key = e.selected.clone().unwrap();
                e.choose_project(&key, "a", w, cx);
                e.cache.get_mut(&key).unwrap().pending = Some("unknown-operation".into());
                e.choose_project(&key, "ab", w, cx);
                assert_eq!(e.draft().unwrap().project_id.as_deref(), Some("a"));
                assert!(commands.try_recv().is_err());
            })
        })
        .unwrap();
    }
    #[gpui_kit::test]
    fn catalog_recovery_without_edit_or_destination_change_allows_one_submit(
        cx: &mut TestAppContext,
    ) {
        for (loaded, error) in [(false, None), (true, Some("Synthetic catalog error"))] {
            let (handle, editor, commands) = setup(cx);
            cx.update_window(handle, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.projects(rows(), true, None, w, cx);
                    e.new_draft(String::new(), w, cx);
                    let key = e.selected.clone().unwrap();
                    e.choose_project(&key, "ab", w, cx);
                    e.text
                        .update(cx, |t, cx| t.set_value("Unchanged message 日本語", w, cx));
                    e.changed(cx);
                    let before = e.draft().unwrap().clone();
                    e.projects(rows(), loaded, error, w, cx);
                    e.submit(false, w, cx);
                    assert!(commands.try_recv().is_err());
                    assert!(e.draft().unwrap() == &before);
                    e.projects(rows(), true, None, w, cx);
                    e.choose_project(&key, "ab", w, cx);
                    assert!(e.project_problem(e.draft().unwrap()).is_none());
                    assert!(
                        e.draft().unwrap() == &before,
                        "catalog recovery/reselection never edits the draft"
                    );
                    assert!(
                        e.error.is_none(),
                        "derived catalog validation must not latch a generic error"
                    );
                    e.submit(false, w, cx);
                    e.submit(false, w, cx);
                })
            })
            .unwrap();
            let WriteCommand::Submit { draft, .. } = commands.try_recv().unwrap() else {
                panic!("one explicit recovered submit")
            };
            assert_eq!(draft.project_id.as_deref(), Some("ab"));
            assert_eq!(draft.cwd, "/tmp/shared");
            assert_eq!(draft.text, "Unchanged message 日本語");
            assert!(commands.try_recv().is_err());
        }
    }
    #[gpui_kit::test]
    fn catalog_recovery_does_not_clear_writer_or_unsaved_input_faults(cx: &mut TestAppContext) {
        for writer_fault in [false, true] {
            let (handle, editor, commands) = setup(cx);
            cx.update_window(handle, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.projects(rows(), true, None, w, cx);
                    e.new_draft(String::new(), w, cx);
                    let key = e.selected.clone().unwrap();
                    e.choose_project(&key, "ab", w, cx);
                    e.text.update(cx, |t, cx| {
                        t.set_value(
                            if writer_fault {
                                "Unchanged text".into()
                            } else {
                                "x".repeat(TEXT_CAP + 1)
                            },
                            w,
                            cx,
                        )
                    });
                    e.changed(cx);
                    if writer_fault {
                        // Exercise a real atomic-write failure in owned temporary state,
                        // then publish its error through the normal editor entry point.
                        let root = std::env::temp_dir()
                            .join(format!("catalog-write-fault-{}", uuid::Uuid::new_v4()));
                        let mut store = crate::delivery_store::Store::open(
                            root.clone(),
                            e.state.book.as_ref().unwrap().host.clone(),
                        )
                        .unwrap();
                        let snapshot = root.join("state-v1.json");
                        let original = std::fs::read(&snapshot).unwrap();
                        std::fs::rename(&snapshot, root.join("retained.json")).unwrap();
                        std::fs::create_dir(&snapshot).unwrap();
                        let failed_edits = std::collections::BTreeMap::from([(
                            key.clone(),
                            e.draft().unwrap().clone(),
                        )]);
                        let error = store.save_edits(failed_edits).unwrap_err();
                        assert_eq!(
                            error,
                            "Draft write failed. Delivery is disabled; keep/copy unsaved text."
                        );
                        assert!(store.book.pending.is_empty());
                        assert!(!store.book.drafts.contains_key(&key));
                        assert_eq!(std::fs::read(root.join("retained.json")).unwrap(), original);
                        let mut state = e.state.clone();
                        state.error = Some(error);
                        e.accept(state, w, cx);
                        drop(store);
                        std::fs::remove_dir_all(root).unwrap();
                    }
                    let local_error = e.error;
                    let writer_error = e.state.error;
                    let before = e.draft().unwrap().clone();
                    assert!(local_error.is_some() || writer_error.is_some());
                    e.projects(rows(), false, Some("Temporary catalog error"), w, cx);
                    e.submit(false, w, cx);
                    e.projects(rows(), true, None, w, cx);
                    e.choose_project(&key, "ab", w, cx);
                    e.submit(false, w, cx);
                    assert_eq!(e.error, local_error);
                    assert_eq!(e.state.error, writer_error);
                    assert!(e.draft().unwrap() == &before);
                    assert!(commands.try_recv().is_err());
                    if !writer_fault {
                        assert!(e.unsaved_local.contains(&key));
                    }
                })
            })
            .unwrap();
        }
    }

    #[gpui_kit::test]
    fn picker_preedit_guards_submit_selection_and_navigation(cx: &mut TestAppContext) {
        let (handle, editor, commands) = setup(cx);
        cx.update_window(handle, |_, w, cx| {
            editor.update(cx, |e, cx| {
                e.projects(rows(), true, None, w, cx);
                e.new_draft(String::new(), w, cx);
                let key = e.selected.clone().unwrap();
                let q = e
                    .project_picker
                    .as_ref()
                    .unwrap()
                    .state
                    .read(cx)
                    .query_input(cx);
                q.update(cx, |q, cx| {
                    q.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                assert!(!e.capture_navigation(w, cx));
                e.choose_project(&key, "a", w, cx);
                e.submit(false, w, cx);
                assert!(e.draft().unwrap().project_id.is_none());
                assert!(commands.try_recv().is_err());
                q.update(cx, |q, cx| q.unmark_text(w, cx));
                assert!(e.capture_navigation(w, cx));
            })
        })
        .unwrap();
    }
}

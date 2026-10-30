//! Explicit per-draft Local project choice. No path-to-project inference.
//! Projects are visible rows: one click (or arrows + Enter) chooses, nothing is sent.
use super::*;
use crate::{local_model::Project, ui};
use gpui_kit::Task;
use gpui_kit::component::IndexPath;
use gpui_kit::component::list::{List, ListDelegate, ListEvent, ListItem, ListState};
use std::sync::Arc;

/// Two-line rows (name, folder). Five stay visible; the rest scroll or filter.
const ROW: f32 = 44.;
const VISIBLE_ROWS: f32 = 5.;

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
    detail: SharedString,
    unavailable: bool,
}
impl Choice {
    fn matches(&self, query: &str) -> bool {
        let query = query.to_lowercase();
        [&*self.title, &*self.detail, &self.id]
            .iter()
            .any(|text| text.to_lowercase().contains(&query))
    }
}
#[derive(Default)]
pub(super) struct Rows {
    all: Vec<Choice>,
    /// Indices into `all` matching the current query, in catalog order.
    shown: Vec<usize>,
    query: String,
    chosen: Option<String>,
    enabled: bool,
}
impl Rows {
    fn set(&mut self, all: Vec<Choice>, chosen: Option<String>) {
        self.all = all;
        self.chosen = chosen;
        self.filter();
    }
    fn filter(&mut self) {
        self.shown = (0..self.all.len())
            .filter(|&i| self.all[i].matches(&self.query))
            .collect();
    }
    fn id_at(&self, ix: IndexPath) -> Option<&str> {
        self.shown.get(ix.row).map(|&i| self.all[i].id.as_str())
    }
    fn chosen_index(&self) -> Option<IndexPath> {
        let id = self.chosen.as_deref()?;
        self.shown
            .iter()
            .position(|&i| self.all[i].id == id)
            .map(IndexPath::new)
    }
}
impl ListDelegate for Rows {
    type Item = ListItem;
    fn items_count(&self, _: usize, _: &gpui_kit::App) -> usize {
        self.shown.len()
    }
    fn item_height(&self, _: IndexPath, _: &gpui_kit::App) -> Option<gpui_kit::Pixels> {
        Some(px(ROW))
    }
    fn perform_search(
        &mut self,
        query: &str,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Task<()> {
        self.query = query.to_owned();
        self.filter();
        Task::ready(())
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let choice = &self.all[*self.shown.get(ix.row)?];
        Some(
            ListItem::new(SharedString::from(format!("new-project-{}", choice.id)))
                .h(px(ROW))
                .px_2()
                .py_0()
                .rounded(px(ui::Radius::ROW))
                .accessibility_label(SharedString::from(format!(
                    "{} · {}",
                    choice.title, choice.detail
                )))
                .disabled(!self.enabled || choice.unavailable)
                .confirmed(self.chosen.as_deref() == Some(choice.id.as_str()))
                .check_icon(ui::IconRole::Complete.icon())
                .child(
                    ui::ResourceLabel::new(choice.title.clone())
                        .detail(choice.detail.clone())
                        .icon(ui::IconRole::Project)
                        .muted(!self.enabled || choice.unavailable),
                ),
        )
    }
    fn set_selected_index(
        &mut self,
        _: Option<IndexPath>,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) {
        cx.notify();
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        div()
            .px_2()
            .py_2()
            .text_size(px(crate::appearance::TextRole::BODY))
            .text_color(cx.theme().muted_foreground)
            .child("No matching projects")
    }
}
pub(super) struct Picker {
    source: String,
    state: Entity<ListState<Rows>>,
    catalog: Arc<Vec<Project>>,
    selected: Option<String>,
    _subscriptions: Vec<Subscription>,
}
impl ChatEditor {
    #[cfg(feature = "native-probes")]
    pub(crate) fn project_query(&self, cx: &gpui_kit::App) -> Option<Entity<InputState>> {
        self.project_picker
            .as_ref()
            .map(|p| p.state.read(cx).query_input())
    }
    /// The row list's checked project and whether rows accept a choice.
    #[cfg(feature = "native-probes")]
    pub(crate) fn project_rows_probe(&self, cx: &gpui_kit::App) -> (Option<String>, bool) {
        self.project_picker.as_ref().map_or((None, false), |p| {
            let rows = p.state.read(cx).delegate();
            (rows.chosen.clone(), rows.enabled)
        })
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
        self.sync_models(window, cx);
        if changed {
            cx.notify();
        }
    }
    pub(super) fn project_query_marked(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.project_picker.as_ref().is_some_and(|picker| {
            picker
                .state
                .read(cx)
                .query_input()
                .update(cx, |q, cx| q.marked_text_range(window, cx).is_some())
        })
    }
    /// Navigation waits for a project-search composition, like the composer's.
    pub(super) fn retire_project_picker(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        !self.project_query_marked(window, cx)
    }
    pub(super) fn project_problem(&self, draft: &Draft) -> Option<&'static str> {
        if draft.diagnostics {
            return None;
        }
        if !self.project_catalog.loaded {
            return Some("Loading projects…");
        }
        if self.project_catalog.error.is_some() {
            return Some("Local projects are unavailable. Draft and selection are retained.");
        }
        let Some(id) = draft.project_id.as_ref() else {
            return Some(if self.project_catalog.rows.is_empty() {
                "No projects yet. Add a project to start a chat."
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
    /// Whether a click or Enter on a project row can change this draft now.
    fn projects_choosable(&self, draft: &Draft) -> bool {
        self.ready()
            && self.writable
            && !self.waiting()
            && draft.editable()
            && self.project_catalog.loaded
            && !self.project_catalog.rows.is_empty()
            && self.project_catalog.error.is_none()
    }
    /// Keeps row affordance in step with the existing choice guards. Render-time,
    /// but it only notifies the list when the answer actually changes.
    pub(super) fn sync_project_rows_enabled(&self, cx: &mut Context<Self>) {
        let (Some(picker), Some(draft)) = (self.project_picker.as_ref(), self.draft()) else {
            return;
        };
        let enabled = self.projects_choosable(draft);
        if picker.state.read(cx).delegate().enabled != enabled {
            picker.state.update(cx, |list, cx| {
                list.delegate_mut().enabled = enabled;
                list.set_selectable(enabled, cx);
            });
        }
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
            let state = cx.new(|cx| ListState::new(Rows::default(), window, cx).searchable(true));
            let source = key.clone();
            let events = cx.subscribe_in(
                &state,
                window,
                move |view, list, event: &ListEvent, window, cx| match event {
                    ListEvent::Confirm(ix) => {
                        let id = list.read(cx).delegate().id_at(*ix).map(str::to_owned);
                        if let Some(id) = id {
                            // Show every project again, the chosen one checked.
                            if !view.project_query_marked(window, cx)
                                && !list.read(cx).query_input().read(cx).value().is_empty()
                            {
                                list.update(cx, |l, cx| l.set_query("", window, cx));
                            }
                            view.choose_project(&source, &id, window, cx);
                        }
                    }
                    // Escape leaves the search; the draft keeps its project.
                    ListEvent::Cancel if !view.project_query_marked(window, cx) => {
                        list.update(cx, |l, cx| l.set_query("", window, cx));
                        view.focus(window, cx);
                    }
                    _ => {}
                },
            );
            let query = state.read(cx).query_input();
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
                _subscriptions: vec![events, changed],
            });
        }
        if self.project_query_marked(window, cx) {
            return;
        }
        let picker = self.project_picker.as_mut().unwrap();
        if Arc::ptr_eq(&picker.catalog, &self.project_catalog.rows) && picker.selected == selected {
            return;
        }
        let mut names = BTreeMap::<&str, usize>::new();
        for project in self.project_catalog.rows.iter() {
            *names.entry(&project.name).or_default() += 1;
        }
        let mut choices: Vec<_> = self
            .project_catalog
            .rows
            .iter()
            .map(|p| Choice {
                id: p.id.clone(),
                title: if names[p.name.as_str()] > 1 {
                    format!("{} · {}", p.name, p.id).into()
                } else {
                    p.name.clone().into()
                },
                detail: p.path.clone().into(),
                unavailable: false,
            })
            .collect();
        if let Some(id) = &selected
            && !choices.iter().any(|p| &p.id == id)
        {
            choices.push(Choice {
                id: id.clone(),
                title: "Project unavailable".into(),
                detail: id.clone().into(),
                unavailable: true,
            });
        }
        let first =
            !Arc::ptr_eq(&picker.catalog, &self.project_catalog.rows) && picker.catalog.is_empty();
        picker.state.update(cx, |list, cx| {
            list.delegate_mut().set(choices, selected.clone());
            let chosen = list.delegate().chosen_index();
            list.set_selected_index(chosen, window, cx);
            if first && chosen.is_some() {
                list.scroll_to_selected_item(window, cx);
            }
            cx.notify();
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
        self.sync_models(window, cx);
    }
    pub(super) fn project_setup_problem(&self, draft: &Draft) -> Option<&'static str> {
        if !draft.editable() {
            return None;
        }
        self.project_problem(draft).filter(|_| {
            draft.project_id.is_some()
                || !self.project_catalog.loaded
                || self.project_catalog.error.is_some()
                || self.project_catalog.rows.is_empty()
        })
    }
    pub(super) fn project_field(
        &self,
        draft: &Draft,
        window: &mut Window,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        // Rows only while this draft's destination can still change. Loading,
        // empty, failed and sent drafts keep their notice/caption instead.
        let shown = draft.editable()
            && self.project_catalog.loaded
            && self.project_catalog.error.is_none()
            && !self.project_catalog.rows.is_empty();
        let list = self
            .project_picker
            .as_ref()
            .filter(|_| shown)
            .map(|picker| {
                let rows = picker.state.read(cx).delegate().all.len() as f32;
                // Half a row past the fold says the list scrolls.
                let visible = if rows > VISIBLE_ROWS {
                    VISIBLE_ROWS + 0.5
                } else {
                    rows
                };
                let frame = div()
                    .id("new-chat-project")
                    .aria_label("New chat project")
                    .w_full()
                    .min_w_0()
                    .border(crate::appearance::hairline(window))
                    .border_color(cx.theme().border)
                    .rounded(px(ui::Radius::CONTROL))
                    .overflow_hidden()
                    .child(
                        List::new(&picker.state)
                            .p_1()
                            .max_h(px(ROW * visible + 8.))
                            .search_placeholder("Find a project…"),
                    );
                #[cfg(any(test, feature = "native-probes"))]
                let frame = frame.test_support();
                frame
            });
        // A sent draft's destination is fixed, so Add project would be noise there.
        let add = draft.editable().then(|| {
            div().h_flex().child(
                ui::action("new-chat-add-project", "Add project…", ui::Action::Quiet)
                    .disabled(!self.ready() || self.waiting())
                    .on_click(cx.listener(|view, _, window, cx| {
                        if !view.marked(window, cx) {
                            cx.emit(EditorEvent::AddProject);
                        }
                    })),
            )
        });
        div()
            .v_flex()
            .gap(px(ui::Space::CONTROL))
            .min_w_0()
            .children(list)
            .children(add)
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
                ..Default::default()
            },
            Project {
                id: "ab".into(),
                name: "Same title 日本語".into(),
                path: "/tmp/shared".into(),
                ..Default::default()
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
                let list = e.project_picker.as_ref().unwrap().state.read(cx);
                assert_eq!(list.delegate().chosen.as_deref(), Some("ab"));
                assert_eq!(list.selected_index(), Some(IndexPath::new(1)));
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
            old.update(cx, |_, cx| cx.emit(ListEvent::Confirm(IndexPath::new(1))))
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
                    .query_input();
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

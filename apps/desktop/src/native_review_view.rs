//! Mission-scoped native retained Review. All reads share one exact comparison fence.
#[path = "native_review_render.rs"]
mod render;
use crate::{
    LocalOptions,
    mission_browser::Key,
    native_review as model,
    native_review_reader::{self as wire, Data, Reader, Route},
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, AppContext, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled,
    Subscription, Task, TestSupportExt, Window,
    base::SelectableText,
    component::{
        Disableable, Selectable, StyledExt,
        diff::{Diff, DiffMode, DiffState},
        scroll::ScrollableElement,
        select::{SearchableVec, Select, SelectEvent, SelectItem, SelectState},
    },
    div, rems,
};
use std::sync::Arc;
gpui_kit::actions!(native_review, [Back, NextChange, PreviousChange]);
pub(crate) struct Close;
#[derive(Clone)]
struct Item {
    id: String,
    label: SharedString,
}
impl SelectItem for Item {
    type Value = String;
    fn value(&self) -> &String {
        &self.id
    }
    fn title(&self) -> SharedString {
        self.label.clone()
    }
    fn render(&self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div().truncate().child(self.label.clone())
    }
}
type Picker = SelectState<SearchableVec<Item>>;
pub(crate) struct Pane {
    key: Option<Key>,
    options: Option<LocalOptions>,
    visible: bool,
    generation: u64,
    route: Option<Route>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    workers: Vec<model::Worker>,
    worker: Option<String>,
    project: Option<String>,
    comparisons: Vec<model::Comparison>,
    next: Option<u64>,
    after: u64,
    selected: Option<model::Comparison>,
    snapshot: Option<Arc<model::Snapshot>>,
    diff: Entity<DiffState>,
    worker_picker: Entity<Picker>,
    comparison_picker: Entity<Picker>,
    file_picker: Entity<Picker>,
    file: Option<String>,
    source: Option<(String, SharedString)>,
    records: Vec<String>,
    records_open: bool,
    details: bool,
    busy: bool,
    error: Option<&'static str>,
    patch_error: Option<&'static str>,
    more_workers: bool,
    focus: FocusHandle,
    summary_scroll: gpui_kit::ScrollHandle,
    source_scroll: gpui_kit::ScrollHandle,
    _subscriptions: Vec<Subscription>,
}
impl EventEmitter<Close> for Pane {}
impl Pane {
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe(
        &self,
        cx: &App,
    ) -> (
        bool,
        Option<String>,
        Option<String>,
        usize,
        Option<&'static str>,
    ) {
        (
            self.busy,
            self.selected.as_ref().map(|s| s.snapshot_id.clone()),
            self.source.as_ref().map(|s| s.1.to_string()),
            self.diff.read(cx).files().len(),
            self.error,
        )
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_stale(&mut self, cx: &mut Context<Self>) {
        let before = self.snapshot.as_ref().map(|s| s.snapshot_id.clone());
        if let Some(route) = self
            .key
            .clone()
            .zip(self.worker.clone())
            .zip(self.selected.clone())
            .map(|((k, w), c)| Route::Snapshot(k, w, Box::new(c)))
        {
            let previous = self.route.replace(route.clone());
            self.accept(
                wire::Response {
                    generation: self.generation.saturating_sub(1),
                    route,
                    result: Err("obsolete unauthorized reply"),
                },
                cx,
            );
            self.route = previous;
        }
        assert_eq!(
            before,
            self.snapshot.as_ref().map(|s| s.snapshot_id.clone())
        );
    }
    pub(crate) fn new(w: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            gpui_kit::KeyBinding::new("escape", Back, Some("NativeReview")),
            gpui_kit::KeyBinding::new("alt-down", NextChange, Some("NativeReview")),
            gpui_kit::KeyBinding::new("alt-up", PreviousChange, Some("NativeReview")),
        ]);
        let worker_picker =
            cx.new(|cx| Picker::new(SearchableVec::<Item>::new(vec![]), None, w, cx));
        let comparison_picker =
            cx.new(|cx| Picker::new(SearchableVec::<Item>::new(vec![]), None, w, cx));
        let file_picker = cx.new(|cx| Picker::new(SearchableVec::<Item>::new(vec![]), None, w, cx));
        let mut subscriptions = vec![];
        for (kind, picker) in [
            (0, worker_picker.clone()),
            (1, comparison_picker.clone()),
            (2, file_picker.clone()),
        ] {
            subscriptions.push(cx.subscribe_in(
                &picker,
                w,
                move |v, p, event: &SelectEvent<SearchableVec<Item>>, w, cx| {
                    let SelectEvent::Confirm(Some(id)) = event else {
                        return;
                    };
                    if !v.visible || p.read(cx).selected_value() != Some(id) {
                        return;
                    }
                    match kind {
                        0 => v.choose_worker(id, w, cx),
                        1 => v.choose_comparison(id, w, cx),
                        _ => {
                            if v.diff
                                .read(cx)
                                .files()
                                .iter()
                                .any(|f| f.path().as_ref() == id)
                            {
                                v.file = Some(id.clone());
                                v.diff.update(cx, |d, cx| d.scroll_to_file(id, cx));
                                cx.notify();
                            }
                        }
                    }
                },
            ));
        }
        Self {
            key: None,
            options: None,
            visible: false,
            generation: 0,
            route: None,
            reader: None,
            updates: None,
            workers: vec![],
            worker: None,
            project: None,
            comparisons: vec![],
            next: None,
            after: 0,
            selected: None,
            snapshot: None,
            diff: cx.new(|cx| DiffState::new(vec![], cx)),
            worker_picker,
            comparison_picker,
            file_picker,
            file: None,
            source: None,
            records: vec![],
            records_open: false,
            details: false,
            busy: false,
            error: None,
            patch_error: None,
            more_workers: false,
            focus: cx.focus_handle().tab_stop(true),
            summary_scroll: Default::default(),
            source_scroll: Default::default(),
            _subscriptions: subscriptions,
        }
    }
    pub(crate) fn sync(
        &mut self,
        key: Option<Key>,
        options: Option<LocalOptions>,
        visible: bool,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let changed = self.key != key
            || !crate::session_file_view_reader::same_source(
                self.options.as_ref(),
                options.as_ref(),
            );
        if changed {
            self.cancel();
            self.clear_comparison(cx);
            self.workers.clear();
            self.worker = None;
            self.project = None;
            self.comparisons.clear();
            self.selected = None;
            self.key = key;
            self.options = options;
            self.error = None;
            self.next = None;
            self.after = 0;
            Self::items(&self.worker_picker, vec![], None, w, cx);
            Self::items(&self.comparison_picker, vec![], None, w, cx);
        }
        let opening = visible && !self.visible;
        if !visible {
            self.cancel();
            if self.visible {
                self.clear_comparison(cx);
                cx.notify();
            }
        }
        self.visible = visible;
        if visible && (changed || opening) {
            self.refresh(w, cx);
        }
        if changed || opening {
            cx.notify();
        }
    }
    fn cancel(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.route = None;
        self.reader = None;
        self.updates = None;
        self.busy = false;
    }
    /// Known host-summary changes revoke the display immediately; missing rows are not proof.
    pub(crate) fn observe_scope(
        &mut self,
        chats: &[crate::local_model::Chat],
        cx: &mut Context<Self>,
    ) {
        let Some(worker) = &self.worker else {
            return;
        };
        let revoked=chats.iter().find(|c|&c.id==worker).is_some_and(|c|{
            self.project.as_ref().is_some_and(|p|c.project_id.as_ref()!=Some(p))
                || !matches!((&c.mission,&self.key),(crate::local_model::MissionAssociation::Linked(id),Some(k)) if id==&k.id)
        });
        if revoked {
            self.cancel();
            self.clear_comparison(cx);
            self.worker = None;
            self.selected = None;
            self.comparisons.clear();
            self.error = Some(
                "Worker mission/project scope changed. Previous retained content was cleared.",
            );
            cx.notify();
        }
    }
    fn clear_comparison(&mut self, cx: &mut Context<Self>) {
        self.snapshot = None;
        self.source = None;
        self.records.clear();
        self.records_open = false;
        self.patch_error = None;
        self.file = None;
        self.diff.update(cx, |d, cx| d.set_files(vec![], cx));
    }
    fn items(
        p: &Entity<Picker>,
        items: Vec<Item>,
        selected: Option<String>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        p.update(cx, |p, cx| {
            p.set_items(SearchableVec::new(items), w, cx);
            if let Some(selected) = &selected {
                p.set_selected_value(selected, w, cx);
            } else {
                p.set_selected_index(None, w, cx);
            }
        });
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    pub(crate) fn owns_focus(&self, w: &Window, cx: &App) -> bool {
        self.focus.contains_focused(w, cx)
    }
    fn request(&mut self, route: Route, w: &mut Window, cx: &mut Context<Self>) {
        if !self.visible {
            return;
        }
        self.generation = self.generation.saturating_add(1);
        self.busy = true;
        self.error = None;
        self.route = Some(route.clone());
        if self.reader.is_none() {
            match self
                .options
                .clone()
                .ok_or("Retained Review is unavailable without a Local host.")
                .and_then(Reader::start)
            {
                Ok((r, rx)) => {
                    self.reader = Some(r);
                    self.updates = Some(cx.spawn_in(w, async move |pane, cx| {
                        while let Ok(r) = rx.recv().await {
                            if pane
                                .update_in(cx, |p, w, cx| {
                                    p.accept(r, cx);
                                    p.continue_read(w, cx);
                                })
                                .is_err()
                            {
                                return;
                            }
                        }
                        let _ = pane.update(cx, |p, cx| {
                            p.reader = None;
                            if p.busy {
                                p.busy = false;
                                p.error = Some("Retained reader stopped. Refresh to retry.");
                                p.clear_comparison(cx);
                                cx.notify();
                            }
                        });
                    }));
                }
                Err(e) => {
                    self.busy = false;
                    self.error = Some(e);
                    cx.notify();
                    return;
                }
            }
        }
        if !self
            .reader
            .as_ref()
            .is_some_and(|r| r.request(self.generation, route))
        {
            self.busy = false;
            self.reader = None;
            self.error = Some("Retained reader is unavailable. Refresh to retry.");
            self.clear_comparison(cx);
        }
        cx.notify();
    }
    fn refresh(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(k) = self.key.clone() {
            self.request(Route::Workers(k), w, cx);
        }
    }
    fn choose_worker(&mut self, id: &str, w: &mut Window, cx: &mut Context<Self>) {
        if self.worker.as_deref() == Some(id) || !self.workers.iter().any(|v| v.id == id) {
            return;
        }
        self.clear_comparison(cx);
        self.selected = None;
        self.worker = Some(id.into());
        self.comparisons.clear();
        self.after = 0;
        self.next = None;
        Self::items(&self.comparison_picker, vec![], None, w, cx);
        if let Some(k) = self.key.clone() {
            self.request(Route::Comparisons(k, id.into(), 0), w, cx);
        }
    }
    fn choose_comparison(&mut self, id: &str, w: &mut Window, cx: &mut Context<Self>) {
        let Some(c) = self
            .comparisons
            .iter()
            .find(|c| c.snapshot_id == id)
            .cloned()
        else {
            return;
        };
        if self.selected.as_ref().is_some_and(|s| s.snapshot_id == id) && self.snapshot.is_some() {
            return;
        }
        self.open_comparison(c, w, cx);
    }
    fn open_comparison(&mut self, c: model::Comparison, w: &mut Window, cx: &mut Context<Self>) {
        let (Some(k), Some(worker)) = (self.key.clone(), self.worker.clone()) else {
            return;
        };
        self.clear_comparison(cx);
        self.selected = Some(c.clone());
        self.request(Route::Snapshot(k, worker, Box::new(c)), w, cx);
    }
    pub(crate) fn accept(&mut self, r: wire::Response, cx: &mut Context<Self>) {
        if !self.visible || r.generation != self.generation || self.route.as_ref() != Some(&r.route)
        {
            return;
        }
        self.busy = false;
        match r.result {
            Err(e) => {
                self.error = Some(e);
                if !matches!(r.route, Route::Records(..)) || e != wire::RECORDS_UNAVAILABLE {
                    self.clear_comparison(cx);
                }
            }
            Ok(Data::Workers(v)) => {
                if self.project.as_ref().is_some_and(|p| p != &v.project_id) {
                    self.worker = None;
                    self.selected = None;
                    self.comparisons.clear();
                    self.clear_comparison(cx);
                }
                self.project = Some(v.project_id);
                self.more_workers = v.more;
                self.workers = v.workers;
                if self
                    .worker
                    .as_ref()
                    .is_some_and(|id| !self.workers.iter().any(|w| &w.id == id))
                {
                    self.worker = None;
                    self.selected = None;
                    self.comparisons.clear();
                    self.clear_comparison(cx);
                }
            }
            Ok(Data::Comparisons(v)) => {
                self.comparisons = v.comparisons;
                self.next = v.next;
                self.error = if v.unavailable.is_some() {
                    Some(
                        "No retained ownership binding. Reading does not enroll, capture or migrate existing work.",
                    )
                } else {
                    None
                };
            }
            Ok(Data::Snapshot(s, files)) => {
                self.snapshot = Some(s);
                match files {
                    Ok(files) => {
                        self.file = files.first().map(|f| f.path().to_string());
                        self.diff.update(cx, |d, cx| d.set_files(files, cx));
                    }
                    Err(e) => self.patch_error = Some(e),
                }
            }
            Ok(Data::Records(lines)) => {
                self.records = lines;
                self.records_open = true;
            }
            Ok(Data::Source(text)) => {
                let Route::Source(_, _, _, side, path, _) = r.route else {
                    return;
                };
                let mut end = text.len().min(65536);
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                let shown = &text[..end];
                let suffix = if end < text.len() {
                    "\n[Preview truncated at 64 KiB. This is not complete source coverage.]"
                } else {
                    ""
                };
                self.source = Some((format!("{side}: {path}"), format!("{shown}{suffix}").into()));
            }
        }
        cx.notify();
    }
    // Picker updates require Window, and happen in a scheduled callback after admission,
    // never from render. The callback repeats the generation fence before issuing follow-up reads.
    fn continue_read(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.route.is_none() {
            return;
        }
        let route = self.route.take();
        if self.error.is_some() {
            return;
        }
        match route {
            Some(Route::Workers(k)) => {
                Self::items(
                    &self.worker_picker,
                    self.workers
                        .iter()
                        .map(|v| Item {
                            id: v.id.clone(),
                            label: v.title.clone().into(),
                        })
                        .collect(),
                    self.worker.clone(),
                    w,
                    cx,
                );
                if let Some(worker) = self.worker.clone() {
                    self.request(Route::Comparisons(k, worker, self.after), w, cx);
                }
            }
            Some(Route::Comparisons(k, worker, _)) => {
                let mut items: Vec<_> = self
                    .comparisons
                    .iter()
                    .map(|c| Item {
                        id: c.snapshot_id.clone(),
                        label: c.label().into(),
                    })
                    .collect();
                if let Some(s) = self.selected.as_ref().filter(|s| {
                    !self
                        .comparisons
                        .iter()
                        .any(|c| c.snapshot_id == s.snapshot_id)
                }) {
                    items.push(Item {
                        id: s.snapshot_id.clone(),
                        label: format!("Pinned · {}", s.label()).into(),
                    });
                }
                Self::items(
                    &self.comparison_picker,
                    items,
                    self.selected.as_ref().map(|s| s.snapshot_id.clone()),
                    w,
                    cx,
                );
                if let Some(c) = self.selected.clone() {
                    self.request(Route::Snapshot(k, worker, Box::new(c)), w, cx);
                }
            }
            Some(Route::Snapshot(..)) => {
                let items = self
                    .diff
                    .read(cx)
                    .files()
                    .iter()
                    .map(|f| Item {
                        id: f.path().to_string(),
                        label: f.path().clone(),
                    })
                    .collect();
                Self::items(&self.file_picker, items, self.file.clone(), w, cx);
            }
            _ => {}
        }
    }
    fn back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.source.is_some() {
            self.source = None;
            self.diff.read(cx).focus_handle(cx).focus(w, cx);
        } else {
            self.cancel();
            cx.emit(Close);
        }
        cx.notify();
    }
    fn read_source(&mut self, side: &str, w: &mut Window, cx: &mut Context<Self>) {
        let (Some(k), Some(worker), Some(s), Some(file)) = (
            self.key.clone(),
            self.worker.clone(),
            self.snapshot.clone(),
            self.file.clone(),
        ) else {
            return;
        };
        let path = self
            .diff
            .read(cx)
            .files()
            .iter()
            .find(|f| f.path().as_ref() == file)
            .and_then(|f| {
                if side == "before" {
                    f.original_path()
                } else {
                    f.modified_path()
                }
            })
            .map(|p| p.to_string());
        let entries = if side == "before" {
            &s.before
        } else {
            &s.after
        };
        let Some(e) = path
            .and_then(|path| entries.iter().find(|e| e.path == path))
            .filter(|e| e.state == "text")
        else {
            self.error =
                Some("This side is absent, binary or unsupported. Retained text is unavailable.");
            cx.notify();
            return;
        };
        if let Some(sha) = &e.sha256 {
            self.request(
                Route::Source(
                    k,
                    worker,
                    s.snapshot_id.clone(),
                    side.into(),
                    e.path.clone(),
                    sha.clone(),
                ),
                w,
                cx,
            );
        }
    }
}

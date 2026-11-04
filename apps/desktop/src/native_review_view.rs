//! Global, change-centered native retained Review. Explicit review requests across projects
//! form one list; each opens its exact saved revision. All reads share one exact fence.
#[path = "native_review_render.rs"]
mod render;
use crate::{
    LocalOptions,
    mission_browser::{Home, Key},
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
#[derive(Clone)]
pub(crate) enum Event {
    /// Leave Review, or go back from one change to the list.
    Close,
    /// Open one listed change as the page target.
    Open(Target),
    /// Show the current workspace file of a change's chat, outside Review. The target
    /// is rechecked against current metadata before anything opens.
    CurrentFile {
        home: Home,
        chat: String,
        project: String,
        path: String,
    },
}
/// What the list reads: this host's requests, optionally only those from one chat.
/// The chat narrows the list; it never owns the review.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Scope {
    pub(crate) home: Home,
    pub(crate) chat: Option<String>,
}
/// One exact change a page opens: a queue item, or one of a chat's saved revisions
/// opened without a request (never labelled pending).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Request(String),
    Saved(String),
}
/// The exact revision on screen and the custody it is read through.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Opened {
    target: Target,
    session: String,
    project: String,
    title: String,
    status: &'static str,
    comparison: model::Comparison,
}
impl Scope {
    fn valid(&self) -> bool {
        self.chat
            .as_deref()
            .is_none_or(crate::local_model::valid_id)
    }
}
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
const MOVED: &str =
    "This change's chat is now in another project. Its Review here was closed and cleared.";
pub(crate) struct Pane {
    scope: Option<Scope>,
    /// The change this page targets, if one is open.
    target: Option<Target>,
    options: Option<LocalOptions>,
    visible: bool,
    generation: u64,
    route: Option<Route>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    requests: Vec<model::ReviewRequest>,
    /// A list page has been read for this scope.
    listed: bool,
    unavailable: bool,
    next: Option<u64>,
    after: u64,
    /// A chat-narrowed Review also lists that chat's saved revisions, read under the
    /// project it is in here.
    saved: Vec<model::Comparison>,
    saved_project: Option<String>,
    saved_more: bool,
    not_captured: bool,
    capture_notice: Option<&'static str>,
    capture_limits: Vec<&'static str>,
    /// Chats known here: a known move closes an open change, and a saved list needs
    /// the chat's current project.
    chats: Arc<Vec<crate::local_model::Chat>>,
    /// The open change, pinned to its exact revision even if the list changes.
    selected: Option<Opened>,
    /// The open change's chat is known to have left its listed project: its reads stay
    /// closed, including Refresh, until another change is opened.
    moved: bool,
    snapshot: Option<Arc<model::Snapshot>>,
    diff: Entity<DiffState>,
    file_picker: Entity<Picker>,
    file: Option<String>,
    source: Option<(String, SharedString)>,
    source_side: &'static str,
    records: Vec<String>,
    records_open: bool,
    busy: bool,
    error: Option<&'static str>,
    patch_error: Option<&'static str>,
    focus: FocusHandle,
    summary_scroll: gpui_kit::ScrollHandle,
    source_scroll: gpui_kit::ScrollHandle,
    list_scroll: gpui_kit::ScrollHandle,
    _subscriptions: Vec<Subscription>,
}
impl EventEmitter<Event> for Pane {}
impl Pane {
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_enrollment(&self) -> Option<String> {
        self.snapshot.as_ref().map(|s| s.enrollment())
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_state(&self) -> Option<&'static str> {
        self.state_message().map(|(title, _)| title)
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_requests(&self) -> Vec<String> {
        self.requests.iter().map(|r| r.request_id.clone()).collect()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_saved(&self) -> Vec<String> {
        self.saved_rows().map(|c| c.snapshot_id.clone()).collect()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_capture_notice(&self) -> Option<&'static str> {
        self.capture_notice
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_status(&self) -> Option<&'static str> {
        self.selected.as_ref().map(|s| s.status)
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_files(&self, cx: &App) -> Vec<String> {
        self.diff
            .read(cx)
            .files()
            .iter()
            .map(|f| f.path().to_string())
            .collect()
    }
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
            self.selected
                .as_ref()
                .map(|s| s.comparison.snapshot_id.clone()),
            self.source.as_ref().map(|s| s.1.to_string()),
            self.diff.read(cx).files().len(),
            self.error,
        )
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_stale(&mut self, cx: &mut Context<Self>) {
        let before = self.snapshot.as_ref().map(|s| s.snapshot_id.clone());
        if let Some(route) = self
            .chat_key()
            .zip(self.selected.clone())
            .map(|(k, c)| Route::Snapshot(k, Box::new(c.comparison)))
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
        let file_picker = cx.new(|cx| Picker::new(SearchableVec::<Item>::new(vec![]), None, w, cx));
        let subscriptions = vec![cx.subscribe_in(
            &file_picker,
            w,
            move |v, p, event: &SelectEvent<SearchableVec<Item>>, w, cx| {
                let SelectEvent::Confirm(Some(id)) = event else {
                    return;
                };
                if !v.visible || p.read(cx).selected_value() != Some(id) {
                    return;
                }
                if v.diff
                    .read(cx)
                    .files()
                    .iter()
                    .any(|f| f.path().as_ref() == id)
                {
                    v.file = Some(id.clone());
                    v.diff.update(cx, |d, cx| d.scroll_to_file(id, cx));
                    // Jump is navigation, not a selection: return to its placeholder.
                    let picker = p.clone();
                    cx.defer_in(w, move |_, w, cx| {
                        picker.update(cx, |p, cx| p.set_selected_index(None, w, cx))
                    });
                    cx.notify();
                }
            },
        )];
        Self {
            scope: None,
            target: None,
            options: None,
            visible: false,
            generation: 0,
            route: None,
            reader: None,
            updates: None,
            requests: vec![],
            saved: vec![],
            saved_project: None,
            saved_more: false,
            not_captured: false,
            capture_notice: None,
            capture_limits: vec![],
            chats: Arc::new(vec![]),
            listed: false,
            unavailable: false,
            next: None,
            after: 0,
            selected: None,
            moved: false,
            snapshot: None,
            diff: cx.new(|cx| DiffState::new(vec![], cx)),
            file_picker,
            file: None,
            source: None,
            source_side: "after",
            records: vec![],
            records_open: false,
            busy: false,
            error: None,
            patch_error: None,
            focus: cx.focus_handle().tab_stop(true),
            summary_scroll: Default::default(),
            source_scroll: Default::default(),
            list_scroll: Default::default(),
            _subscriptions: subscriptions,
        }
    }
    pub(crate) fn sync(
        &mut self,
        scope: Option<Scope>,
        target: Option<Target>,
        options: Option<LocalOptions>,
        visible: bool,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let scope = scope.filter(Scope::valid);
        let changed = self.scope != scope
            || !crate::session_file_view_reader::same_source(
                self.options.as_ref(),
                options.as_ref(),
            );
        if changed {
            self.cancel();
            self.close_change(cx);
            self.requests.clear();
            self.clear_saved();
            self.listed = false;
            self.unavailable = false;
            self.scope = scope;
            self.options = options;
            self.error = None;
            self.next = None;
            self.after = 0;
        }
        let retarget = changed || self.target != target;
        if retarget && !changed {
            // Another change, or back to the list: the list stays, the change does not.
            self.cancel();
            self.close_change(cx);
            self.error = None;
        }
        self.target = target;
        let opening = visible && !self.visible;
        if !visible {
            self.cancel();
            if self.visible {
                self.clear_comparison(cx);
                cx.notify();
            }
        }
        self.visible = visible;
        if visible && (changed || !self.listed) {
            self.refresh(w, cx);
        } else if visible && (retarget || opening) {
            self.open_target(w, cx);
        }
        if changed || retarget || opening {
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
    fn clear_saved(&mut self) {
        self.saved.clear();
        self.saved_project = None;
        self.saved_more = false;
        self.not_captured = false;
        self.capture_notice = None;
        self.capture_limits.clear();
    }
    /// The targeted change, as currently listed. Never guesses another.
    fn listed_target(&self) -> Option<Opened> {
        match self.target.as_ref()? {
            Target::Request(id) => {
                self.requests
                    .iter()
                    .find(|r| &r.request_id == id)
                    .map(|r| Opened {
                        target: Target::Request(r.request_id.clone()),
                        session: r.session_id.clone(),
                        project: r.project_id.clone(),
                        title: r.title.clone(),
                        status: r.status(),
                        comparison: r.comparison.clone(),
                    })
            }
            Target::Saved(id) => {
                let chat = self.scope.as_ref()?.chat.clone()?;
                let c = self.saved.iter().find(|c| &c.snapshot_id == id)?;
                Some(Opened {
                    target: Target::Saved(id.clone()),
                    session: chat,
                    project: self.saved_project.clone()?,
                    title: c.label(),
                    status: "No review request",
                    comparison: c.clone(),
                })
            }
        }
    }
    /// Opens the targeted change once it is listed, unless its chat is known to be in
    /// another project now.
    fn open_target(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.target.clone() else {
            return;
        };
        let open = match self.selected.clone() {
            Some(s) if s.target == target => s,
            Some(_) => return,
            None => match self.listed_target() {
                Some(o) => o,
                None => return,
            },
        };
        self.selected = Some(open.clone());
        if self.moved || self.revoke_moved(cx) {
            // Refresh keeps saying why the latched change stays closed.
            self.error = Some(MOVED);
            return;
        }
        if let Some(k) = self.chat_key() {
            self.clear_comparison(cx);
            self.request(Route::Snapshot(k, Box::new(open.comparison)), w, cx);
        }
    }
    /// The chats known here, for moves and the current-file handoff.
    pub(crate) fn observe_chats(
        &mut self,
        chats: Arc<Vec<crate::local_model::Chat>>,
        cx: &mut Context<Self>,
    ) {
        if Arc::ptr_eq(&self.chats, &chats) {
            return;
        }
        self.chats = chats;
        // A saved list read under the chat's old project never stays on screen.
        if let (Some(chat), Some(project)) = (
            self.scope.as_ref().and_then(|s| s.chat.as_ref()),
            self.saved_project.as_ref(),
        ) && self
            .chats
            .iter()
            .find(|c| &c.id == chat)
            .is_some_and(|c| c.project_id.as_ref() != Some(project))
        {
            self.clear_saved();
            cx.notify();
        }
        self.revoke_moved(cx);
        cx.notify();
    }
    /// A known move of the open change's chat to another project revokes its display at
    /// once and latches until another change opens. Missing rows are not proof.
    fn revoke_moved(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(open) = self.selected.as_ref() else {
            return false;
        };
        let moved = self
            .chats
            .iter()
            .find(|c| c.id == open.session)
            .is_some_and(|c| c.project_id.as_ref() != Some(&open.project));
        if moved && !self.moved {
            self.cancel();
            self.clear_comparison(cx);
            self.moved = true;
            self.error = Some(MOVED);
            cx.notify();
        }
        moved
    }
    /// The exact custody chat every snapshot, records and source read goes through, with
    /// the request's listed project as the host-checked expectation. None once it moved.
    fn chat_key(&self) -> Option<wire::Chat> {
        if self.moved {
            return None;
        }
        let open = self.selected.as_ref()?;
        self.chat_ref(&open.session, &open.project)
    }
    fn chat_ref(&self, chat: &str, project: &str) -> Option<wire::Chat> {
        Some(wire::Chat {
            key: Key {
                home: self.scope.as_ref()?.home.clone(),
                id: chat.to_owned(),
            },
            project: project.to_owned(),
        })
    }
    fn close_change(&mut self, cx: &mut Context<Self>) {
        self.selected = None;
        self.moved = false;
        self.clear_comparison(cx);
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
    fn items(p: &Entity<Picker>, items: Vec<Item>, w: &mut Window, cx: &mut Context<Self>) {
        p.update(cx, |p, cx| {
            p.set_items(SearchableVec::new(items), w, cx);
            p.set_selected_index(None, w, cx);
        });
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    /// A diff or retained source is on screen (possibly while refreshing).
    fn has_content(&self) -> bool {
        self.source.is_some() || self.snapshot.is_some()
    }
    fn loading_label(&self) -> &'static str {
        match self.route {
            Some(Route::Requests(..)) => "Loading Review…",
            Some(Route::Comparisons(..)) => "Loading saved revisions…",
            Some(Route::Snapshot(..)) => "Loading diff…",
            Some(Route::Records(..)) => "Loading evidence…",
            Some(Route::Source(..)) => "Loading source…",
            None => "Loading…",
        }
    }
    /// A chat's saved revisions that no listed request already covers.
    fn saved_rows(&self) -> impl Iterator<Item = &model::Comparison> {
        self.saved.iter().filter(|c| {
            !self
                .requests
                .iter()
                .any(|r| r.comparison.snapshot_id == c.snapshot_id)
        })
    }
    fn has_rows(&self) -> bool {
        !self.requests.is_empty() || self.saved_rows().next().is_some()
    }
    /// What fills the page when there is no list or diff: loading is not empty, and
    /// no request source is not "nothing to review". Never auto-selects.
    fn state_message(&self) -> Option<(&'static str, Option<&'static str>)> {
        if self.has_content() {
            return None;
        }
        if self.busy && (!self.has_rows() || self.target.is_some()) {
            return Some((self.loading_label(), None));
        }
        if self.busy {
            // Refreshing keeps the current list on screen.
            return None;
        }
        if self.error.is_some() || self.selected.is_some() {
            // The visible warning explains it; nothing else is guessed.
            return None;
        }
        if self.scope.is_none() {
            return Some(("Review is unavailable.", None));
        }
        if !self.listed {
            return None;
        }
        if self.target.is_some() {
            return Some((
                "This change isn't in the loaded list.",
                Some("It may be on another page or no longer listed. Go back to the list."),
            ));
        }
        if self.has_rows() {
            return None;
        }
        if self.unavailable {
            return Some((
                "Review requests are unavailable.",
                Some("Saved revisions aren't shown as waiting without a review request."),
            ));
        }
        let from_chat = self.scope.as_ref().is_some_and(|s| s.chat.is_some());
        if from_chat && self.not_captured {
            return Some((
                "Not captured",
                Some("This chat has no saved revisions. Opening Review doesn't capture anything."),
            ));
        }
        Some((
            if from_chat {
                "Nothing from this chat is waiting for review."
            } else {
                "Nothing is waiting for review."
            },
            None,
        ))
    }
    /// A later saved revision of the open change is also listed; the open one stays.
    fn newer_listed(&self) -> bool {
        self.selected.as_ref().is_some_and(|p| {
            self.requests
                .iter()
                .map(|r| &r.comparison)
                .chain(self.saved.iter())
                .any(|c| p.comparison.superseded_by(c))
        })
    }
    /// The open change is no longer in the refreshed list; it stays pinned and shown.
    fn unlisted(&self) -> bool {
        self.listed
            && self.selected.as_ref().is_some_and(|p| match &p.target {
                Target::Request(id) => !self.requests.iter().any(|r| &r.request_id == id),
                Target::Saved(id) => !self.saved.iter().any(|c| &c.snapshot_id == id),
            })
    }
    #[cfg(feature = "native-probes")]
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
    /// Rereads the list page (and a chat's saved revisions), then the open change.
    fn refresh(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(scope) = self.scope.clone() else {
            return;
        };
        self.request(Route::Requests(scope.home, self.after, scope.chat), w, cx);
    }
    fn page(&mut self, after: u64, w: &mut Window, cx: &mut Context<Self>) {
        self.after = after;
        self.refresh(w, cx);
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
                if matches!(r.route, Route::Requests(..)) {
                    // An unreadable list never leaves an older one looking current.
                    self.requests.clear();
                    self.next = None;
                }
                if matches!(r.route, Route::Requests(..) | Route::Comparisons(..)) {
                    self.clear_saved();
                }
            }
            Ok(Data::Requests(v)) => {
                // The reader already checked the filter; nothing else is inferred.
                self.listed = true;
                self.unavailable = v.unavailable.is_some();
                self.requests = v.requests;
                self.next = v.next;
                self.error = None;
            }
            Ok(Data::Comparisons(v)) => {
                let Route::Comparisons(chat, _) = &r.route else {
                    return;
                };
                self.capture_notice = v.capture.as_ref().and_then(model::CaptureStatus::notice);
                self.capture_limits = v
                    .capture
                    .as_ref()
                    .map(model::CaptureStatus::limitations)
                    .unwrap_or_default();
                self.saved = v.comparisons;
                self.saved_more = v.next.is_some();
                self.saved_project = Some(chat.project.clone());
                // On the chat route every `unavailable` reason means no current retained
                // custody: an honest Not captured state, never an error or a mission
                // requirement. The host's reason text is not a stable token, so it is not matched.
                self.not_captured = v.unavailable.is_some();
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
                let Route::Source(_, _, side, path, _) = r.route else {
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
                self.source_side = if side == "before" { "before" } else { "after" };
                self.source = Some((path, format!("{shown}{suffix}").into()));
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
            Some(Route::Requests(..)) => {
                // A chat-narrowed Review also lists that chat's saved revisions, under the
                // project the chat is in here. Without a known project, none are read.
                let saved = self
                    .scope
                    .as_ref()
                    .and_then(|s| s.chat.clone())
                    .and_then(|id| {
                        let project = self
                            .chats
                            .iter()
                            .find(|c| c.id == id && !c.local_draft)?
                            .project_id
                            .clone()?;
                        self.chat_ref(&id, &project)
                    });
                match saved {
                    Some(k) => self.request(Route::Comparisons(k, 0), w, cx),
                    None => self.open_target(w, cx),
                }
            }
            Some(Route::Comparisons(..)) => self.open_target(w, cx),
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
                // Jumping is navigation only; the full file list stays in the diff.
                Self::items(&self.file_picker, items, w, cx);
            }
            _ => {}
        }
    }
    fn back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.source.is_some() {
            // A pending Before/After read must not reopen source after Back.
            if matches!(self.route, Some(Route::Source(..))) {
                self.cancel();
            }
            self.source = None;
            self.diff.read(cx).focus_handle(cx).focus(w, cx);
        } else {
            self.cancel();
            cx.emit(Event::Close);
        }
        cx.notify();
    }
    /// Opens retained source for one file of the shown diff: after, or before for deletions.
    fn view_file(&mut self, path: String, w: &mut Window, cx: &mut Context<Self>) {
        let side = match self
            .diff
            .read(cx)
            .files()
            .iter()
            .find(|f| f.path().as_ref() == path)
        {
            Some(f) if f.modified_path().is_none() => "before",
            Some(_) => "after",
            None => return,
        };
        self.file = Some(path);
        self.read_source(side, w, cx);
    }
    /// The retained path of one side of the current file, if that side exists.
    fn side_path(&self, side: &str, cx: &App) -> Option<String> {
        let file = self.file.as_ref()?;
        self.diff
            .read(cx)
            .files()
            .iter()
            .find(|f| f.path().as_ref() == file.as_str())
            .and_then(|f| {
                if side == "before" {
                    f.original_path()
                } else {
                    f.modified_path()
                }
            })
            .map(|p| p.to_string())
    }
    /// The retained text entry for one side of the current file, if that side exists as text.
    fn source_entry(&self, side: &str, cx: &App) -> Option<model::Source> {
        let s = self.snapshot.as_ref()?;
        let path = self.side_path(side, cx)?;
        let entries = if side == "before" {
            &s.before
        } else {
            &s.after
        };
        entries
            .iter()
            .find(|e| e.path == path && e.state == "text")
            .cloned()
    }
    pub(super) fn side_available(&self, side: &str, cx: &App) -> bool {
        self.source_entry(side, cx).is_some()
    }
    /// The open change's custody and the file's after path, when its current workspace
    /// file can be shown in that chat. Review itself never shows live content.
    fn current_file_target(&self, cx: &App) -> Option<Event> {
        let open = self.selected.as_ref().filter(|_| !self.moved)?;
        // The change's chat is loaded here, in the project its change was listed under.
        let loaded = self.chats.iter().any(|c| {
            c.id == open.session
                && !c.local_draft
                && !c.cwd.is_empty()
                && c.project_id.as_ref() == Some(&open.project)
        });
        if !loaded {
            return None;
        }
        let path = self.side_path("after", cx)?;
        let home = self.scope.as_ref()?.home.clone();
        crate::session_file_view::valid_path(&path).then(|| Event::CurrentFile {
            home,
            chat: open.session.clone(),
            project: open.project.clone(),
            path,
        })
    }
    fn read_source(&mut self, side: &str, w: &mut Window, cx: &mut Context<Self>) {
        let (Some(k), Some(s)) = (self.chat_key(), self.snapshot.clone()) else {
            return;
        };
        let Some(e) = self.source_entry(side, cx) else {
            self.error =
                Some("This side is absent, binary or unsupported. Retained text is unavailable.");
            cx.notify();
            return;
        };
        if let Some(sha) = &e.sha256 {
            self.request(
                Route::Source(
                    k,
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

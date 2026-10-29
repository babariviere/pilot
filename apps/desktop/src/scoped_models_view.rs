//! Retained Local settings editor. Only explicit Save may PUT, Check is GET-only.
use crate::{
    LocalOptions,
    scoped_models::{Candidate, Save, Snapshot},
    scoped_models_worker::{Command, Update, Worker},
    ui::{self, Action, FieldRow, Notice, Text, Tone},
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{
    AppContext, Context, Entity, EntityInputHandler, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, Styled, Subscription, Task, TestSupportExt, Window,
    component::{
        ActiveTheme, Disableable, Icon, IconName, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        checkbox::Checkbox,
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
    },
    div, relative, rems,
};
pub(crate) struct ScopedModels {
    source: Option<LocalOptions>,
    worker: Option<Worker>,
    updates: Option<Task<()>>,
    request: u64,
    baseline: Option<Snapshot>,
    observed: Option<Snapshot>,
    pending: Option<Save>,
    pending_text: Option<String>,
    pub(crate) patterns: Entity<TextareaState>,
    pub(crate) search: Entity<InputState>,
    all: bool,
    edited: bool,
    busy: bool,
    unconfirmed: bool,
    advanced: bool,
    shown: usize,
    folded_providers: std::collections::BTreeSet<String>,
    problem: Option<&'static str>,
    status: &'static str,
    confirm_revert: bool,
    _subscriptions: Vec<Subscription>,
    owner_window: gpui_kit::AnyWindowHandle,
    synced_text: String,
    active_save: bool,
    worker_stopped: bool,
}
pub(crate) struct ScopeChanged;
impl gpui_kit::EventEmitter<ScopeChanged> for ScopedModels {}
// Presentation only: provider identity comes from the catalog, never an ID split.
// Sort sections by exact provider key; retain catalog order within each section.
// Filter before applying the existing global display budget, omitting empty groups.
fn provider_groups<'a>(
    candidates: &'a [Candidate],
    query: &str,
    shown: usize,
) -> (usize, Vec<(&'a str, Vec<&'a Candidate>)>) {
    let mut groups = std::collections::BTreeMap::<&str, Vec<&Candidate>>::new();
    let mut matched = 0;
    for candidate in candidates {
        if query.is_empty() || candidate.search_key.contains(query) {
            groups
                .entry(&candidate.provider)
                .or_default()
                .push(candidate);
            matched += 1;
        }
    }
    let mut remaining = shown;
    let groups = groups
        .into_iter()
        .filter_map(|(provider, mut rows)| {
            rows.truncate(remaining);
            remaining -= rows.len();
            (!rows.is_empty()).then_some((provider, rows))
        })
        .collect();
    (matched, groups)
}
impl ScopedModels {
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_state(&self) -> (bool, bool, bool, bool, Option<Vec<String>>) {
        (
            self.baseline.is_some(),
            self.busy,
            self.unconfirmed,
            self.worker_stopped,
            self.baseline
                .as_ref()
                .and_then(|s| s.enabled_models.clone()),
        )
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn disconnect_fixture(&self) {
        if let Some(worker) = &self.worker {
            worker.disconnect_fixture();
        }
    }
    pub(crate) fn new(
        source: Option<LocalOptions>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let patterns = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(3, 7)
                .placeholder("One literal model pattern per line")
        });
        patterns.update(cx, |t, cx| t.set_submit_on_enter(false, cx));
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder("Find an authenticated model…"));
        let changed = cx.subscribe(&patterns, |v, state, event, cx| {
            if matches!(event, InputEvent::Change)
                && state.read(cx).value().as_ref() != v.synced_text
            {
                v.edited = true;
                v.confirm_revert = false;
                cx.notify();
            }
        });
        let searched = cx.subscribe(&search, |v, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                v.shown = 30;
                cx.notify();
            }
        });
        Self {
            source,
            worker: None,
            updates: None,
            request: 0,
            baseline: None,
            observed: None,
            pending: None,
            pending_text: None,
            patterns,
            search,
            all: true,
            edited: false,
            busy: false,
            unconfirmed: false,
            advanced: false,
            shown: 30,
            folded_providers: Default::default(),
            problem: None,
            status: "Open Scoped models to read the global pi baseline. Nothing is written on load.",
            confirm_revert: false,
            _subscriptions: vec![changed, searched],
            owner_window: window.window_handle(),
            synced_text: String::new(),
            active_save: false,
            worker_stopped: false,
        }
    }
    pub(crate) fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.patterns
            .update(cx, |t, cx| t.marked_text_range(w, cx).is_some())
            || self
                .search
                .update(cx, |t, cx| t.marked_text_range(w, cx).is_some())
    }
    fn selection(&self, cx: &gpui_kit::App) -> Option<Vec<String>> {
        (!self.all).then(|| {
            self.patterns
                .read(cx)
                .value()
                .split('\n')
                .map(str::to_owned)
                .collect()
        })
    }
    pub(crate) fn unsettled(&self, cx: &gpui_kit::App) -> bool {
        self.busy
            || self.unconfirmed
            || self.edited
            || self.baseline.as_ref().is_some_and(|b| {
                let normalized = b.enabled_models.as_ref().filter(|p| !p.is_empty()).cloned();
                normalized != self.selection(cx)
            })
    }
    pub(crate) fn load(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.baseline.is_none() {
            self.check(w, cx);
        }
    }
    pub(crate) fn check(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.marked(w, cx) {
            return;
        }
        if self.worker_stopped {
            self.worker = None;
            self.updates = None;
            self.worker_stopped = false;
        }
        self.send(None, cx);
    }
    fn send(&mut self, save: Option<Save>, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            self.problem = Some(
                "Scoped models are available only in the real Local viewer, not this synthetic fixture.",
            );
            cx.notify();
            return;
        };
        if self.worker.is_none() {
            match Worker::start(source) {
                Err(error) => {
                    self.problem = Some(error);
                    cx.notify();
                    return;
                }
                Ok((worker, updates)) => {
                    self.worker = Some(worker);
                    let handle = self.owner_window;
                    self.updates = Some(cx.spawn(async move |v, cx| {
                        while let Ok(update) = updates.recv().await {
                            if !cx
                                .update_window(handle, |_, w, cx| {
                                    v.update(cx, |v, cx| v.accept(update, w, cx))
                                })
                                .is_ok_and(|r| r.is_ok())
                            {
                                break;
                            }
                        }
                        let _ = v.update(cx, |v, cx| {
                            v.worker_stopped = true;
                            if v.pending.is_some() {
                                v.unconfirmed = true;
                            }
                            v.busy = false;
                            v.problem =
                                Some("Local model worker stopped. Retained edits were not resent.");
                            cx.notify();
                        });
                    }));
                }
            }
        }
        self.request += 1;
        let command = match save.clone() {
            Some(save) => Command::Save(self.request, save),
            None => Command::Read(self.request),
        };
        if self.worker.as_ref().is_some_and(|w| w.command(command)) {
            self.active_save = save.is_some();
            if let Some(save) = save {
                self.pending_text = Some(self.patterns.read(cx).value().to_string());
                self.pending = Some(save);
                self.status = "Saving the global pi scope, then reading it back…";
            } else {
                self.status = "Checking current Local pi settings…";
            }
            self.busy = true;
            self.problem = None;
        } else {
            self.problem =
                Some("Local model worker unavailable. Nothing was queued; edits are retained.");
        }
        cx.notify();
    }
    pub(crate) fn save(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.editable() || self.marked(w, cx) {
            return;
        }
        let selection = self.selection(cx);
        if let Err(error) = crate::scoped_models::valid_selection(&selection) {
            self.problem = Some(error);
            cx.notify();
            return;
        }
        let Some(base) = &self.baseline else {
            return;
        };
        self.send(
            Some(Save {
                enabled_models: selection,
                expected_hash: base.scope_hash.clone(),
            }),
            cx,
        );
    }
    fn apply(&mut self, snapshot: Snapshot, w: &mut Window, cx: &mut Context<Self>) {
        self.all = snapshot.all_models;
        let text = snapshot
            .enabled_models
            .as_ref()
            .map(|p| p.join("\n"))
            .unwrap_or_default();
        self.synced_text = text.clone();
        self.patterns.update(cx, |t, cx| t.set_value(text, w, cx));
        self.baseline = Some(snapshot);
        self.pending = None;
        self.pending_text = None;
        self.unconfirmed = false;
        self.edited = false;
    }
    fn accept(&mut self, Update(id, reply): Update, w: &mut Window, cx: &mut Context<Self>) {
        if id != self.request {
            return;
        }
        if reply.attempted {
            cx.emit(ScopeChanged);
        }
        self.busy = false;
        self.problem = reply.problem;
        if self.active_save && !reply.attempted {
            self.pending = None;
            self.pending_text = None;
        }
        match reply.observation {
            Err(error) => {
                self.problem = Some(error);
                self.unconfirmed |= reply.attempted;
                self.status = "Couldn't confirm the current models. Your edits are kept.";
            }
            Ok(snapshot) => {
                let matches = self
                    .pending
                    .as_ref()
                    .is_some_and(|p| p.enabled_models == snapshot.enabled_models);
                self.observed = Some(snapshot.clone());
                if matches
                    && (self
                        .pending
                        .as_ref()
                        .is_some_and(|p| p.enabled_models != self.selection(cx))
                        || self
                            .pending_text
                            .as_ref()
                            .is_some_and(|t| t != self.patterns.read(cx).value().as_ref()))
                {
                    self.baseline = Some(snapshot);
                    self.pending = None;
                    self.pending_text = None;
                    self.unconfirmed = false;
                    self.edited = true;
                    self.status = "Current pi scope verified. Newer unsaved edits are retained.";
                } else if matches || (self.baseline.is_none() && !self.edited) {
                    self.apply(snapshot, w, cx);
                    self.status = "Current global pi scope verified.";
                } else if self.pending.is_some() {
                    self.unconfirmed = true;
                    self.status = "Current pi scope differs from your submitted list. Review current values before another save.";
                } else if !self.edited {
                    self.apply(snapshot, w, cx);
                    self.status = "Current global pi scope loaded.";
                } else {
                    self.status = "Current pi values checked. Your unsaved list and original CAS baseline are retained.";
                }
            }
        }
        cx.notify();
    }
    fn revert(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.marked(w, cx) {
            return;
        }
        if self.unsettled(cx) && !self.confirm_revert {
            self.confirm_revert = true;
            cx.notify();
            return;
        }
        if let Some(snapshot) = self.observed.clone() {
            self.apply(snapshot, w, cx);
            self.problem = None;
            self.confirm_revert = false;
            self.status = "Using the currently observed pi list. No write was sent.";
        }
    }
    fn editable(&self) -> bool {
        self.source.is_some()
            && self.baseline.is_some()
            && !self.busy
            && !self.unconfirmed
            && !self.worker_stopped
    }
    fn choose(&mut self, id: &str, checked: bool, w: &mut Window, cx: &mut Context<Self>) {
        if !self.editable()
            || self.marked(w, cx)
            || self
                .observed
                .as_ref()
                .is_none_or(|s| !s.candidates.iter().any(|c| c.id == id))
        {
            return;
        }
        let value = self.patterns.read(cx).value().to_string();
        let mut patterns = if value.is_empty() {
            Vec::new()
        } else {
            value.split('\n').map(str::to_owned).collect::<Vec<_>>()
        };
        if checked {
            if !patterns.iter().any(|s| s == id) {
                patterns.push(id.into());
            }
        } else {
            patterns.retain(|s| s != id);
        }
        self.all = false;
        self.edited = true;
        self.patterns
            .update(cx, |t, cx| t.set_value(patterns.join("\n"), w, cx));
        cx.notify();
    }
    fn toggle_provider(&mut self, provider: &str, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) || !self.search.read(cx).value().is_empty() {
            return;
        }
        if !self.folded_providers.remove(provider) {
            self.folded_providers.insert(provider.to_owned());
        }
        cx.notify();
    }
}

#[cfg(feature = "native-probes")]
#[path = "scoped_models_groups_probe.rs"]
pub(crate) mod groups_probe;
#[cfg(test)]
#[path = "scoped_models_view_tests.rs"]
mod tests;
impl Render for ScopedModels {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let editable = self.editable();
        let selection = self.selection(cx);
        let error = crate::scoped_models::valid_selection(&selection).err();
        let query = self
            .search
            .read(cx)
            .value()
            .chars()
            .take(256)
            .collect::<String>()
            .to_lowercase();
        let (matched, groups) = self
            .observed
            .as_ref()
            .map(|s| provider_groups(&s.candidates, &query, self.shown))
            .unwrap_or_default();
        let selected_ids = selection
            .as_ref()
            .into_iter()
            .flatten()
            .collect::<std::collections::HashSet<_>>();
        let mut selected_by_provider = std::collections::BTreeMap::<&str, usize>::new();
        for candidate in self
            .observed
            .as_ref()
            .into_iter()
            .flat_map(|s| &s.candidates)
        {
            if selected_ids.contains(&candidate.id) {
                *selected_by_provider.entry(&candidate.provider).or_default() += 1;
            }
        }
        div().id("scoped-models").test_support().v_flex().gap_3().min_w_0()
            .child(ui::header("scoped-models-title","Scoped models",Text::Title)
                .child(ui::text(Text::Body,"Choose pi’s global models on this Mac. Changes apply only when you save.")))
            .child(Checkbox::new("scope-all").label("All authenticated models").checked(self.all).disabled(!editable)
                .on_change(cx.listener(|v,value,w,cx|{if v.editable()&&!v.marked(w,cx){v.all = *value;v.edited=true;cx.notify();}})))
            .child(ui::text(Text::Caption,"Project overrides, default models, sign-ins and running chats remain unchanged."))
            .child(div().h_flex().gap_2().flex_wrap()
                .child(ui::action("scope-save","Save changes",Action::Primary).disabled(!editable || !self.unsettled(cx) || error.is_some()).on_click(cx.listener(|v,_,w,cx|v.save(w,cx))))
                .child(ui::action("scope-check","Check again",Action::Quiet).disabled(self.source.is_none()||self.busy).on_click(cx.listener(|v,_,w,cx|v.check(w,cx))))
                .child(ui::action("scope-revert",if self.confirm_revert{"Confirm use current pi values"}else{"Use current pi values"},Action::Secondary).disabled(self.observed.is_none()||self.busy).on_click(cx.listener(|v,_,w,cx|v.revert(w,cx)))))
            .child(Notice::new(self.status).tone(if self.unconfirmed{Tone::Warning}else{Tone::Quiet}))
            .children(self.problem.map(|error|Notice::new(error).tone(Tone::Error)))
            .children((!self.all).then_some(error).flatten().map(|error|Notice::new(error).tone(Tone::Warning)))
            .children(self.confirm_revert.then(||Notice::new("This discards the unsaved selection and adopts the last observed pi list without writing. It does not prove that an unconfirmed earlier save failed.").tone(Tone::Warning)))
            .when(!self.all,|this|this
                .child(FieldRow::new("scope-search-row","Available models",Input::new(&self.search).aria_label("Find authenticated models").disabled(!editable)))
                .children(groups.into_iter().map(|(provider, candidates)| {
                    let open = !query.is_empty() || !self.folded_providers.contains(provider);
                    let label = if provider.is_empty() { "Unspecified provider" } else { provider };
                    let provider_key = provider.to_owned();
                    let selected = selected_by_provider.get(provider).copied().unwrap_or(0);
                    // Flat list: the toggle is outdented by its own px_2 on both sides so the chevron,
                    // every model checkbox and All share the page edge; names line up with the label.
                    div().id(SharedString::from(format!("scope-provider-{provider}"))).test_support().v_flex().min_w_0()
                        .child(Button::new(SharedString::from(format!("scope-provider-toggle-{provider}"))).ghost().small().justify_start().mx(rems(-0.5))
                            .accessibility_label(SharedString::from(format!("{} {label}, {selected} selected", if open { "Collapse" } else { "Expand" })))
                            .disabled(!query.is_empty())
                            .tooltip(if query.is_empty() { "Expand or collapse provider" } else { "Search keeps matching providers expanded. Clear search to fold them." })
                            .child(div().h_flex().items_center().gap_2().w_full().min_w_0()
                                .child(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }).small())
                                .child(ui::text(Text::Label, SharedString::from(label)).id(SharedString::from(format!("scope-provider-title-{provider}"))).test_support().truncate().font_semibold().text_color(cx.theme().muted_foreground))
                                .when(selected > 0, |this| this.child(ui::text(Text::Caption, SharedString::from(format!("{selected} selected"))).text_color(cx.theme().muted_foreground))))
                            .on_click(cx.listener(move |v,_,w,cx| v.toggle_provider(&provider_key,w,cx))))
                        .when(open, |this| this.child(div().v_flex().min_w_0()
                            .children(candidates.into_iter().map(|c|{
                    let id=c.id.clone();let checked=selection.as_ref().is_some_and(|p|p.iter().any(|s|s==&id));
                    // One line per model: checkbox, name, then the muted ID trailing. The ID truncates
                    // first; the full ID stays in the accessible name. The whole row is one hit target.
                    Checkbox::new(SharedString::from(format!("scope-model-{id}"))).small().w_full().min_w_0().py_1()
                        .accessibility_label(SharedString::from(format!("{}, {id}", c.name)))
                        .checked(checked).disabled(!editable)
                        .child(div().h_flex().items_center().w_full().min_w_0()
                            .child(ui::text(Text::Body, SharedString::from(c.name.clone())).id(SharedString::from(format!("scope-model-name-{id}"))).test_support().flex_shrink_0().max_w(relative(0.65)).truncate())
                            .child(ui::text(Text::Caption, SharedString::from(id.clone())).id(SharedString::from(format!("scope-model-id-{id}"))).test_support().ml_auto().pl_3().min_w_0().truncate().text_color(cx.theme().muted_foreground)))
                        .on_change(cx.listener(move|v,checked,w,cx|v.choose(&id,*checked,w,cx)))
                }))))
                }))
                .child(ui::text(Text::Caption,SharedString::from(format!("{} of {matched} authenticated models loaded. Unavailable patterns are preserved.",matched.min(self.shown)))))
                .when(matched>self.shown,|this|this.child(ui::action("scope-show-more","Show more models",Action::Quiet).on_click(cx.listener(|v,_,_,cx|{v.shown=(v.shown+30).min(2048);cx.notify();}))))
                .child(ui::action("scope-advanced",if self.advanced{"Hide literal patterns"}else{"Advanced literal patterns…"},Action::Quiet).on_click(cx.listener(|v,_,w,cx|{if !v.marked(w,cx){v.advanced = !v.advanced;cx.notify();}})))
                .when(self.advanced,|this|this.child(FieldRow::new("scope-patterns-row","Literal patterns, in order",Textarea::new(&self.patterns).aria_label("Global model patterns").readonly(!editable))
                    .description("One per line. Order, duplicates, unavailable patterns, wildcards and thinking suffixes are kept literally. No automatic substitution."))))
            .children(self.observed.as_ref().into_iter().flat_map(|s|s.resolution.iter()).filter_map(|r|r.unresolved.as_ref().map(|reason|ui::text(Text::Caption,SharedString::from(format!("Current pi pattern {}: {reason}. No automatic substitution.",r.pattern))))))
    }
}

//! Composer model/thinking controls, native Select behavior and parent-owned actions.
use super::*;
use crate::{
    chat_model_reader::{Reader, Request, Scope, Update},
    chat_models::{self, Catalog, Choice as ModelChoice, DraftChoice, SessionModel, Target},
    ui::{self, Action, Notice, Tone},
};
use gpui_kit::{
    App, DismissEvent, Task,
    component::{
        FocusableExt,
        select::{SearchableVec, Select, SelectEvent, SelectItem, SelectState},
    },
    prelude::FluentBuilder,
};
use std::sync::Arc;
#[path = "chat_subscription.rs"]
mod subscription;
#[cfg(test)]
#[path = "chat_model_picker_tests.rs"]
mod tests;
/// Disabled menu row that explains a busy chat's locked model/thinking to keyboard users.
const BUSY_ITEM: &str = ":busy";
/// Presentation only: catalog IDs remain unchanged for selection and saving.
fn thinking_title(level: &str) -> String {
    let mut chars = level.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}
fn busy_item() -> Item {
    Item {
        id: BUSY_ITEM.into(),
        title: "Available when this chat is idle".into(),
        detail: "After its work and queued messages finish".into(),
        disabled: true,
        search: SharedString::default(),
    }
}
#[derive(Clone)]
struct Item {
    id: String,
    title: SharedString,
    detail: SharedString,
    disabled: bool,
    search: SharedString,
}
impl SelectItem for Item {
    type Value = String;
    fn value(&self) -> &String {
        &self.id
    }
    fn title(&self) -> SharedString {
        self.title.clone()
    }
    fn disabled(&self) -> bool {
        self.disabled
    }
    fn matches(&self, query: &str) -> bool {
        query.len() <= 256 && self.search.contains(&query.to_lowercase())
    }
    fn render(&self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let row = div()
            .id(SharedString::from(format!("model-option-{}", self.id)))
            .v_flex()
            .min_w_0()
            .child(div().min_w_0().truncate().child(self.title.clone()))
            .child(
                div()
                    .text_xs()
                    .min_w_0()
                    .truncate()
                    .child(self.detail.clone()),
            );
        #[cfg(any(test, feature = "native-probes"))]
        let row = row.test_support();
        row
    }
}
pub(super) struct Picker {
    epoch: String,
    for_model: Option<String>,
    scope: Scope,
    catalog: Option<Arc<Catalog>>,
    deferred: Option<(Catalog, Option<SessionModel>)>,
    error: Option<&'static str>,
    loading: bool,
    models: Entity<SelectState<SearchableVec<Item>>>,
    thinking: Entity<SelectState<SearchableVec<Item>>>,
    /// Choice, new draft, editable, failed, continuable, waiting for work: the inputs items were built from.
    synced: Option<(Option<ModelChoice>, bool, bool, bool, bool, bool)>,
    _subscriptions: Vec<Subscription>,
}
pub(super) struct Models {
    options: crate::LocalOptions,
    reader: Option<Reader>,
    task: Option<Task<()>>,
    request: u64,
    picker: Option<Picker>,
    current: Option<(String, String, SessionModel)>,
    mutation: u64,
    handled: u64,
    busy: bool,
    error: Option<&'static str>,
    confirm_ack: bool,
    inspection: Option<String>,
    continuation: Option<subscription::Continuation>,
}
impl ChatEditor {
    #[cfg(feature = "native-probes")]
    pub(crate) fn model_probe_state(&self) -> (bool, bool, Option<ModelChoice>, bool, bool) {
        (
            self.models
                .as_ref()
                .and_then(|m| m.picker.as_ref())
                .is_some_and(|p| p.catalog.is_some() && !p.loading),
            self.models.as_ref().is_some_and(|m| m.busy),
            self.model_choice(),
            self.model_uncertain().is_some(),
            self.models.as_ref().is_none_or(|m| m.reader.is_none()),
        )
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn model_probe_restriction(&self) -> Option<&'static str> {
        self.model_restriction()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn model_probe_pending(&mut self, pending: bool) {
        if pending {
            self.pending.insert("chat:source".into(), 1);
        } else {
            self.pending.remove("chat:source");
        }
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn disconnect_model_fixture(&self) {
        if let Some(reader) = self.models.as_ref().and_then(|m| m.reader.as_ref()) {
            reader.disconnect_fixture();
        }
    }
    pub(crate) fn enable_models(
        &mut self,
        options: crate::LocalOptions,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.models = Some(Models {
            options,
            reader: None,
            task: None,
            request: 0,
            picker: None,
            current: None,
            mutation: 0,
            handled: 0,
            busy: false,
            error: None,
            confirm_ack: false,
            inspection: None,
            continuation: None,
        });
        self.sync_models(w, cx);
    }
    pub(crate) fn model_context(
        &mut self,
        id: &str,
        path: &str,
        mut current: SessionModel,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let editable = self.can_choose_model();
        if let Some(models) = &mut self.models {
            if let Some((old_id, old_path, old)) = &models.current
                && old_id == id
                && old_path == path
                && old.updated_at > current.updated_at
            {
                current.model = old.model.clone();
                current.thinking = old.thinking.clone();
                current.updated_at = old.updated_at;
            }
            let next = Some((id.into(), path.into(), current));
            if models.current == next
                && models
                    .picker
                    .as_ref()
                    .and_then(|p| p.synced.as_ref())
                    .is_some_and(|(_, _, old_editable, _, _, _)| *old_editable == editable)
            {
                return;
            }
            models.current = next;
            // A continuation belongs to one held chat; it closes once that changes.
            if models.continuation.as_ref().is_some_and(|c| {
                models
                    .current
                    .as_ref()
                    .is_none_or(|(id, _, s)| !s.continuable || !c.is_for(id))
            }) {
                models.continuation = None;
            }
        }
        self.sync_models(w, cx);
        cx.notify();
    }
    fn model_scope(&self) -> Option<Scope> {
        let key = self.selected.clone()?;
        if key.starts_with("new:") {
            let d = self.draft()?;
            if self.project_problem(d).is_some() {
                return None;
            }
            Some(Scope {
                key,
                project: d.project_id.clone(),
                cwd: d.cwd.clone(),
            })
        } else {
            let (id, path, _) = self.models.as_ref()?.current.as_ref()?;
            if key != format!("chat:{id}") {
                return None;
            }
            Some(Scope {
                key,
                project: None,
                cwd: path.clone(),
            })
        }
    }
    fn model_target(&self) -> Option<Target> {
        let (id, path, s) = self.models.as_ref()?.current.as_ref()?;
        if self.selected.as_deref() != Some(format!("chat:{id}").as_str()) {
            return None;
        }
        Some(Target {
            session: id.clone(),
            cwd: path.clone(),
            model: s.model.clone(),
            thinking: s.thinking.clone(),
            failed_source: s.failed_source.clone(),
        })
    }
    fn model_choice(&self) -> Option<ModelChoice> {
        if self
            .selected
            .as_ref()
            .is_some_and(|k| k.starts_with("new:"))
        {
            self.draft()?
                .model_choice
                .as_ref()
                .map(|c| c.choice.clone())
        } else {
            let s = &self.models.as_ref()?.current.as_ref()?.2;
            s.model.as_ref().map(|m| ModelChoice {
                model: m.clone(),
                thinking: s.thinking.clone(),
            })
        }
    }
    pub(super) fn model_query_marked(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        let picker = self.models.as_ref().and_then(|m| m.picker.as_ref());
        let continuation = self.models.as_ref().and_then(|m| m.continuation.as_ref());
        picker
            .into_iter()
            .flat_map(|p| [&p.models, &p.thinking])
            .chain(continuation.map(|c| c.select()))
            .any(|s| {
                s.read(cx)
                    .query_input(cx)
                    .update(cx, |q, cx| q.marked_text_range(w, cx).is_some())
            })
    }
    fn model_query_busy(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.model_query_marked(w, cx)
            || self
                .models
                .as_ref()
                .and_then(|m| m.picker.as_ref())
                .is_some_and(|p| {
                    [&p.models, &p.thinking]
                        .into_iter()
                        .any(|s| !s.read(cx).query_input(cx).read(cx).value().is_empty())
                })
    }
    pub(super) fn sync_models(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.models.is_none() || self.model_query_marked(w, cx) {
            return;
        }
        let Some(scope) = self.model_scope() else {
            if let Some(m) = &mut self.models {
                m.picker = None;
                m.request += 1;
            }
            return;
        };
        let for_model = self.model_choice().map(|c| c.model);
        let new = self
            .models
            .as_ref()
            .unwrap()
            .picker
            .as_ref()
            .is_none_or(|p| p.scope != scope || p.for_model != for_model);
        if new {
            let retained = self
                .models
                .as_ref()
                .and_then(|m| m.picker.as_ref())
                .filter(|p| p.scope == scope && !p.loading && p.error.is_none())
                .and_then(|p| p.catalog.clone());
            if let Some(old) = self.models.as_ref().and_then(|m| m.picker.as_ref()) {
                for s in [&old.models, &old.thinking] {
                    s.update(cx, |s, cx| s.prepare_navigation(w, cx));
                }
            }
            let models = cx.new(|cx| {
                SelectState::new(SearchableVec::new(Vec::<Item>::new()), None, w, cx)
                    .searchable(true)
            });
            let thinking =
                cx.new(|cx| SelectState::new(SearchableVec::new(Vec::<Item>::new()), None, w, cx));
            let epoch = uuid::Uuid::new_v4().to_string();
            let event_epoch = epoch.clone();
            let source = scope.clone();
            let change = cx.subscribe_in(
                &models,
                w,
                move |v, _, event: &SelectEvent<SearchableVec<Item>>, w, cx| {
                    if let SelectEvent::Confirm(Some(id)) = event {
                        v.choose_model(&source, &event_epoch, id, None, w, cx);
                    }
                },
            );
            let event_epoch = epoch.clone();
            let source = scope.clone();
            let current = for_model.clone();
            let level = cx.subscribe_in(
                &thinking,
                w,
                move |v, _, event: &SelectEvent<SearchableVec<Item>>, w, cx| {
                    if let (SelectEvent::Confirm(Some(level)), Some(current)) = (event, &current) {
                        v.choose_model(&source, &event_epoch, current, Some(level), w, cx);
                    }
                },
            );
            let mut subscriptions = vec![change, level];
            for state in [&models, &thinking] {
                subscriptions.push(cx.subscribe_in(state, w, |v, _, _: &DismissEvent, w, cx| {
                    v.finish_model_query(w, cx)
                }));
                let input = state.read(cx).query_input(cx);
                subscriptions.push(cx.subscribe_in(&input, w, |v, _, event, w, cx| {
                    if matches!(event, InputEvent::Change) {
                        v.finish_model_query(w, cx);
                    }
                }));
            }
            let need_read = retained.is_none();
            self.models.as_mut().unwrap().picker = Some(Picker {
                epoch,
                for_model,
                scope,
                catalog: retained,
                deferred: None,
                error: None,
                loading: false,
                models,
                thinking,
                synced: None,
                _subscriptions: subscriptions,
            });
            if need_read {
                self.refresh_models(w, cx);
            }
        }
        self.sync_model_inputs(w, cx);
    }
    fn finish_model_query(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.model_query_busy(w, cx) {
            return;
        }
        if let Some((catalog, current)) = self
            .models
            .as_mut()
            .and_then(|m| m.picker.as_mut())
            .and_then(|p| p.deferred.take())
        {
            self.apply_model_catalog(catalog, current, w, cx);
        } else {
            self.sync_model_inputs(w, cx);
        }
    }
    fn refresh_models(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        let target = self.model_target();
        let Some(models) = &mut self.models else {
            return;
        };
        let Some(p) = &mut models.picker else {
            return;
        };
        if models.reader.is_none() {
            match Reader::start(models.options.clone()) {
                Err(e) => {
                    p.error = Some(e);
                    return;
                }
                Ok((reader, updates)) => {
                    models.reader = Some(reader);
                    models.task = Some(cx.spawn_in(w, async move |v, cx| {
                        while let Ok(update) = updates.recv().await {
                            if v.update_in(cx, |v, w, cx| v.accept_models(update, w, cx))
                                .is_err()
                            {
                                break;
                            }
                        }
                        let _ = v.update(cx, |v, cx| {
                            if let Some(m) = &mut v.models {
                                m.reader = None;
                                if let Some(p) = &mut m.picker {
                                    p.loading = false;
                                    p.error = Some("Couldn't load models. Refresh to try again.");
                                }
                            }
                            cx.notify();
                        });
                    }));
                }
            }
        }
        models.request += 1;
        p.loading = true;
        p.error = None;
        p.deferred = None;
        p.synced = None;
        if !models.reader.as_ref().unwrap().request(Request {
            id: models.request,
            scope: p.scope.clone(),
            target,
        }) {
            p.loading = false;
            p.error = Some("Models aren't available right now. Refresh to try again.");
        }
        cx.notify();
    }
    fn accept_models(&mut self, u: Update, w: &mut Window, cx: &mut Context<Self>) {
        let Some(m) = &mut self.models else {
            return;
        };
        let Some(p) = &mut m.picker else {
            return;
        };
        if m.request != u.id || p.scope != u.scope {
            return;
        }
        p.loading = false;
        match u.result {
            Err(e) => p.error = Some(e),
            Ok((c, s)) => {
                if self.model_query_busy(w, cx) {
                    self.models
                        .as_mut()
                        .unwrap()
                        .picker
                        .as_mut()
                        .unwrap()
                        .deferred = Some((c, s));
                } else {
                    self.apply_model_catalog(c, s, w, cx);
                }
            }
        }
        cx.notify();
    }
    fn apply_model_catalog(
        &mut self,
        c: Catalog,
        current: Option<SessionModel>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let m = self.models.as_mut().unwrap();
        let p = m.picker.as_mut().unwrap();
        p.catalog = Some(Arc::new(c));
        p.error = None;
        p.synced = None;
        if let (Some(next), Some((_, _, current))) = (current, &mut m.current)
            && next.updated_at >= current.updated_at
        {
            *current = next;
        }
        m.error = None;
        self.sync_models(w, cx);
    }
    fn sync_model_inputs(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.model_query_busy(w, cx) {
            return;
        }
        let editable = self.can_choose_model();
        let continuable = self.can_continue();
        let waiting = self.model_waits_for_work();
        let failed = self
            .model_target()
            .is_some_and(|t| t.failed_source.is_some());
        let choice = self.model_choice();
        let is_new = self
            .selected
            .as_ref()
            .is_some_and(|s| s.starts_with("new:"));
        let Some(p) = self.models.as_mut().and_then(|m| m.picker.as_mut()) else {
            return;
        };
        let Some(c) = &p.catalog else {
            return;
        };
        let inputs = (
            choice.clone(),
            is_new,
            editable,
            failed,
            continuable,
            waiting,
        );
        if p.synced.as_ref() == Some(&inputs) {
            return;
        }
        let mut items: Vec<_> = c
            .models
            .iter()
            .map(|m| Item {
                id: m.id.clone(),
                title: m.name.clone().into(),
                detail: m.id.clone().into(),
                // While held at a limit, a pick opens the continuation instead.
                disabled: !editable && !continuable,
                search: if m.search_key.is_empty() {
                    format!("{} {}", m.name, m.id).to_lowercase().into()
                } else {
                    m.search_key.clone().into()
                },
            })
            .collect();
        items.push(Item {
            id: ":refresh".into(),
            title: "Refresh scoped models".into(),
            detail: "Read only; current choices are retained".into(),
            disabled: false,
            search: "refresh scoped models".into(),
        });
        if is_new {
            items.insert(
                0,
                Item {
                    id: String::new(),
                    title: "Project/pi default".into(),
                    detail: "Resolved by Local when you create the chat".into(),
                    disabled: !editable,
                    search: "project pi default".into(),
                },
            );
        }
        if let Some(choice) = &choice
            && !items.iter().any(|m| m.id == choice.model)
        {
            items.push(Item {
                id: choice.model.clone(),
                title: format!("{} (outside scope)", choice.model).into(),
                detail: "Current selection is retained, not substituted".into(),
                disabled: true,
                search: choice.model.to_lowercase().into(),
            });
        }
        let option = choice
            .as_ref()
            .and_then(|s| c.models.iter().find(|m| m.id == s.model));
        let mut levels = Vec::new();
        if (is_new || failed) && option.is_some_and(|m| m.thinking_levels.len() >= 2) {
            levels.push(Item {
                id: String::new(),
                title: "Scoped default".into(),
                detail: "No thinking override".into(),
                disabled: !editable,
                search: "scoped default".into(),
            });
        }
        if let Some(option) = option {
            levels.extend(option.thinking_levels.iter().map(|l| Item {
                id: l.clone(),
                title: if option.thinking_levels.len() == 1 {
                    format!("{} (fixed)", thinking_title(l)).into()
                } else {
                    thinking_title(l).into()
                },
                detail: String::new().into(),
                disabled: !editable,
                search: l.to_lowercase().into(),
            }));
        }
        let selected = choice.as_ref().map(|c| c.model.clone()).unwrap_or_default();
        if waiting {
            items.insert(0, busy_item());
            levels.insert(0, busy_item());
        }
        p.models.update(cx, |s, cx| {
            s.prepare_navigation(w, cx);
            s.set_items(SearchableVec::new(items), w, cx);
            s.set_selected_value(&selected, w, cx);
        });
        let selected = choice
            .as_ref()
            .and_then(|c| c.thinking.clone())
            .or_else(|| {
                option
                    .filter(|m| m.thinking_levels.len() == 1)
                    .and_then(|m| m.thinking_levels.first().cloned())
            })
            .unwrap_or_default();
        p.thinking.update(cx, |s, cx| {
            s.prepare_navigation(w, cx);
            s.set_items(SearchableVec::new(levels), w, cx);
            s.set_selected_value(&selected, w, cx);
        });
        p.synced = Some(inputs);
    }
    /// A healthy chat that is only waiting for its work. Explained in context, not as a notice.
    fn model_waits_for_work(&self) -> bool {
        self.model_restriction() == Some(chat_models::BUSY)
    }
    fn model_uncertain(&self) -> Option<&chat_models::Attempt> {
        let id = self.selected.as_deref()?.strip_prefix("chat:")?;
        self.state.book.as_ref()?.model_changes.get(id)
    }
    pub(super) fn models_block_send(&self) -> bool {
        self.models.as_ref().is_some_and(|m| m.busy) || self.model_uncertain().is_some()
    }
    fn can_choose_model(&self) -> bool {
        self.model_restriction().is_none()
    }
    fn model_restriction(&self) -> Option<&'static str> {
        if !self.ready() {
            return Some(
                "Connect to Local and load this chat before changing its model or thinking.",
            );
        }
        if !self.writable {
            return Some(
                "This chat is read-only. Its model and scoped catalog can be inspected, not changed.",
            );
        }
        if self.waiting() {
            return Some("Wait for the pending chat action before changing its model or thinking.");
        }
        if self.error.is_some() || !self.draft().is_some_and(Draft::editable) {
            return Some(
                "Resolve the retained chat delivery before changing its model or thinking.",
            );
        }
        if self.model_uncertain().is_some() {
            return Some(
                "The previous model switch is unconfirmed. Inspect it below; no automatic retry.",
            );
        }
        if self.models.as_ref().is_some_and(|m| m.busy) {
            return Some(
                "Waiting for the explicit model action. No other model change can be submitted yet.",
            );
        }
        let Some(p) = self.models.as_ref().and_then(|m| m.picker.as_ref()) else {
            return Some("Load this chat's scoped model catalog before choosing a model.");
        };
        if p.loading {
            return Some("Loading scoped models. The current choice is retained.");
        }
        if p.error.is_some() || p.catalog.is_none() {
            return Some(
                "Scoped models could not be verified. Refresh models; the current choice is retained.",
            );
        }
        if p.deferred.is_some() {
            return Some(
                "Finish or dismiss the model search to apply the refreshed scoped catalog.",
            );
        }
        if !self
            .selected
            .as_ref()
            .is_some_and(|s| s.starts_with("new:"))
        {
            let Some((_, _, current)) = self.models.as_ref().and_then(|m| m.current.as_ref())
            else {
                return Some("Load the current chat model before choosing another model.");
            };
            if !current.allowed {
                return current
                    .blocked
                    .or(Some("Model changes require a healthy idle chat."));
            }
            if self.busy {
                return Some(chat_models::BUSY);
            }
        }
        None
    }
    fn choose_model(
        &mut self,
        source: &Scope,
        epoch: &str,
        id: &str,
        thinking: Option<&String>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.marked(w, cx) {
            return;
        }
        if id == BUSY_ITEM {
            return;
        }
        self.changed(cx);
        if id == ":refresh" && thinking.is_none() {
            if self.model_scope().as_ref() == Some(source)
                && self
                    .models
                    .as_ref()
                    .and_then(|m| m.picker.as_ref())
                    .is_some_and(|p| p.epoch == epoch)
                && !self.marked(w, cx)
            {
                self.refresh_models(w, cx);
                self.sync_model_inputs(w, cx);
            }
            return;
        }
        if thinking.is_none()
            && !source.key.starts_with("new:")
            && self.model_choice().is_none_or(|c| c.model != id)
            && self.can_continue()
        {
            if self.model_scope().as_ref() == Some(source)
                && self
                    .models
                    .as_ref()
                    .and_then(|m| m.picker.as_ref())
                    .is_some_and(|p| p.epoch == epoch)
            {
                self.begin_continuation(Some(id.to_string()), w, cx);
            }
            // The chip keeps showing the actual model until the continuation is confirmed.
            if let Some(p) = self.models.as_mut().and_then(|m| m.picker.as_mut()) {
                p.synced = None;
            }
            self.sync_model_inputs(w, cx);
            return;
        }
        if !self.can_choose_model() {
            if let Some(p) = self.models.as_mut().and_then(|m| m.picker.as_mut()) {
                p.synced = None;
            }
            self.sync_model_inputs(w, cx);
            return;
        }
        if self.marked(w, cx)
            || self.model_scope().as_ref() != Some(source)
            || self
                .models
                .as_ref()
                .unwrap()
                .picker
                .as_ref()
                .is_none_or(|p| p.epoch != epoch)
        {
            return;
        }
        if thinking.is_none() && self.model_choice().as_ref().is_some_and(|c| c.model == id) {
            return;
        }
        if thinking.is_some()
            && (self.model_choice().is_none_or(|c| c.model != id)
                || !self
                    .models
                    .as_ref()
                    .unwrap()
                    .picker
                    .as_ref()
                    .unwrap()
                    .catalog
                    .as_ref()
                    .unwrap()
                    .models
                    .iter()
                    .any(|m| m.id == id && m.thinking_levels.len() >= 2))
        {
            return;
        }
        let choice = if id.is_empty() && source.key.starts_with("new:") {
            None
        } else {
            Some(ModelChoice {
                model: id.into(),
                thinking: thinking.filter(|s| !s.is_empty()).cloned(),
            })
        };
        if choice.as_ref().is_some_and(|c| {
            !self
                .models
                .as_ref()
                .unwrap()
                .picker
                .as_ref()
                .unwrap()
                .catalog
                .as_ref()
                .unwrap()
                .admits(c)
        }) {
            return;
        }
        if source.key.starts_with("new:") {
            let d = self.cache.get_mut(&source.key).unwrap();
            let next = choice.map(|choice| DraftChoice {
                project_id: source.project.clone().unwrap(),
                cwd: source.cwd.clone(),
                choice,
            });
            if d.model_choice == next {
                return;
            }
            d.model_choice = next;
            self.record_edit(true, cx);
            self.sync_models(w, cx);
        } else if let (Some(choice), Some(target)) = (choice, self.model_target()) {
            if self.model_choice().as_ref() == Some(&choice) {
                return;
            }
            let attempt = chat_models::Attempt {
                id: uuid::Uuid::new_v4().to_string(),
                target: target.clone(),
                choice,
            };
            self.model_command(target.session, chat_models::Action::Submit(attempt), cx);
        }
        cx.notify();
    }
    fn model_command(
        &mut self,
        session: String,
        action: chat_models::Action,
        cx: &mut Context<Self>,
    ) {
        if !self.ready()
            || self.selected.as_deref() != Some(format!("chat:{session}").as_str())
            || self.models.as_ref().is_none_or(|m| m.busy)
        {
            return;
        }
        let m = self.models.as_mut().unwrap();
        m.mutation += 1;
        m.confirm_ack = false;
        if matches!(action, chat_models::Action::Submit(_)) {
            m.inspection = None;
        }
        if self.client.as_ref().is_some_and(|c| {
            c.command(WriteCommand::Model {
                session,
                request: m.mutation,
                action,
            })
        }) {
            m.busy = true;
            m.error = None;
            m.request += 1;
            if let Some(p) = &mut m.picker {
                p.loading = false;
            }
        } else {
            m.error = Some("Local model action queue is busy. Nothing was submitted.");
        }
        cx.notify();
    }
    pub(super) fn accept_model_action(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(reply) = self.state.model.clone() else {
            return;
        };
        let Some(m) = &mut self.models else {
            return;
        };
        if reply.request != m.mutation || reply.request <= m.handled {
            return;
        }
        if !matches!(reply.outcome, chat_models::Outcome::Pending) {
            m.handled = reply.request;
            m.request += 1;
            if let Some(p) = &mut m.picker {
                p.loading = false;
            }
        }
        if self.selected.as_deref() != Some(format!("chat:{}", reply.session).as_str()) {
            m.busy = false;
            cx.notify();
            return;
        }
        match reply.outcome {
            chat_models::Outcome::Pending => return,
            chat_models::Outcome::Refused(e) => {
                m.busy = false;
                m.error = Some(e);
            }
            chat_models::Outcome::Unknown(e) => {
                m.busy = false;
                m.error = Some(e);
                m.continuation = None;
            }
            chat_models::Outcome::Continued(next) => {
                m.busy = false;
                m.error = None;
                m.continuation = None;
                cx.emit(EditorEvent::OpenContinued(next));
            }
            chat_models::Outcome::Acknowledged(next)
            | chat_models::Outcome::Observed(next)
            | chat_models::Outcome::Dismissed(next) => {
                m.busy = false;
                m.error = None;
                m.continuation = None;
                m.inspection = Some(reply.session.clone());
                if let Some((id, _, old)) = &mut m.current
                    && *id == reply.session
                {
                    *old = next;
                }
            }
        }
        self.sync_models(w, cx);
        cx.notify();
    }
    pub(super) fn new_model_problem(&self, d: &Draft) -> Option<&'static str> {
        d.model_choice.as_ref().and_then(|c|{
            if d.project_id.as_ref()!=Some(&c.project_id)||d.cwd!=c.cwd{return Some("Model choice belongs to the previous project. Choose a scoped model or Project/pi default explicitly.");}
            match self.models.as_ref().and_then(|m|m.picker.as_ref()){
                Some(p) if !p.loading&&p.error.is_none()&&p.catalog.as_ref().is_some_and(|catalog|catalog.admits(&c.choice))=>None,
                _=>Some("Verify the explicit model/thinking choice in this project's scoped catalog before creating."),
            }
        })
    }
    pub(crate) fn invalidate_models(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(p) = self.models.as_mut().and_then(|m| m.picker.as_mut()) {
            p.error = Some("Scope changed. Refresh the catalog; current choices are retained.");
            p.synced = None;
        }
        self.refresh_models(w, cx);
    }
    pub(super) fn model_controls(&self, cx: &Context<Self>) -> impl IntoElement {
        let p = self.models.as_ref().and_then(|m| m.picker.as_ref());
        let levels = p
            .and_then(|p| p.catalog.as_ref())
            .and_then(|c| {
                self.model_choice()
                    .and_then(|s| c.models.iter().find(|m| m.id == s.model))
            })
            .map(|m| m.thinking_levels.len())
            .unwrap_or(0);
        let actual = self.model_choice();
        let loading = p.is_some_and(|p| p.loading && p.catalog.is_none());
        // Hover help; the keyboard path is the open menu's disabled first row.
        let waiting = self.model_waits_for_work();
        let field = move |id: &'static str| {
            let field = div().id(id);
            #[cfg(any(test, feature = "native-probes"))]
            let field = field.test_support();
            field.min_w_0().when(waiting, |d| {
                d.tooltip(|w, cx| {
                    gpui_kit::component::tooltip::Tooltip::element(|_, _| {
                        let help = ui::text(ui::Text::Caption, chat_models::BUSY)
                            .id("chat-model-busy-help");
                        #[cfg(any(test, feature = "native-probes"))]
                        let help = help.test_support();
                        help
                    })
                    .build(w, cx)
                })
            })
        };
        let model_label: SharedString = if loading {
            "Loading models…".into()
        } else {
            actual
                .as_ref()
                .map(|c| c.model.clone())
                .unwrap_or_else(|| "Project/pi default".into())
                .into()
        };
        let thinking_label: SharedString = actual
            .as_ref()
            .and_then(|c| c.thinking.as_ref())
            .map(|l| format!("{} (not in catalog)", thinking_title(l)))
            .unwrap_or_else(|| {
                if actual.is_none() {
                    "Default thinking".into()
                } else if levels == 0 {
                    "Thinking not reported".into()
                } else {
                    "Scoped default".into()
                }
            })
            .into();
        div()
            .h_flex()
            .flex_1()
            .min_w_0()
            .gap_1()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if v.marked(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .children(p.map(|p| {
                field("chat-model-field").max_w_40().child(
                    Select::new(&p.models)
                        .id("chat-model")
                        .small()
                        .appearance(false)
                        .focus_ring(false)
                        .disabled(p.catalog.is_none())
                        .menu_width(px(320.))
                        .menu_max_h(px(260.))
                        .placeholder(model_label.clone())
                        .search_placeholder("Find a scoped model…")
                        .accessibility_label("Model for this new chat"),
                )
            }))
            .children(p.map(|p| {
                field("chat-thinking-field").max_w_32().child(
                    Select::new(&p.thinking)
                        .id("chat-thinking")
                        .small()
                        .appearance(false)
                        .focus_ring(false)
                        .disabled(p.catalog.is_none() || levels < 2)
                        .menu_width(px(180.))
                        .menu_max_h(px(230.))
                        .placeholder(thinking_label.clone())
                        .accessibility_label("Supported thinking level"),
                )
            }))
    }
    fn visible_model_restriction(&self) -> Option<&'static str> {
        // Sending/recovery already explains a pending chat action. Keep the
        // admission restriction and contextual picker explanation, not a second
        // "Wait for the pending…" sentence above the composer.
        if self.waiting() {
            return None;
        }
        let is_new = self
            .selected
            .as_ref()
            .is_some_and(|key| key.starts_with("new:"));
        // Exact delivery/error notices already explain a locked new draft.
        // Actual model errors are rendered independently below.
        if is_new
            && (self.state.error.is_some()
                || self.error.is_some()
                || self.waiting()
                || self.draft().is_some_and(|draft| !draft.editable()))
        {
            return None;
        }
        // Before a new draft has a destination, its project chooser explains the
        // next step. Do not duplicate it with a technical missing-catalog notice.
        // This is presentation only; model_restriction still gates admission.
        if is_new
            && self
                .draft()
                .is_some_and(|draft| draft.project_id.is_none() && draft.editable())
            && self.ready()
            && self.writable
            && !self.waiting()
            && self.error.is_none()
            && self
                .models
                .as_ref()
                .is_some_and(|m| m.picker.is_none() && m.error.is_none() && !m.busy)
        {
            return None;
        }
        // The subscription row explains a held chat and offers its actions. A chat
        // that is only working is explained by the model/thinking tooltip and menu.
        self.model_restriction()
            .filter(|reason| *reason != chat_models::PAUSED && *reason != chat_models::BUSY)
    }
    pub(super) fn has_model_notice(&self) -> bool {
        self.model_target()
            .is_some_and(|t| t.failed_source.is_some())
            || self.visible_model_restriction().is_some()
            || self.models.as_ref().is_some_and(|m| {
                m.error.is_some() || m.picker.as_ref().is_some_and(|p| p.error.is_some())
            })
            || self.model_catalog_empty()
            || self.model_uncertain().is_some()
            || self
                .selected
                .as_ref()
                .is_some_and(|s| s.starts_with("new:"))
                && self
                    .draft()
                    .is_some_and(|d| self.new_model_problem(d).is_some())
    }
    pub(crate) fn model_catalog_empty(&self) -> bool {
        self.models
            .as_ref()
            .and_then(|m| m.picker.as_ref())
            .and_then(|p| p.catalog.as_ref())
            .is_some_and(|c| c.models.is_empty())
    }
    pub(super) fn model_notices(&self, cx: &Context<Self>) -> impl IntoElement {
        let error = self.models.as_ref().and_then(|m| m.error).or(self
            .models
            .as_ref()
            .and_then(|m| m.picker.as_ref())
            .and_then(|p| p.error));
        let uncertain = self.model_uncertain();
        div().v_flex().gap_1().min_w_0()
            .children(self.model_target().filter(|t|t.failed_source.is_some()).map(|_| {
                let view=ui::text(ui::Text::Caption,"Next attempt only. Model and thinking choices are saved without retrying work.").id("chat-model-next-attempt");
                #[cfg(any(test, feature="native-probes"))]
                let view=view.test_support();
                view
            }))
            .children(self.visible_model_restriction().filter(|_|error.is_none() && uncertain.is_none()).map(|reason|{
                let view = ui::text(ui::Text::Caption,reason).id("chat-model-restriction");
                #[cfg(any(test, feature = "native-probes"))]
                let view = view.test_support();
                view
            }))
            .children(error.map(|e|Notice::new(e).tone(Tone::Error)))
            .children(self.model_catalog_empty().then(||Notice::new("No models reported for this directory. Refresh models or check Scoped models in Settings; current choices are retained.").tone(Tone::Warning)))
            .children(self.draft().filter(|_|self.selected.as_ref().is_some_and(|k|k.starts_with("new:"))).and_then(|d|self.new_model_problem(d)).map(|e|Notice::new(e).tone(Tone::Warning)))
            .when(error.is_some(),|v|v.child(ui::action("refresh-chat-models","Refresh models",Action::Quiet).disabled(self.models.as_ref().is_some_and(|m|m.busy)).on_click(cx.listener(|v,_,w,cx|v.refresh_models(w,cx)))))
            .children(uncertain.map(|a|{
                let id=a.id.clone();let session=a.target.session.clone();let target=a.target.clone();let acknowledge=session.clone();
                div().v_flex().gap_1().child(Notice::new("Model switch is unconfirmed. Original choice retained; no automatic retry. Inspect the chat before acknowledging uncertainty.").tone(Tone::Warning))
                    .child(ui::action("inspect-chat-model","Inspect current model",Action::Secondary).disabled(self.models.as_ref().is_some_and(|m|m.busy)).on_click(cx.listener(move|v,_,w,cx|{if !v.marked(w,cx){v.model_command(session.clone(),chat_models::Action::Inspect(target.clone()),cx);}})))
                    .child(ui::action("ack-chat-model",if self.models.as_ref().is_some_and(|m|m.confirm_ack){"Confirm local acknowledgment"}else{"Acknowledge model uncertainty"},Action::Secondary).disabled(self.models.as_ref().is_none_or(|m|m.busy||m.inspection.as_deref()!=Some(acknowledge.as_str()))).on_click(cx.listener(move|v,_,w,cx|{
                        if !v.ready()||v.marked(w,cx)||v.selected.as_deref()!=Some(format!("chat:{acknowledge}").as_str())||v.model_uncertain().is_none_or(|a|a.id!=id)||v.models.as_ref().is_none_or(|m|m.busy||m.inspection.as_deref()!=Some(acknowledge.as_str())){return;}let m=v.models.as_mut().unwrap();if !m.confirm_ack{m.confirm_ack=true;cx.notify();return;}v.model_command(acknowledge.clone(),chat_models::Action::Acknowledge{session:acknowledge.clone(),id:id.clone()},cx);
                    })))
            }))
    }
}

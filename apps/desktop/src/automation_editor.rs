//! The New/Edit automation sheet: a recurring rule or a one-time message.
//! Values are read at Save time; one write per press, never retried. An unconfirmed save
//! keeps the form but blocks Save, so a rule that may exist isn't created twice.
use crate::{
    LocalOptions,
    chat_model_reader::{Reader as Models, Request as ModelRequest, Scope, Update as ModelUpdate},
    local_model::{Chat, Project},
    recurring_schedules as words,
    scheduled_messages::{Item, Recurrence, Target},
    scheduled_messages_reader::{Outcome, Write, perform},
    ui::{self, Action, Notice, Text, Tone},
};
use chrono::{Datelike, NaiveDate, NaiveTime, Timelike};
use gpui_kit::{
    App, AppContext, Context, Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString, Styled, Subscription,
    Task, TestSupportExt, Window,
    component::{
        ActiveTheme, Disableable, FocusableExt, Selectable, Sizable, StyledExt, WindowExt,
        button::ButtonGroup,
        date_picker::{DatePicker, DatePickerState, DateTime},
        input::{Textarea, TextareaState},
        select::{SearchableVec, Select, SelectEvent, SelectItem, SelectState},
        time_field::{TimeField, TimeFieldState},
    },
    div, px,
};
use serde_json::{Value, json};
gpui_kit::actions!(automation_editor, [SaveAutomation, CloseAutomation]);
struct Keys;
impl gpui_kit::Global for Keys {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Recurring,
    Once,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Every {
    Day,
    Week,
    Month,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Act {
    NewChat,
    Message,
}
pub(crate) enum EditorEvent {
    Close,
    Saved,
}
const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const NAME_UNITS: usize = 200;
const TARGET_BYTES: usize = 16 * 1024;

/// Everything the form holds, captured at Save.
#[derive(Clone, Debug)]
pub(crate) struct Draft {
    pub(crate) kind: Kind,
    pub(crate) every: Every,
    pub(crate) weekdays: [bool; 7],
    pub(crate) weekday: u8,
    pub(crate) day_of_month: u8,
    pub(crate) time: (u32, u32),
    pub(crate) zone: String,
    /// Once: the local instant chosen.
    pub(crate) at: Option<u64>,
    pub(crate) act: Act,
    pub(crate) project: Option<String>,
    /// New automation only: the new chat's model, or None for the project default.
    pub(crate) model: Option<String>,
    pub(crate) chat: Option<String>,
    pub(crate) name: String,
    pub(crate) text: String,
}
impl Draft {
    pub(crate) fn recurrence(&self) -> Result<Recurrence, &'static str> {
        let zone = self.zone.trim();
        if !words::zone_name(zone) {
            return Err("Enter a time zone such as Europe/Paris.");
        }
        let days: Vec<u8> = (1..=7u8)
            .filter(|d| self.weekdays[usize::from(d - 1)])
            .collect();
        if self.every == Every::Day && days.is_empty() {
            return Err("Choose at least one day.");
        }
        Ok(Recurrence {
            every: match self.every {
                Every::Day => "day",
                Every::Week => "week",
                Every::Month => "month",
            }
            .into(),
            time: format!("{:02}:{:02}", self.time.0, self.time.1),
            time_zone: zone.into(),
            weekdays: (self.every == Every::Day && days.len() < 7).then_some(days),
            weekday: (self.every == Every::Week).then_some(self.weekday.clamp(1, 7)),
            day_of_month: (self.every == Every::Month).then_some(self.day_of_month.clamp(1, 31)),
        })
    }
    /// One line under the form: when it runs, in words.
    pub(crate) fn summary(&self, chats: &[Chat], now: u64) -> Option<String> {
        match self.kind {
            Kind::Recurring => {
                let r = self.recurrence().ok()?;
                // Always name the zone here; the list shows it only when it differs.
                let mut text = format!("{}.", words::schedule(&r, ""));
                if let Some(next) = words::preview_next(&r, now) {
                    let when = crate::scheduled_messages::words(
                        next,
                        now,
                        crate::subscription_pause::local_offset,
                    );
                    // Another zone's rule is previewed in this computer's time, and says so.
                    if r.time_zone == words::local_zone() {
                        text.push_str(&format!(" Next: {when}."));
                    } else {
                        text.push_str(&format!(" Next: {when}, your time."));
                    }
                }
                Some(text)
            }
            Kind::Once => {
                let at = self.at?;
                let when = crate::scheduled_messages::words(
                    at,
                    now,
                    crate::subscription_pause::local_offset,
                );
                Some(match self.act {
                    Act::NewChat => format!("Starts a new chat {}.", lower(&when)),
                    Act::Message => format!(
                        "Sends to {} {}.",
                        self.chat
                            .as_ref()
                            .and_then(|id| chats.iter().find(|c| &c.id == id))
                            .map_or("the chat", |c| c.title.as_str()),
                        lower(&when)
                    ),
                })
            }
        }
    }
    fn target(&self, chats: &[Chat], old: Option<&Item>) -> Result<Value, &'static str> {
        let text = self.text.clone();
        if text.trim().is_empty() {
            return Err(match self.act {
                Act::NewChat => "Write the prompt for the new chat.",
                Act::Message => "Write the message to send.",
            });
        }
        let target = match self.act {
            Act::NewChat => {
                let project = self.project.clone().ok_or("Choose a project.")?;
                // An edit keeps the saved chat settings (model, thinking, mode) when the
                // project stays; a new project starts from its defaults.
                let mut spawn = match old.map(|o| &o.target) {
                    Some(Target::Chat { spawn, .. }) if spawn["projectId"] == project.as_str() => {
                        spawn.clone()
                    }
                    _ => json!({}),
                };
                spawn["message"] = json!(text);
                spawn["projectId"] = json!(project);
                if let Some(model) = &self.model {
                    spawn["model"] = json!(model);
                }
                json!({"kind": "chat", "spawn": spawn})
            }
            Act::Message => {
                let id = self.chat.clone().ok_or("Choose a chat.")?;
                let chat = chats.iter().find(|c| c.id == id);
                if self.kind == Kind::Recurring && chat.is_some_and(|c| c.project_id.is_none()) {
                    return Err("Repeating messages need a chat in a project.");
                }
                json!({"kind": "message", "sessionId": id, "message": text})
            }
        };
        if target.to_string().len() > TARGET_BYTES {
            return Err("The text is too long for an automation (16 KB).");
        }
        Ok(target)
    }
    /// The POST body for a new automation, or the changed fields of an edited rule
    /// (None when nothing changed).
    pub(crate) fn body(
        &self,
        chats: &[Chat],
        old: Option<&Item>,
        now: u64,
    ) -> Result<Option<Value>, &'static str> {
        let name = self.name.trim();
        if name.encode_utf16().count() > NAME_UNITS {
            return Err("The name is too long (200 characters at most).");
        }
        let target = self.target(chats, old)?;
        if let Some(old) = old {
            let mut patch = serde_json::Map::new();
            if !name.is_empty() && name != old.title {
                patch.insert("title".into(), json!(name));
            }
            let recurrence = self.recurrence()?;
            if old.recurrence.as_ref() != Some(&recurrence) {
                patch.insert(
                    "recurrence".into(),
                    serde_json::to_value(recurrence).unwrap_or_default(),
                );
            }
            let before = match &old.target {
                Target::Chat { spawn, .. } => json!({"kind": "chat", "spawn": spawn}),
                Target::Message {
                    session_id,
                    message,
                } => {
                    json!({"kind": "message", "sessionId": session_id, "message": message})
                }
            };
            if before != target {
                patch.insert("target".into(), target);
            }
            return Ok((!patch.is_empty()).then_some(Value::Object(patch)));
        }
        let mut body = json!({"target": target});
        if !name.is_empty() {
            body["title"] = json!(name);
        }
        match self.kind {
            Kind::Recurring => {
                body["trigger"] = json!("recurring");
                body["recurrence"] = serde_json::to_value(self.recurrence()?).unwrap_or_default();
            }
            Kind::Once => {
                let at = self.at.ok_or("Choose a date and time.")?;
                if at <= now {
                    return Err("Choose a time in the future.");
                }
                body["trigger"] = json!("at");
                body["at"] = json!(at);
            }
        }
        Ok(Some(body))
    }
}
fn lower(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if text.starts_with("Today") || text.starts_with("Tomorrow") => {
            c.to_lowercase().chain(chars).collect()
        }
        _ => format!("on {text}"),
    }
}

#[derive(Clone)]
pub(crate) struct Choice {
    id: String,
    title: SharedString,
}
impl SelectItem for Choice {
    type Value = String;
    fn value(&self) -> &String {
        &self.id
    }
    fn title(&self) -> SharedString {
        self.title.clone()
    }
}
type Picker = Entity<SelectState<SearchableVec<Choice>>>;
/// The model list's first row: no `model` in the spawn, so Local uses the project default.
fn default_model() -> Choice {
    Choice {
        id: String::new(),
        title: "Project default".into(),
    }
}
/// Models listed for one project; Local's catalog is bounded at 2048.
const MODELS_SHOWN: usize = 500;

pub(crate) struct Editor {
    options: LocalOptions,
    /// The rule being edited, as shown when Edit was pressed.
    pub(crate) source: Option<Item>,
    chats: std::sync::Arc<Vec<Chat>>,
    pub(crate) kind: Kind,
    pub(crate) every: Every,
    pub(crate) weekdays: [bool; 7],
    pub(crate) weekday: u8,
    pub(crate) act: Act,
    name: Entity<TextareaState>,
    zone: Entity<TextareaState>,
    pub(crate) text: Entity<TextareaState>,
    pub(crate) time: Entity<TimeFieldState>,
    pub(crate) when: Entity<DatePickerState>,
    month_day: Picker,
    pub(crate) project: Picker,
    pub(crate) model: Picker,
    /// Scoped catalog reads, New automation only. Edits keep the saved model.
    models: Option<Models>,
    /// The project the model list was asked for, and that request.
    models_for: Option<String>,
    model_request: u64,
    models_note: Option<&'static str>,
    /// Project ID and directory, for scoped catalog reads.
    paths: Vec<(String, String)>,
    pub(crate) chat: Picker,
    pub(crate) saving: bool,
    /// A save Local didn't confirm. Save stays off; the list shows what Local has.
    pub(crate) unconfirmed: bool,
    pub(crate) error: Option<String>,
    focus: FocusHandle,
    save: Option<Task<()>>,
    _models: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}
impl EventEmitter<EditorEvent> for Editor {}
fn picker(
    choices: Vec<Choice>,
    selected: Option<&str>,
    w: &mut Window,
    cx: &mut Context<Editor>,
) -> Picker {
    let ix = selected.and_then(|id| choices.iter().position(|c| c.id == id));
    cx.new(|cx| {
        SelectState::new(
            SearchableVec::new(choices),
            ix.map(gpui_kit::component::IndexPath::new),
            w,
            cx,
        )
        .searchable(true)
    })
}
fn input(
    placeholder: &'static str,
    value: &str,
    rows: (usize, usize),
    w: &mut Window,
    cx: &mut Context<Editor>,
) -> Entity<TextareaState> {
    let value = value.to_owned();
    cx.new(|cx| {
        let mut t = TextareaState::new(w, cx)
            .placeholder(placeholder)
            .auto_grow(rows.0, rows.1);
        t.set_submit_on_enter(false, cx);
        t.set_value(value, w, cx);
        t
    })
}
impl Editor {
    pub(crate) fn new(
        options: LocalOptions,
        source: Option<Item>,
        chats: std::sync::Arc<Vec<Chat>>,
        projects: &[Project],
        now: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        if !cx.has_global::<Keys>() {
            let bindings = [
                ui::shortcut(
                    "secondary-enter",
                    SaveAutomation,
                    Some("AutomationEditor"),
                    cx,
                ),
                gpui_kit::KeyBinding::new("escape", CloseAutomation, Some("AutomationEditor")),
            ];
            cx.bind_keys(bindings);
            cx.set_global(Keys);
        }
        let rule = source.as_ref().and_then(|s| s.recurrence.clone());
        let (hour, minute) = rule
            .as_ref()
            .and_then(|r| r.time.split_once(':'))
            .and_then(|(h, m)| Some((h.parse().ok()?, m.parse().ok()?)))
            .unwrap_or((9, 0));
        let time = cx.new(|cx| {
            let mut t = TimeFieldState::new(w, cx);
            t.set_time(
                NaiveTime::from_hms_opt(hour, minute, 0).unwrap_or(NaiveTime::MIN),
                w,
                cx,
            );
            t
        });
        let (y, m, d) = words::local_date(now, 1);
        let when = cx.new(|cx| {
            let mut p = DatePickerState::new(w, cx)
                .time_precision(gpui_kit::component::time_field::TimePrecision::Minute)
                .first_day_of_week(chrono::Weekday::Mon);
            if let Some(at) = NaiveDate::from_ymd_opt(y, m, d).and_then(|d| d.and_hms_opt(9, 0, 0))
            {
                p.set_date_time(at, w, cx);
            }
            p
        });
        let (act, project, chat, text) = match source.as_ref().map(|s| &s.target) {
            Some(Target::Message {
                session_id,
                message,
            }) => (
                Act::Message,
                None,
                Some(session_id.clone()),
                message.clone(),
            ),
            Some(Target::Chat { spawn, .. }) => (
                Act::NewChat,
                spawn["projectId"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| source.as_ref().and_then(|s| s.project_id.clone())),
                None,
                spawn["message"].as_str().unwrap_or_default().to_owned(),
            ),
            None => (
                Act::NewChat,
                projects.first().map(|p| p.id.clone()),
                None,
                String::new(),
            ),
        };
        let project = picker(
            projects
                .iter()
                .map(|p| Choice {
                    id: p.id.clone(),
                    title: p.name.clone().into(),
                })
                .collect(),
            project.as_deref(),
            w,
            cx,
        );
        let chat = picker(
            chats
                .iter()
                .filter(|c| !c.archived && !c.local_draft)
                .take(1000)
                .map(|c| {
                    let project = c
                        .project_id
                        .as_ref()
                        .and_then(|id| projects.iter().find(|p| &p.id == id))
                        .map_or(String::new(), |p| format!(" · {}", p.name));
                    Choice {
                        id: c.id.clone(),
                        title: format!("{}{project}", c.title).into(),
                    }
                })
                .collect(),
            chat.as_deref(),
            w,
            cx,
        );
        let month_day = picker(
            (1..=31u8)
                .map(|d| Choice {
                    id: d.to_string(),
                    title: format!("{d}").into(),
                })
                .collect(),
            Some(
                &rule
                    .as_ref()
                    .and_then(|r| r.day_of_month)
                    .unwrap_or(1)
                    .to_string(),
            ),
            w,
            cx,
        );
        let every = match rule.as_ref().map(|r| r.every.as_str()) {
            Some("week") => Every::Week,
            Some("month") => Every::Month,
            _ => Every::Day,
        };
        let mut weekdays = [true; 7];
        if let Some(days) = rule.as_ref().and_then(|r| r.weekdays.as_ref()) {
            weekdays = [false; 7];
            for d in days.iter().filter(|d| (1..=7).contains(*d)) {
                weekdays[usize::from(d - 1)] = true;
            }
        }
        let name = input(
            "Name (optional)",
            source.as_ref().map_or("", |s| s.title.as_str()),
            (1, 2),
            w,
            cx,
        );
        let zone = input(
            "Time zone",
            rule.as_ref()
                .map_or(words::local_zone(), |r| r.time_zone.as_str()),
            (1, 1),
            w,
            cx,
        );
        let text = input("What should happen?", &text, (3, 8), w, cx);
        let mut subscriptions: Vec<Subscription> = [&name, &zone, &text]
            .into_iter()
            .map(|i| cx.observe(i, |_, _, cx| cx.notify()))
            .collect();
        subscriptions.push(cx.observe(&when, |_, _, cx| cx.notify()));
        subscriptions.push(cx.observe(&time, |_, _, cx| cx.notify()));
        let model = picker(vec![default_model()], Some(""), w, cx);
        let paths = projects
            .iter()
            .map(|p| (p.id.clone(), p.path.clone()))
            .collect();
        let mut editor = Self {
            options,
            kind: Kind::Recurring,
            every,
            weekdays,
            weekday: rule.as_ref().and_then(|r| r.weekday).unwrap_or(1),
            act,
            source,
            chats,
            name,
            zone,
            text,
            time,
            when,
            month_day,
            project,
            model,
            models: None,
            models_for: None,
            model_request: 0,
            models_note: None,
            paths,
            chat,
            saving: false,
            unconfirmed: false,
            error: None,
            focus: cx.focus_handle(),
            save: None,
            _models: None,
            _subscriptions: subscriptions,
        };
        if editor.source.is_none() {
            editor.start_models(w, cx);
        }
        editor
    }
    /// One catalog reader for this sheet; a project change asks again.
    fn start_models(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Ok((reader, updates)) = Models::start(self.options.clone()) else {
            self.models_note =
                Some("Models are unavailable. The new chat uses the project default.");
            return;
        };
        self.models = Some(reader);
        self._subscriptions.push(cx.subscribe_in(
            &self.project,
            w,
            |e, _, event: &SelectEvent<SearchableVec<Choice>>, w, cx| {
                if let SelectEvent::Confirm(Some(_)) = event {
                    e.load_models(w, cx);
                }
            },
        ));
        self._models = Some(cx.spawn_in(w, async move |editor, cx| {
            while let Ok(update) = updates.recv().await {
                if editor
                    .update_in(cx, |e, w, cx| e.accept_models(update, w, cx))
                    .is_err()
                {
                    return;
                }
            }
        }));
        self.load_models(w, cx);
    }
    fn load_models(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let project = self.project.read(cx).selected_value().cloned();
        if project == self.models_for {
            return;
        }
        // Another project's models don't apply: back to the default until this list arrives.
        self.models_for = project.clone();
        self.models_note = None;
        self.model.update(cx, |p, cx| {
            p.set_items(SearchableVec::new(vec![default_model()]), w, cx);
            p.set_selected_value(&String::new(), w, cx);
        });
        let Some((id, path)) =
            project.and_then(|id| self.paths.iter().find(|(p, _)| *p == id).cloned())
        else {
            cx.notify();
            return;
        };
        self.model_request += 1;
        let request = ModelRequest {
            id: self.model_request,
            catalog_generation: 0,
            scope: Scope {
                key: format!("automation:{id}"),
                project: Some(id),
                cwd: path,
            },
            target: None,
            refresh: false,
        };
        if !self.models.as_ref().is_some_and(|r| r.request(request)) {
            self.models_note =
                Some("Models are unavailable. The new chat uses the project default.");
        }
        cx.notify();
    }
    fn accept_models(&mut self, update: ModelUpdate, w: &mut Window, cx: &mut Context<Self>) {
        if update.id != self.model_request || update.scope.project != self.models_for {
            return;
        }
        match update.result {
            Ok((catalog, _)) => {
                let mut items = vec![default_model()];
                items.extend(catalog.models.iter().take(MODELS_SHOWN).map(|m| Choice {
                    id: m.id.clone(),
                    title: m.name.clone().into(),
                }));
                // A choice made meanwhile stays when the list still has it.
                self.model.update(cx, |p, cx| {
                    p.set_items(SearchableVec::new(items), w, cx);
                    if p.selected_value().is_none() {
                        p.set_selected_value(&String::new(), w, cx);
                    }
                });
            }
            Err(_) => {
                self.models_note = Some(
                    "Couldn’t read this project’s models. The new chat uses the project default.",
                );
            }
        }
        cx.notify();
    }
    /// Typed text or a save in flight holds an app update.
    pub(crate) fn update_hold(&self, cx: &App) -> Option<crate::update_hold::Hold> {
        let typed = !self.text.read(cx).value().trim().is_empty();
        crate::update_hold::Hold::of(self.saving, typed && !self.unconfirmed)
    }
    pub(crate) fn open(editor: Entity<Self>, w: &mut Window, cx: &mut App) {
        let title = if editor.read(cx).source.is_some() {
            "Edit automation"
        } else {
            "New automation"
        };
        w.open_dialog(cx, {
            let editor = editor.clone();
            move |dialog, _, cx| {
                ui::dialog(dialog, cx)
                    .title(title)
                    .w(px(560.))
                    .overlay_closable(false)
                    .close_button(false)
                    .keyboard(false)
                    // All dismissal goes through the editor's IME guard.
                    .on_cancel(|_, _, _| false)
                    .child(editor.clone())
            }
        });
        editor.update(cx, |e, cx| e.focus(w, cx));
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.text.read(cx).focus_handle(cx).focus(w, cx);
    }
    fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        [self.name.clone(), self.zone.clone(), self.text.clone()]
            .iter()
            .any(|i| i.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()))
    }
    fn close(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        // A save in flight keeps the sheet, so its outcome is never lost.
        if !self.saving && !self.marked(w, cx) {
            cx.emit(EditorEvent::Close);
        }
    }
    /// The form's values now, never queued change events.
    pub(crate) fn draft(&self, cx: &App) -> Draft {
        let time = self.time.read(cx).time();
        let at = match self.when.read(cx).date_time() {
            DateTime::Single(Some(at)) => {
                words::local_instant(at.year(), at.month(), at.day(), at.hour(), at.minute())
            }
            _ => None,
        };
        let value = |p: &Picker| p.read(cx).selected_value().cloned();
        Draft {
            kind: if self.source.is_some() {
                Kind::Recurring
            } else {
                self.kind
            },
            every: self.every,
            weekdays: self.weekdays,
            weekday: self.weekday,
            day_of_month: value(&self.month_day)
                .and_then(|d| d.parse().ok())
                .unwrap_or(1),
            time: (time.hour(), time.minute()),
            zone: self.zone.read(cx).value().to_string(),
            at,
            act: self.act,
            project: value(&self.project),
            model: value(&self.model)
                .filter(|m| self.source.is_none() && !m.is_empty() && self.act == Act::NewChat),
            chat: value(&self.chat),
            name: self.name.read(cx).value().to_string(),
            text: self.text.read(cx).value().to_string(),
        }
    }
    pub(crate) fn submit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.saving || self.unconfirmed || self.marked(w, cx) {
            return;
        }
        let now = crate::usage_overview::now();
        let draft = self.draft(cx);
        let request = match draft.body(&self.chats, self.source.as_ref(), now) {
            Err(error) => {
                self.error = Some(error.into());
                cx.notify();
                return;
            }
            // Nothing changed: closing is the whole edit.
            Ok(None) => {
                cx.emit(EditorEvent::Close);
                return;
            }
            Ok(Some(body)) => match &self.source {
                Some(s) => Write::Edit {
                    id: s.id.clone(),
                    revision: s.revision,
                    body,
                },
                None => Write::Create { body },
            },
        };
        self.error = None;
        self.saving = true;
        let outcome = perform(self.options.clone(), request);
        self.save = Some(cx.spawn(async move |view, cx| {
            let outcome = outcome.recv().await.unwrap_or(Outcome::Unconfirmed(
                "Pilot couldn’t confirm this save. Refresh the list before trying again.".into(),
            ));
            let _ = view.update(cx, |v, cx| {
                v.saving = false;
                match outcome {
                    Outcome::Done => cx.emit(EditorEvent::Saved),
                    Outcome::Refused(text) => v.error = Some(text),
                    Outcome::Unconfirmed(text) => {
                        v.unconfirmed = true;
                        v.error = Some(text);
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn choice(
        &self,
        id: &'static str,
        label: &'static str,
        selected: bool,
    ) -> gpui_kit::component::button::Button {
        ui::action(id, label, Action::Quiet)
            .selected(selected)
            .disabled(self.saving)
    }
}
fn field(label: &'static str, control: impl IntoElement) -> gpui_kit::Div {
    row(label, control).items_center()
}
fn row(label: &'static str, control: impl IntoElement) -> gpui_kit::Div {
    div()
        .h_flex()
        .w_full()
        .min_w_0()
        .gap_3()
        .child(ui::text(Text::Label, label).w(px(92.)).flex_none())
        .child(div().flex_1().min_w_0().child(control))
}
impl Render for Editor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let editing = self.source.is_some();
        let kind = if editing { Kind::Recurring } else { self.kind };
        let busy = self.saving;
        let mut form = div()
            .id("automation-editor")
            .test_support()
            .w_full()
            .min_w_0()
            .v_flex()
            .gap_3()
            .track_focus(&self.focus)
            .key_context("AutomationEditor")
            .capture_action(
                cx.listener(|v, event: &gpui_kit::base::input::Enter, w, cx| {
                    if event.secondary && !event.shift {
                        cx.stop_propagation();
                        v.submit(w, cx);
                    }
                }),
            )
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                cx.stop_propagation();
                v.close(w, cx);
            }))
            .on_action(cx.listener(|v, _: &SaveAutomation, w, cx| v.submit(w, cx)))
            .on_action(cx.listener(|v, _: &CloseAutomation, w, cx| v.close(w, cx)));
        if !editing {
            form = form.child(
                ButtonGroup::new("automation-kind")
                    .small()
                    .outline()
                    .self_start()
                    .child(
                        self.choice(
                            "automation-kind-recurring",
                            "Repeats",
                            kind == Kind::Recurring,
                        )
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.kind = Kind::Recurring;
                            cx.notify();
                        })),
                    )
                    .child(
                        self.choice("automation-kind-once", "Once", kind == Kind::Once)
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.kind = Kind::Once;
                                cx.notify();
                            })),
                    ),
            );
        }
        form = form.child(field(
            "Name",
            div()
                .id("automation-name")
                .test_support()
                .child(Textarea::new(&self.name).aria_label("Name").disabled(busy)),
        ));
        match kind {
            Kind::Recurring => {
                let every = self.every;
                let mut repeat = ButtonGroup::new("automation-every").small().outline();
                for (id, label, value) in [
                    ("automation-every-day", "Daily", Every::Day),
                    ("automation-every-week", "Weekly", Every::Week),
                    ("automation-every-month", "Monthly", Every::Month),
                ] {
                    repeat = repeat.child(self.choice(id, label, every == value).on_click(
                        cx.listener(move |v, _, _, cx| {
                            v.every = value;
                            cx.notify();
                        }),
                    ));
                }
                form = form.child(field("Repeat", repeat));
                let days = match every {
                    Every::Month => div().w(px(96.)).child(
                        Select::new(&self.month_day)
                            .id("automation-month-day")
                            .small()
                            .w_full()
                            .focus_ring(false)
                            .menu_max_h(px(240.))
                            .disabled(busy)
                            .accessibility_label("Day of the month"),
                    ),
                    _ => {
                        let mut group = ButtonGroup::new("automation-days")
                            .small()
                            .outline()
                            .multiple(every == Every::Day);
                        for (ix, label) in DAYS.iter().enumerate() {
                            let selected = match every {
                                Every::Day => self.weekdays[ix],
                                _ => usize::from(self.weekday) == ix + 1,
                            };
                            group = group.child(
                                ui::action(
                                    SharedString::from(format!("automation-day-{}", ix + 1)),
                                    *label,
                                    Action::Quiet,
                                )
                                .selected(selected)
                                .disabled(busy)
                                .on_click(cx.listener(
                                    move |v, _, _, cx| {
                                        if v.every == Every::Day {
                                            v.weekdays[ix] = !v.weekdays[ix];
                                        } else {
                                            v.weekday = ix as u8 + 1;
                                        }
                                        cx.notify();
                                    },
                                )),
                            );
                        }
                        div().child(group)
                    }
                };
                form = form.child(field(
                    if every == Every::Month { "Day" } else { "On" },
                    days,
                ));
                form = form.child(field(
                    "At",
                    div()
                        .h_flex()
                        .items_center()
                        .gap_3()
                        .min_w_0()
                        .child(
                            div()
                                .id("automation-time")
                                .test_support()
                                .flex_none()
                                .child(TimeField::new(&self.time).small().disabled(busy)),
                        )
                        .child(
                            div()
                                .id("automation-zone")
                                .test_support()
                                .flex_1()
                                .min_w_0()
                                .child(
                                    Textarea::new(&self.zone)
                                        .aria_label("Time zone")
                                        .disabled(busy),
                                ),
                        ),
                ));
            }
            Kind::Once => {
                form = form.child(field(
                    "When",
                    div().id("automation-when").test_support().child(
                        DatePicker::new(&self.when)
                            .small()
                            .placeholder("Choose a date and time")
                            .disabled(busy),
                    ),
                ));
            }
        }
        let act = self.act;
        form = form.child(field(
            "Action",
            ButtonGroup::new("automation-act")
                .small()
                .outline()
                .child(
                    self.choice(
                        "automation-act-chat",
                        "Start a new chat",
                        act == Act::NewChat,
                    )
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.act = Act::NewChat;
                        cx.notify();
                    })),
                )
                .child(
                    self.choice(
                        "automation-act-message",
                        "Send to a chat",
                        act == Act::Message,
                    )
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.act = Act::Message;
                        cx.notify();
                    })),
                ),
        ));
        let (label, picker, id) = match act {
            Act::NewChat => ("Project", &self.project, "automation-project"),
            Act::Message => ("Chat", &self.chat, "automation-chat"),
        };
        form = form.child(field(
            label,
            Select::new(picker)
                .id(id)
                .small()
                .w_full()
                .focus_ring(false)
                .menu_max_h(px(260.))
                .disabled(busy)
                .accessibility_label(label),
        ));
        if !editing && act == Act::NewChat {
            form = form.child(field(
                "Model",
                Select::new(&self.model)
                    .id("automation-model")
                    .small()
                    .w_full()
                    .focus_ring(false)
                    .menu_max_h(px(260.))
                    .disabled(busy)
                    .accessibility_label("Model"),
            ));
            if let Some(note) = self.models_note {
                form = form.child(
                    ui::text(Text::Caption, note)
                        .id("automation-model-note")
                        .test_support()
                        .text_color(cx.theme().muted_foreground),
                );
            }
        }
        let label = match act {
            Act::NewChat => "Prompt",
            Act::Message => "Message",
        };
        form = form.child(
            row(
                label,
                div()
                    .id("automation-text")
                    .test_support()
                    .w_full()
                    .min_w_0()
                    .child(Textarea::new(&self.text).aria_label(label).disabled(busy)),
            )
            .items_start(),
        );
        let now = crate::usage_overview::now();
        if let Some(summary) = self.draft(cx).summary(&self.chats, now) {
            form = form.child(
                ui::text(Text::Caption, SharedString::from(summary))
                    .id("automation-summary")
                    .test_support()
                    .text_color(cx.theme().muted_foreground),
            );
        }
        if let Some(error) = &self.error {
            form = form.child(div().id("automation-editor-error").test_support().child(
                Notice::new(SharedString::from(error.clone())).tone(if self.unconfirmed {
                    Tone::Warning
                } else {
                    Tone::Error
                }),
            ));
        }
        form.child(
            div()
                .h_flex()
                .gap_2()
                .pt_1()
                .child(
                    ui::action(
                        "automation-save",
                        if editing { "Save" } else { "Create" },
                        Action::Primary,
                    )
                    .disabled(busy || self.unconfirmed)
                    .loading(busy)
                    .tooltip(if editing {
                        "Save this automation (⌘Enter)"
                    } else {
                        "Create this automation (⌘Enter)"
                    })
                    .on_click(cx.listener(|v, _, w, cx| v.submit(w, cx))),
                )
                .child(
                    ui::action(
                        "automation-cancel",
                        if self.unconfirmed { "Close" } else { "Cancel" },
                        Action::Quiet,
                    )
                    .disabled(busy)
                    .on_click(cx.listener(|v, _, w, cx| v.close(w, cx))),
                ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduled_messages::Snapshot;
    fn draft() -> Draft {
        Draft {
            kind: Kind::Recurring,
            every: Every::Week,
            weekdays: [true; 7],
            weekday: 1,
            day_of_month: 1,
            time: (9, 0),
            zone: "Europe/Paris".into(),
            at: None,
            act: Act::NewChat,
            project: Some("project-a".into()),
            model: None,
            chat: None,
            name: "Weekly DB performance analysis".into(),
            text: "Analyse slow queries 日本語".into(),
        }
    }
    fn chats() -> Vec<Chat> {
        vec![
            crate::local_model::chat(
                &json!({"id":"chat-a","title":"Design","projectId":"project-a","state":"idle"}),
            )
            .unwrap(),
            crate::local_model::chat(&json!({"id":"loose","title":"Loose","state":"idle"}))
                .unwrap(),
        ]
    }
    #[test]
    fn create_bodies_for_rules_and_one_time_messages() {
        let body = draft().body(&chats(), None, 0).unwrap().unwrap();
        assert_eq!(
            body,
            json!({"title":"Weekly DB performance analysis","trigger":"recurring",
                "recurrence":{"every":"week","time":"09:00","timeZone":"Europe/Paris","weekday":1},
                "target":{"kind":"chat","spawn":{"message":"Analyse slow queries 日本語","projectId":"project-a"}}})
        );
        let mut d = draft();
        d.every = Every::Day;
        d.weekdays = [true, true, true, true, true, false, false];
        assert_eq!(
            d.body(&chats(), None, 0).unwrap().unwrap()["recurrence"]["weekdays"],
            json!([1, 2, 3, 4, 5])
        );
        d.weekdays = [true; 7];
        assert!(
            d.body(&chats(), None, 0).unwrap().unwrap()["recurrence"]
                .get("weekdays")
                .is_none()
        );
        d.weekdays = [false; 7];
        assert!(d.body(&chats(), None, 0).is_err());
        let mut d = draft();
        d.model = Some("anthropic/claude".into());
        assert_eq!(
            d.body(&chats(), None, 0).unwrap().unwrap()["target"]["spawn"],
            json!({"message":"Analyse slow queries 日本語","projectId":"project-a","model":"anthropic/claude"}),
            "a chosen model goes into the new chat's spawn"
        );
        let mut d = draft();
        d.every = Every::Month;
        d.day_of_month = 31;
        assert_eq!(
            d.body(&chats(), None, 0).unwrap().unwrap()["recurrence"]["dayOfMonth"],
            json!(31)
        );
        let mut once = draft();
        once.kind = Kind::Once;
        once.act = Act::Message;
        once.chat = Some("loose".into());
        once.name = String::new();
        once.at = Some(5_000);
        assert_eq!(
            once.body(&chats(), None, 1_000).unwrap().unwrap(),
            json!({"trigger":"at","at":5_000,"target":{"kind":"message","sessionId":"loose","message":"Analyse slow queries 日本語"}})
        );
        assert!(
            once.body(&chats(), None, 6_000).is_err(),
            "past times are refused"
        );
        once.kind = Kind::Recurring;
        assert!(
            once.body(&chats(), None, 0).is_err(),
            "repeating messages need a project chat"
        );
        for bad in [
            Draft {
                zone: "../etc".into(),
                ..draft()
            },
            Draft {
                text: "  \n".into(),
                ..draft()
            },
            Draft {
                project: None,
                ..draft()
            },
            Draft {
                name: "x".repeat(201),
                ..draft()
            },
            Draft {
                text: "x".repeat(17 * 1024),
                ..draft()
            },
        ] {
            assert!(bad.body(&chats(), None, 0).is_err());
        }
    }
    #[test]
    fn edits_send_only_changed_fields_and_keep_chat_settings() {
        let rule = json!([{"id":"rule","revision":3,"title":"Weekly DB performance analysis","projectId":"project-a","trigger":"recurring","at":10,
            "recurrence":{"every":"week","time":"09:00","timeZone":"Europe/Paris","weekday":1},
            "target":{"kind":"chat","spawn":{"message":"Analyse slow queries 日本語","projectId":"project-a","model":"m","thinking":"high"}},
            "state":"pending","createdAt":1,"updatedAt":1,"handledThrough":1,"runs":[]}]);
        let snapshot = Snapshot::from_value(&rule).unwrap();
        let old = &snapshot.items[0];
        assert_eq!(
            draft().body(&chats(), Some(old), 0).unwrap(),
            None,
            "nothing changed"
        );
        let mut d = draft();
        d.time = (10, 30);
        d.text = "New prompt".into();
        let patch = d.body(&chats(), Some(old), 0).unwrap().unwrap();
        assert_eq!(patch["recurrence"]["time"], "10:30");
        assert_eq!(
            patch["target"],
            json!({"kind":"chat","spawn":{"message":"New prompt","projectId":"project-a","model":"m","thinking":"high"}})
        );
        assert!(patch.get("title").is_none());
        let mut d = draft();
        d.project = Some("project-b".into());
        let patch = d.body(&chats(), Some(old), 0).unwrap().unwrap();
        assert_eq!(
            patch["target"]["spawn"],
            json!({"message":"Analyse slow queries 日本語","projectId":"project-b"})
        );
        assert!(
            patch.get("recurrence").is_none(),
            "an unchanged rule keeps its handled cursor"
        );
    }
    #[test]
    fn summaries_say_when_it_runs() {
        let d = draft();
        assert!(
            d.summary(&[], 0)
                .unwrap()
                .starts_with("Mondays at 09:00 (Europe/Paris).")
        );
        let mut once = draft();
        once.kind = Kind::Once;
        once.at = None;
        assert_eq!(once.summary(&[], 0), None);
    }
}

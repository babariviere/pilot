//! Insights review settings: one compact editor for the desired weekly review, Save,
//! then a separate Apply confirmation from Local's exact fresh preview. Save persists
//! desired values only; the current weekly rule keeps its settings until Apply. Reads are
//! passive GETs; each write is one durable native operation, only ever Checked after that.
use super::*;
use crate::{
    delivery_store::Failure,
    insights_enable::Model,
    insights_settings::{self as review, Frozen, Gate, Preview, Settings, Snapshot},
    local_model::Project,
};
use chrono::{NaiveTime, Timelike};
use gpui_kit::{
    AppContext as _, EntityInputHandler as _, Subscription,
    component::{
        Selectable as _, Sizable as _,
        button::ButtonGroup,
        checkbox::Checkbox,
        input::{Input, InputState},
        time_field::{TimeField, TimeFieldState},
    },
};

const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Edit,
    /// The Apply confirmation over the latest preview read.
    Preview,
}

/// The values being edited and the exact snapshot they started from.
struct Draft {
    base: Snapshot,
    settings: Settings,
}
/// Text and time controls; their contents are read at Save, never mirrored on change.
struct Inputs {
    time: Entity<TimeFieldState>,
    zone: Entity<InputState>,
    budget: Entity<InputState>,
    _observe: Vec<Subscription>,
}

pub(crate) struct Editor {
    session: String,
    snapshot: Load<Gate<Snapshot>>,
    seq: u64,
    reading: Option<Task<()>>,
    draft: Option<Draft>,
    /// Local saved a different revision while these edits were open.
    stale: bool,
    /// Inputs take the draft's values at the next render.
    seed: bool,
    inputs: Option<Inputs>,
    sources_open: bool,
    projects: Arc<Vec<Project>>,
    mode: Mode,
    preview: Option<Load<Gate<Preview>>>,
    preview_seq: u64,
    preview_read: Option<Task<()>>,
    /// The latest panel request whose settled reply was handled here.
    handled: u64,
    /// A short confirmation of the last accepted Save or Apply.
    done: Option<String>,
}
impl Editor {
    pub(super) fn new(session: String) -> Self {
        Self {
            session,
            snapshot: Load::Loading,
            seq: 0,
            reading: None,
            draft: None,
            stale: false,
            seed: false,
            inputs: None,
            sources_open: false,
            projects: Arc::new(Vec::new()),
            mode: Mode::Edit,
            preview: None,
            preview_seq: 0,
            preview_read: None,
            handled: 0,
            done: None,
        }
    }
    fn project_name(&self, id: &str) -> Option<&str> {
        self.projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.name.as_str())
    }
}

fn hm(t: &str) -> NaiveTime {
    t.split_once(':')
        .and_then(|(h, m)| NaiveTime::from_hms_opt(h.parse().ok()?, m.parse().ok()?, 0))
        .unwrap_or(NaiveTime::MIN)
}
fn usd_text(usd: f64) -> String {
    if usd.fract() == 0. {
        format!("{usd:.0}")
    } else {
        format!("{usd:.2}")
    }
}
fn budget_words(usd: f64, monthly: bool) -> String {
    format!(
        "About ${} per {}",
        usd_text(usd),
        if monthly { "month" } else { "report" }
    )
}
fn sample_words((i, h, e): (u64, u64, u64)) -> String {
    format!(
        "Partial: {i} chat list page{}, {h} history pages, {e} entries each",
        if i == 1 { "" } else { "s" }
    )
}
fn next_words(at: u64) -> String {
    crate::scheduled_messages::words(
        at,
        crate::usage_overview::now(),
        crate::subscription_pause::local_offset,
    )
}
fn note<T: Into<SharedString>>(id: &'static str, text: T, cx: &App) -> impl IntoElement + use<T> {
    div()
        .id(id)
        .test_support()
        .child(ui::text(Text::Caption, text.into()).text_color(cx.theme().muted_foreground))
}
fn warn<T: Into<SharedString>>(id: &'static str, text: T, cx: &App) -> impl IntoElement + use<T> {
    div()
        .id(id)
        .test_support()
        .child(ui::text(Text::Caption, text.into()).text_color(Tone::Warning.color(cx)))
}
fn stack() -> gpui_kit::Div {
    div().v_flex().gap_1().min_w_0()
}

impl Panel {
    fn review_mut(&mut self) -> Option<&mut Editor> {
        self.review.as_mut()
    }
    /// Project names for the source list; never a destination.
    pub(super) fn review_projects(&mut self, projects: Arc<Vec<Project>>, cx: &mut Context<Self>) {
        let Some(r) = self.review_mut() else {
            return;
        };
        r.projects = projects;
        self.review_catalog(cx);
        cx.notify();
    }
    /// The report project's model catalog, for names and the model choice.
    fn review_catalog(&mut self, cx: &mut Context<Self>) {
        let Some(r) = &self.review else {
            return;
        };
        let Some(d) = &r.draft else {
            return;
        };
        let Some(path) = r
            .projects
            .iter()
            .find(|p| p.id == d.base.project_id)
            .map(|p| p.path.clone())
        else {
            return;
        };
        if self.catalog_path.as_deref() == Some(path.as_str()) {
            return;
        }
        self.model = Some(d.base.chat.model.clone());
        self.catalog_path = Some(path);
        self.catalog = Load::Loading;
        self.read_catalog(cx);
    }

    /// Passive settings read. Only the newest read lands.
    pub(super) fn review_refresh(&mut self, cx: &mut Context<Self>) {
        let options = self.options.clone();
        let Some(r) = self.review_mut() else {
            return;
        };
        r.seq += 1;
        let seq = r.seq;
        if !matches!(r.snapshot, Load::Ready(_)) {
            r.snapshot = Load::Loading;
        }
        let Some(rx) = review::read_snapshot(options, r.session.clone()) else {
            r.snapshot = Load::Failed("Couldn't read settings.".into());
            return;
        };
        r.reading = Some(cx.spawn(async move |view, cx| {
            let reply = rx.recv().await;
            let _ = view.update(cx, |v, cx| {
                if v.review.as_ref().is_none_or(|r| r.seq != seq) {
                    return;
                }
                match reply {
                    Ok(Ok(Gate::Ready(s))) => v.review_adopt(s, cx),
                    Ok(Ok(Gate::Unsupported)) => {
                        if let Some(r) = v.review_mut() {
                            r.snapshot = Load::Ready(Gate::Unsupported);
                        }
                    }
                    Ok(Err(e)) => {
                        if let Some(r) = v.review_mut() {
                            r.snapshot = Load::Failed(e.into());
                        }
                    }
                    Err(_) => {
                        if let Some(r) = v.review_mut() {
                            r.snapshot = Load::Failed("Couldn't read settings.".into());
                        }
                    }
                }
                if let Some(r) = v.review_mut() {
                    r.reading = None;
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    /// A fresh snapshot. Unsaved edits are kept; a newer saved revision marks them stale.
    fn review_adopt(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        // The shown values, valid or not: only a real difference keeps edits apart.
        let current = self.review_read(cx).ok();
        let Some(r) = self.review_mut() else {
            return;
        };
        r.snapshot = Load::Ready(Gate::Ready(snapshot.clone()));
        match &mut r.draft {
            None => {
                r.draft = Some(Draft {
                    settings: snapshot.settings.clone(),
                    base: snapshot,
                });
                r.seed = true;
            }
            Some(d) => {
                let dirty = current.as_ref().is_none_or(|c| *c != d.base.settings);
                let same = d.base.revision == snapshot.revision
                    && d.base.project_id == snapshot.project_id
                    && d.base.mission_id == snapshot.mission_id;
                if current.as_ref() == Some(&snapshot.settings) {
                    // What Local saved is what is shown: nothing to keep apart.
                    d.base = snapshot;
                    r.stale = false;
                } else if !dirty {
                    d.settings = snapshot.settings.clone();
                    d.base = snapshot;
                    r.stale = false;
                    r.seed = true;
                } else if same {
                    // Same saved revision: fresher fences, the user's edits unchanged.
                    d.base = snapshot;
                } else {
                    r.stale = true;
                }
            }
        }
        self.review_catalog(cx);
    }
    /// The settings shown now, validated: the draft plus the time, zone and budget controls.
    fn review_values(&self, cx: &App) -> Result<Settings, Failure> {
        let s = self.review_read(cx)?;
        let r = self.review.as_ref().ok_or("No settings.")?;
        if let Some(p) = &s.projects
            && p.iter().any(|id| !r.projects.iter().any(|l| &l.id == id))
        {
            return Err("Remove unavailable projects before saving.");
        }
        s.validate()?;
        Ok(s)
    }
    /// The shown values, before validation: only an unreadable amount fails here.
    fn review_read(&self, cx: &App) -> Result<Settings, Failure> {
        let r = self.review.as_ref().ok_or("No settings.")?;
        let d = r.draft.as_ref().ok_or("No settings.")?;
        let mut s = d.settings.clone();
        if let Some(i) = &r.inputs {
            let t = i.time.read(cx).time();
            s.time = format!("{:02}:{:02}", t.hour(), t.minute());
            s.zone = i.zone.read(cx).value().trim().to_owned();
            let usd = i
                .budget
                .read(cx)
                .value()
                .trim()
                .trim_start_matches('$')
                .trim()
                .to_owned();
            s.budget_usd = usd
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
                .ok_or("Enter the budget in dollars, such as 5.")?;
            // Cents are the finest advisory amount.
            s.budget_usd = (s.budget_usd * 100.).round() / 100.;
        }
        let base = &d.base.settings;
        s.user_budget =
            base.user_budget || s.budget_usd != base.budget_usd || s.monthly != base.monthly;
        Ok(s)
    }
    fn review_dirty(&self, cx: &App) -> bool {
        let Some(d) = self.review.as_ref().and_then(|r| r.draft.as_ref()) else {
            return false;
        };
        self.review_read(cx).map_or(true, |s| s != d.base.settings)
    }
    /// Text inputs need a window; created and seeded here, at render.
    pub(super) fn review_seed(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(r) = self.review.as_mut() else {
            return;
        };
        let values = r.draft.as_ref().map(|d| d.settings.clone());
        if r.inputs.is_none() {
            let time = cx.new(|cx| TimeFieldState::new(w, cx));
            let zone = cx.new(|cx| InputState::new(w, cx).placeholder("Europe/Paris"));
            let budget = cx.new(|cx| InputState::new(w, cx).placeholder("5"));
            let observe = vec![
                cx.observe(&time, |_, _, cx| cx.notify()),
                cx.observe(&zone, |_, _, cx| cx.notify()),
                cx.observe(&budget, |_, _, cx| cx.notify()),
            ];
            r.inputs = Some(Inputs {
                time,
                zone,
                budget,
                _observe: observe,
            });
            r.seed = values.is_some();
        }
        if !std::mem::take(&mut r.seed) {
            return;
        }
        let (Some(i), Some(s)) = (&r.inputs, values) else {
            return;
        };
        let (time, zone, budget) = (i.time.clone(), i.zone.clone(), i.budget.clone());
        time.update(cx, |t, cx| t.set_time(hm(&s.time), w, cx));
        zone.update(cx, |z, cx| z.set_value(s.zone.clone(), w, cx));
        budget.update(cx, |b, cx| b.set_value(usd_text(s.budget_usd), w, cx));
    }
    /// An open IME composition in any text control keeps the panel open.
    pub(super) fn review_marked(&self, w: &mut Window, cx: &mut App) -> bool {
        let Some(i) = self.review.as_ref().and_then(|r| r.inputs.as_ref()) else {
            return false;
        };
        [i.zone.clone(), i.budget.clone()]
            .iter()
            .any(|s| s.update(cx, |s, cx| s.marked_text_range(w, cx).is_some()))
    }

    fn review_edit(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut Settings)) {
        if self.waiting() {
            return;
        }
        if let Some(d) = self.review_mut().and_then(|r| r.draft.as_mut()) {
            f(&mut d.settings);
        }
        if let Some(r) = self.review_mut() {
            r.done = None;
        }
        self.error = None;
        cx.notify();
    }
    /// Discard edits for Local's newer saved values.
    fn review_discard(&mut self, cx: &mut Context<Self>) {
        let Some(r) = self.review_mut() else {
            return;
        };
        if let (Load::Ready(Gate::Ready(s)), Some(d)) = (&r.snapshot, &mut r.draft) {
            d.settings = s.settings.clone();
            d.base = s.clone();
        }
        r.stale = false;
        r.seed = true;
        cx.notify();
    }
    /// Keep the edits and save them over Local's newer revision, explicitly.
    fn review_keep(&mut self, cx: &mut Context<Self>) {
        let Some(r) = self.review_mut() else {
            return;
        };
        if let (Load::Ready(Gate::Ready(s)), Some(d)) = (&r.snapshot, &mut r.draft) {
            d.base = s.clone();
        }
        r.stale = false;
        cx.notify();
    }
    fn review_open(&self) -> bool {
        let Some(r) = &self.review else {
            return false;
        };
        [
            review::settings_slot(&r.session),
            review::apply_slot(&r.session),
        ]
        .iter()
        .any(|s| self.attempt(s).is_some_and(|a| a.open()))
    }
    fn review_save(&mut self, cx: &mut Context<Self>) {
        // A second click in the same frame finds this Save still unanswered.
        if self.review_open()
            || self
                .review
                .as_ref()
                .is_some_and(|r| r.stale || self.unanswered(&review::settings_slot(&r.session)))
        {
            return;
        }
        let request = self.review_values(cx).and_then(|s| {
            self.review
                .as_ref()
                .and_then(|r| r.draft.as_ref())
                .ok_or("No settings.")?
                .base
                .request(&s)
        });
        match request {
            Ok(r) => {
                if let Some(e) = self.review_mut() {
                    e.done = None;
                }
                self.send(model::Action::Start(r), cx);
            }
            Err(e) => {
                self.error = Some(e);
                cx.notify();
            }
        }
    }
    /// Passive Apply preview. A sent Apply or a newer read wins over a late reply.
    fn review_preview(&mut self, cx: &mut Context<Self>) {
        let options = self.options.clone();
        let Some(r) = self.review_mut() else {
            return;
        };
        r.mode = Mode::Preview;
        r.done = None;
        r.preview_seq += 1;
        let seq = r.preview_seq;
        r.preview = Some(Load::Loading);
        let Some(rx) = review::read_preview(options, r.session.clone()) else {
            r.preview = Some(Load::Failed("Couldn't check Apply.".into()));
            return;
        };
        r.preview_read = Some(cx.spawn(async move |view, cx| {
            let reply = rx.recv().await;
            let _ = view.update(cx, |v, cx| {
                let Some(r) = v.review_mut() else {
                    return;
                };
                if r.preview_seq != seq {
                    return;
                }
                r.preview_read = None;
                r.preview = Some(match reply {
                    Ok(Ok(p)) => Load::Ready(p),
                    Ok(Err(e)) => Load::Failed(e.into()),
                    Err(_) => Load::Failed("Couldn't check Apply.".into()),
                });
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn review_back(&mut self, cx: &mut Context<Self>) {
        if let Some(r) = self.review_mut() {
            r.mode = Mode::Edit;
            r.preview_seq += 1;
            r.preview = None;
            r.preview_read = None;
        }
        cx.notify();
    }
    fn review_apply(&mut self, cx: &mut Context<Self>) {
        let Some(r) = &self.review else {
            return;
        };
        let Some(Load::Ready(Gate::Ready(Preview {
            frozen: Some(f), ..
        }))) = &r.preview
        else {
            return;
        };
        // A second click in the same frame finds this Apply still unanswered.
        if self.review_open() || self.unanswered(&review::apply_slot(&r.session)) {
            return;
        }
        let request = f.request(&r.session);
        // A late preview never replaces the confirmation that was just sent.
        if let Some(r) = self.review_mut() {
            r.preview_seq += 1;
            r.preview_read = None;
        }
        self.send(model::Action::Start(request), cx);
    }

    /// The panel's latest command settled as accepted: re-read the saved values.
    pub(super) fn review_settled(&mut self, result: &serde_json::Value, cx: &mut Context<Self>) {
        let request = self.request;
        let apply = self
            .slot
            .as_deref()
            .is_some_and(|s| s.starts_with("apply:"));
        let Some(r) = self.review_mut() else {
            return;
        };
        if r.handled >= request {
            return;
        }
        r.handled = request;
        r.done = Some(if apply {
            r.mode = Mode::Edit;
            r.preview = None;
            format!(
                "Applied revision {}. Weekly rule {}.",
                result["settingsRevision"].as_u64().unwrap_or_default(),
                result["scheduleId"].as_str().unwrap_or_default()
            )
        } else {
            format!(
                "Saved revision {}. Apply to use it.",
                result["revision"].as_u64().unwrap_or_default()
            )
        });
        self.review_refresh(cx);
    }
    /// A refusal: re-read before any new confirmation; edits stay.
    pub(super) fn review_refused(&mut self, cx: &mut Context<Self>) {
        let request = self.request;
        let Some(r) = self.review_mut() else {
            return;
        };
        if r.handled >= request {
            return;
        }
        r.handled = request;
        if r.mode == Mode::Preview {
            r.preview = None;
        }
        self.review_refresh(cx);
    }

    pub(super) fn review_probe_ready(&self) -> bool {
        let Some(r) = &self.review else {
            return true;
        };
        let models = self.catalog_path.is_none() || !matches!(self.catalog, Load::Loading);
        !matches!(r.snapshot, Load::Loading)
            && r.reading.is_none()
            && !matches!(r.preview, Some(Load::Loading))
            && models
    }

    /// The retained Apply this panel follows, open or settled, with its frozen values.
    fn review_apply_attempt(&self) -> Option<(model::Attempt, Frozen)> {
        let r = self.review.as_ref()?;
        let a = self.attempt(&review::apply_slot(&r.session))?.clone();
        let f = Frozen::retained(&a.operation)?;
        Some((a, f))
    }

    pub(super) fn render_review(
        &mut self,
        cx: &mut Context<Self>,
    ) -> (gpui_kit::Div, gpui_kit::Div) {
        if let Some((a, f)) = self.review_apply_attempt().filter(|(a, _)| a.open()) {
            return self.render_apply_progress(&a, &f, cx);
        }
        let mode = self.review.as_ref().map_or(Mode::Edit, |r| r.mode);
        match mode {
            Mode::Preview => self.render_apply_preview(cx),
            Mode::Edit => self.render_editor(cx),
        }
    }

    fn model_label(&self, id: &str) -> String {
        match &self.catalog {
            Load::Ready(c) => c
                .models
                .iter()
                .find(|m| m.id == id)
                .map_or_else(|| id.to_owned(), |m| m.name.clone()),
            _ => id.to_owned(),
        }
    }
    fn thinking_words(&self, model: &str, thinking: Option<&str>) -> (String, bool) {
        let Some(t) = thinking else {
            return ("Thinking: Default".into(), true);
        };
        let supported = match &self.catalog {
            Load::Ready(c) => c
                .models
                .iter()
                .find(|m| m.id == model)
                .is_none_or(|m| m.thinking_levels.iter().any(|l| l == t)),
            _ => true,
        };
        (format!("Thinking: {t}"), supported)
    }

    fn sources_summary(&self, s: &Settings) -> String {
        let reads = match &s.projects {
            None => "All projects".to_owned(),
            Some(p) => {
                let n = p
                    .iter()
                    .filter(|id| !s.exclude_projects.contains(id))
                    .count();
                match n {
                    0 => "No projects".to_owned(),
                    1 => "1 project".to_owned(),
                    n => format!("{n} projects"),
                }
            }
        };
        let archived = if s.include_archived {
            ", incl. archived"
        } else {
            ", no archived"
        };
        let excluded = match &s.projects {
            None => s.exclude_projects.len(),
            Some(_) => 0,
        } + s.exclude_sessions.len();
        if excluded > 0 {
            format!("{reads}{archived} · {excluded} excluded")
        } else {
            format!("{reads}{archived}")
        }
    }

    fn render_editor(&mut self, cx: &mut Context<Self>) -> (gpui_kit::Div, gpui_kit::Div) {
        let body = div().v_flex().gap_3().min_w_0();
        let tail = div().v_flex().gap_3().w_full().min_w_0();
        let snapshot = self.review.as_ref().map(|r| r.snapshot.clone());
        let failed = match snapshot {
            None | Some(Load::Loading) => {
                Some(note("insights-review-loading", "Reading…", cx).into_any_element())
            }
            Some(Load::Failed(e)) => Some(
                div()
                    .id("insights-review-blocked")
                    .test_support()
                    .child(Notice::new(e).tone(Tone::Error))
                    .into_any_element(),
            ),
            Some(Load::Ready(Gate::Unsupported)) => Some(
                div()
                    .id("insights-review-blocked")
                    .test_support()
                    .child(Notice::new("Update Pilot to edit review settings."))
                    .into_any_element(),
            ),
            Some(Load::Ready(Gate::Ready(_))) => None,
        };
        let has_draft = self.review.as_ref().is_some_and(|r| r.draft.is_some());
        if let Some(f) = failed.filter(|_| !has_draft) {
            let actions = div()
                .h_flex()
                .items_center()
                .gap_2()
                .child(
                    div().flex_1().h_flex().child(
                        ui::action("insights-review-retry", "Check again", Action::Quiet)
                            .on_click(cx.listener(|v, _, _, cx| v.review_refresh(cx))),
                    ),
                )
                .child(self.close_button("Close", Action::Primary, cx));
            return (body.child(f), tail.child(actions));
        }
        let (Some(r), true) = (self.review.as_ref(), has_draft) else {
            return (body, tail);
        };
        let d = r.draft.as_ref().expect("draft");
        let s = d.settings.clone();
        let base = d.base.clone();
        let stale = r.stale;
        let sources_open = r.sources_open;
        let done = r.done.clone();
        let inputs = r
            .inputs
            .as_ref()
            .map(|i| (i.time.clone(), i.zone.clone(), i.budget.clone()));
        let projects = r.projects.clone();
        let read_failed = match &r.snapshot {
            Load::Failed(e) => Some(e.clone()),
            _ => None,
        };
        let busy = self.waiting();
        let open = self.review_open();
        let dirty = self.review_dirty(cx);
        let values = self.review_values(cx);
        let locked = busy || open;

        // Saved state, in words that never claim a running rule.
        let applied = self
            .review_apply_attempt()
            .filter(|(a, f)| a.state == model::State::Accepted && f.revision == base.revision)
            .is_some();
        let state = match base.revision {
            0 => "Suggested values. Not saved yet.".to_owned(),
            n if applied => format!("Saved revision {n}, applied from this Mac."),
            n => format!("Saved revision {n}. Apply updates the weekly rule."),
        };
        let mut body = body.child(note("insights-review-state", state, cx));

        // When: day, time and zone.
        let mut days = ButtonGroup::new("insights-review-days").small().outline();
        for (ix, label) in DAYS.iter().enumerate() {
            let day = ix as u8 + 1;
            days = days.child(
                ui::action(
                    SharedString::from(format!("insights-review-day-{day}")),
                    *label,
                    Action::Quiet,
                )
                .selected(s.weekday == day)
                .disabled(locked)
                .on_click(cx.listener(move |v, _, _, cx| v.review_edit(cx, |s| s.weekday = day))),
            );
        }
        let mut when = stack().child(div().h_flex().child(days));
        if let Some((time, zone, _)) = &inputs {
            when = when.child(
                div()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .min_w_0()
                    .child(
                        div()
                            .id("insights-review-time")
                            .test_support()
                            .flex_none()
                            .child(TimeField::new(time).small().disabled(locked)),
                    )
                    .child(
                        div()
                            .id("insights-review-zone")
                            .test_support()
                            .flex_1()
                            .min_w_0()
                            .child(
                                Input::new(zone)
                                    .small()
                                    .aria_label("Time zone")
                                    .disabled(locked),
                            ),
                    ),
            );
        }
        let same_cadence = values
            .as_ref()
            .is_ok_and(|v| v.recurrence() == base.settings.recurrence());
        if let (true, Some(at)) = (same_cadence, base.next_at) {
            when = when.child(note(
                "insights-review-next",
                format!("If applied, next run: {}", next_words(at)),
                cx,
            ));
        }
        body = body.child(field("insights-review-when", "When", when, cx));

        // Model: an exact configured ID, with its effective thinking.
        let model_id = s.model.value.clone();
        let label = if s.model.by_name {
            format!("By name: {model_id}")
        } else {
            self.model_label(&model_id)
        };
        let weak = cx.weak_entity();
        let picker = match &self.catalog {
            Load::Ready(catalog) => {
                let catalog = catalog.clone();
                ui::action(
                    "insights-review-model",
                    SharedString::from(shorten(&label, 40)),
                    Action::Secondary,
                )
                .accessibility_label(SharedString::from(format!("Model: {label}")))
                .tooltip(SharedString::from(label.clone()))
                .dropdown_caret(true)
                .disabled(locked)
                .dropdown_menu(move |mut menu, _, _| {
                    for m in catalog.models.iter().take(500) {
                        let (weak, id) = (weak.clone(), m.id.clone());
                        menu = menu.item(
                            PopupMenuItem::new(SharedString::from(m.name.clone())).on_click(
                                move |_, w, cx| {
                                    let _ = weak.update(cx, |v, cx| {
                                        let id = id.clone();
                                        v.review_edit(cx, |s| {
                                            s.model = review::Requested {
                                                by_name: false,
                                                value: id,
                                            };
                                        });
                                        v.focus.focus(w, cx);
                                    });
                                },
                            ),
                        );
                    }
                    menu
                })
                .into_any_element()
            }
            Load::Loading => {
                note("insights-review-model", shorten(&label, 60), cx).into_any_element()
            }
            Load::Failed(_) => note(
                "insights-review-model",
                format!("{} (models unavailable)", shorten(&label, 60)),
                cx,
            )
            .into_any_element(),
        };
        let mut model = stack().child(div().h_flex().child(picker));
        let resolved = if s.model == base.settings.model {
            base.model.clone()
        } else {
            Model::Available(model_id.clone())
        };
        match &resolved {
            Model::Available(id) => {
                let (thinking, ok) = self.thinking_words(id, base.chat.thinking.as_deref());
                model = model.child(note(
                    "insights-review-model-note",
                    format!("{id} · {thinking}"),
                    cx,
                ));
                if !ok {
                    model = model.child(warn(
                        "insights-review-model-warning",
                        "This model doesn't offer the chat's thinking level. Apply would refuse.",
                        cx,
                    ));
                }
            }
            Model::Unavailable(_) => {
                model = model.child(warn(
                    "insights-review-model-warning",
                    "Not available. Nothing else is used instead.",
                    cx,
                ))
            }
            Model::Ambiguous(_) => {
                model = model.child(warn(
                    "insights-review-model-warning",
                    "Several models have this name. Choose one.",
                    cx,
                ))
            }
        }
        body = body.child(field("insights-review-model-field", "Model", model, cx));

        // Reads: a one-line summary, the source choices on request.
        let provider = self.model_label(match &resolved {
            Model::Available(id) => id,
            _ => &model_id,
        });
        let toggle = div()
            .id("insights-review-sources")
            .test_support()
            .h_flex()
            .items_center()
            .gap_1()
            .cursor_pointer()
            .child(ui::text(
                Text::Body,
                SharedString::from(self.sources_summary(&s)),
            ))
            .child(ui::disclosure_chevron(
                "insights-review-sources",
                sources_open,
            ))
            .on_click(cx.listener(|v, _, _, cx| {
                if let Some(r) = v.review_mut() {
                    r.sources_open = !r.sources_open;
                    cx.notify();
                }
            }));
        let mut reads = stack().child(toggle);
        if sources_open {
            reads = reads.child(self.render_sources(&s, &projects, locked, cx));
        }
        reads = reads.child(note(
            "insights-review-provider",
            format!(
                "Read-only. Sent to {}'s provider. Redaction isn't a guarantee.",
                shorten(&provider, 40)
            ),
            cx,
        ));
        body = body.child(field("insights-review-reads", "Reads", reads, cx));

        // Sample: three bounded counts.
        let (i, h, e) = s.bounds;
        let count = |id: &'static str,
                     label: String,
                     range: (u64, u64),
                     set: fn(&mut Settings, u64),
                     cx: &mut Context<Self>| {
            let weak = cx.weak_entity();
            ui::action(id, SharedString::from(label.clone()), Action::Secondary)
                .accessibility_label(SharedString::from(label))
                .dropdown_caret(true)
                .disabled(locked)
                .dropdown_menu(move |mut menu, _, _| {
                    for n in range.0..=range.1 {
                        let weak = weak.clone();
                        menu = menu.item(
                            PopupMenuItem::new(SharedString::from(n.to_string())).on_click(
                                move |_, w, cx| {
                                    let _ = weak.update(cx, |v, cx| {
                                        v.review_edit(cx, |s| set(s, n));
                                        v.focus.focus(w, cx);
                                    });
                                },
                            ),
                        );
                    }
                    menu
                })
        };
        let sample = stack()
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap_2()
                    .child(count(
                        "insights-review-inventory",
                        format!("{i} list page{}", if i == 1 { "" } else { "s" }),
                        review::INVENTORY,
                        |s, n| s.bounds.0 = n,
                        cx,
                    ))
                    .child(count(
                        "insights-review-history",
                        format!("{h} history"),
                        review::HISTORY,
                        |s, n| s.bounds.1 = n,
                        cx,
                    ))
                    .child(count(
                        "insights-review-entries",
                        format!("{e} entries"),
                        review::ENTRIES,
                        |s, n| s.bounds.2 = n,
                        cx,
                    )),
            )
            .child(note(
                "insights-review-sample",
                "Partial sample, never complete history.",
                cx,
            ));
        body = body.child(field("insights-review-coverage", "Sample", sample, cx));

        // Budget: an advisory amount and its period.
        let monthly = s.monthly;
        let mut budget = div().h_flex().items_center().gap_2().min_w_0();
        if let Some((_, _, amount)) = &inputs {
            budget = budget.child(ui::text(Text::Body, "$")).child(
                div()
                    .id("insights-review-budget")
                    .test_support()
                    .w(px(72.))
                    .child(
                        Input::new(amount)
                            .small()
                            .aria_label("Budget in dollars")
                            .disabled(locked),
                    ),
            );
        }
        budget = budget.child(
            ButtonGroup::new("insights-review-period")
                .small()
                .outline()
                .child(
                    ui::action("insights-review-per-report", "Per report", Action::Quiet)
                        .selected(!monthly)
                        .disabled(locked)
                        .on_click(
                            cx.listener(|v, _, _, cx| v.review_edit(cx, |s| s.monthly = false)),
                        ),
                )
                .child(
                    ui::action("insights-review-per-month", "Per month", Action::Quiet)
                        .selected(monthly)
                        .disabled(locked)
                        .on_click(
                            cx.listener(|v, _, _, cx| v.review_edit(cx, |s| s.monthly = true)),
                        ),
                ),
        );
        body = body.child(field(
            "insights-review-budget-field",
            "Budget",
            stack().child(budget).child(note(
                "insights-review-budget-note",
                "Advisory, not a cap. Spend isn't tracked yet.",
                cx,
            )),
            cx,
        ));

        // Tail: stale edits, validation, Check, outcome, then actions.
        let mut tail = tail;
        if let Some(e) = read_failed {
            tail = tail.child(warn(
                "insights-review-read-failed",
                format!("Couldn't refresh: {e}"),
                cx,
            ));
        }
        if stale {
            tail = tail.child(
                div()
                    .id("insights-review-stale")
                    .test_support()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded(px(crate::appearance::Radius::CONTROL))
                    .bg(cx.theme().warning.opacity(0.12))
                    .child(
                        div().flex_1().min_w_0().child(
                            ui::text(
                                Text::Caption,
                                "Settings changed on Local. Your edits are kept.",
                            )
                            .text_color(Tone::Warning.color(cx)),
                        ),
                    )
                    .child(
                        ui::action("insights-review-discard", "Discard", Action::Quiet)
                            .disabled(locked)
                            .on_click(cx.listener(|v, _, _, cx| v.review_discard(cx))),
                    )
                    .child(
                        ui::action("insights-review-keep", "Keep mine", Action::Quiet)
                            .disabled(locked)
                            .on_click(cx.listener(|v, _, _, cx| v.review_keep(cx))),
                    ),
            );
        }
        if let (Err(e), true) = (&values, dirty) {
            tail = tail.child(warn("insights-review-invalid", *e, cx));
        }
        tail = tail.children(self.check_row(cx));
        if let Some(text) = done.filter(|_| !busy) {
            tail = tail.child(
                div()
                    .id("insights-review-done")
                    .test_support()
                    .child(Notice::new(text).tone(Tone::Success)),
            );
        }
        tail = self.notices(tail, "Saving… Closing doesn't cancel it.");
        let can_save = dirty && values.is_ok() && !stale && !locked;
        let can_apply = base.revision > 0 && !dirty && !stale && !locked;
        let actions = div()
            .h_flex()
            .items_center()
            .gap_2()
            .child(
                div().flex_1().h_flex().child(
                    ui::action("insights-review-apply", "Review Apply…", Action::Quiet)
                        .disabled(!can_apply)
                        .on_click(cx.listener(|v, _, _, cx| v.review_preview(cx))),
                ),
            )
            .child(self.close_button("Close", Action::Quiet, cx))
            .child(
                ui::action("insights-review-save", "Save", Action::Primary)
                    .disabled(!can_save)
                    .on_click(cx.listener(|v, _, _, cx| v.review_save(cx))),
            );
        let tail = tail
            .child(note(
                "insights-review-save-note",
                "Save keeps desired settings. Only Apply changes the weekly rule.",
                cx,
            ))
            .child(actions);
        (body, tail)
    }

    fn render_sources(
        &self,
        s: &Settings,
        projects: &Arc<Vec<Project>>,
        locked: bool,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let selected = s.projects.is_some();
        let mut list = stack().gap_1p5().pl_1().child(
            div().h_flex().child(
                ButtonGroup::new("insights-review-scope")
                    .small()
                    .outline()
                    .child(
                        ui::action("insights-review-all", "All projects", Action::Quiet)
                            .selected(!selected)
                            .disabled(locked)
                            .on_click(
                                cx.listener(|v, _, _, cx| v.review_edit(cx, |s| s.projects = None)),
                            ),
                    )
                    .child(
                        ui::action("insights-review-selected", "Selected", Action::Quiet)
                            .selected(selected)
                            .disabled(locked)
                            .on_click(cx.listener(|v, _, _, cx| {
                                let local: Vec<String> = v
                                    .review
                                    .as_ref()
                                    .map(|r| r.projects.iter().map(|p| p.id.clone()).collect())
                                    .unwrap_or_default();
                                v.review_edit(cx, |s| {
                                    if s.projects.is_none() {
                                        s.projects = Some(
                                            local
                                                .into_iter()
                                                .filter(|id| !s.exclude_projects.contains(id))
                                                .take(review::LIST_CAP)
                                                .collect(),
                                        );
                                    }
                                })
                            })),
                    ),
            ),
        );
        for (ix, p) in projects.iter().enumerate().take(review::LIST_CAP) {
            let id = p.id.clone();
            let read = !s.exclude_projects.contains(&id)
                && s.projects.as_ref().is_none_or(|l| l.contains(&id));
            list = list.child(
                Checkbox::new(SharedString::from(format!("insights-review-project-{ix}")))
                    .label(SharedString::from(shorten(&p.name, 60)))
                    .checked(read)
                    .disabled(locked)
                    .on_click(cx.listener(move |v, checked: &bool, w, cx| {
                        let (id, on) = (id.clone(), *checked);
                        v.review_edit(cx, |s| {
                            s.exclude_projects.retain(|x| x != &id);
                            match &mut s.projects {
                                None if !on => s.exclude_projects.push(id),
                                None => {}
                                Some(l) => {
                                    l.retain(|x| x != &id);
                                    if on {
                                        l.push(id);
                                    }
                                }
                            }
                        });
                        v.focus.focus(w, cx);
                    })),
            );
        }
        // Selected projects that this Local no longer lists can't be saved; remove them here.
        let missing: Vec<String> = s
            .projects
            .iter()
            .flatten()
            .filter(|id| !projects.iter().any(|p| &p.id == *id))
            .cloned()
            .collect();
        if !missing.is_empty() {
            list = list.child(
                div()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .child(warn(
                        "insights-review-unavailable",
                        format!(
                            "{} selected project{} unavailable",
                            missing.len(),
                            if missing.len() == 1 { " is" } else { "s are" }
                        ),
                        cx,
                    ))
                    .child(
                        ui::action(
                            "insights-review-unavailable-remove",
                            "Remove",
                            Action::Quiet,
                        )
                        .disabled(locked)
                        .on_click(cx.listener(move |v, _, _, cx| {
                            let missing = missing.clone();
                            v.review_edit(cx, |s| {
                                if let Some(l) = &mut s.projects {
                                    l.retain(|x| !missing.contains(x));
                                }
                            })
                        })),
                    ),
            );
        }
        let others = s
            .exclude_projects
            .iter()
            .filter(|id| !projects.iter().any(|p| &p.id == *id))
            .count();
        if others > 0 {
            list = list.child(note(
                "insights-review-other-excluded",
                format!(
                    "{others} other project{} excluded.",
                    if others == 1 { " stays" } else { "s stay" }
                ),
                cx,
            ));
        }
        list = list.child(
            Checkbox::new("insights-review-archived")
                .label("Include archived chats")
                .checked(s.include_archived)
                .disabled(locked)
                .on_click(cx.listener(|v, checked: &bool, w, cx| {
                    let on = *checked;
                    v.review_edit(cx, |s| s.include_archived = on);
                    v.focus.focus(w, cx);
                })),
        );
        let chats = s.exclude_sessions.len();
        if chats > 0 {
            list = list.child(
                div()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .child(note(
                        "insights-review-chats",
                        format!("{chats} chat{} excluded", if chats == 1 { "" } else { "s" }),
                        cx,
                    ))
                    .child(
                        ui::action("insights-review-chats-clear", "Include them", Action::Quiet)
                            .disabled(locked)
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.review_edit(cx, |s| s.exclude_sessions.clear())
                            })),
                    ),
            );
        }
        list
    }

    /// The confirmation shows exactly what the preview's payload sends.
    fn apply_fields(
        &self,
        f: &Frozen,
        next_at: Option<u64>,
        body: gpui_kit::Div,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let name = self.model_label(&f.model);
        let (thinking, ok) = self.thinking_words(&f.model, f.chat.thinking.as_deref());
        let mut model = stack()
            .child(ui::text(Text::Body, SharedString::from(shorten(&name, 60))))
            .child(note(
                "insights-apply-model-id",
                format!("{} · {thinking}", f.model),
                cx,
            ));
        if f.changes_model() {
            model = model.child(warn(
                "insights-apply-model-change",
                format!(
                    "Changes the report chat's model from {}.",
                    shorten(&self.model_label(&f.chat.model), 40)
                ),
                cx,
            ));
        }
        if !ok {
            model = model.child(warn(
                "insights-apply-thinking",
                "This model doesn't offer the chat's thinking level. Local will refuse.",
                cx,
            ));
        }
        let cadence = crate::recurring_schedules::schedule(&f.settings.recurrence(), "");
        let when_note = if f.keeps_rule {
            "Keeps the current rule's timing.".to_owned()
        } else {
            next_at.map_or_else(
                || "Next run after Apply.".to_owned(),
                |at| format!("First run {}", next_words(at)),
            )
        };
        let s = &f.settings;
        let names = |ids: &[String]| -> String {
            let shown: Vec<String> = ids
                .iter()
                .take(5)
                .map(|id| {
                    self.review
                        .as_ref()
                        .and_then(|r| r.project_name(id))
                        .unwrap_or(id)
                        .to_owned()
                })
                .collect();
            let more = ids.len().saturating_sub(5);
            let mut t = shown.join(", ");
            if more > 0 {
                t.push_str(&format!(" and {more} more"));
            }
            t
        };
        let mut reads = stack().child(ui::text(
            Text::Body,
            SharedString::from(self.sources_summary(s)),
        ));
        if let Some(p) = &s.projects
            && !p.is_empty()
        {
            reads = reads.child(note(
                "insights-apply-projects",
                format!("Reads {}.", names(p)),
                cx,
            ));
        }
        if !s.exclude_projects.is_empty() || !s.exclude_sessions.is_empty() {
            let mut parts = Vec::new();
            if !s.exclude_projects.is_empty() {
                parts.push(names(&s.exclude_projects));
            }
            if !s.exclude_sessions.is_empty() {
                let n = s.exclude_sessions.len();
                parts.push(format!("{n} chat{}", if n == 1 { "" } else { "s" }));
            }
            reads = reads.child(note(
                "insights-apply-excluded",
                format!("Excludes {}.", parts.join("; ")),
                cx,
            ));
        }
        reads = reads.child(note(
            "insights-apply-provider",
            format!(
                "Read-only. Sent to {}'s provider. Redaction isn't a guarantee.",
                shorten(&name, 40)
            ),
            cx,
        ));
        let rule = match (&f.rule, f.keeps_rule) {
            (None, _) => stack()
                .child(ui::text(Text::Body, "Creates a weekly rule for this chat."))
                .child(note(
                    "insights-apply-rule-id",
                    format!("New rule {}", f.schedule_id),
                    cx,
                )),
            (Some(r), true) => stack()
                .child(ui::text(
                    Text::Body,
                    SharedString::from(format!("Keeps “{}”", shorten(&r.title, 60))),
                ))
                .child(note(
                    "insights-apply-rule-id",
                    format!(
                        "{} · revision {} · {} · this chat",
                        r.id,
                        r.revision,
                        crate::recurring_schedules::schedule(&r.recurrence, "")
                    ),
                    cx,
                )),
            (Some(r), false) => stack()
                .child(ui::text(
                    Text::Body,
                    SharedString::from(format!("Replaces “{}”", shorten(&r.title, 60))),
                ))
                .child(note(
                    "insights-apply-rule-id",
                    format!(
                        "Cancels {} (revision {}, {}, this chat). New rule {}.",
                        r.id,
                        r.revision,
                        crate::recurring_schedules::schedule(&r.recurrence, ""),
                        f.schedule_id
                    ),
                    cx,
                )),
        }
        .child(note(
            "insights-apply-rule-scope",
            "Other automations stay as they are. No review runs now.",
            cx,
        ));
        body.child(field("insights-apply-model", "Model", model, cx))
            .child(field(
                "insights-apply-when",
                "When",
                stack()
                    .child(ui::text(Text::Body, SharedString::from(cadence)))
                    .child(note("insights-apply-when-note", when_note, cx)),
                cx,
            ))
            // The rule effect sits beside its timing, in view before the details.
            .child(field("insights-apply-rule", "Rule", rule, cx))
            .child(field("insights-apply-reads", "Reads", reads, cx))
            .child(field(
                "insights-apply-sample",
                "Sample",
                ui::text(Text::Body, SharedString::from(sample_words(s.bounds))),
                cx,
            ))
            .child(field(
                "insights-apply-budget",
                "Budget",
                stack()
                    .child(ui::text(
                        Text::Body,
                        SharedString::from(budget_words(s.budget_usd, s.monthly)),
                    ))
                    .child(note(
                        "insights-apply-budget-note",
                        "Advisory, not a cap. Spend is unknown.",
                        cx,
                    )),
                cx,
            ))
    }

    fn render_apply_preview(&mut self, cx: &mut Context<Self>) -> (gpui_kit::Div, gpui_kit::Div) {
        let preview = self.review.as_ref().and_then(|r| r.preview.clone());
        let mut body = div().v_flex().gap_3().min_w_0();
        let mut tail = div().v_flex().gap_3().w_full().min_w_0();
        let mut confirm = false;
        match preview {
            None | Some(Load::Loading) => {
                body = body.child(note("insights-apply-checking", "Checking…", cx))
            }
            Some(Load::Failed(e)) => {
                tail = tail.child(
                    div()
                        .id("insights-apply-blocked")
                        .test_support()
                        .child(Notice::new(e).tone(Tone::Error)),
                )
            }
            Some(Load::Ready(Gate::Unsupported)) => {
                tail = tail.child(
                    div()
                        .id("insights-apply-blocked")
                        .test_support()
                        .child(Notice::new("Update Pilot to apply review settings.")),
                )
            }
            Some(Load::Ready(Gate::Ready(p))) => match &p.frozen {
                Some(f) => {
                    confirm = true;
                    body = body.child(note(
                        "insights-apply-intro",
                        format!("Applies saved revision {} to the weekly rule.", f.revision),
                        cx,
                    ));
                    body = self.apply_fields(f, p.next_at, body, cx);
                }
                None => {
                    tail = tail.child(
                        div().id("insights-apply-blocked").test_support().child(
                            Notice::new(format!(
                                "Can't apply: {}",
                                p.reason.as_deref().unwrap_or("Local refused.")
                            ))
                            .tone(Tone::Warning),
                        ),
                    )
                }
            },
        }
        tail = self.notices(tail, "Applying… Closing doesn't cancel it.");
        let busy = self.waiting();
        let enabled = confirm && !busy && !self.review_open();
        let actions = div()
            .h_flex()
            .items_center()
            .gap_2()
            .child(div().flex_1().h_flex().when(!confirm, |d| {
                d.child(
                    ui::action("insights-apply-retry", "Check again", Action::Quiet)
                        .disabled(busy)
                        .on_click(cx.listener(|v, _, _, cx| v.review_preview(cx))),
                )
            }))
            .child(
                ui::action("insights-apply-back", "Back", Action::Quiet)
                    .disabled(busy)
                    .on_click(cx.listener(|v, _, _, cx| v.review_back(cx))),
            )
            .child(
                ui::action("insights-apply-confirm", "Apply", Action::Primary)
                    .disabled(!enabled)
                    .on_click(cx.listener(|v, _, _, cx| v.review_apply(cx))),
            );
        (body, tail.child(actions))
    }

    /// A sent Apply that Local hasn't confirmed: its frozen values and Check only.
    fn render_apply_progress(
        &mut self,
        a: &model::Attempt,
        f: &Frozen,
        cx: &mut Context<Self>,
    ) -> (gpui_kit::Div, gpui_kit::Div) {
        let words = if a.state == model::State::Pending {
            "In progress. Some steps may be done."
        } else {
            "Unconfirmed. It may have applied."
        };
        let body = div().v_flex().gap_3().min_w_0().child(field(
            "insights-apply-state",
            "Status",
            ui::text(Text::Body, words).text_color(Tone::Warning.color(cx)),
            cx,
        ));
        let body = self.apply_fields(f, None, body, cx);
        let mut tail = div().v_flex().gap_3().w_full().min_w_0();
        tail = tail.children(self.check_row(cx));
        tail = self.notices(tail, "Checking… Closing doesn't cancel it.");
        let actions = div()
            .h_flex()
            .justify_end()
            .gap_2()
            .child(self.close_button("Close", Action::Primary, cx));
        (body, tail.child(actions))
    }
}

/// Hidden probes read the same state the view draws; never compiled into production.
#[cfg(feature = "native-probes")]
impl Panel {
    /// "loading", "edit", "preview" or "progress".
    pub(crate) fn probe_review_mode(&self) -> &'static str {
        if self.review_apply_attempt().is_some_and(|(a, _)| a.open()) {
            return "progress";
        }
        match self.review.as_ref() {
            Some(r) if r.mode == Mode::Preview => "preview",
            Some(r) if r.draft.is_some() => "edit",
            _ => "loading",
        }
    }
    pub(crate) fn probe_review_values(&self, cx: &App) -> Result<Settings, Failure> {
        self.review_values(cx)
    }
    pub(crate) fn probe_review_base(&self) -> Option<Snapshot> {
        Some(self.review.as_ref()?.draft.as_ref()?.base.clone())
    }
    pub(crate) fn probe_review_dirty(&self, cx: &App) -> bool {
        self.review_dirty(cx)
    }
    pub(crate) fn probe_review_stale(&self) -> bool {
        self.review.as_ref().is_some_and(|r| r.stale)
    }
    pub(crate) fn probe_review_preview(&self) -> Option<Preview> {
        match self.review.as_ref()?.preview.as_ref()? {
            Load::Ready(Gate::Ready(p)) => Some(p.clone()),
            _ => None,
        }
    }
    pub(crate) fn probe_review_done(&self) -> Option<String> {
        self.review.as_ref()?.done.clone()
    }
    pub(crate) fn probe_review_inputs(
        &self,
    ) -> Option<(
        Entity<TimeFieldState>,
        Entity<InputState>,
        Entity<InputState>,
    )> {
        let i = self.review.as_ref()?.inputs.as_ref()?;
        Some((i.time.clone(), i.zone.clone(), i.budget.clone()))
    }
    pub(crate) fn probe_review_sources(&mut self, open: bool, cx: &mut Context<Self>) {
        if let Some(r) = self.review_mut() {
            r.sources_open = open;
        }
        cx.notify();
    }
}

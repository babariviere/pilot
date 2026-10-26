//! Retained popup. Non-searchable Kit selects mount no text/IME input.
use crate::{
    LocalOptions,
    task_edit::Target,
    task_model::{Loaded, Outcome, Preference, State},
    task_model_transport as wire,
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, AppContext, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Task, TestSupportExt,
    Window,
    component::{
        Disableable, StyledExt, WindowExt,
        select::{SearchableVec, Select, SelectEvent, SelectItem, SelectState},
    },
    div, px,
};
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
        div().min_w_0().truncate().child(self.label.clone())
    }
}
type Picker = SelectState<SearchableVec<Item>>;
pub(crate) struct Close;
pub(crate) struct Form {
    pub(crate) target: Target,
    options: LocalOptions,
    pub(crate) visible: bool,
    pub(crate) state: State,
    pub(crate) loaded: Option<Loaded>,
    pub(crate) value: Preference,
    model: Entity<Picker>,
    thinking: Entity<Picker>,
    focus: FocusHandle,
    error: Option<&'static str>,
    read: Option<Task<()>>,
    completion: Option<Task<()>>,
    _inputs: Vec<Subscription>,
}
impl EventEmitter<Close> for Form {}
impl Form {
    pub(crate) fn new(
        target: Target,
        options: LocalOptions,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let model = cx.new(|cx| SelectState::new(SearchableVec::<Item>::new(vec![]), None, w, cx));
        let thinking =
            cx.new(|cx| SelectState::new(SearchableVec::<Item>::new(vec![]), None, w, cx));
        let mut inputs = vec![];
        for (is_model, picker) in [(true, model.clone()), (false, thinking.clone())] {
            inputs.push(cx.subscribe_in(
                &picker,
                w,
                move |v, source, event: &SelectEvent<SearchableVec<Item>>, w, cx| {
                    if !v.visible || v.state.blocked() || v.loaded.is_none() {
                        return;
                    }
                    if let SelectEvent::Confirm(Some(id)) = event {
                        // Read the control's actual value, fence an obsolete queued event.
                        if source.read(cx).selected_value() != Some(id) {
                            return;
                        }
                        if is_model {
                            let next = (!id.is_empty()).then(|| id.clone());
                            if v.value.model != next {
                                v.value.model = next;
                                v.value.thinking = None;
                                v.refresh_thinking(w, cx);
                            }
                        } else {
                            v.value.thinking = (!id.is_empty()).then(|| id.clone());
                        }
                        v.error = None;
                        cx.notify();
                    }
                },
            ));
        }
        Self {
            target,
            options,
            visible: true,
            state: State::default(),
            loaded: None,
            value: Preference::default(),
            model,
            thinking,
            focus: cx.focus_handle(),
            error: None,
            read: None,
            completion: None,
            _inputs: inputs,
        }
    }
    pub(crate) fn matches(&self, t: &Target, o: &LocalOptions) -> bool {
        self.target == *t
            && self.options.host() == o.host()
            && self.options.loopback() == o.loopback()
    }
    pub(crate) fn owns_focus(&self, w: &Window, cx: &App) -> bool {
        self.focus.contains_focused(w, cx)
    }
    pub(crate) fn open(form: Entity<Self>, w: &mut Window, cx: &mut App) {
        w.open_dialog(cx, {
            let form = form.clone();
            move |d, _, _| {
                d.title("Preferred model")
                    .w(px(480.))
                    .overlay_closable(false)
                    .close_button(false)
                    .keyboard(false)
                    .on_cancel(|_, _, _| false)
                    .child(form.clone())
            }
        });
        form.update(cx, |f, cx| f.model.read(cx).focus_handle(cx).focus(w, cx));
    }
    pub(crate) fn load(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.loaded.is_some() || self.read.is_some() || self.state.blocked() {
            return;
        }
        let rx = match wire::read(self.options.clone(), self.target.clone()) {
            Ok(r) => r,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                return;
            }
        };
        self.error = None;
        self.read = Some(cx.spawn_in(w, async move |view, cx| {
            let result = rx
                .recv()
                .await
                .unwrap_or(Err("Preference reader stopped. No save sent."));
            let _ = view.update_in(cx, |v, w, cx| {
                v.read = None;
                match result {
                    Ok(m) => {
                        v.value = m.value.clone();
                        v.loaded = Some(m);
                        v.refresh_model(w, cx);
                        v.refresh_thinking(w, cx);
                    }
                    Err(e) => v.error = Some(e),
                }
                cx.notify();
            });
        }));
    }
    fn refresh_model(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(m) = &self.loaded else {
            return;
        };
        let mut items = vec![Item {
            id: String::new(),
            label: "Project default (no task preference)".into(),
        }];
        items.extend(m.catalog.models.iter().map(|m| Item {
            id: m.id.clone(),
            label: format!("{} ({})", m.name, m.id).into(),
        }));
        if let Some(id) = &self.value.model
            && !m.catalog.models.iter().any(|m| &m.id == id)
        {
            items.push(Item {
                id: id.clone(),
                label: format!("Unavailable: {id}").into(),
            });
        }
        let selected = self.value.model.clone().unwrap_or_default();
        self.model.update(cx, |p, cx| {
            p.set_items(SearchableVec::new(items), w, cx);
            p.set_selected_value(&selected, w, cx);
        });
    }
    fn refresh_thinking(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let model = self.loaded.as_ref().and_then(|m| {
            m.catalog
                .models
                .iter()
                .find(|m| Some(&m.id) == self.value.model.as_ref())
        });
        let default = model
            .and_then(|m| m.thinking.as_deref())
            .map(|s| format!("Default ({s})"))
            .unwrap_or_else(|| "Default".into());
        let mut items = vec![Item {
            id: String::new(),
            label: default.into(),
        }];
        if let Some(m) = model {
            items.extend(m.thinking_levels.iter().map(|l| Item {
                id: l.clone(),
                label: l.clone().into(),
            }));
        }
        if let Some(l) = &self.value.thinking
            && !items.iter().any(|i| &i.id == l)
        {
            items.push(Item {
                id: l.clone(),
                label: format!("Unsupported: {l}").into(),
            });
        }
        let selected = self.value.thinking.clone().unwrap_or_default();
        self.thinking.update(cx, |p, cx| {
            p.set_items(SearchableVec::new(items), w, cx);
            p.set_selected_value(&selected, w, cx);
        });
    }
    fn can_save(&self) -> bool {
        !self.state.blocked()
            && self
                .loaded
                .as_ref()
                .is_some_and(|m| self.value != m.value && self.value.admitted(&m.catalog))
    }
    fn submit(&mut self, cx: &mut Context<Self>) {
        if !self.visible || !self.can_save() {
            return;
        }
        let m = self.loaded.as_ref().unwrap();
        let s = match self.state.begin(&m.source, &self.value, &m.catalog) {
            Ok(s) => s,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                return;
            }
        };
        match wire::start(self.options.clone(), s.clone()) {
            Err(e) => {
                self.state.finish(&s, Outcome::NotSent(e));
            }
            Ok(rx) => {
                self.completion = Some(cx.spawn(async move |view, cx| {
                    let o = rx.recv().await.unwrap_or(Outcome::Unknown(
                        "Worker stopped without a receipt. Do not replay.",
                    ));
                    let _ = view.update(cx, |v, cx| {
                        v.state.finish(&s, o);
                        cx.notify();
                    });
                }));
            }
        }
        cx.notify();
    }
}
impl Render for Form {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let blocked = self.loaded.is_none() || self.state.blocked();
        let mut root=div().id("task-model-form").test_support().v_flex().w_full().min_w_0().gap_3().track_focus(&self.focus)
            .on_key_down(cx.listener(|v,e:&gpui_kit::KeyDownEvent,_,cx|{if e.keystroke.key=="escape" && v.visible {cx.stop_propagation();cx.emit(Close);}}))
            .child(ui::text(Text::Body,SharedString::from(self.loaded.as_ref().map(|m|format!("#{} {}",self.target.number,m.title)).unwrap_or_else(||format!("Task #{}",self.target.number)))))
            .child(ui::text(Text::Caption,"For future chats only. Assigned and running chats stay unchanged. Your choice is protected from coordinator overrides."))
            .child(ui::text(Text::Label,"Model"))
            .child(div().id("task-model-picker").test_support().h_7().w_full().min_w_0().child(Select::new(&self.model).accessibility_label("Preferred model for future task chats").menu_max_h(px(260.)).disabled(blocked)))
            .child(ui::text(Text::Label,"Thinking"))
            .child(div().id("task-model-thinking").test_support().h_7().w_full().min_w_0().child(Select::new(&self.thinking).accessibility_label("Preferred thinking for future task chats").menu_max_h(px(260.)).disabled(blocked || self.value.model.is_none())))
            .child(ui::text(Text::Caption,"Default follows the model’s configuration when a future chat starts. Removing the task preference uses the project default."));
        if self.loaded.is_none() {
            root = root.child(Notice::new(if self.read.is_some() {
                "Loading task preferences…"
            } else {
                "Preferences unavailable. Close and reopen to retry."
            }));
        }
        if let Some(m) = &self.loaded
            && !self.value.admitted(&m.catalog)
        {
            root=root.child(Notice::new("Retained preference is unavailable in this project's task scope. Choose a supported option or remove the preference.").tone(Tone::Error));
        }
        if let Some(e) = self.error {
            root = root.child(Notice::new(e).tone(Tone::Error));
        }
        if let Some((_, o)) = &self.state.attempt {
            let (text,tone)=match o {Outcome::Pending=>("Saving… Closing does not cancel this captured save.".to_string(),Tone::Normal),Outcome::NotSent(e)=>(format!("Not sent. {e}"),Tone::Error),Outcome::Unknown(e)=>(format!("Save unconfirmed. {e}"),Tone::Error),Outcome::Saved=>("Saved. Local acknowledged this exact preference. Refresh tasks to read current state.".into(),Tone::Normal)};
            root = root.child(
                div()
                    .id("task-model-result")
                    .test_support()
                    .child(Notice::new(SharedString::from(text)).tone(tone)),
            );
        }
        root=root.child(ui::text(Text::Caption,"No version check: another user edit can be overwritten. Draft and receipt are retained in this window, not across app restart."));
        let mut actions = div()
            .h_flex()
            .gap_2()
            .child(
                ui::action("task-model-save", "Save", Action::Primary)
                    .disabled(!self.can_save())
                    .on_click(cx.listener(|v, _, _, cx| v.submit(cx))),
            )
            .child(
                ui::action("task-model-close", "Close", Action::Quiet).on_click(cx.listener(
                    |v, _, _, cx| {
                        if v.visible {
                            cx.emit(Close);
                        }
                    },
                )),
            );
        if matches!(self.state.attempt.as_ref(), Some((_, Outcome::Saved))) {
            actions = actions.child(
                ui::action("task-model-again", "Edit again", Action::Secondary).on_click(
                    cx.listener(|v, _, w, cx| {
                        if v.visible
                            && matches!(v.state.attempt.as_ref(), Some((_, Outcome::Saved)))
                        {
                            v.state = State::default();
                            v.loaded = None;
                            v.load(w, cx);
                            cx.notify();
                        }
                    }),
                ),
            );
        }
        root.child(actions)
    }
}

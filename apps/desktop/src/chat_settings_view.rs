//! Settings → Chats. Retained by the Local window so a reply landing after the
//! Settings window closes is kept. Opening the page reads once; only a toggle writes.
use crate::{
    LocalOptions,
    chat_settings::{self, Job, Model, Note, Phase},
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    Context, FocusHandle, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    Styled, Task, TestSupportExt, Window,
    component::{ActiveTheme, Disableable, StyledExt, checkbox::Checkbox},
    div,
};

pub(crate) const LABEL: &str = "Automatic handoff (experimental)";
const DESCRIPTION: &str = "Long chats continue in a fresh model context, with full history kept. Applies across this host; mission coordinators are unchanged.";
const TIMING: &str = "At the lesser of 100k context tokens or 70% of the model window, handoff waits for a tool-safe model-request boundary. An admitted handoff may finish after you turn this off.";

pub(crate) struct ChatSettings {
    focus: FocusHandle,
    source: Option<LocalOptions>,
    model: Model,
    reply: Option<Task<()>>,
}
impl ChatSettings {
    pub(crate) fn new(source: Option<LocalOptions>, cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            source,
            model: Model::default(),
            reply: None,
        }
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_state(&self) -> (Phase, Option<bool>, Option<Note>) {
        (self.model.phase(), self.model.value(), self.model.note())
    }
    /// Refresh on every page opening; an existing read or write is never duplicated.
    pub(crate) fn open(&mut self, cx: &mut Context<Self>) {
        if self.model.clear_saved() {
            cx.notify();
        }
        self.check(cx);
    }
    pub(crate) fn update_hold(&self) -> Option<crate::update_hold::Hold> {
        matches!(self.model.phase(), Phase::Saving(_)).then_some(crate::update_hold::Hold::Sending)
    }
    /// Read-only. Never writes, never retries on its own.
    pub(crate) fn check(&mut self, cx: &mut Context<Self>) {
        if self.source.is_none() {
            return;
        }
        if let Some((request, job)) = self.model.begin_read() {
            self.dispatch(request, job, cx);
        }
    }
    pub(crate) fn set(&mut self, auto_handoff: bool, cx: &mut Context<Self>) {
        if self.source.is_none() {
            return;
        }
        if let Some((request, job)) = self.model.begin_save(auto_handoff) {
            self.dispatch(request, job, cx);
        }
    }
    fn dispatch(&mut self, request: u64, job: Job, cx: &mut Context<Self>) {
        let Some(options) = self.source.clone() else {
            return;
        };
        let lost = job.lost();
        match chat_settings::start(options, job) {
            Err(refused) => {
                self.model.finish(request, refused);
            }
            Ok(replies) => {
                self.reply = Some(cx.spawn(async move |owner, cx| {
                    let reply = replies.recv().await.unwrap_or(lost);
                    let _ = owner.update(cx, |owner, cx| {
                        if owner.model.finish(request, reply) {
                            cx.notify();
                        }
                    });
                }));
            }
        }
        cx.notify();
    }
}

/// Words for the current outcome, beside the control it describes.
fn note(note: Note) -> (&'static str, Tone) {
    match note {
        Note::Saved(true) => (
            "Saved. Applies from each chat's next model request.",
            Tone::Quiet,
        ),
        Note::Saved(false) => (
            "Saved. A handoff already underway may still finish.",
            Tone::Quiet,
        ),
        Note::Unsupported => (
            "This Pilot daemon doesn't support automatic handoff. Update Pilot to change it.",
            Tone::Normal,
        ),
        Note::LoadFailed => ("Couldn't load chat settings. Check again.", Tone::Error),
        Note::Conflict => (
            "Changed elsewhere, so your change wasn't saved. Review the current setting.",
            Tone::Warning,
        ),
        Note::Rejected => ("Pilot rejected the change. Nothing was saved.", Tone::Error),
        Note::NotSent => ("Couldn't reach Pilot. Nothing was changed.", Tone::Error),
        Note::Unknown(true) => (
            "Couldn't confirm turning automatic handoff on. It may have saved. Check again before changing this setting.",
            Tone::Warning,
        ),
        Note::Unknown(false) => (
            "Couldn't confirm turning automatic handoff off. It may have saved. Check again before changing this setting.",
            Tone::Warning,
        ),
    }
}

impl Render for ChatSettings {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let page = div()
            .id("chat-settings")
            .test_support()
            .track_focus(&self.focus)
            .v_flex()
            .gap_4()
            .min_w_0()
            .child(ui::header("settings-page-title", "Chats", Text::Title));
        if self.source.is_none() {
            return page.child(Notice::new(
                "Chat settings require the real Local viewer. This synthetic Settings window has no daemon authority.",
            ));
        }
        let phase = self.model.phase();
        let muted = cx.theme().muted_foreground;
        // The box appears only for an acknowledged value; otherwise the state is said in words.
        let control = match self.model.value() {
            Some(on) => Checkbox::new("chat-auto-handoff")
                .label(LABEL)
                .checked(on)
                .disabled(phase != Phase::Idle)
                .on_change(cx.listener(|owner, checked: &bool, window, cx| {
                    // Keep a stable keyboard route while this control is disabled or removed.
                    owner.focus.focus(window, cx);
                    owner.set(*checked, cx);
                }))
                .into_any_element(),
            None => div()
                .id("chat-auto-handoff-unknown")
                .test_support()
                .v_flex()
                .gap(gpui_kit::px(ui::Space::META))
                .child(ui::text(Text::Body, LABEL))
                .child(
                    ui::text(
                        Text::Caption,
                        match (phase, self.model.note()) {
                            (Phase::Loading, _) => "Checking…",
                            (_, Some(Note::Unsupported)) => "Unavailable",
                            _ => "Unknown",
                        },
                    )
                    .text_color(muted),
                )
                .into_any_element(),
        };
        let status = match phase {
            Phase::Saving(true) => Some("Turning on…"),
            Phase::Saving(false) => Some("Turning off…"),
            _ => None,
        };
        let check = phase == Phase::Idle && self.model.value().is_none();
        page.child(
            div()
                .v_flex()
                .gap_2()
                .min_w_0()
                .child(control)
                .child(ui::text(Text::Caption, DESCRIPTION).text_color(muted))
                .child(ui::text(Text::Caption, TIMING).text_color(muted)),
        )
        .children(status.map(|status| {
            ui::text(Text::Caption, status)
                .id("chat-settings-status")
                .test_support()
                .text_color(muted)
        }))
        .children(self.model.note().map(|n| {
            let (title, tone) = note(n);
            div()
                .id("chat-settings-note")
                .test_support()
                .child(Notice::new(SharedString::from(title)).tone(tone))
        }))
        .children(check.then(|| {
            div().child(
                ui::action("chat-settings-check", "Check again", Action::Quiet).on_click(
                    cx.listener(|owner, _, window, cx| {
                        owner.focus.focus(window, cx);
                        owner.check(cx);
                    }),
                ),
            )
        }))
    }
}

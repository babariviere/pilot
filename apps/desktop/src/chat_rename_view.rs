//! Retained per-chat form. Closing the dialog never cancels or replays a dispatched write.
use crate::{
    LocalOptions,
    chat_actions::{Evidence, Outcome},
    chat_rename,
    ui::{self, Action, Notice, Tone},
};
use gpui_kit::{
    App, AppContext, Context, Entity, EntityInputHandler, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window,
    component::{
        Disableable, StyledExt, WindowExt,
        input::{Input, InputState},
    },
    div, px,
};

pub(crate) struct Rename {
    pub(crate) evidence: Evidence,
    options: LocalOptions,
    pub(crate) input: Entity<InputState>,
    pub(crate) outcome: Option<Outcome>,
    pub(crate) pending: bool,
    request: u64,
    _events: Subscription,
}
impl Rename {
    pub(crate) fn new(
        options: LocalOptions,
        evidence: Evidence,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            let mut i = InputState::new(w, cx).validate(|s, _| chat_rename::bounded(s));
            i.set_value(evidence.target.chat.title.clone(), w, cx);
            i
        });
        let events = cx.observe(&input, |_, _, cx| cx.notify());
        Self {
            evidence,
            options,
            input,
            outcome: None,
            pending: false,
            request: 0,
            _events: events,
        }
    }
    pub(crate) fn status(&self) -> Option<(SharedString, Tone)> {
        let (label, tone) = if self.pending {
            ("Rename pending", Tone::Quiet)
        } else {
            match self.outcome {
                Some(Outcome::Unknown) => (
                    "Rename unconfirmed. Do not repeat it; later reads are not a receipt.",
                    Tone::Warning,
                ),
                Some(Outcome::Acknowledged) => ("Rename confirmed by Local", Tone::Success),
                Some(Outcome::Rejected(e)) => (e, Tone::Error),
                None => return None,
            }
        };
        Some((
            format!("{}: {label}", self.evidence.target.chat.title).into(),
            tone,
        ))
    }
    pub(crate) fn blocked(&self) -> bool {
        self.pending || self.outcome == Some(Outcome::Unknown)
    }
    /// An unanswered rename, or a changed title in the open dialog. A closed form's text
    /// is replaced on the next open, so it holds nothing.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn update_hold(&self, open: bool, cx: &App) -> Option<crate::update_hold::Hold> {
        let unsent = open
            && matches!(self.outcome, None | Some(Outcome::Rejected(_)))
            && self.title(cx).is_some();
        crate::update_hold::Hold::of(self.pending, unsent)
    }
    fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.input
            .update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
    }
    fn title(&self, cx: &App) -> Option<String> {
        chat_rename::normalized(&self.input.read(cx).value())
            .filter(|s| s != &self.evidence.target.chat.title)
    }
    fn submit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.blocked() || self.outcome == Some(Outcome::Acknowledged) || self.marked(w, cx) {
            return;
        }
        let Some(title) = self.title(cx) else {
            return;
        };
        let options = self.options.clone();
        let evidence = self.evidence.clone();
        let (tx, rx) = async_channel::bounded(1);
        let spawned = std::thread::Builder::new()
            .name("local-chat-rename".into())
            .spawn(move || {
                let outcome = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map(|rt| rt.block_on(chat_rename::rename(&options, &evidence, &title)))
                    .unwrap_or(Outcome::Rejected(
                        "Rename transport is unavailable. Nothing was submitted.",
                    ));
                let _ = tx.try_send(outcome);
            });
        if spawned.is_err() {
            self.outcome = Some(Outcome::Rejected(
                "Rename worker is unavailable. Nothing was submitted.",
            ));
            cx.notify();
            return;
        }
        self.pending = true;
        self.outcome = None;
        self.request += 1;
        let request = self.request;
        cx.notify();
        cx.spawn_in(w, async move |v, cx| {
            let outcome = rx.recv().await.unwrap_or(Outcome::Unknown);
            let _ = v.update(cx, |v, cx| {
                if v.request == request && v.pending {
                    v.pending = false;
                    v.outcome = Some(outcome);
                    cx.notify();
                }
            });
        })
        .detach();
    }
    pub(crate) fn open(form: Entity<Self>, w: &mut Window, cx: &mut App) {
        let cancel = form.clone();
        let input = form.read(cx).input.clone();
        w.open_dialog(cx, move |dialog, _, cx| {
            crate::ui::dialog(dialog, cx)
                .title("Rename chat")
                .w(px(380.))
                .overlay_closable(false)
                .close_button(false)
                .keyboard(false)
                .on_cancel({
                    let cancel = cancel.clone();
                    move |_, w, cx| cancel.update(cx, |v, cx| !v.marked(w, cx))
                })
                .child(form.clone())
        });
        input.focus_handle(cx).focus(w, cx);
    }
}
impl Render for Rename {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let disabled = self.blocked() || self.outcome == Some(Outcome::Acknowledged);
        let (status, tone) = if self.pending {
            (
                "Waiting for Local. This request will not be retried automatically.",
                Tone::Quiet,
            )
        } else {
            match self.outcome {
                None => (
                    "Up to 200 UTF-16 units. Whitespace is normalized by Local.",
                    Tone::Quiet,
                ),
                Some(Outcome::Acknowledged) => ("Rename confirmed by Local.", Tone::Success),
                Some(Outcome::Rejected(e)) => (e, Tone::Error),
                Some(Outcome::Unknown) => (
                    "Rename unconfirmed. Do not repeat it. Later titles or reads are not a receipt. Check this exact chat in Swift.",
                    Tone::Warning,
                ),
            }
        };
        div()
            .v_flex()
            .gap_3()
            .min_w_0()
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Enter, w, cx| {
                if v.input.focus_handle(cx).is_focused(w) {
                    v.submit(w, cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                if !v.marked(w, cx) {
                    w.close_dialog(cx);
                }
                cx.stop_propagation();
            }))
            .child(ui::text(
                ui::Text::Caption,
                SharedString::from(format!(
                    "{} ({})",
                    self.evidence.target.chat.title, self.evidence.target.chat.id
                )),
            ))
            .child(
                Input::new(&self.input)
                    .id("rename-title")
                    .aria_label("Chat title")
                    .disabled(disabled),
            )
            .child(Notice::new(status).tone(tone))
            .child(
                div()
                    .h_flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        ui::action(
                            "rename-cancel",
                            if disabled { "Close" } else { "Cancel" },
                            Action::Secondary,
                        )
                        .on_click(cx.listener(|v, _, w, cx| {
                            if !v.marked(w, cx) {
                                w.close_dialog(cx);
                            }
                        })),
                    )
                    .child(
                        ui::action("rename-submit", "Rename", Action::Primary)
                            .disabled(disabled || self.title(cx).is_none())
                            .on_click(cx.listener(|v, _, w, cx| v.submit(w, cx))),
                    ),
            )
    }
}

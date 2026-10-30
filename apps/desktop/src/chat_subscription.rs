//! Subscription-limit recovery above the composer, only while pilotd reports a
//! pause: Force work / Pause at limit, and Continue with another model… with an
//! explanation of what the chosen model actually does before it is confirmed.
use super::*;
use crate::subscription_pause::{self, PICKER_HELP, Pause};

/// The open "Continue with another model…" choice for one held chat.
pub(super) struct Continuation {
    session: String,
    model: Option<String>,
    select: Entity<SelectState<SearchableVec<Item>>>,
    _subscription: Subscription,
}
impl Continuation {
    pub(super) fn is_for(&self, session: &str) -> bool {
        self.session == session
    }
    pub(super) fn select(&self) -> &Entity<SelectState<SearchableVec<Item>>> {
        &self.select
    }
}

impl ChatEditor {
    /// Open continuation (and its chosen model), forced state and model-action busy.
    #[cfg(feature = "native-probes")]
    pub(crate) fn subscription_probe(&self) -> (Option<Option<String>>, Option<bool>, bool) {
        (
            self.continuation().map(|c| c.model.clone()),
            self.subscription_pause().map(|p| p.forced),
            self.models.as_ref().is_some_and(|m| m.busy),
        )
    }
    fn subscription_current(&self) -> Option<(&str, &SessionModel)> {
        let (id, _, current) = self.models.as_ref()?.current.as_ref()?;
        (self.selected.as_deref() == Some(format!("chat:{id}").as_str()))
            .then_some((id.as_str(), current))
    }
    fn subscription_pause(&self) -> Option<&Pause> {
        self.subscription_current()?.1.pause.as_ref()
    }
    fn can_force(&self) -> bool {
        self.ready()
            && self.writable
            && self.subscription_pause().is_some()
            && self.models.as_ref().is_some_and(|m| !m.busy)
    }
    /// Like pilotd: only an unforced pause on a healthy interactive chat, with no
    /// pending delivery, unconfirmed model switch or other model action.
    pub(super) fn can_continue(&self) -> bool {
        self.ready()
            && self.writable
            && !self.waiting()
            && self.error.is_none()
            && self.draft().is_some_and(Draft::editable)
            && self.model_uncertain().is_none()
            && self.models.as_ref().is_some_and(|m| {
                !m.busy
                    && m.picker
                        .as_ref()
                        .is_some_and(|p| p.catalog.is_some() && !p.loading && p.error.is_none())
            })
            && self
                .subscription_current()
                .is_some_and(|(_, current)| current.continuable)
    }
    fn continuation(&self) -> Option<&Continuation> {
        let (id, _) = self.subscription_current()?;
        self.models
            .as_ref()?
            .continuation
            .as_ref()
            .filter(|c| c.is_for(id))
    }
    pub(super) fn begin_continuation(
        &mut self,
        model: Option<String>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_continue() {
            return;
        }
        let Some((id, current)) = self
            .subscription_current()
            .map(|(id, s)| (id.to_string(), s.model.clone()))
        else {
            return;
        };
        let model = model.filter(|m| Some(m) != current.as_ref());
        if let Some(open) = self
            .models
            .as_mut()
            .and_then(|m| m.continuation.as_mut())
            .filter(|c| c.is_for(&id))
        {
            if let Some(model) = model {
                open.select
                    .update(cx, |s, cx| s.set_selected_value(&model, w, cx));
                open.model = Some(model);
            }
            cx.notify();
            return;
        }
        let Some(catalog) = self
            .models
            .as_ref()
            .and_then(|m| m.picker.as_ref())
            .and_then(|p| p.catalog.clone())
        else {
            return;
        };
        let items: Vec<Item> = catalog
            .models
            .iter()
            .filter(|m| Some(&m.id) != current.as_ref())
            .map(|m| Item {
                id: m.id.clone(),
                title: m.name.clone().into(),
                detail: m.id.clone().into(),
                disabled: false,
                search: format!("{} {}", m.name, m.id).to_lowercase().into(),
            })
            .collect();
        let select =
            cx.new(|cx| SelectState::new(SearchableVec::new(items), None, w, cx).searchable(true));
        if let Some(model) = &model {
            select.update(cx, |s, cx| s.set_selected_value(model, w, cx));
        }
        let session = id.clone();
        let subscription = cx.subscribe_in(
            &select,
            w,
            move |v, _, event: &SelectEvent<SearchableVec<Item>>, _, cx| {
                if let SelectEvent::Confirm(Some(model)) = event
                    && let Some(m) = &mut v.models
                    && let Some(open) = m.continuation.as_mut().filter(|c| c.is_for(&session))
                {
                    open.model = Some(model.clone());
                    m.error = None;
                    cx.notify();
                }
            },
        );
        if let Some(m) = &mut self.models {
            m.error = None;
            m.continuation = Some(Continuation {
                session: id,
                model,
                select,
                _subscription: subscription,
            });
        }
        cx.notify();
    }
    fn cancel_continuation(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(m) = &mut self.models {
            m.continuation = None;
        }
        self.focus(w, cx);
        cx.notify();
    }
    fn confirm_continuation(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) || !self.can_continue() {
            return;
        }
        let Some(target) = self.model_target() else {
            return;
        };
        let Some(model) = self.continuation().and_then(|c| c.model.clone()) else {
            return;
        };
        if target.model.as_ref() == Some(&model) {
            return;
        }
        // Capture the draft first; continuing never sends or discards it.
        self.changed(cx);
        let attempt = chat_models::Attempt {
            id: uuid::Uuid::new_v4().to_string(),
            target: target.clone(),
            choice: ModelChoice {
                model,
                thinking: None,
            },
        };
        self.model_command(target.session, chat_models::Action::Continue(attempt), cx);
    }
    fn force_subscription(&mut self, force: bool, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) || !self.can_force() {
            return;
        }
        let Some(target) = self.model_target() else {
            return;
        };
        self.model_command(
            target.session.clone(),
            chat_models::Action::Force { target, force },
            cx,
        );
    }
    /// One row: the pause and its quiet actions, then the continuation choice when open.
    pub(crate) fn subscription_row(&self, cx: &Context<Self>) -> Option<gpui_kit::AnyElement> {
        let pause = self.subscription_pause()?;
        let now = subscription_pause::now();
        let notice: SharedString = pause.notice(now).into();
        let help: SharedString = if pause.forced {
            pause.help(now)
        } else {
            format!("Usage limit reached\n{}", pause.help(now))
        }
        .into();
        let forced = pause.forced;
        let busy = self.models.as_ref().is_some_and(|m| m.busy);
        let open = self.continuation();
        let status = div()
            .id("subscription-limit-status")
            .h_flex()
            .items_center()
            .gap_1()
            .min_w_0()
            .child(
                div()
                    .flex_none()
                    .text_color(if forced {
                        cx.theme().warning
                    } else {
                        cx.theme().muted_foreground
                    })
                    .child(if forced {
                        crate::app_icon::AppIcon::Error.inline()
                    } else {
                        crate::app_icon::AppIcon::Paused.inline()
                    }),
            )
            .child(ui::text(ui::Text::Caption, notice.clone()).min_w_0())
            .aria_label(notice)
            .tooltip(move |w, cx| {
                gpui_kit::component::tooltip::Tooltip::new(help.clone()).build(w, cx)
            });
        #[cfg(any(test, feature = "native-probes"))]
        let status = status.test_support();
        let force = ui::action(
            "subscription-force",
            if forced {
                "Pause at limit"
            } else {
                "Force work"
            },
            Action::Quiet,
        )
        .tooltip(if forced {
            "Hold new work again until usage resets below the limit"
        } else {
            "Keep working past the usage limit. Pilot stops holding work for this chat."
        })
        .loading(busy && open.is_none())
        .disabled(!self.can_force())
        .on_click(cx.listener(move |v, _, w, cx| v.force_subscription(!forced, w, cx)));
        let resume = (!forced).then(|| {
            ui::action(
                "subscription-continue",
                "Continue with another model…",
                Action::Quiet,
            )
            .tooltip(PICKER_HELP)
            .disabled(!self.can_continue() || open.is_some())
            .on_click(cx.listener(|v, _, w, cx| {
                if !v.marked(w, cx) {
                    v.begin_continuation(None, w, cx);
                }
            }))
        });
        let row = div()
            .id("subscription-limit")
            .v_flex()
            .gap_2()
            .min_w_0()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if v.marked(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap_x_3()
                    .gap_y_1()
                    .min_w_0()
                    .child(status)
                    .child(div().h_flex().gap_1().children(resume).child(force)),
            )
            .children(open.map(|open| self.continuation_panel(pause, open, busy, cx)));
        #[cfg(any(test, feature = "native-probes"))]
        let row = row.test_support();
        Some(row.into_any_element())
    }
    fn continuation_panel(
        &self,
        pause: &Pause,
        open: &Continuation,
        busy: bool,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let catalog = self
            .models
            .as_ref()
            .and_then(|m| m.picker.as_ref())
            .and_then(|p| p.catalog.clone());
        let current = self.model_target().and_then(|t| t.model);
        let chosen = open.model.as_ref().and_then(|model| {
            let catalog = catalog.as_ref()?;
            let name = catalog
                .models
                .iter()
                .find(|m| &m.id == model)
                .map(|m| m.name.clone())
                .unwrap_or_else(|| model.clone());
            Some((pause.continuation(current.as_deref(), model, catalog), name))
        });
        let explanation: SharedString = chosen
            .as_ref()
            .map(|(kind, name)| kind.explanation(name))
            .unwrap_or_else(|| PICKER_HELP.into())
            .into();
        let explanation = ui::text(ui::Text::Caption, explanation)
            .id("subscription-continue-explanation")
            .min_w_0()
            .text_color(cx.theme().muted_foreground);
        #[cfg(any(test, feature = "native-probes"))]
        let explanation = explanation.test_support();
        let panel = div()
            .id("subscription-continuation")
            .v_flex()
            .gap_1()
            .min_w_0()
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .min_w_0()
                    .child(
                        div().w(px(240.)).max_w_full().min_w_0().child(
                            Select::new(&open.select)
                                .id("subscription-continue-model")
                                .small()
                                .w_full()
                                .menu_width(px(320.))
                                .menu_max_h(px(260.))
                                .disabled(busy)
                                .placeholder("Choose a model")
                                .search_placeholder("Find a scoped model…")
                                .accessibility_label("Model to continue with"),
                        ),
                    )
                    .child(
                        ui::action("subscription-continue-cancel", "Cancel", Action::Quiet)
                            .disabled(busy)
                            .on_click(cx.listener(|v, _, w, cx| v.cancel_continuation(w, cx))),
                    )
                    .child(
                        ui::action(
                            "subscription-continue-confirm",
                            chosen
                                .as_ref()
                                .map(|(kind, _)| kind.confirm())
                                .unwrap_or("Continue"),
                            Action::Primary,
                        )
                        .loading(busy)
                        .disabled(chosen.is_none() || busy || !self.can_continue())
                        .on_click(cx.listener(|v, _, w, cx| v.confirm_continuation(w, cx))),
                    ),
            )
            .child(explanation);
        #[cfg(any(test, feature = "native-probes"))]
        let panel = panel.test_support();
        panel
    }
}

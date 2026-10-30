//! Shared Home/Usage owner, one explicit refresh at a time and no timer.
use crate::{
    LocalOptions,
    provider_refresh::State,
    provider_usage::Snapshot,
    ui::{self, Action, Space, Text},
};
use gpui_kit::{
    Context, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Task, TestSupportExt, Window,
    component::{ActiveTheme, Disableable, StyledExt},
    div, px,
};

pub(crate) struct Limits {
    pub(crate) state: State,
    options: LocalOptions,
    open: Vec<&'static str>,
    pending: Option<Task<()>>,
}
impl Limits {
    pub(crate) fn new(options: LocalOptions) -> Self {
        Self {
            state: State::default(),
            options,
            open: Vec::new(),
            pending: None,
        }
    }
    pub(crate) fn sync(&mut self, reports: Vec<Snapshot>, cx: &mut Context<Self>) {
        let before = self.state.snapshots.clone();
        self.state.merge(reports);
        if before != self.state.snapshots {
            cx.notify();
        }
    }
    pub(crate) fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.state.begin() {
            return;
        }
        match crate::provider_refresh_reader::start(self.options.clone()) {
            Ok(rx) => {
                self.pending = Some(cx.spawn(async move |view, cx| {
                    let result = rx.recv().await.unwrap_or(Err(
                        "Limits refresh interrupted. Previous reports retained.",
                    ));
                    let _ = view.update(cx, |v, cx| {
                        v.state.finish(result);
                        v.pending = None;
                        cx.notify();
                    });
                }))
            }
            Err(e) => self.state.finish(Err(e)),
        }
        cx.notify();
    }
}
impl Render for Limits {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let toggle = |provider: &'static str| -> crate::provider_usage_view::Toggle {
            Box::new(cx.listener(move |v: &mut Self, _, _, cx| {
                if let Some(ix) = v.open.iter().position(|p| *p == provider) {
                    v.open.remove(ix);
                } else {
                    v.open.push(provider);
                }
                cx.notify();
            }))
        };
        let controls = div()
            .h_flex()
            .flex_wrap()
            .items_center()
            .gap(px(Space::CONTROL))
            .child(ui::text(Text::Headline, "Subscription limits"))
            .child(
                ui::action("subscription-refresh", "Refresh limits", Action::Quiet)
                    .disabled(self.state.busy)
                    .accessibility_label("Refresh subscription limits from providers")
                    .on_click(cx.listener(|v, _, _, cx| v.refresh(cx))),
            );
        div()
            .id("subscription-limits")
            .test_support()
            .v_flex()
            .gap(px(Space::META))
            .child(controls)
            .children(self.state.status.as_ref().map(|s| {
                ui::text(Text::Caption, SharedString::from(s.clone()))
                    .id("subscription-refresh-status")
                    .test_support()
                    .aria_label(s.clone())
                    .text_color(cx.theme().muted_foreground)
            }))
            .children(crate::provider_usage_view::section(
                &self.state.snapshots,
                &self.open,
                crate::usage_overview::now(),
                toggle,
                cx,
            ))
            .children(self.state.snapshots.is_empty().then(|| {
                ui::text(Text::Caption, "No subscription report yet.")
                    .text_color(cx.theme().muted_foreground)
            }))
    }
}

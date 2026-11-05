//! Composer disclosure. Reads only the existing bounded Local summary feed.
use super::*;
use crate::ui::{self, Action, Text};
use gpui_kit::component::{
    Sizable, WindowExt,
    button::{Button, ButtonVariants},
};

struct Info {
    viewer: gpui_kit::WeakEntity<LocalViewer>,
    chat: String,
    generation: u64,
    /// Token accounting disclosure, folded by default.
    details: bool,
    _subscription: Subscription,
}
impl Info {
    fn summary(
        &self,
        usage: &crate::context_usage::Usage,
        stale: bool,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let muted = cx.theme().muted_foreground;
        let mut track = muted;
        track.a *= 0.2;
        let figures = gpui_kit::FontFeatures(Arc::new(vec![("tnum".into(), 1)]));
        let mut summary = div().v_flex().gap_2().min_w_0().child(
            div()
                .h_flex()
                .items_end()
                .justify_between()
                .gap_3()
                .min_w_0()
                .child(
                    ui::text(
                        Text::Title,
                        SharedString::from(usage.percent().unwrap_or_else(|| "Unknown".into())),
                    )
                    .id("context-usage-percent")
                    .test_support()
                    .flex_none()
                    .font_features(figures.clone()),
                )
                .child(
                    ui::text(Text::Body, SharedString::from(usage.amount()))
                        .id("context-usage-amount")
                        .test_support()
                        .min_w_0()
                        .truncate()
                        .text_color(muted)
                        .font_features(figures),
                ),
        );
        if let Some((used, limit)) = usage.context_pair() {
            // Overage fills the bar; the percentage keeps the raw share.
            let filled = (u128::from(used) * 1000 / u128::from(limit)).min(1000) as usize;
            summary = summary.child(
                div()
                    .id("context-usage-meter")
                    .test_support()
                    .child(ui::progress_bar(&[(filled, muted)], 1000, track)),
            );
        }
        let status = if stale {
            Some("Reconnecting · may be out of date")
        } else if usage.has_context() {
            Some("Last report, not a live count")
        } else {
            None
        };
        summary.children(status.map(|status| {
            ui::text(Text::Caption, status)
                .id("context-usage-status")
                .test_support()
                .text_color(muted)
        }))
    }

    fn accounting(
        &self,
        usage: &crate::context_usage::Usage,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let muted = cx.theme().muted_foreground;
        let figures = gpui_kit::FontFeatures(Arc::new(vec![("tnum".into(), 1)]));
        // Labels truncate; numbers keep their full width and share one right edge.
        let row = |id: (&'static str, usize), label: SharedString, values: Vec<SharedString>| {
            div()
                .id(id)
                .test_support()
                .h_flex()
                .gap_3()
                .min_w_0()
                .child(
                    ui::text(Text::Label, label)
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(muted),
                )
                .children(values.into_iter().enumerate().map(|(col, value)| {
                    ui::text(Text::Label, value)
                        .id(("context-usage-cell", id.1 * 2 + col))
                        .test_support()
                        .flex_none()
                        .min_w(px(72.))
                        .text_right()
                        .whitespace_nowrap()
                        .font_features(figures.clone())
                }))
        };
        let mut table = div()
            .id("context-usage-accounting")
            .test_support()
            .v_flex()
            .gap_1()
            .min_w_0()
            .child(row(
                ("context-usage-row", 0),
                "In context".into(),
                vec![SharedString::from(usage.exact())],
            ))
            .child(div().py_1().child(ui::rule(window, cx)));
        match usage.accounting() {
            Some((rows, child)) => {
                let mut header = vec![SharedString::from("Direct")];
                if child {
                    header.push("Child".into());
                }
                table = table.child(row(("context-usage-row", 1), "Cumulative".into(), header));
                for (ix, r) in rows.into_iter().enumerate() {
                    let mut values = vec![SharedString::from(r.direct)];
                    if child {
                        values.push(r.child.into());
                    }
                    table = table.child(row(("context-usage-row", ix + 2), r.label.into(), values));
                }
                table.child(
                    ui::text(
                        Text::Caption,
                        "Totals span reported turns and restarts and may be partial. Output includes reasoning.",
                    )
                    .id("context-usage-note")
                    .test_support()
                    .pt_1()
                    .text_color(muted),
                )
                .into_any_element()
            }
            None => table
                .child(row(
                    ("context-usage-row", 1),
                    "Cumulative".into(),
                    vec!["Not reported".into()],
                ))
                .into_any_element(),
        }
    }
}
impl Render for Info {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewer = self.viewer.upgrade();
        let active = viewer.as_ref().map(|v| v.read(cx)).filter(|v| {
            v.page == Page::Chat
                && v.selected.as_deref() == Some(self.chat.as_str())
                && v.generation == self.generation
        });
        let mut content = div()
            .id("context-usage-info")
            .test_support()
            .v_flex()
            .gap_4()
            .min_w_0();
        let found = active.map(|view| {
            let usage = view
                .state
                .chats
                .iter()
                .find(|c| c.id == self.chat && !c.local_draft)
                .map(|c| c.context_usage.clone())
                .unwrap_or_default();
            (
                usage,
                view.state.status != "Connected · Local" || !view.state.list_loaded,
            )
        });
        if let Some((usage, stale)) = found {
            let details = self.details;
            let table = details.then(|| self.accounting(&usage, window, cx));
            content = content.child(self.summary(&usage, stale, cx)).child(
                div()
                    .v_flex()
                    .gap_2()
                    .min_w_0()
                    .child(
                        // Outdent by the Kit button inset, so "Details" shares the text edge.
                        div().h_flex().ml(px(-8.)).child(
                            ui::action("context-usage-details", "", Action::Quiet)
                                .accessibility_label(if details {
                                    "Hide token details"
                                } else {
                                    "Show token details"
                                })
                                .child(
                                    div()
                                        .h_flex()
                                        .items_center()
                                        .gap_1()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(ui::text(Text::Label, "Details"))
                                        .child(ui::disclosure_chevron(
                                            "context-usage-details",
                                            details,
                                        )),
                                )
                                .on_click(cx.listener(|info, _, _, cx| {
                                    info.details = !info.details;
                                    cx.notify();
                                })),
                        ),
                    )
                    .children(table),
            );
        } else {
            content = content.child(
                ui::text(
                    Text::Body,
                    "Chat changed. Reopen Context for the active chat.",
                )
                .id("context-usage-changed")
                .test_support(),
            );
        }
        content
    }
}
pub(super) struct Entry {
    viewer: gpui_kit::WeakEntity<LocalViewer>,
    _subscription: Subscription,
}
pub(super) fn entry(cx: &mut Context<LocalViewer>) -> Entity<Entry> {
    let viewer = cx.entity();
    cx.new(|cx| Entry {
        viewer: viewer.downgrade(),
        _subscription: cx.observe(&viewer, |_, _, cx| cx.notify()),
    })
}
impl Entry {
    fn allowed(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.viewer
            .update(cx, |v, cx| v.project_choices_ready(window, cx))
            .unwrap_or(false)
    }
}
impl Render for Entry {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewer = self.viewer.upgrade();
        let view = viewer.as_ref().map(|v| v.read(cx));
        let chat = view.and_then(|v| {
            v.selected
                .as_ref()
                .and_then(|id| v.state.chats.iter().find(|c| &c.id == id && !c.local_draft))
        });
        // Unknown usage is an empty gauge, never a different icon.
        let meter = chat
            .and_then(|c| crate::context_meter::Meter::reported(&c.context_usage))
            .unwrap_or_else(|| crate::context_meter::Meter {
                ratio: 0.,
                description: "Context usage unknown until reported".into(),
            });
        let description = meter.description.clone();
        let mut button = Button::new("context-usage")
            .ghost()
            .small()
            .w(px(28.))
            .p_0()
            .accessibility_label(SharedString::from(description.clone()))
            .tooltip(SharedString::from(description))
            .disabled(chat.is_none());
        button = button.child(meter.ring(cx));
        // Guard before a sibling pointer event can commit/clear editor preedit.
        div()
            .flex_none()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if !v.allowed(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(button.on_click(cx.listener(|entry, _, w, cx| {
                let _ = entry.viewer.update(cx, |v, cx| v.open_context_usage(w, cx));
            })))
    }
}
impl LocalViewer {
    fn open_context_usage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.project_choices_ready(window, cx) {
            return;
        }
        let Some(chat) = self.selected.clone().filter(|id| {
            self.state
                .chats
                .iter()
                .any(|c| &c.id == id && !c.local_draft)
        }) else {
            return;
        };
        let viewer = cx.entity();
        let info = cx.new(|cx| Info {
            viewer: viewer.downgrade(),
            chat,
            generation: self.generation,
            details: false,
            _subscription: cx.observe(&viewer, |_, _, cx| cx.notify()),
        });
        window.open_dialog(cx, move |dialog, _, cx| {
            crate::ui::dialog(dialog, cx)
                .title("Context usage")
                .w(px(380.))
                .child(info.clone())
                .footer(
                    ui::action("context-usage-done", "Done", Action::Secondary)
                        .on_click(|_, w, cx| w.close_dialog(cx)),
                )
        });
    }
}

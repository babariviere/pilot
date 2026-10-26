//! On-demand header information. Reads only the existing bounded Local summary feed.
use super::*;
use crate::ui::{self, Action, Text};
use gpui_kit::component::WindowExt;

struct Info {
    viewer: gpui_kit::WeakEntity<LocalViewer>,
    chat: String,
    _subscription: Subscription,
}
impl Render for Info {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewer = self.viewer.upgrade();
        let active = viewer
            .as_ref()
            .map(|v| v.read(cx))
            .filter(|v| v.page == Page::Chat && v.selected.as_deref() == Some(self.chat.as_str()));
        let mut content = div()
            .id("context-usage-info")
            .test_support()
            .v_flex()
            .gap_3()
            .min_w_0();
        if let Some(view) = active {
            let usage = view
                .state
                .chats
                .iter()
                .find(|c| c.id == self.chat && !c.local_draft)
                .map(|c| c.context_usage.clone())
                .unwrap_or_default();
            content = content.child(ui::text(Text::Body, SharedString::from(view.title.clone())));
            if view.state.status != "Connected · Local" || !view.state.list_loaded {
                content = content.child(ui::text(
                    Text::Caption,
                    "Local usage unavailable or reconnecting. Retained figures are not current.",
                ));
            }
            for (ix, line) in usage.lines().into_iter().enumerate() {
                content = content.child(
                    ui::text(
                        if ix == 0 { Text::Body } else { Text::Caption },
                        SharedString::from(line),
                    )
                    .id(("context-usage-line", ix))
                    .test_support()
                    .text_color(if ix == 0 {
                        cx.theme().foreground
                    } else {
                        cx.theme().muted_foreground
                    }),
                );
            }
        } else {
            content = content.child(
                ui::text(
                    Text::Body,
                    "Chat changed. Close this panel and open Context for the active chat.",
                )
                .id("context-usage-changed")
                .test_support(),
            );
        }
        content
    }
}
impl LocalViewer {
    pub(super) fn context_usage_action(&self, cx: &mut Context<Self>) -> impl IntoElement {
        // Guard before a sibling pointer event can commit/clear editor preedit.
        div()
            .flex_none()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if !v.project_choices_ready(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(
                ui::action("context-usage", "Context…", Action::Quiet)
                    .icon(AppIcon::Info.asset())
                    .disabled(self.selected.as_ref().is_none_or(|id| {
                        !self
                            .state
                            .chats
                            .iter()
                            .any(|c| &c.id == id && !c.local_draft)
                    }))
                    .on_click(cx.listener(|v, _, w, cx| v.open_context_usage(w, cx))),
            )
    }
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
            _subscription: cx.observe(&viewer, |_, _, cx| cx.notify()),
        });
        window.open_dialog(cx, move |dialog, _, _| {
            dialog
                .title("Context usage")
                .w(px(440.))
                .child(info.clone())
                .footer(
                    ui::action("context-usage-done", "Done", Action::Secondary)
                        .on_click(|_, w, cx| w.close_dialog(cx)),
                )
        });
    }
}

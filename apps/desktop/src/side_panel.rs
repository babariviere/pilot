//! Chat side-panel shell: the conversation plus at most one panel (mission
//! context, links or changes) in a slot that eases open and closed.
//!
//! The panel keeps its full extent inside the clipped slot, so its content
//! slides with the slot's edge instead of reflowing each frame. Closing removes
//! the panel at once (focus returns, its work stops as before); only an empty
//! edge collapses. Reduced motion shows the end state immediately.
use super::*;
use gpui_kit::AnyElement;

pub(super) struct SidePanel {
    pub key: &'static str,
    /// Beside the conversation, else docked below it.
    pub side: bool,
    pub extent: f32,
    pub region: AnyElement,
}

impl LocalViewer {
    pub(super) fn side_panel_shell(
        &mut self,
        conversation: AnyElement,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let panel = self
            .mission_panel(w, cx)
            .or_else(|| self.conversation_links_panel(w, cx))
            .or_else(|| self.workspace_changes_panel(w, cx));
        if let Some(p) = &panel {
            self.side_panel_beside = p.side;
        }
        let side = self.side_panel_beside;
        let shown = self
            .side_panel
            .extent(panel.as_ref().map(|p| (p.key, p.extent)), w, cx);
        let slot = (panel.is_some() || shown > 0.).then(|| {
            div()
                .id("side-panel-slot")
                .test_support()
                .flex()
                .flex_none()
                .overflow_hidden()
                .when(side, |d| d.flex_row().w(px(shown)).h_full())
                .when(!side, |d| d.flex_col().h(px(shown)).w_full())
                .child(match panel {
                    Some(p) => p.region,
                    None => div()
                        .id("side-panel-closing")
                        .test_support()
                        .size_full()
                        .when(side, |d| d.border_l(appearance::hairline(w)))
                        .when(!side, |d| d.border_t(appearance::hairline(w)))
                        .border_color(cx.theme().border)
                        .into_any_element(),
                })
        });
        div()
            .id("chat-mission-companion")
            .test_support()
            .flex()
            .items_stretch()
            .size_full()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .when(side, |d| d.flex_row())
            .when(!side, |d| d.flex_col())
            .child(
                div()
                    .id("mission-context-conversation")
                    .test_support()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .overflow_hidden()
                    .child(conversation),
            )
            .children(slot)
            .into_any_element()
    }
}

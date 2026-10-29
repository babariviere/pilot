//! New-chat presentation only. ChatEditor retains input and delivery ownership.
use super::*;
use crate::ui::{self, Text};

impl ChatEditor {
    pub(super) fn new_chat_setup(
        &self,
        draft: &Draft,
        _blocked: bool,
        window: &mut Window,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let setup = div()
            .id("new-chat-setup")
            .v_flex()
            .min_w_0()
            .gap(px(ui::Space::CONTROL))
            // Guard before a sibling control blurs the native editor/query.
            .capture_any_mouse_down(cx.listener(|view, _, window, cx| {
                if view.marked(window, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(
                ui::header("new-chat-heading", "New chat", Text::Title).mb(px(ui::Space::SIDEBAR)),
            )
            .child(self.project_field(draft, window, cx))
            .children(self.project_setup_problem(draft).map(|error| {
                ui::Notice::new(error).tone(if error.starts_with("Loading") {
                    ui::Tone::Quiet
                } else {
                    ui::Tone::Warning
                })
            }))
            .children((!draft.editable()).then(|| {
                ui::text(
                    Text::Caption,
                    format!(
                        "Original destination: {} · {}",
                        draft.project_id.as_deref().unwrap_or("Unresolved project"),
                        draft.cwd
                    ),
                )
                .text_color(cx.theme().muted_foreground)
            }))
            .children(draft.editable().then(|| {
                ui::text(Text::Caption, "Build can make changes.")
                    .text_color(cx.theme().muted_foreground)
            }));
        #[cfg(any(test, feature = "native-probes"))]
        let setup = setup.test_support();
        setup
    }
}

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
        if draft.diagnostics {
            let setup = div().id("diagnostic-chat-setup").v_flex().gap_2()
                .child(ui::header("diagnostic-chat-heading", "Ask about Pilot", Text::Title))
                .child(ui::text(Text::Body, "Investigate with bounded, sanitized Local diagnostics, logs and available chat history."))
                .child(ui::text(Text::Caption, "Read-only specialist. No shell, arbitrary files or repairs. Uses the daemon’s default model. Nothing starts until you send."));
            #[cfg(any(test, feature = "native-probes"))]
            let setup = setup.test_support();
            return setup.into_any_element();
        }
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
        setup.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;

    #[gpui_kit::test]
    fn diagnostic_draft_is_distinct_read_only_and_explicit_send_only(cx: &mut TestAppContext) {
        let (h, editor, commands) = super::super::tests::setup(cx);
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                e.new_draft(String::new(), w, cx);
                let build = e.navigation_key().unwrap().to_owned();
                e.new_diagnostics(w, cx);
                assert_ne!(e.navigation_key().unwrap(), build);
                assert!(e.diagnostic_chat());
                assert!(e.project_problem(e.draft().unwrap()).is_none());
                assert!(e.draft().unwrap().project_id.is_none());
                assert_eq!(e.draft().unwrap().mode, "ask");
                e.attach_images(
                    vec![crate::image_attachments::Incoming::File(
                        "/synthetic/a.png".into(),
                    )],
                    w,
                    cx,
                );
                assert!(e.draft().unwrap().attachments.is_empty());
                e.text
                    .update(cx, |t, cx| t.set_value("Diagnose 日本語 👩‍💻", w, cx));
                e.submit(false, w, cx);
            })
        })
        .unwrap();
        let mut submissions = Vec::new();
        while let Ok(command) = commands.try_recv() {
            if let WriteCommand::Submit { draft, .. } = command {
                submissions.push(draft);
            }
        }
        assert_eq!(submissions.len(), 1);
        assert!(submissions[0].diagnostics);
        assert_eq!(submissions[0].text, "Diagnose 日本語 👩‍💻");
    }
}

//! New-chat presentation only. ChatEditor retains input and delivery ownership.
use super::*;
use crate::ui::{self, Text};
use gpui_kit::component::{Selectable, button::ButtonGroup};

impl ChatEditor {
    pub(super) fn new_chat_setup(
        &self,
        draft: &Draft,
        blocked: bool,
        window: &mut Window,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let source = self.selected.clone();
        let setup = div()
            .id("new-chat-setup")
            .v_flex()
            .min_w_0()
            .gap(px(ui::Space::CONTROL))
            // Guard before a sibling control blurs the native editor/query.
            .capture_any_mouse_down(cx.listener(|view, _, window, cx| {
                if view.marked(window, cx) { cx.stop_propagation(); }
            }))
            .child(ui::header("new-chat-heading", "New chat", Text::Title).mb(px(ui::Space::SIDEBAR)))
            .child(div().h_flex().gap_2().min_w_0()
                .child(div().flex_1().min_w_0().child(self.project_field(draft, window, cx)))
                .child(ButtonGroup::new("new-chat-mode")
                    .small()
                    .ghost()
                    .disabled(blocked || !draft.editable())
                    .child(Button::new("new-chat-ask").label("Ask")
                        .selected(draft.mode != "build")
                        .tooltip("Ask is read-only. No isolated workspace is created."))
                    .child(Button::new("new-chat-build").label("Build")
                        .selected(draft.mode == "build")
                        .tooltip("Build can make changes in the project's configured workspace."))
                    .on_click(cx.listener(move |view, selected: &Vec<usize>, window, cx| {
                        if view.selected != source { return; }
                        if let Some(index) = selected.first() { view.choose_new_chat_mode(*index, window, cx); }
                    }))))
            .children(self.project_setup_problem(draft).map(|error| {
                ui::Notice::new(error).tone(if error.starts_with("Loading") { ui::Tone::Quiet } else { ui::Tone::Warning })
            }))
            .children((!draft.editable()).then(|| {
                ui::text(Text::Caption, format!("Original destination: {} · {}",
                    draft.project_id.as_deref().unwrap_or("Unresolved project"), draft.cwd))
                    .text_color(cx.theme().muted_foreground)
            }))
            .child(ui::text(Text::Caption, if draft.mode == "build" {
                "Build can make changes."
            } else { "Ask explores without changing files." }).text_color(cx.theme().muted_foreground));
        #[cfg(any(test, feature = "native-probes"))]
        let setup = setup.test_support();
        setup
    }

    fn choose_new_chat_mode(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if index > 1
            || !self.ready()
            || !self.writable
            || self.waiting()
            || self.marked(window, cx)
            || !self.draft().is_some_and(Draft::editable)
            || !self
                .selected
                .as_ref()
                .is_some_and(|key| key.starts_with("new:"))
        {
            return;
        }
        if let Some(key) = &self.selected
            && let Some(draft) = self.cache.get_mut(key)
        {
            draft.mode = if index == 0 { "ask" } else { "build" }.into();
        }
        self.record_edit(true, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_editor::tests::setup;
    use gpui_kit::TestAppContext;

    #[gpui_kit::test]
    fn mode_preserves_exact_native_draft_and_destination(cx: &mut TestAppContext) {
        let (h, editor, requests) = setup(cx);
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                e.new_draft(String::new(), w, cx);
                let key = e.selected.clone();
                let text = "Keep 私 👩‍💻 e\u{301}\nsecond line";
                e.text.update(cx, |t, cx| t.set_value(text, w, cx));
                e.choose_new_chat_mode(1, w, cx);
                assert_eq!(e.selected, key);
                assert_eq!(e.draft().unwrap().text, text);
                assert_eq!(e.draft().unwrap().mode, "build");
                assert!(e.draft().unwrap().project_id.is_none());
                assert!(e.draft().unwrap().cwd.is_empty());
                e.submit(false, w, cx);
                e.choose_new_chat_mode(0, w, cx);
                assert_eq!(e.draft().unwrap().mode, "ask");
                assert_eq!(e.draft().unwrap().text, text);
            })
        })
        .unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[gpui_kit::test]
    fn mode_rejects_preedit_pending_readonly_and_existing_chat(cx: &mut TestAppContext) {
        let (h, editor, requests) = setup(cx);
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                e.new_draft(String::new(), w, cx);
                e.text.update(cx, |t, cx| {
                    t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                let revision = e.draft().unwrap().revision;
                e.choose_new_chat_mode(1, w, cx);
                assert_eq!(e.draft().unwrap().revision, revision);
                assert!(e.marked(w, cx));
                e.text.update(cx, |t, cx| t.unmark_text(w, cx));
                let key = e.selected.clone().unwrap();
                e.cache.get_mut(&key).unwrap().pending = Some("original-operation".into());
                let pending = e.draft().unwrap().clone();
                e.choose_new_chat_mode(1, w, cx);
                assert!(e.draft().unwrap() == &pending);
                e.cache.get_mut(&key).unwrap().pending = None;
                e.writable = false;
                let before = e.draft().unwrap().clone();
                e.choose_new_chat_mode(1, w, cx);
                assert!(e.draft().unwrap() == &before);
                e.select("chat:a".into(), true, false, w, cx);
                let before = e.draft().unwrap().clone();
                e.choose_new_chat_mode(1, w, cx);
                assert!(e.draft().unwrap() == &before);
            })
        })
        .unwrap();
        assert!(requests.try_recv().is_err());
    }
}

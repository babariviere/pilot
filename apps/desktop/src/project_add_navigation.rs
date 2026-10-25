//! Additive sheet; capture and keep the current reader/editor mounted.
use super::*;
impl LocalViewer {
    pub(super) fn open_add_project(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.project_choices_ready(w, cx) {
            return;
        }
        // Faulted input is not captured/cleared for receipt inspection. That
        // sheet is read-only, including when its retained receipt arrived closed.
        let mut issue = self.editor.read(cx).resource_navigation_issue();
        if issue.is_none() {
            if !self.editor.update(cx, |e, cx| e.capture_navigation(w, cx)) {
                return;
            }
            issue = self.editor.read(cx).resource_navigation_issue();
        }
        if let Some(error) = issue
            && !self.add_project.read(cx).has_context()
        {
            self.nav_error = Some(error);
            cx.notify();
            return;
        }
        self.projects_open = false;
        self.add_project_return = w.focused(cx);
        self.add_project_open = true;
        self.add_project.update(cx, |p, cx| p.open(issue, w, cx));
        cx.notify();
    }
    pub(super) fn add_project_overlay(
        &self,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let width = (f32::from(w.viewport_size().width) - 32.).clamp(200., 560.);
        let height = (f32::from(w.viewport_size().height) - 32.).clamp(160., 420.);
        div()
            .id("add-project-overlay")
            .test_support()
            .absolute()
            .inset_0()
            .occlude()
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .bg(cx.theme().background.opacity(0.88)),
            )
            .child(
                div()
                    .id("add-project-sheet")
                    .test_support()
                    .absolute()
                    .top(px(16.))
                    .left(px((f32::from(w.viewport_size().width) - width) / 2.))
                    .w(px(width))
                    .h(px(height))
                    .p_4()
                    .rounded(px(appearance::Radius::TRAY))
                    .bg(crate::ui::Surface::Card.color(cx))
                    .border_1()
                    .border_color(cx.theme().border)
                    .occlude()
                    .child(self.add_project.clone()),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{TestAppContext, WindowOptions};
    #[gpui_kit::test]
    fn project_add_refuses_private_fault_or_oversized_uncaptured_input(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        for fault in [false, true] {
            let (writer, commands) = Interaction::recording();
            let (h, v) = cx.update(|cx| {
                gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
                    cx.new(|cx| {
                        let v = LocalViewer::build(None, Some(writer), w, cx);
                        v.editor.update(cx, |e, cx| {
                            e.accept(
                                crate::interaction::WriteState {
                                    book: Some(
                                        Arc::new(crate::delivery_store::Book::shell_probe()),
                                    ),
                                    error: fault
                                        .then_some("Synthetic actual private-write refusal"),
                                    ..Default::default()
                                },
                                w,
                                cx,
                            );
                            e.select("chat:source".into(), true, false, w, cx);
                        });
                        v
                    })
                })
                .unwrap()
            });
            cx.update_window(h, |_, w, cx| {
                let text = v.read(cx).editor.read(cx).shell_probe().0;
                if !fault {
                    text.update(cx, |t, cx| {
                        t.set_value("x".repeat(crate::delivery_store::TEXT_CAP + 1), w, cx)
                    });
                }
                v.update(cx, |v, cx| v.open_add_project(w, cx));
                assert!(!v.read(cx).add_project_open);
                assert!(v.read(cx).nav_error.is_some());
                assert!(commands.try_recv().is_err());
            })
            .unwrap();
        }
    }
}

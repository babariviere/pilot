//! Additive exact-task entry; retained forms stay owned by the task pane.
use super::*;
use crate::{
    task_edit::Target,
    task_edit_view::{Close, Form},
};
use gpui_kit::component::WindowExt;
impl Pane {
    pub(super) fn hide_edit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(f) = self.edit_form.take() {
            let owned = f.read(cx).owns_focus(w, cx);
            let moved_focus = w.focused(cx);
            w.close_dialog(cx);
            if owned {
                self.trigger.focus(w, cx);
            } else if let Some(focus) = moved_focus {
                // Navigation may already have focused the mounted page before
                // hiding this dialog. Do not restore its now-unmounted trigger.
                focus.focus(w, cx);
            }
            f.update(cx, |f, cx| {
                f.visible = false;
                cx.notify();
            });
        }
    }
    pub(super) fn edit_task(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) || self.state.busy || self.state.error.is_some() {
            return;
        }
        let (Some(s), Some(id), Some(options)) = (
            &self.state.snapshot,
            &self.state.selected,
            self.options.clone(),
        ) else {
            return;
        };
        let Some(t) = s.task(id) else {
            return;
        };
        let target = Target {
            key: s.key.clone(),
            task: t.id.clone(),
            number: t.number,
        };
        if target.key.home != crate::mission_browser::Home::local(&options.host()) {
            return;
        }
        let prior = self
            .edits
            .iter()
            .find(|(f, _)| f.read(cx).matches(&target, &options))
            .map(|(f, _)| f.clone());
        let form = if let Some(f) = prior {
            f
        } else {
            if self.edits.len() >= 16 {
                self.create_error = Some(
                    "Task edit capacity reached (16 tasks). Existing text and receipts are retained in this window.",
                );
                cx.notify();
                return;
            }
            let f = cx.new(|cx| Form::new(target, options, w, cx));
            let sub = cx.subscribe_in(&f, w, |v, f, _: &Close, w, cx| {
                if v.edit_form.as_ref() != Some(f) || f.update(cx, |f, cx| f.marked(w, cx)) {
                    return;
                }
                let owned = f.read(cx).owns_focus(w, cx);
                v.hide_edit(w, cx);
                if owned {
                    v.focus_list(w, cx);
                }
                cx.notify();
            });
            self.edits.push((f.clone(), sub));
            f
        };
        self.hide_status(w, cx);
        form.update(cx, |f, cx| {
            f.visible = true;
            f.load(w, cx);
            cx.notify();
        });
        self.edit_form = Some(form.clone());
        Form::open(form, w, cx);
        cx.notify();
    }
}

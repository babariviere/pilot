//! The task pane retains at most sixteen exact-source preference popups.
use super::*;
use crate::{
    task_edit::Target,
    task_model_view::{Close, Form},
};
use gpui_kit::component::WindowExt;
impl Pane {
    pub(super) fn hide_model(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(f) = self.model_form.take() {
            let owned = f.read(cx).owns_focus(w, cx);
            let moved = w.focused(cx);
            w.close_dialog(cx);
            if owned {
                self.trigger.focus(w, cx);
            } else if let Some(focus) = moved {
                focus.focus(w, cx);
            }
            f.update(cx, |f, cx| {
                f.visible = false;
                cx.notify();
            });
        }
    }
    pub(super) fn task_model(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) || self.state.busy || self.state.error.is_some() {
            return;
        }
        let (Some(s), Some(id), Some(o)) = (
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
        if target.key.home != crate::mission_browser::Home::local(&o.host()) {
            return;
        }
        let prior = self
            .models
            .iter()
            .find(|(f, _)| f.read(cx).matches(&target, &o))
            .map(|(f, _)| f.clone());
        let form = if let Some(f) = prior {
            f
        } else {
            if self.models.len() >= 16 {
                self.create_error = Some(
                    "Task preference capacity reached (16 tasks). Existing choices and receipts are retained in this window.",
                );
                cx.notify();
                return;
            }
            let f = cx.new(|cx| Form::new(target, o, w, cx));
            let sub = cx.subscribe_in(&f, w, |v, f, _: &Close, w, cx| {
                if v.model_form.as_ref() != Some(f) {
                    return;
                }
                let owned = f.read(cx).owns_focus(w, cx);
                v.hide_model(w, cx);
                if owned {
                    v.focus_list(w, cx);
                }
                cx.notify();
            });
            self.models.push((f.clone(), sub));
            f
        };
        self.hide_status(w, cx);
        if let Some(f) = self.creation.take() {
            if f.read(cx).owns_focus(w, cx) {
                self.trigger.focus(w, cx);
            }
            f.update(cx, |f, cx| {
                f.visible = false;
                cx.notify();
            });
        }
        form.update(cx, |f, cx| {
            f.visible = true;
            f.load(w, cx);
            cx.notify();
        });
        self.model_form = Some(form.clone());
        Form::open(form, w, cx);
        cx.notify();
    }
}

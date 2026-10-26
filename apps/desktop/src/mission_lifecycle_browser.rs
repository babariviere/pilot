//! Additive Overview lifecycle entry and bounded retained confirmation ownership.
use super::*;
use crate::{mission_lifecycle::Action as Lifecycle, mission_lifecycle_view::Form};
impl Browser {
    pub(crate) fn hide_lifecycle(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let owned = self
            .lifecycle
            .iter()
            .any(|f| f.read(cx).visible && f.read(cx).owns_focus(w, cx));
        if owned {
            self.focus.focus(w, cx);
        }
        for f in &self.lifecycle {
            f.update(cx, |v, cx| {
                v.visible = false;
                cx.notify();
            });
        }
    }
    pub(crate) fn open_lifecycle(
        &mut self,
        action: Lifecycle,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy || self.error.is_some() || !self.online || self.brief_marked(w, cx) {
            return;
        }
        let (Some(options), Some(source)) = (self.options.clone(), self.brief_source()) else {
            return;
        };
        if !self.catalog.as_ref().is_some_and(|c| source.canonical(c)) {
            return;
        }
        let form = if let Some(f) = self
            .lifecycle
            .iter()
            .find(|f| f.read(cx).matches(&source, &options))
        {
            f.clone()
        } else {
            if self.lifecycle.len() >= 16 {
                self.error = Some(
                    "Lifecycle confirmation capacity reached. Existing outcomes are retained.",
                );
                cx.notify();
                return;
            }
            let f = cx.new(|cx| Form::new(source, options, action, cx));
            cx.subscribe_in(
                &f,
                w,
                |v, _, _: &crate::mission_lifecycle_view::Close, w, cx| {
                    v.hide_lifecycle(w, cx);
                    cx.notify();
                },
            )
            .detach();
            self.lifecycle.push(f.clone());
            f
        };
        self.hide_metadata(cx);
        if self.activity_open {
            self.hide_activity(w, cx);
        }
        if let Some(b) = &self.brief {
            b.update(cx, |v, cx| v.hide(cx));
        }
        self.tasks_browser
            .update(cx, |v, cx| v.sync(None, self.options.clone(), w, cx));
        form.update(cx, |v, cx| {
            v.visible = true;
            v.prepare(action);
            v.load(cx);
            v.focus(w, cx);
            cx.notify();
        });
        cx.notify();
    }
}

//! Additive Overview lifecycle entry and bounded retained confirmation ownership.
use super::*;
use crate::{mission_lifecycle::Action as Lifecycle, mission_lifecycle_view::Form};
impl Browser {
    pub(super) fn completion_action(
        &self,
        generation: u64,
        cx: &Context<Self>,
    ) -> Option<gpui_kit::AnyElement> {
        let d = self
            .detail
            .as_ref()
            .filter(|d| self.route == Some(Route::Detail(d.key.clone())) && d.status == "active")?;
        let source = self.brief_source()?;
        let enabled = self.current(generation)
            && self.online
            && self.catalog_current
            && self.catalog.as_ref().is_some_and(|c| source.canonical(c))
            && d.finished.is_some();
        Some(
            ui::action("mission-mark-done", "Mark done", Action::Primary)
                .disabled(!enabled)
                .tooltip("Mark this mission done when every remaining task is done")
                .on_click(cx.listener(move |v, _, w, cx| {
                    if v.generation == generation {
                        v.open_lifecycle(Lifecycle::Complete, w, cx);
                    }
                }))
                .into_any_element(),
        )
    }
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
        if action == Lifecycle::Complete
            && (!self.catalog_current
                || !self
                    .detail
                    .as_ref()
                    .is_some_and(|d| d.status == "active" && d.finished.is_some()))
        {
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
        self.sync_tasks(None, w, cx);
        form.update(cx, |v, cx| {
            v.visible = true;
            v.available = true;
            v.prepare(action);
            v.load(cx);
            v.focus(w, cx);
            cx.notify();
        });
        cx.notify();
    }
}

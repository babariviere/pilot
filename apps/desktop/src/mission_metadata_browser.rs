//! Additive Overview entry and retained metadata forms, owned by Browser.
use super::*;
use crate::mission_metadata_view::Form;
impl Browser {
    pub(crate) fn metadata_marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.metadata
            .iter()
            .any(|f| f.update(cx, |v, cx| v.marked(w, cx)))
    }
    pub(crate) fn hide_metadata(&mut self, cx: &mut Context<Self>) {
        for form in &self.metadata {
            form.update(cx, |v, cx| {
                v.visible = false;
                cx.notify();
            });
        }
    }
    pub(crate) fn open_metadata(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.error.is_some() || !self.online || self.brief_marked(w, cx) {
            return;
        }
        let (Some(options), Some(source)) = (self.options.clone(), self.brief_source()) else {
            return;
        };
        if !self.catalog.as_ref().is_some_and(|c| source.canonical(c)) {
            return;
        }
        let form = if let Some(form) = self
            .metadata
            .iter()
            .find(|f| f.read(cx).matches(&source, &options))
        {
            form.clone()
        } else {
            if self.metadata.len() >= 16 {
                self.error = Some(
                    "Metadata draft capacity reached. Existing drafts and receipts are retained.",
                );
                cx.notify();
                return;
            }
            let form = cx.new(|cx| Form::new(source, options, w, cx));
            cx.subscribe_in(
                &form,
                w,
                |v, form, _: &crate::mission_metadata_view::Close, w, cx| {
                    if form.update(cx, |v, cx| v.marked(w, cx)) {
                        return;
                    }
                    let owned = form.read(cx).owns_focus(w, cx);
                    form.update(cx, |v, cx| {
                        v.visible = false;
                        cx.notify();
                    });
                    let key = v.brief_source().map(|s| s.key).filter(|key| {
                        v.catalog.as_ref().is_some_and(|c| {
                            c.rows
                                .iter()
                                .any(|r| r.key == *key && r.local_definition(&key.home))
                        })
                    });
                    v.tasks_browser
                        .update(cx, |p, cx| p.sync(key, v.options.clone(), w, cx));
                    if owned {
                        v.focus(w, cx);
                    }
                    cx.notify();
                },
            )
            .detach();
            self.metadata.push(form.clone());
            form
        };
        if self.activity_open {
            self.hide_activity(w, cx);
        }
        if let Some(brief) = &self.brief {
            brief.update(cx, |v, cx| v.hide(cx));
        }
        self.tasks_browser
            .update(cx, |v, cx| v.sync(None, self.options.clone(), w, cx));
        form.update(cx, |v, cx| {
            v.visible = true;
            v.load(w, cx);
            v.focus(w, cx);
            cx.notify();
        });
        cx.notify();
    }
}

//! Selected Local chat owns source and disclosure; the editor is only a stable slot.
use super::*;
use crate::{
    session_todos::{Feed, Phase, Source},
    ui::{self, Action},
};
use std::collections::VecDeque;

pub(super) struct Entry {
    height: crate::composer_height::State,
    viewer: gpui_kit::WeakEntity<LocalViewer>,
    // Bounded, window-local intent, keyed by exact Local identity/port and chat,
    // not by title or connection generation. Never auto-open/close on progress.
    expanded: VecDeque<(Source, bool)>,
    focus: gpui_kit::FocusHandle,
    _subscription: Subscription,
}
pub(super) fn entry(window: &mut Window, cx: &mut Context<LocalViewer>) -> Entity<Entry> {
    let viewer = cx.entity();
    cx.new(|cx: &mut Context<Entry>| Entry {
        height: Default::default(),
        viewer: viewer.downgrade(),
        expanded: VecDeque::new(),
        focus: cx.focus_handle(),
        _subscription: cx.observe_in(&viewer, window, |entry, _, w, cx| {
            if entry.selected(cx).is_none() && entry.focus.contains_focused(w, cx) {
                let _ = entry.viewer.update(cx, |v, cx| {
                    // The composer may be read-only/unavailable or no longer
                    // mounted. Establish a mounted navigation fallback first.
                    v.chats.update(cx, |list, cx| list.focus(w, cx));
                    if v.page == Page::Chat && v.selected.is_some() {
                        v.editor.update(cx, |e, cx| e.focus(w, cx));
                    }
                });
            }
            cx.notify();
        }),
    })
}
impl Entry {
    fn allowed(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.viewer
            .update(cx, |v, cx| v.project_choices_ready(w, cx))
            .unwrap_or(false)
    }
    fn selected(&self, cx: &App) -> Option<(Source, Feed)> {
        let viewer = self.viewer.upgrade()?;
        let v = viewer.read(cx);
        let options = v.usage_options.as_ref()?;
        let feed = &v.state.todos;
        if v.page != Page::Chat || !feed.visible(Some(options), v.selected.as_deref(), v.generation)
        {
            return None;
        }
        Some((feed.source.clone()?, feed.clone()))
    }
}
impl Render for Entry {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let scope = self
            .viewer
            .upgrade()
            .and_then(|v| v.read(cx).selected.clone());
        let Some((key, feed)) = self.selected(cx) else {
            return crate::composer_height::slot(
                "session-todos-slot",
                &self.height,
                scope,
                None,
                f32::from(w.rem_size()) * 0.25,
                w,
                cx,
            );
        };
        let expanded = self
            .expanded
            .iter()
            .find(|(k, _)| k.same_chat(&key))
            .is_some_and(|(_, v)| *v);
        let mut content = div()
            .id("session-todos-strip")
            .test_support()
            .track_focus(&self.focus)
            .v_flex()
            .min_w_0()
            .p_1()
            .bg(crate::appearance::tray(cx))
            .rounded(px(crate::appearance::Radius::TRAY))
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if !v.allowed(w, cx) {
                    cx.stop_propagation();
                }
            }));
        // selected() admits only known nonempty snapshots, including retained.
        let snapshot = feed.snapshot.expect("visible task snapshot");
        let stale = feed.phase == Phase::Retained;
        content = content.child(ui::action("session-todos-toggle", "", Action::Quiet).w_full().min_w_0()
            .accessibility_label(SharedString::from(format!("{} tasks. {}{}", if expanded { "Hide" } else { "Show" }, snapshot.summary(), if stale { ". Retained snapshot, not current" } else { "" })))
            .tooltip("Read-only public chat tasks. Only closed/done count as completed. Assigned to this chat sorts first.")
            .child(crate::session_todos_view::summary(&snapshot, expanded, cx))
            .on_click(cx.listener(move |v, _, w, cx| {
                if !v.allowed(w, cx) || v.selected(cx).is_none_or(|(current, _)| !current.same_admission(&key)) { return; }
                if let Some((_, value)) = v.expanded.iter_mut().find(|(k, _)| k.same_chat(&key)) { *value = !*value; }
                else { if v.expanded.len() == 128 { v.expanded.pop_front(); } v.expanded.push_back((key.clone(), true)); }
                cx.notify();
            })));
        // Retention/coverage is never hidden by collapse, nor does it change intent.
        if expanded {
            content = content.child(crate::session_todos_view::rows(&snapshot, feed.phase, cx));
        } else {
            if stale {
                content = content.child(
                    ui::text(ui::Text::Caption, "Retained task snapshot, not current")
                        .id("session-todos-retained")
                        .test_support()
                        .text_color(cx.theme().muted_foreground),
                );
            }
            if let Some(coverage) = snapshot.coverage() {
                content = content.child(
                    ui::text(ui::Text::Caption, SharedString::from(coverage))
                        .id("session-todos-coverage")
                        .test_support()
                        .text_color(cx.theme().muted_foreground),
                );
            }
        }
        crate::composer_height::slot(
            "session-todos-slot",
            &self.height,
            scope,
            Some(content.into_any_element()),
            f32::from(w.rem_size()) * 0.25,
            w,
            cx,
        )
    }
}

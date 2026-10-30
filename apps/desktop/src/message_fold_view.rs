//! Transcript-owned disclosure, no alternate editor or source authority.
use super::TranscriptView;
use crate::{
    model::Message,
    ui::{self, Action},
};
use gpui_kit::{
    App, Context, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, TestSupportExt, Window,
    component::{ActiveTheme, Disableable, StyledExt},
    div,
    prelude::FluentBuilder,
};

impl TranscriptView {
    pub(crate) fn fold_scope(&mut self, scope: Option<crate::session_todos::Source>) {
        if self.folds.scope(scope) {
            self.fold_motion.clear();
            self.fold_retired
                .extend(std::mem::take(&mut self.fold_focus).into_values());
            self.fold_retired.truncate(1024);
        }
    }
    pub(super) fn fold_source<'a>(&'a self, row: &'a Message) -> &'a str {
        self.folds.source(row).unwrap_or_else(|| {
            if row.is_plain() {
                row.source()
            } else {
                row.display_source()
            }
        })
    }
    fn toggle_fold(
        &mut self,
        id: u64,
        key: Option<crate::model::ReaderKey>,
        source: std::sync::Arc<String>,
        scope: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if scope != self.history_scope || !self.tool_preview_ready(w, cx) {
            return;
        }
        let Some(ix) =
            self.transcript.messages().iter().position(|r| {
                r.id() == id && r.reader_key() == key && r.source() == source.as_str()
            })
        else {
            return;
        };
        let row = self.transcript.messages()[ix].clone();
        if !self.folds.long(&row) {
            return;
        }
        // Establish a mounted fallback before replacing a selected/focused parser.
        if let Some(focus) = self.fold_focus.get(&row.reader_key().unwrap()) {
            focus.focus(w, cx);
        } else {
            self.find.focus.focus(w, cx);
        }
        self.hold_for_history(cx);
        self.fold_motion.entry(id).or_default().start(cx);
        self.folds.toggle(&row);
        self.text_subscriptions.remove(&id);
        self.text_states[ix] = self.create_text_state(ix, cx);
        self.sync_find_highlights(cx);
        self.scroller
            .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
        cx.notify();
    }
    /// The guarded focus scope of a row's fold control. Space/Enter toggle,
    /// Escape collapses; pointer input waits for marked text to settle.
    fn fold_scope_div(
        &self,
        row: &Message,
        owner: gpui_kit::WeakEntity<Self>,
    ) -> Option<(
        gpui_kit::Div,
        impl Fn(&mut Window, &mut App) + Clone + use<>,
    )> {
        if !self.folds.long(row) {
            return None;
        }
        let collapsed = self.folds.collapsed(row);
        let (id, key, source, scope) = (
            row.id(),
            row.reader_key(),
            row.shared_source(),
            self.history_scope,
        );
        let focus = self.fold_focus.get(&key.clone()?)?.clone();
        let toggle = {
            let owner = owner.clone();
            move |w: &mut Window, cx: &mut App| {
                let _ = owner.update(cx, |v, cx| {
                    v.toggle_fold(id, key.clone(), source.clone(), scope, w, cx)
                });
            }
        };
        let keys = toggle.clone();
        let wrapper = div()
            .track_focus(&focus)
            .h_flex()
            .gap_2()
            .items_center()
            .capture_any_mouse_down(move |_, w, cx| {
                let allowed = owner
                    .update(cx, |v, cx| v.tool_preview_ready(w, cx))
                    .unwrap_or(false);
                if !allowed {
                    cx.stop_propagation();
                }
            })
            .capture_key_down(move |e, w, cx| {
                if matches!(e.keystroke.key.as_str(), "space" | "enter")
                    || (e.keystroke.key == "escape" && !collapsed)
                {
                    cx.stop_propagation();
                    keys(w, cx);
                }
            });
        Some((wrapper, toggle))
    }
    pub(super) fn fold_controls(
        &self,
        row: &Message,
        cx: &App,
        owner: gpui_kit::WeakEntity<Self>,
    ) -> Option<impl IntoElement + use<>> {
        if row.automatic().is_some() {
            return None;
        }
        let collapsed = self.folds.collapsed(row);
        let (wrapper, toggle) = self.fold_scope_div(row, owner)?;
        Some(
            wrapper
                .child(
                    ui::action(
                        ("message-fold", row.id()),
                        if collapsed { "Show more" } else { "Show less" },
                        Action::Quiet,
                    )
                    .icon(
                        if collapsed {
                            crate::app_icon::AppIcon::Expand
                        } else {
                            crate::app_icon::AppIcon::Collapse
                        }
                        .asset(),
                    )
                    .accessibility_label(if collapsed {
                        "Expand message"
                    } else {
                        "Collapse message"
                    })
                    .on_click(move |_, w, cx| toggle(w, cx)),
                )
                .when(collapsed, |d| {
                    d.child(
                        ui::text(
                            ui::Text::Caption,
                            SharedString::from(
                                "Source preview. Selection copies only this prefix.",
                            ),
                        )
                        .text_color(cx.theme().muted_foreground),
                    )
                }),
        )
    }
    /// Automatic input as one disclosure line, like a work row: what it is and
    /// its first line. Expanded, the exact plain source follows; copy and the
    /// sent time stay on the line, folded or not.
    pub(super) fn render_automatic(
        &self,
        ix: usize,
        cx: &App,
        owner: gpui_kit::WeakEntity<Self>,
        found: Option<SharedString>,
        trailing: gpui_kit::AnyElement,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let row = &self.transcript.messages()[ix];
        let automatic = row.automatic().expect("automatic row");
        let collapsed = !self.folds.long(row) || self.folds.collapsed(row);
        let sentence = automatic.sentence().to_owned();
        let preview = automatic.preview(row.source()).unwrap_or_default();
        let mut button = crate::work_view::disclosure(
            SharedString::from(format!("automatic-toggle-{}", row.id())),
            crate::work_view::Caption {
                verb: sentence.clone(),
                subject: preview.clone(),
                ..Default::default()
            },
            !collapsed,
            Some(automatic.origin.icon()),
            cx,
        )
        .accessibility_label(SharedString::from(format!(
            "{} automatic input: {sentence}",
            if collapsed { "Show" } else { "Hide" }
        )));
        if let Some(sender) = &automatic.sender {
            let parts = [
                sentence.as_str(),
                preview.as_str(),
                &format!("From chat {sender}"),
            ];
            let tooltip: Vec<&str> = parts.into_iter().filter(|p| !p.is_empty()).collect();
            button = button.tooltip(SharedString::from(tooltip.join(" · ")));
        }
        let line = match self.fold_scope_div(row, owner.clone()) {
            Some((wrapper, toggle)) => wrapper
                .flex_1()
                .min_w_0()
                .child(button.on_click(move |_, w, cx| toggle(w, cx)))
                .into_any_element(),
            // Without a canonical key there is no fold state: the line still
            // names the input, and copy keeps its exact source.
            None => div()
                .flex_1()
                .min_w_0()
                .child(button.disabled(true))
                .into_any_element(),
        };
        div()
            .id(("message", row.id()))
            .group("message")
            .v_flex()
            .gap_2()
            .w_full()
            .min_w_0()
            .when_some(found, |m, text| {
                m.child(
                    div()
                        .id(("find-target", row.id()))
                        .test_support()
                        .aria_label(text.clone())
                        .min_w_0()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .whitespace_normal()
                        .child(text),
                )
            })
            .child(
                div()
                    .h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_1()
                    .items_center()
                    .child(line)
                    .child(trailing),
            )
            .when(!collapsed, |m| {
                m.child(
                    div()
                        .id(("automatic-body", row.id()))
                        .test_support()
                        .v_flex()
                        .pl_4()
                        .border_l_1()
                        .border_color(cx.theme().border)
                        .min_w_0()
                        .child(self.render_text(ix, row, false, cx, owner)),
                )
            })
    }
}

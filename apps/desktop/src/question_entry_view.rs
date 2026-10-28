//! Question record rows: a quiet "Agent asked" disclosure, collapsed by
//! default like the Swift app, that expands to the formatted question. The
//! record is history only: no answer controls, and the live Ask popup is
//! unaffected. Expanded text is the row's ordinary selectable TextView.
use super::{LinkOpen, TranscriptView};
use crate::{
    app_icon::AppIcon,
    model::{Message, ReaderKey},
    question_entry::Record,
};
use gpui_kit::{
    App, ClipboardItem, Context, InteractiveElement, IntoElement, ParentElement, SharedString,
    Styled, TestSupportExt, Window,
    component::{
        ActiveTheme, Icon, IconName, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        text::TextView,
    },
    div, px,
};
use std::{collections::VecDeque, sync::Arc};

/// Expanded question rows, by canonical entry and exact record so another
/// chat's entry with the same ID never inherits the choice.
#[derive(Default)]
pub(crate) struct Disclosures(VecDeque<(ReaderKey, Arc<Record>)>);
impl Disclosures {
    const RETAINED: usize = 256;
    fn position(&self, row: &Message) -> Option<usize> {
        let (key, record) = (row.reader_key()?, row.question_data()?);
        self.0.iter().position(|(k, r)| *k == key && r == record)
    }
    pub(crate) fn open(&self, row: &Message) -> bool {
        self.position(row).is_some()
    }
    fn toggle(&mut self, row: &Message) {
        if let Some(ix) = self.position(row) {
            self.0.remove(ix);
        } else if let (Some(key), Some(record)) = (row.reader_key(), row.question_data()) {
            self.0.push_back((key, record.clone()));
            if self.0.len() > Self::RETAINED {
                self.0.pop_front();
            }
        }
    }
}

impl TranscriptView {
    fn toggle_question(
        &mut self,
        id: u64,
        record: Arc<Record>,
        scope: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if scope != self.history_scope || !self.tool_preview_ready(w, cx) {
            return;
        }
        let Some(ix) = self
            .transcript
            .messages()
            .iter()
            .position(|r| r.id() == id && r.question_data() == Some(&record))
        else {
            return;
        };
        let row = self.transcript.messages()[ix].clone();
        // Keep the reading position; the row grows or shrinks in place.
        self.hold_for_history(cx);
        self.questions.toggle(&row);
        self.scroller
            .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
        cx.notify();
    }

    pub(super) fn question_row(
        &self,
        ix: usize,
        cx: &App,
        owner: gpui_kit::WeakEntity<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let row = &self.transcript.messages()[ix];
        let record = row.question_data().unwrap().clone();
        let open = self.questions.open(row);
        let (id, scope, source) = (row.id(), self.history_scope, row.shared_source());
        let preview = SharedString::from(record.preview());
        let toggle = Button::new(("question-toggle", id))
            .ghost()
            .small()
            .flex_1()
            .min_w_0()
            .accessibility_label(format!(
                "{} question: {preview}",
                if open { "Collapse" } else { "Expand" }
            ))
            .child(
                div()
                    .h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_1()
                    .items_center()
                    .child(
                        Icon::new(if open {
                            IconName::ChevronDown
                        } else {
                            IconName::ChevronRight
                        })
                        .small()
                        .flex_shrink_0(),
                    )
                    .child(AppIcon::Question.inline().flex_shrink_0())
                    .child(
                        crate::ui::text(crate::ui::Text::Label, "Agent asked")
                            .flex_shrink_0()
                            .text_color(cx.theme().muted_foreground),
                    )
                    .child(
                        crate::ui::text(crate::ui::Text::Body, preview)
                            .id(("question-preview", id))
                            .test_support()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(cx.theme().foreground),
                    ),
            )
            .on_click({
                let (owner, record) = (owner.clone(), record.clone());
                move |_, w, cx| {
                    let _ = owner.update(cx, |v, cx| {
                        v.toggle_question(id, record.clone(), scope, w, cx)
                    });
                }
            });
        let copy = Button::new(("question-copy", id))
            .ghost()
            .xsmall()
            .flex_none()
            .icon(AppIcon::Copy.asset())
            .accessibility_label("Copy question")
            .tooltip("Copy question")
            .opacity(0.)
            .group_hover("message", |s| s.opacity(1.))
            .focus_visible(|s| s.opacity(1.))
            .on_click(move |_, _, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(source.as_ref().clone()))
            });
        let body = open.then(|| {
            div()
                .id(("question-detail", id))
                .test_support()
                .ml(px(15.))
                .pl_4()
                .border_l_1()
                .border_color(cx.theme().border)
                .min_w_0()
                .child(match &self.text_states[ix] {
                    Some(state) => crate::markdown_mermaid::install(
                        crate::typography::rich(
                            TextView::new(state),
                            crate::typography::current(cx),
                            crate::typography::Content::Chat,
                            cx,
                        ),
                        id,
                        row.source(),
                    )
                    .selectable(true)
                    .scrollable(false)
                    .on_link_click(move |url, event, _, cx| {
                        if event.is_right_click() || event.is_middle_click() {
                            return;
                        }
                        let _ = owner.update(cx, |_, cx| {
                            cx.emit(LinkOpen {
                                url: url.to_string(),
                                generation: scope,
                            })
                        });
                    })
                    .into_any_element(),
                    None => div()
                        .child(SharedString::from(row.source().to_owned()))
                        .into_any_element(),
                })
        });
        let mut root = div()
            .id(("message", id))
            .group("message")
            .v_flex()
            .gap_1()
            .w_full()
            .min_w_0()
            .child(
                div()
                    .h_flex()
                    .w_full()
                    .min_w_0()
                    .items_center()
                    .gap_1()
                    .child(toggle)
                    .child(copy),
            )
            .children(body);
        if let Some(guard) = self.history_guard.clone() {
            root = root.capture_any_mouse_down(move |_, w, cx| {
                if !guard(w, cx) {
                    cx.stop_propagation();
                }
            });
        }
        root
    }
}

#[cfg(feature = "native-probes")]
#[path = "question_entry_probe.rs"]
pub(crate) mod probe;

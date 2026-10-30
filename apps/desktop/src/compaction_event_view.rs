//! Context compaction and reset rows (Swift `ChatEventRow` for
//! `pi.compaction`/`pi.reset`): one quiet muted line with the compaction
//! glyph, "Context compacted" and the reported token counts, collapsed by
//! default. When the entry has a summary or handoff text, the line is a
//! disclosure that expands to it as ordinary selectable Markdown, with the
//! trigger when recorded. Time and Copy (the exact stored text) appear on
//! hover or focus. Not a message: no bubble, card, spinner or work group.
use super::{LinkOpen, TranscriptView};
use crate::{
    app_icon::AppIcon,
    compaction_event::{Event, Kind},
    model::{Message, ReaderKey},
    ui::{self, Text},
};
use gpui_kit::{
    App, ClipboardItem, Context, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, TestSupportExt, Window,
    component::{
        ActiveTheme, Icon, IconName, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        text::TextView,
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::{collections::VecDeque, sync::Arc};

/// Expanded rows, by canonical entry and exact event so another chat's entry
/// with the same ID never inherits the choice.
#[derive(Default)]
pub(crate) struct Disclosures(VecDeque<(ReaderKey, Arc<Event>)>);
impl Disclosures {
    const RETAINED: usize = 256;
    fn position(&self, row: &Message) -> Option<usize> {
        let (key, event) = (row.reader_key()?, row.compaction_event()?);
        self.0.iter().position(|(k, e)| *k == key && e == event)
    }
    pub(crate) fn open(&self, row: &Message) -> bool {
        self.position(row).is_some()
    }
    fn toggle(&mut self, row: &Message) {
        if let Some(ix) = self.position(row) {
            self.0.remove(ix);
        } else if let (Some(key), Some(event)) = (row.reader_key(), row.compaction_event()) {
            self.0.push_back((key, event.clone()));
            if self.0.len() > Self::RETAINED {
                self.0.pop_front();
            }
        }
    }
}

impl TranscriptView {
    fn toggle_compaction(
        &mut self,
        id: u64,
        event: Arc<Event>,
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
            .position(|r| r.id() == id && r.compaction_event() == Some(&event))
        else {
            return;
        };
        let row = self.transcript.messages()[ix].clone();
        // Keep the reading position; the row grows or shrinks in place.
        self.hold_for_history(cx);
        self.compactions.toggle(&row);
        self.scroller
            .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
        cx.notify();
    }

    pub(super) fn compaction_row(
        &self,
        ix: usize,
        cx: &App,
        owner: gpui_kit::WeakEntity<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let row = &self.transcript.messages()[ix];
        let event = row.compaction_event().unwrap().clone();
        let expandable = event.detail().is_some();
        let open = expandable && self.compactions.open(row);
        let (id, scope) = (row.id(), self.history_scope);
        let muted = cx.theme().muted_foreground;
        let sentence = SharedString::from(event.sentence());
        let help = SharedString::from(event.help());
        let content = div()
            .h_flex()
            .w_full()
            .min_w_0()
            .gap_1()
            .items_center()
            .text_color(muted)
            .child(
                // A line with nothing to disclose keeps the chevron's width,
                // so marker glyphs align in one column.
                Icon::new(if open {
                    IconName::ChevronDown
                } else {
                    IconName::ChevronRight
                })
                .small()
                .flex_shrink_0()
                .when(!expandable, |icon| icon.opacity(0.)),
            )
            .child(
                match event.kind {
                    Kind::Compacted | Kind::Handoff => AppIcon::Compaction,
                    Kind::Reset => AppIcon::Reset,
                }
                .inline()
                .flex_shrink_0(),
            )
            .child(
                ui::text(Text::Label, sentence.clone())
                    .id(("compaction-sentence", id))
                    .test_support()
                    .flex_1()
                    .min_w_0()
                    .truncate(),
            );
        let tooltip = {
            let help = help.clone();
            move |w: &mut Window, cx: &mut App| {
                gpui_kit::component::tooltip::Tooltip::new(help.clone()).build(w, cx)
            }
        };
        let line = if expandable {
            Button::new(("compaction-toggle", id))
                .ghost()
                .small()
                .flex_1()
                .min_w_0()
                .accessibility_label(format!(
                    "{} {}. {help}",
                    if open { "Collapse" } else { "Expand" },
                    match event.kind {
                        Kind::Compacted => "compaction summary",
                        Kind::Handoff => "context handoff",
                        Kind::Reset => "reset handoff",
                    }
                ))
                .tooltip(help.clone())
                .child(content)
                .on_click({
                    let (owner, event) = (owner.clone(), event.clone());
                    move |_, w, cx| {
                        let _ = owner.update(cx, |v, cx| {
                            v.toggle_compaction(id, event.clone(), scope, w, cx)
                        });
                    }
                })
                .into_any_element()
        } else {
            // Same inset as the disclosure button's label, so lines align.
            div()
                .id(("compaction-line", id))
                .test_support()
                .aria_label(help.clone())
                .flex_1()
                .min_w_0()
                .min_h(px(24.))
                .px_2()
                .h_flex()
                .items_center()
                .tooltip(tooltip)
                .child(content)
                .into_any_element()
        };
        let time = row.sent().map(|ms| {
            ui::text(
                Text::Caption,
                SharedString::from(crate::message_time::label(ms)),
            )
            .id(("compaction-time", id))
            .test_support()
            .flex_none()
            .whitespace_nowrap()
            .text_color(muted)
            .opacity(0.)
            .group_hover("message", |s| s.opacity(1.))
        });
        let copy = event.text.clone().map(|text| {
            let label = match event.kind {
                Kind::Compacted => "Copy summary",
                Kind::Reset | Kind::Handoff => "Copy handoff",
            };
            Button::new(("compaction-copy", id))
                .ghost()
                .xsmall()
                .flex_none()
                .icon(AppIcon::Copy.asset())
                .accessibility_label(label)
                .tooltip(format!("{label}. Copies the exact stored text."))
                .opacity(0.)
                .group_hover("message", |s| s.opacity(1.))
                .focus_visible(|s| s.opacity(1.))
                .on_click(move |_, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(text.clone()))
                })
        });
        let body = open.then(|| {
            div()
                .id(("compaction-detail", id))
                .test_support()
                .ml(px(15.))
                .pl_4()
                .border_l_1()
                .border_color(cx.theme().border)
                .min_w_0()
                .v_flex()
                .gap_1()
                .children(event.reason.map(|reason| {
                    ui::text(Text::Caption, reason.text())
                        .id(("compaction-reason", id))
                        .test_support()
                        .text_color(muted)
                }))
                .child(match &self.text_states[ix] {
                    Some(state) => crate::typography::rich(
                        TextView::new(state),
                        crate::typography::current(cx),
                        crate::typography::Content::Chat,
                        cx,
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
                    .child(line)
                    .children(time)
                    .children(copy),
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
#[path = "compaction_event_probe.rs"]
pub(crate) mod probe;

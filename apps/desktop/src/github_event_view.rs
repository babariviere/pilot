//! GitHub audit rows (Swift `ChatEventRow`): one quiet line with the action's
//! glyph, sentence, branch in code type and PR title. A failure gets the red
//! warning mark and a Show disclosure for its exit status; the time appears on
//! hover. Not a message: no bubble, card or permanent action.
use super::TranscriptView;
use crate::{
    app_icon::AppIcon,
    github_event::{Event, Kind},
    ui::{self, Radius, Text},
};
use gpui_kit::{
    App, ClipboardItem, Context, InteractiveElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, TestSupportExt, Window,
    component::{
        ActiveTheme, Sizable, StyledExt,
        button::{Button, ButtonVariants},
    },
    div, px,
};
use std::{collections::HashSet, sync::Arc};

fn glyph(event: &Event) -> AppIcon {
    match event.kind {
        _ if event.failed() => AppIcon::Error,
        Some(Kind::Push) => AppIcon::Push,
        Some(Kind::Updated) | None => AppIcon::Branch,
        Some(_) => AppIcon::PullRequest,
    }
}

impl TranscriptView {
    fn toggle_github(
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
            .position(|r| r.id() == id && r.github_event() == Some(&event))
        else {
            return;
        };
        // Keep the reading position; the row grows or shrinks in place.
        self.hold_for_history(cx);
        if !self.github_open.remove(&event.id) {
            self.github_open.insert(event.id.clone());
        }
        self.scroller
            .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
        cx.notify();
    }

    pub(super) fn github_row(
        &self,
        ix: usize,
        cx: &App,
        owner: gpui_kit::WeakEntity<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let row = &self.transcript.messages()[ix];
        let event = row.github_event().unwrap().clone();
        let (id, scope) = (row.id(), self.history_scope);
        let detail = event.detail();
        let open = detail.is_some() && self.github_open.contains(&event.id);
        let muted = cx.theme().muted_foreground;
        let time = SharedString::from(match event.end {
            Some(end) if end != event.at => format!(
                "{} to {}",
                crate::message_time::label(event.at),
                crate::message_time::label(end)
            ),
            _ => crate::message_time::label(event.at),
        });
        let show = detail.is_some().then(|| {
            let event = event.clone();
            Button::new(("github-show", id))
                .ghost()
                .xsmall()
                .flex_none()
                .label(if open { "Hide" } else { "Show" })
                .accessibility_label(if open {
                    "Hide event details"
                } else {
                    "Show event details"
                })
                .on_click(move |_, w, cx| {
                    let _ =
                        owner.update(cx, |v, cx| v.toggle_github(id, event.clone(), scope, w, cx));
                })
        });
        let line = div()
            .id(("github-event", id))
            .test_support()
            .aria_label(SharedString::from(event.help()))
            .h_flex()
            .w_full()
            .min_w_0()
            .min_h(px(24.))
            .items_center()
            .gap(px(7.))
            .tooltip({
                let help = SharedString::from(event.help());
                move |w, cx| gpui_kit::component::tooltip::Tooltip::new(help.clone()).build(w, cx)
            })
            .child(
                div()
                    .flex_none()
                    .text_color(if event.failed() {
                        cx.theme().danger
                    } else {
                        muted
                    })
                    .child(glyph(&event).inline()),
            )
            .child(
                ui::text(Text::Label, SharedString::from(event.sentence()))
                    .id(("github-sentence", id))
                    .test_support()
                    .flex_none()
                    .whitespace_nowrap()
                    .text_color(if event.failed() {
                        cx.theme().foreground
                    } else {
                        muted
                    }),
            )
            .children(event.branch.clone().map(|branch| {
                div()
                    .id(("github-branch", id))
                    .test_support()
                    .min_w_0()
                    .max_w(gpui_kit::relative(0.45))
                    .overflow_hidden()
                    .px(px(5.))
                    .py(px(2.))
                    .rounded(px(Radius::SMALL))
                    .bg(cx.theme().muted)
                    .text_color(muted)
                    .child(
                        ui::text(Text::Caption, SharedString::from(branch))
                            .font_family(cx.theme().mono_font_family.clone())
                            .truncate(),
                    )
            }))
            .children(event.title.clone().map(|title| {
                ui::text(Text::Label, SharedString::from(title))
                    .id(("github-title", id))
                    .test_support()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(muted)
                    .opacity(0.75)
            }))
            .children(show)
            .children(event.url.clone().map(|url| {
                // Pilot Next has no URL opener: the exact link is copied.
                Button::new(("github-link", id))
                    .ghost()
                    .xsmall()
                    .flex_none()
                    .icon(AppIcon::Links.asset())
                    .accessibility_label("Copy PR link")
                    .tooltip(SharedString::from(format!("Copy link · {url}")))
                    .opacity(0.)
                    .group_hover("message", |s| s.opacity(1.))
                    .focus_visible(|s| s.opacity(1.))
                    .on_click(move |_, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(url.clone()))
                    })
            }))
            .child(div().flex_1())
            .child(
                ui::text(Text::Caption, time)
                    .id(("github-time", id))
                    .test_support()
                    .flex_none()
                    .whitespace_nowrap()
                    .text_color(muted)
                    .opacity(0.)
                    .group_hover("message", |s| s.opacity(1.)),
            );
        let mut root = div()
            .id(("message", id))
            .group("message")
            .v_flex()
            .gap_1()
            .w_full()
            .min_w_0()
            .child(line)
            .children(detail.filter(|_| open).map(|detail| {
                div()
                    .id(("github-detail", id))
                    .test_support()
                    .pl(px(21.))
                    .min_w_0()
                    .child(ui::text(Text::Label, SharedString::from(detail)).text_color(muted))
            }));
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

/// Expanded failure details, by the first audit action's ID.
pub(crate) type Open = HashSet<String>;

#[cfg(feature = "native-probes")]
#[path = "github_event_probe.rs"]
pub(crate) mod probe;

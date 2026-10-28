//! Read-only Comments page over Browser's retained mission detail snapshot.
//! No reply, resolve, delete or request of its own: Refresh rereads the mission.
use super::*;
use crate::mission_comments::Comment;
use gpui_kit::{AnyElement, KeyDownEvent, ListAlignment, ListOffset, ListState, list};

pub(crate) struct Comments {
    pub(super) open: bool,
    pub(super) list: ListState,
    /// Keyboard-selected comment, by exact ID.
    pub(super) selected: Option<String>,
    /// Comment IDs in list order, for the snapshot the list was sized for.
    ids: Vec<String>,
}
impl Default for Comments {
    fn default() -> Self {
        Self {
            open: false,
            list: ListState::new(0, ListAlignment::Top, px(800.)),
            selected: None,
            ids: Vec::new(),
        }
    }
}
fn received(d: &Detail) -> &[Comment] {
    match &d.comments {
        Ok(Some(c)) => c,
        _ => &[],
    }
}
impl Comments {
    /// Size the list for a new snapshot, keeping the reading position and the
    /// selection on the same comment IDs.
    pub(super) fn reconcile(&mut self, d: &Detail) {
        let ids: Vec<String> = received(d).iter().map(|c| c.id.clone()).collect();
        let top = self.list.logical_scroll_top();
        let anchor = self.ids.get(top.item_ix).cloned();
        self.list.reset(ids.len());
        if let Some(item_ix) = anchor.and_then(|a| ids.iter().position(|id| *id == a)) {
            self.list.scroll_to(ListOffset {
                item_ix,
                offset_in_item: top.offset_in_item,
            });
        }
        self.selected = self.selected.take().filter(|s| ids.contains(s));
        self.ids = ids;
    }
}
impl Browser {
    fn comments_source(&self) -> Option<&Arc<Detail>> {
        self.detail
            .as_ref()
            .filter(|d| self.route == Some(Route::Detail(d.key.clone())))
    }
    pub(super) fn can_read_comments(&self, generation: u64) -> bool {
        self.generation == generation && self.comments_source().is_some()
    }
    /// Opens Comments with this exact comment at the top and selected, or
    /// where the reader left it. Reads the retained snapshot only.
    pub(super) fn reveal_comment(
        &mut self,
        id: Option<String>,
        generation: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_read_comments(generation) || self.brief_marked(w, cx) {
            return;
        }
        if let Some(item_ix) = id
            .as_ref()
            .and_then(|id| self.comments.ids.iter().position(|i| i == id))
        {
            self.comments.list.scroll_to(ListOffset {
                item_ix,
                offset_in_item: px(0.),
            });
            self.comments.selected = id;
        }
        self.comments.open = true;
        self.focus.focus(w, cx);
        cx.notify();
    }
    fn close_comments(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.comments.open = false;
        self.focus.focus(w, cx);
        cx.notify();
    }
    /// Up and Down select a comment and keep it in view; Copy then copies it.
    fn comments_key(&mut self, e: &KeyDownEvent, cx: &mut Context<Self>) {
        let step = match e.keystroke.key.as_str() {
            "down" => 1,
            "up" => -1,
            _ => return,
        };
        let ids = &self.comments.ids;
        if e.keystroke.modifiers.modified() || ids.is_empty() {
            return;
        }
        let ix = match ids
            .iter()
            .position(|id| Some(id) == self.comments.selected.as_ref())
        {
            Some(ix) => ix.saturating_add_signed(step).min(ids.len() - 1),
            None => self
                .comments
                .list
                .logical_scroll_top()
                .item_ix
                .min(ids.len() - 1),
        };
        self.comments.selected = Some(ids[ix].clone());
        self.comments.list.scroll_to_reveal_item(ix);
        cx.stop_propagation();
        cx.notify();
    }
    fn chat_name(&self, id: &str) -> String {
        self.chats
            .iter()
            .find(|c| c.id == id && !c.title.is_empty())
            .map(|c| c.title.clone())
            .or_else(|| {
                let m = self.members.as_ref().ok()?;
                m.rows.iter().find(|m| m.id == id).map(|m| m.title.clone())
            })
            .unwrap_or_else(|| "A chat".into())
    }
    /// "to Coordinator · 3h ago · brief revision 4"
    fn comment_meta(&self, d: &Detail, c: &Comment) -> String {
        let to = match &c.target {
            Some(id) => self.chat_name(id),
            None if d.coordinator.is_some() => "the coordinator".into(),
            None => "you".into(),
        };
        let mut meta = format!(
            "to {to} · {}",
            crate::mission_activity_view::relative_time(c.created_at.max(0.) as u64)
        );
        if let Some(r) = c.revision {
            meta.push_str(&format!(" · brief revision {r}"));
        }
        meta
    }
    fn comment_text(
        &self,
        id: String,
        text: &str,
        role: Text,
        muted: bool,
        cx: &App,
    ) -> impl IntoElement {
        let focus = self.focus.clone();
        div()
            .id(SharedString::from(id.clone()))
            .test_support()
            .w_full()
            .min_w_0()
            .text_size(px(role.size()))
            .line_height(px(role.size() * 1.5))
            .when(muted, |d| d.text_color(cx.theme().muted_foreground))
            .on_mouse_down(gpui_kit::MouseButton::Left, move |_, w, cx| {
                focus.focus(w, cx)
            })
            .child(SelectableText::new(
                SharedString::from(format!("{id}-text")),
                SharedString::from(text.to_owned()),
            ))
    }
    fn comment_item(&self, ix: usize, cx: &Context<Self>) -> AnyElement {
        let Some((d, c)) = self
            .comments_source()
            .and_then(|d| Some((d, received(d).get(ix)?)))
        else {
            return div().into_any_element();
        };
        let id = c.id.clone();
        let tag = format!("{}-{}", d.key.tag(), c.id);
        let group = SharedString::from(format!("comment-row-{id}"));
        let selected = self.comments.selected.as_ref() == Some(&c.id);
        let author = c
            .author
            .as_deref()
            .map_or_else(|| "You".into(), |a| self.chat_name(a));
        let state = (!c.open()).then(|| match &c.resolved_by {
            Some(by) => format!("Resolved by {}", self.chat_name(by)),
            None => "Resolved".into(),
        });
        let copy = {
            let id = id.clone();
            let key = d.key.clone();
            ui::icon_action(
                SharedString::from(format!("comment-copy-{id}")),
                "Copy comment",
                ui::IconRole::Copy,
                Action::Quiet,
            )
            .opacity(0.)
            .group_hover(group.clone(), |s| s.opacity(1.))
            .focus_visible(|s| s.opacity(1.))
            .on_click(cx.listener(move |v, _, _, cx| {
                if let Some(c) = v
                    .comments_source()
                    .filter(|d| d.key == key)
                    .and_then(|d| received(d).iter().find(|c| c.id == id))
                {
                    cx.write_to_clipboard(ClipboardItem::new_string(c.text.clone()));
                }
            }))
        };
        let card = div()
            .group(group)
            .v_flex()
            .w_full()
            .min_w_0()
            .gap(px(Space::META))
            .p(px(Space::SIDEBAR))
            .rounded(px(ui::Radius::ROW))
            .when(selected, |d| d.bg(ui::selected_fill(cx)))
            .child(
                div()
                    .h_flex()
                    .w_full()
                    .min_w_0()
                    .items_center()
                    .gap(px(Space::CONTROL))
                    .child(
                        ui::text(Text::Label, SharedString::from(author))
                            .font_semibold()
                            .flex_none(),
                    )
                    .child(
                        ui::text(Text::Caption, SharedString::from(self.comment_meta(d, c)))
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(cx.theme().muted_foreground),
                    )
                    .children(state.map(|s| {
                        ui::text(Text::Caption, SharedString::from(s))
                            .id(SharedString::from(format!("comment-state-{id}")))
                            .test_support()
                            .flex_none()
                            .text_color(cx.theme().muted_foreground)
                    }))
                    .child(copy),
            )
            .children(c.anchor.as_ref().map(|a| {
                div()
                    .w_full()
                    .min_w_0()
                    .pl(px(Space::CONTROL))
                    .border_l_2()
                    .border_color(cx.theme().border)
                    .italic()
                    .child(self.comment_text(
                        format!("comment-quote-{tag}"),
                        a,
                        Text::Caption,
                        true,
                        cx,
                    ))
            }))
            .child(self.comment_text(
                format!("comment-body-{tag}"),
                if c.text.is_empty() {
                    "(Empty comment)"
                } else {
                    &c.text
                },
                Text::Body,
                !c.open(),
                cx,
            ));
        div()
            .id(SharedString::from(format!("comment-{id}")))
            .test_support()
            .w_full()
            .flex()
            .justify_center()
            .pb(px(if ix + 1 == self.comments.ids.len() {
                Space::HOME
            } else {
                Space::META
            }))
            // The page's reading column: text lines up with the header's.
            .child(
                div()
                    .w_full()
                    .min_w_0()
                    .max_w(px(760.))
                    .px(px(Space::HOME - Space::SIDEBAR))
                    .child(card),
            )
            .into_any_element()
    }
    /// A Needs you comment: its author and first line; opens it in Comments.
    pub(super) fn needs_comment_row(&self, c: &Comment, cx: &Context<Self>) -> AnyElement {
        let generation = self.generation;
        let id = c.id.clone();
        let author = c
            .author
            .as_deref()
            .map_or_else(|| "You".into(), |a| self.chat_name(a));
        let line = c
            .text
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("(Empty comment)")
            .to_owned();
        ui::action(
            SharedString::from(format!("mission-needs-comment-{id}")),
            "",
            Action::Quiet,
        )
        .w_full()
        .justify_start()
        .disabled(!self.can_read_comments(generation))
        .accessibility_label(SharedString::from(format!(
            "Comment from {author}: {line}. Read in Comments"
        )))
        .child(
            div()
                .h_flex()
                .w_full()
                .min_w_0()
                .items_center()
                .gap(px(Space::CONTROL))
                .child(crate::app_icon::AppIcon::Info.inline())
                .child(
                    ui::text(Text::Body, SharedString::from(author))
                        .flex_none()
                        .text_left(),
                )
                .child(
                    ui::text(Text::Caption, SharedString::from(line))
                        .flex_1()
                        .min_w_0()
                        .text_left()
                        .truncate()
                        .text_color(cx.theme().muted_foreground),
                ),
        )
        .on_click(
            cx.listener(move |v, _, w, cx| v.reveal_comment(Some(id.clone()), generation, w, cx)),
        )
        .into_any_element()
    }
    /// The overview's Comments line: open count and the way into the page.
    pub(super) fn comments_line(&self, d: &Detail, cx: &Context<Self>) -> impl IntoElement {
        let generation = self.generation;
        let count = match &d.comments {
            Err(_) => "Unavailable".to_owned(),
            Ok(None) => "Not included".to_owned(),
            Ok(Some(c)) => match c.iter().filter(|c| c.open()).count() {
                0 => "None open".to_owned(),
                n => format!("{n} open"),
            },
        };
        div()
            .h_flex()
            .items_center()
            .gap_2()
            // A marked sibling draft keeps its preedit: refuse before the button takes focus.
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if v.brief_marked(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(div().flex_1().min_w_0().child(ui::heading(
                "mission-comments-heading",
                "Comments",
                Text::Headline,
            )))
            .child(
                ui::text(Text::Caption, SharedString::from(count))
                    .id("mission-comments-count")
                    .test_support()
                    .text_color(cx.theme().muted_foreground),
            )
            .child(
                ui::action("mission-comments-open", "Read comments", Action::Secondary)
                    .disabled(!self.can_read_comments(generation))
                    .on_click(
                        cx.listener(move |v, _, w, cx| v.reveal_comment(None, generation, w, cx)),
                    ),
            )
    }
    pub(super) fn comments_page(&self, cx: &Context<Self>) -> AnyElement {
        let generation = self.generation;
        let d = self.comments_source();
        let mut header = ui::page()
            .flex_none()
            .gap(px(Space::CONTROL))
            .pb(px(Space::CONTROL))
            .child(
                div()
                    .h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(
                        ui::action("comments-back", "Back to mission", Action::Quiet)
                            .icon(crate::app_icon::AppIcon::Back.asset())
                            .on_click(cx.listener(|v, _, w, cx| {
                                if !v.brief_marked(w, cx) {
                                    v.close_comments(w, cx);
                                }
                            })),
                    )
                    .child(
                        ui::icon_action(
                            "comments-refresh",
                            "Refresh",
                            crate::app_icon::AppIcon::Retry,
                            Action::Quiet,
                        )
                        .disabled(self.options.is_none() || self.busy)
                        .on_click(cx.listener(move |v, _, w, cx| {
                            if v.generation == generation {
                                v.read(w, cx);
                            }
                        })),
                    ),
            )
            .child(
                div()
                    .v_flex()
                    .gap(px(Space::META))
                    .child(ui::heading("comments-heading", "Comments", Text::Title))
                    .children(d.map(|d| {
                        ui::text(Text::Body, SharedString::from(d.title.clone()))
                            .text_color(cx.theme().muted_foreground)
                    })),
            );
        // As on the overview: what's shown is the last received snapshot.
        header = header.children(self.snapshot_note().map(|note| {
            ui::text(Text::Caption, note)
                .id("comments-stale")
                .test_support()
                .text_color(cx.theme().muted_foreground)
        }));
        if let Some(e) = self.error {
            header = header.child(
                div()
                    .id("comments-read-error")
                    .test_support()
                    .child(Notice::new(e).tone(Tone::Error)),
            );
        }
        let mut page = div()
            .id("mission-comments-page")
            .test_support()
            .track_focus(&self.focus)
            .size_full()
            .min_w_0()
            .min_h_0()
            .v_flex()
            .on_key_down(cx.listener(|v, e: &KeyDownEvent, _, cx| v.comments_key(e, cx)))
            .on_action(cx.listener(|v, _: &gpui_kit::base::input::Copy, w, cx| {
                let text = gpui_kit::base::TextSelection::selected_text(w, cx);
                let text = if text.is_empty() {
                    let Some(c) = v.comments_source().and_then(|d| {
                        received(d)
                            .iter()
                            .find(|c| Some(&c.id) == v.comments.selected.as_ref())
                    }) else {
                        cx.propagate();
                        return;
                    };
                    c.text.clone()
                } else {
                    text.to_string()
                };
                cx.write_to_clipboard(ClipboardItem::new_string(text));
            }));
        let notice = |id: &'static str, text: &'static str, tone: Tone| {
            div()
                .id(id)
                .test_support()
                .child(Notice::new(text).tone(tone))
        };
        match d.map(|d| &d.comments) {
            None => {
                header = header.child(notice(
                    "comments-unavailable",
                    "This mission isn't loaded. Go back and refresh it.",
                    Tone::Warning,
                ))
            }
            Some(Err(e)) => header = header.child(notice("comments-error", e, Tone::Error)),
            Some(Ok(None)) => {
                header = header.child(notice(
                    "comments-unknown",
                    "This response doesn't include comments, so there may be some.",
                    Tone::Warning,
                ))
            }
            Some(Ok(Some(c))) if c.is_empty() => {
                header = header.child(notice("comments-empty", "No comments.", Tone::Normal))
            }
            Some(Ok(Some(c))) => {
                let open = c.iter().filter(|c| c.open()).count();
                let resolved = c.len() - open;
                let mut coverage = format!("{open} open");
                if resolved > 0 {
                    coverage.push_str(&format!(" · {resolved} recently resolved"));
                }
                header = header.child(
                    ui::text(Text::Caption, SharedString::from(coverage))
                        .id("comments-coverage")
                        .test_support()
                        .text_color(cx.theme().muted_foreground),
                );
            }
        }
        page = page.child(header);
        if d.is_some_and(|d| !received(d).is_empty()) {
            page = page.child(
                div()
                    .id("mission-comments-list")
                    .test_support()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .child(
                        list(
                            self.comments.list.clone(),
                            cx.processor(|v, ix, _, cx| v.comment_item(ix, cx)),
                        )
                        .size_full(),
                    ),
            );
        }
        page.into_any_element()
    }
}

#[cfg(feature = "native-probes")]
#[path = "mission_comments_probe.rs"]
pub(crate) mod probe;

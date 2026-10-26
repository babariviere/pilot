//! Read-first brief workspace. Retained drafts/ACKs belong to exact sources, not tabs.
use crate::{
    LocalOptions,
    mission_brief::{self as model, Book, Outcome, Source},
    mission_brief_reader::{self as wire, Data, Kind, Reader, Request},
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, AppContext, ClipboardItem, Context, Entity, EntityInputHandler, EventEmitter, FocusHandle,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, TestSupportExt, Window,
    base::SelectableText,
    component::{
        ActiveTheme, Disableable, StyledExt,
        input::{InputEvent, Textarea, TextareaState},
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::{cell::Cell, rc::Rc, sync::Arc};
gpui_kit::actions!(mission_brief, [SaveBrief, CloseBrief]);
struct Keys;
impl gpui_kit::Global for Keys {}
#[derive(Clone)]
pub(crate) enum Event {
    Close,
}
pub(crate) struct Workspace {
    pub(crate) book: Book,
    pub(crate) source: Option<Source>,
    pub(crate) visible: bool,
    pub(crate) busy: bool,
    pub(crate) editing: bool,
    pub(crate) read_error: Option<&'static str>,
    pub(crate) edit_error: Option<&'static str>,
    pub(crate) input: Entity<TextareaState>,
    input_owner: Option<Source>,
    input_bounds: Rc<Cell<Option<gpui_kit::Bounds<gpui_kit::Pixels>>>>,
    title: SharedString,
    online: bool,
    pub(crate) history: Option<Vec<model::Revision>>,
    pub(crate) viewing: Option<Arc<model::Brief>>,
    history_open: bool,
    generation: u64,
    view_epoch: u64,
    request: Option<Request>,
    options: LocalOptions,
    reader: Option<Reader>,
    lane: u64,
    reads: Option<Task<()>>,
    saves: Option<Task<()>>,
    reads_closed: bool,
    saves_closed: bool,
    focus: FocusHandle,
    scroll: gpui_kit::ScrollHandle,
    _input: Subscription,
}
impl EventEmitter<Event> for Workspace {}
impl Workspace {
    pub(crate) fn new(options: LocalOptions, w: &mut Window, cx: &mut Context<Self>) -> Self {
        if !cx.has_global::<Keys>() {
            cx.bind_keys([
                gpui_kit::KeyBinding::new("secondary-s", SaveBrief, Some("MissionBrief")),
                gpui_kit::KeyBinding::new("escape", CloseBrief, Some("MissionBrief")),
            ]);
            cx.set_global(Keys);
        }
        let input = cx.new(|cx| {
            let mut s = TextareaState::new(w, cx)
                .placeholder("Mission brief Markdown")
                .auto_grow(8, 20);
            s.set_submit_on_enter(false, cx);
            s
        });
        let changed = cx.subscribe_in(&input, w, |v, _, event, w, cx| {
            if matches!(event, InputEvent::Change) {
                if let Some(source) = &v.input_owner
                    && let Some(e) = v.book.get_mut(source)
                {
                    let value=v.input.read(cx).value();
                    if value.len()>model::EDIT_BYTES {
                        if let Some(draft)=&e.draft {
                            let prior=draft.text.clone();let range=v.input.read(cx).selected_range();
                            v.input.update(cx,|input,cx|{input.set_value(prior.to_string(),w,cx);input.set_selected_range(range.start.min(prior.len())..range.end.min(prior.len()),cx);});
                        }
                        v.edit_error=Some("That edit exceeds 64 KiB and was rejected in full. The previous draft is retained; the editor undo history was reset at the limit.");
                    } else if e.draft.as_ref().is_none_or(|d|d.text.as_ref()!=value.as_ref()) {
                        // Queued Change events can observe the restored value.
                        // Only a new valid edit clears the atomic-rejection notice.
                        v.edit_error = e.change(value.as_ref()).err();
                    }
                }
                cx.notify();
            }
        });
        Self {
            book: Book::default(),
            source: None,
            visible: false,
            busy: false,
            editing: false,
            read_error: None,
            edit_error: None,
            input,
            input_owner: None,
            input_bounds: Rc::new(Cell::new(None)),
            title: "Brief".into(),
            online: false,
            history: None,
            viewing: None,
            history_open: false,
            generation: 0,
            view_epoch: 0,
            request: None,
            options,
            reader: None,
            lane: 0,
            reads: None,
            saves: None,
            reads_closed: false,
            saves_closed: false,
            focus: cx.focus_handle().tab_stop(true),
            scroll: Default::default(),
            _input: changed,
        }
    }
    pub(crate) fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.editing
            && self
                .input
                .update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
    }
    pub(crate) fn matches_options(&self, options: &LocalOptions) -> bool {
        self.options.host() == options.host() && self.options.loopback() == options.loopback()
    }
    pub(crate) fn owns_focus(&self, w: &Window, cx: &App) -> bool {
        self.focus.contains_focused(w, cx)
    }
    pub(crate) fn show(
        &mut self,
        source: Source,
        title: SharedString,
        online: bool,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.marked(w, cx) {
            return false;
        }
        if let Err(e) = self.book.ensure(&source) {
            self.edit_error = Some(e);
            cx.notify();
            return false;
        }
        if self.source.as_ref() != Some(&source) {
            self.cancel_read();
            self.history = None;
            self.viewing = None;
            self.history_open = false;
            self.editing = false;
            self.read_error = None;
            self.edit_error = None;
            self.scroll.set_offset(gpui_kit::point(px(0.), px(0.)));
        }
        self.source = Some(source);
        self.title = title;
        self.online = online;
        self.visible = true;
        self.view_epoch = self.view_epoch.saturating_add(1);
        self.focus.focus(w, cx);
        self.fetch(Kind::Current, w, cx);
        true
    }
    pub(crate) fn sync(&mut self, source: Option<&Source>, online: bool, cx: &mut Context<Self>) {
        if !self.visible {
            return;
        }
        if source != self.source.as_ref() {
            self.hide(cx);
            return;
        }
        if online != self.online {
            self.online = online;
            self.cancel_read();
            if !online {
                self.read_error = Some(
                    "Local is unavailable. Retained brief and drafts are not a current server snapshot.",
                );
            }
            cx.notify();
        }
    }
    pub(crate) fn hide(&mut self, cx: &mut Context<Self>) {
        self.view_epoch = self.view_epoch.saturating_add(1);
        self.visible = false;
        self.cancel_read();
        cx.notify();
    }
    fn cancel_read(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.request = None;
        self.busy = false;
        if let Some(r) = &self.reader {
            let _ = r.read(None);
        }
    }
    fn start(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.reader.is_some() {
            return true;
        }
        let (reader, updates) = match Reader::start(self.options.clone()) {
            Ok(r) => r,
            Err(e) => {
                self.read_error = Some(e);
                return false;
            }
        };
        self.lane = self.lane.saturating_add(1);
        let lane = self.lane;
        self.reads_closed = false;
        self.saves_closed = false;
        let read = updates.reads;
        let save = updates.saves;
        self.reader = Some(reader);
        self.reads = Some(cx.spawn_in(w, async move |v, cx| {
            while let Ok(r) = read.recv().await {
                if v.update_in(cx, |v, w, cx| v.accept_read(r, w, cx)).is_err() {
                    return;
                }
            }
            let _ = v.update(cx, |v, cx| v.closed(lane, false, cx));
        }));
        self.saves = Some(cx.spawn_in(w, async move |v, cx| {
            while let Ok(r) = save.recv().await {
                if v.update_in(cx, |v, w, cx| v.accept_save(r, w, cx)).is_err() {
                    return;
                }
            }
            let _ = v.update(cx, |v, cx| v.closed(lane, true, cx));
        }));
        true
    }
    fn closed(&mut self, lane: u64, saves: bool, cx: &mut Context<Self>) {
        if lane != self.lane {
            return;
        }
        if saves {
            self.saves_closed = true;
        } else {
            self.reads_closed = true;
        }
        // Drain the non-coalesced ACK lane before retiring any pending attempt.
        if self.reads_closed && self.saves_closed {
            self.book.stopped();
            self.reader = None;
            self.busy = false;
            self.request = None;
            self.read_error.get_or_insert("Brief worker stopped. Refresh explicitly; an unconfirmed save is not safe to replay automatically.");
        }
        cx.notify();
    }
    fn fetch(&mut self, kind: Kind, w: &mut Window, cx: &mut Context<Self>) {
        if !self.visible || !self.online || self.marked(w, cx) {
            return;
        }
        let Some(source) = self.source.clone() else {
            return;
        };
        if matches!(kind, Kind::Revision(_)) {
            self.editing = false;
            self.focus.focus(w, cx);
        }
        if !self.start(w, cx) {
            cx.notify();
            return;
        }
        self.generation = self.generation.saturating_add(1);
        let request = Request {
            source,
            generation: self.generation,
            kind,
        };
        self.busy = self
            .reader
            .as_ref()
            .is_some_and(|r| r.read(Some(request.clone())));
        self.read_error = if self.busy {
            None
        } else {
            Some("Brief read could not be queued. Refresh explicitly.")
        };
        self.request = Some(request);
        cx.notify();
    }
    fn accept_read(&mut self, response: wire::Response, _w: &mut Window, cx: &mut Context<Self>) {
        if !self.visible
            || !self.online
            || self.request.as_ref() != Some(&response.request)
            || self.source.as_ref() != Some(&response.request.source)
        {
            return;
        }
        self.busy = false;
        match response.result {
            Err(e) => self.read_error = Some(e),
            Ok(Data::Current(c)) => {
                if let Some(e) = self.book.get_mut(&c.source) {
                    e.receive(c);
                }
                self.viewing = None;
                self.read_error = None;
            }
            Ok(Data::History(rows)) => {
                self.history = Some(rows);
                self.read_error = None;
            }
            Ok(Data::Revision(brief)) => {
                self.viewing = Some(brief);
                self.read_error = None;
            }
        }
        cx.notify();
    }
    fn accept_save(&mut self, response: wire::Saved, w: &mut Window, cx: &mut Context<Self>) {
        let source = response.save.source.clone();
        let accepted = self.book.finish(&response.save, response.outcome);
        // ACK attribution is independent of active source/read generation. Input
        // restoration still needs the original owner, no newer edit and no preedit.
        if accepted
            && self.visible
            && self.editing
            && self.source.as_ref() == Some(&source)
            && self.input_owner.as_ref() == Some(&source)
            && !self.marked(w, cx)
            && let Some(e) = self.book.get(&source)
            && e.confirmed_current_edit()
            && let Some(d) = &e.draft
            && !d.dirty()
        {
            let text = d.text.clone();
            self.input
                .update(cx, |i, cx| i.set_value(text.to_string(), w, cx));
            self.editing = false;
            self.focus.focus(w, cx);
        }
        cx.notify();
    }
    fn edit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        let Some(s) = self.source.clone() else {
            return;
        };
        let Some(e) = self.book.get_mut(&s) else {
            return;
        };
        if let Err(err) = e.edit() {
            self.edit_error = Some(err);
            cx.notify();
            return;
        }
        let text = e.draft.as_ref().map(|d| d.text.clone()).unwrap_or_default();
        self.input_owner = Some(s);
        self.viewing = None;
        self.input
            .update(cx, |i, cx| i.set_value(text.to_string(), w, cx));
        self.editing = true;
        self.edit_error = None;
        self.input.update(cx, |i, cx| i.focus(w, cx));
        cx.notify();
    }
    fn save(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.visible || !self.online || !self.editing || self.marked(w, cx) {
            return;
        }
        let Some(source) = self.source.clone() else {
            return;
        };
        if self.input_owner.as_ref() != Some(&source) {
            return;
        }
        let text = self.input.read(cx).value().to_string();
        if let Some(e) = self.book.get_mut(&source)
            && let Err(e) = e.change(&text)
        {
            self.edit_error = Some(e);
            cx.notify();
            return;
        }
        if !self.start(w, cx) {
            cx.notify();
            return;
        }
        match self.book.begin(&source) {
            Err(e) => self.edit_error = Some(e),
            Ok(save) => {
                self.edit_error = None;
                if !self.reader.as_ref().is_some_and(|r| r.save(save.clone())) {
                    self.book.finish(
                        &save,
                        Outcome::Rejected("Save could not be queued. No save was dispatched."),
                    );
                }
            }
        }
        cx.notify();
    }
    fn close(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.visible && !self.marked(w, cx) {
            cx.emit(Event::Close);
        }
    }
    fn click<F>(
        &self,
        cx: &Context<Self>,
        callback: F,
    ) -> impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static
    where
        F: Fn(&mut Self, &gpui_kit::ClickEvent, &mut Window, &mut Context<Self>) + 'static,
    {
        let source = self.source.clone();
        let epoch = self.view_epoch;
        cx.listener(move |v, event, w, cx| {
            if v.visible && v.source == source && v.view_epoch == epoch {
                callback(v, event, w, cx);
            }
        })
    }
    fn plain(id: &'static str, text: SharedString) -> impl IntoElement {
        div()
            .id(id)
            .test_support()
            .min_w_0()
            .w_full()
            .child(SelectableText::new(id, text))
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn disconnect_fixture(&self) {
        if let Some(r) = &self.reader {
            r.disconnect_fixture();
        }
    }
}
impl Render for Workspace {
    fn render(&mut self, _w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.input_bounds.set(None);
        let bounds_cell = self.input_bounds.clone();
        let editor_bounds = gpui_kit::canvas(
            |_, _, _| (),
            move |bounds, (), _, _| bounds_cell.set(Some(bounds)),
        )
        .absolute()
        .inset_0()
        .size_full();
        let weak = cx.weak_entity();
        // Paint-scoped listener, cleared by GPUI next frame. It also covers the
        // sibling sidebar before a button's mouse-down can blur native preedit.
        let pointer_fence = gpui_kit::canvas(
            |_, _, _| (),
            move |_, (), w, _cx| {
                w.on_mouse_event(move |event: &gpui_kit::MouseDownEvent, phase, w, cx| {
                    if phase == gpui_kit::DispatchPhase::Capture
                        && weak
                            .update(cx, |v, cx| {
                                v.visible
                                    && v.input_bounds
                                        .get()
                                        .is_none_or(|b| !b.contains(&event.position))
                                    && v.marked(w, cx)
                            })
                            .unwrap_or(false)
                    {
                        cx.stop_propagation();
                    }
                });
            },
        )
        .absolute()
        .inset_0()
        .size_full();
        let source = self.source.clone();
        let e = source.as_ref().and_then(|s| self.book.get(s));
        let pending = e.is_some_and(|e| e.pending());
        let save_ready = self.online
            && !self.book.entries.iter().any(|e| e.pending())
            && e.is_some_and(|e| {
                e.draft.as_ref().is_some_and(|d| {
                    d.reviewed()
                        && d.text.len() <= model::EDIT_BYTES
                        && e.current.as_ref().is_some_and(|c| c.number() <= d.base)
                }) && e.unconfirmed.len()
                    + usize::from(
                        e.attempt
                            .as_ref()
                            .is_some_and(|a| matches!(a.outcome, Outcome::Unknown(_))),
                    )
                    < 4
            });
        let dirty = e.and_then(|e| e.draft.as_ref()).is_some_and(|d| d.dirty());
        let editable = e.is_some_and(|e| {
            e.draft.is_some()
                || e.current
                    .as_ref()
                    .is_some_and(|c| c.text().len() <= model::EDIT_BYTES)
        });
        let brief = self.viewing.clone().or_else(|| {
            e.and_then(|e| e.current.as_ref())
                .and_then(|c| c.brief.clone())
        });
        let empty = e
            .and_then(|e| e.current.as_ref())
            .is_some_and(|c| c.brief.is_none());
        let recovery = e.is_some_and(|e| {
            e.attempt
                .as_ref()
                .is_some_and(|a| matches!(a.outcome, Outcome::Unknown(_) | Outcome::Conflict))
                || e.draft
                    .as_ref()
                    .zip(e.current.as_ref())
                    .is_some_and(|(d, c)| d.base < c.number())
                || e.draft.as_ref().is_some_and(|d| !d.reviewed())
        });
        let content_scope = SharedString::from(format!(
            "brief-content-{}-{}",
            self.source
                .as_ref()
                .map(|s| serde_json::to_string(&(
                    &s.key.home.daemon,
                    &s.key.home.lineage,
                    &s.key.id,
                    &s.project
                ))
                .unwrap_or_default())
                .unwrap_or_default(),
            self.view_epoch
        ));
        let mut page = ui::page()
            .gap_3()
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .flex_wrap()
                    .child(
                        ui::action("brief-overview", "Overview", Action::Quiet)
                            .on_click(self.click(cx, |v, _, w, cx| v.close(w, cx))),
                    )
                    .child(ui::text(Text::Title, "Brief").flex_1().min_w_0())
                    .child(
                        ui::action("brief-refresh", "Refresh latest", Action::Secondary)
                            .disabled(!self.online || self.busy)
                            .on_click(self.click(cx, |v, _, w, cx| v.fetch(Kind::Current, w, cx))),
                    ),
            )
            .child(
                ui::text(Text::Caption, self.title.clone()).text_color(cx.theme().muted_foreground),
            )
            .child(ui::text(
                Text::Small,
                if self.busy {
                    "Loading · retained text is not a fresh snapshot"
                } else if !self.online {
                    "Offline · retained text and private edits"
                } else {
                    "Local brief · explicit revision-checked Save only"
                },
            ));
        if let Some(err) = self.read_error {
            page = page.child(Notice::new(err).tone(Tone::Warning));
        }
        if let Some(err) = self.edit_error {
            page = page.child(Notice::new(err).tone(Tone::Error));
        }
        if let Some(e) = e {
            if let Some(a) = &e.attempt {
                let (note,tone)=match &a.outcome {
                    Outcome::Pending=>(format!("Saving captured draft against revision {}… New typing stays separate.",a.save.expected),Tone::Quiet),
                    Outcome::Confirmed(b)=>(format!("Save confirmed · revision {}{}",b.revision.number,if dirty{" · newer private edits retained"}else{""}),Tone::Success),
                    Outcome::Conflict=>("Save reported a revision conflict. Your draft is retained; review latest before another Save.".into(),Tone::Warning),
                    Outcome::Rejected(err)=>(format!("{err} Your draft is retained."),Tone::Error),
                    Outcome::Unknown(err)=>(format!("{err} Later reads do not confirm this save."),Tone::Warning),
                };
                page = page.child(
                    div()
                        .id("brief-save-state")
                        .test_support()
                        .child(Notice::new(SharedString::from(note)).tone(tone)),
                );
                if !matches!(a.outcome, Outcome::Confirmed(_))
                    && let Some(known) = &e.known
                    && let Outcome::Confirmed(b) = &known.outcome
                {
                    page = page.child(ui::text(
                        Text::Caption,
                        SharedString::from(format!(
                            "Last confirmed Save: revision {}",
                            b.revision.number
                        )),
                    ));
                }
            }
            if !e.unconfirmed.is_empty() {
                page=page.child(Notice::new("An earlier save still has no confirmed outcome. Choosing a new base did not settle it.").tone(Tone::Warning));
            }
            if dirty && !self.editing {
                page = page.child(Notice::new(
                    "Unsaved brief draft retained in this window. Resume editing to review it.",
                ));
            }
        }
        page = page.child(
            div()
                .h_flex()
                .gap_2()
                .items_center()
                .flex_wrap()
                .when(!self.editing, |d| {
                    d.child(
                        ui::action(
                            "brief-edit",
                            if dirty {
                                "Resume editing"
                            } else if self.viewing.is_some() {
                                "Edit current brief"
                            } else {
                                "Edit Markdown"
                            },
                            Action::Primary,
                        )
                        .disabled(!editable)
                        .on_click(self.click(cx, |v, _, w, cx| v.edit(w, cx))),
                    )
                })
                .when(self.editing, |d| {
                    d.child(
                        ui::action(
                            "brief-save",
                            if pending { "Saving…" } else { "Save" },
                            Action::Primary,
                        )
                        .disabled(!save_ready)
                        .tooltip("Save requires a reviewed base and no pending brief save. For a conflict or unknown result, refresh and explicitly choose the received latest base first.")
                        .on_click(self.click(cx, |v, _, w, cx| v.save(w, cx))),
                    )
                    .child(
                        ui::action("brief-cancel", "Cancel editing", Action::Quiet).on_click(
                            self.click(cx, |v, _, w, cx| {
                                if !v.marked(w, cx) {
                                    v.editing = false;
                                    v.focus.focus(w, cx);
                                    cx.notify();
                                }
                            }),
                        ),
                    )
                })
                .child(
                    ui::action("brief-history", "History", Action::Quiet).on_click(self.click(
                        cx,
                        |v, _, w, cx| {
                            if v.marked(w, cx) {
                                return;
                            }
                            v.history_open = !v.history_open;
                            if v.history_open && v.history.is_none() {
                                v.fetch(Kind::History, w, cx);
                            }
                            cx.notify();
                        },
                    )),
                ),
        );
        if self.editing {
            page=page.child(ui::text(Text::Caption,"Private Markdown draft · 64 KiB edit limit · retained through navigation, not app restart"))
                .child(div().id("brief-input").test_support().relative().w_full().min_w_0().child(Textarea::new(&self.input).aria_label("Mission brief Markdown")).child(editor_bounds))
                .child(div().h_flex().gap_2().flex_wrap()
                    .child(ui::action("brief-copy-draft","Copy my draft",Action::Quiet).on_click(self.click(cx,|v,_,_,cx|{cx.write_to_clipboard(ClipboardItem::new_string(v.input.read(cx).value().to_string()));})))
                    .when(recovery,|d|d.child(ui::action("brief-use-latest","Use received latest as base, keep my text",Action::Secondary).disabled(pending).on_click(self.click(cx,|v,_,w,cx|{
                        if v.marked(w,cx){return;}
                        if let Some(s)=&v.source&&let Some(e)=v.book.get_mut(s){v.edit_error=e.use_latest().err();}
                        cx.notify();
                    }))))
                    .when(dirty,|d|d.child(ui::action("brief-discard","Discard draft",Action::Quiet).disabled(pending).on_click(self.click(cx,|v,_,w,cx|{
                        if v.marked(w,cx){return;}
                        if let Some(s)=&v.source&&let Some(e)=v.book.get_mut(s){v.edit_error=e.discard().err();if v.edit_error.is_none(){v.editing=false;v.focus.focus(w,cx);}}
                        cx.notify();
                    })))));
        } else if let Some(b) = brief {
            page = page.child(ui::text(
                Text::Caption,
                SharedString::from(format!(
                    "{} revision {} · Markdown source",
                    if self.viewing.is_some() {
                        "Immutable"
                    } else {
                        "Received current"
                    },
                    b.revision.number
                )),
            ));
            let full = b.markdown.clone();
            let visible = b.visible().to_owned();
            page = page.child(
                div()
                    .h_flex()
                    .gap_2()
                    .flex_wrap()
                    .child(
                        ui::action("brief-copy-full", "Copy full received brief", Action::Quiet)
                            .on_click(self.click(cx, move |_, _, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(full.to_string()))
                            })),
                    )
                    .when(b.clipped(), |d| {
                        d.child(
                            ui::action("brief-copy-visible", "Copy visible excerpt", Action::Quiet)
                                .on_click(self.click(cx, move |_, _, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(
                                        visible.clone(),
                                    ))
                                })),
                        )
                    }),
            );
            if b.clipped() {
                page=page.child(Notice::new("Display is clipped to 32 KiB. Full received copy is separate; clipped text is never used as an edit base."));
            }
            if !b.editable() {
                page=page.child(Notice::new("Full source exceeds this native editor's 64 KiB limit. Read/copy remains available; use Swift to edit larger briefs."));
            }
            page = page.child(Self::plain(
                "brief-source",
                SharedString::from(b.visible().to_owned()),
            ));
        } else if empty {
            page=page.child(Self::plain("brief-empty","No brief revision yet. An explicit initial Save, including an empty brief, creates revision 1.".into()));
        }
        if self.history_open {
            page = page.child(
                div()
                    .h_flex()
                    .gap_2()
                    .items_center()
                    .child(ui::text(Text::Headline, "Revision history").flex_1())
                    .child(
                        ui::action("brief-refresh-history", "Refresh history", Action::Quiet)
                            .disabled(!self.online || self.busy)
                            .on_click(self.click(cx, |v, _, w, cx| v.fetch(Kind::History, w, cx))),
                    ),
            );
            if let Some(rows) = &self.history {
                page = page.child(ui::text(
                    Text::Caption,
                    SharedString::from(format!(
                        "{} immutable revisions received · no inferred pages",
                        rows.len()
                    )),
                ));
                if rows.is_empty() {
                    page = page.child(ui::text(Text::Small, "No revisions received."));
                }
                let mut list = div()
                    .id("brief-history-list")
                    .test_support()
                    .v_flex()
                    .max_h(px(240.))
                    .overflow_y_scroll();
                for r in rows {
                    let n = r.number;
                    list = list.child(
                        ui::action(
                            SharedString::from(format!("brief-revision-{n}")),
                            SharedString::from(format!("Revision {n}")),
                            Action::Quiet,
                        )
                        .w_full()
                        .on_click(self.click(cx, move |v, _, w, cx| {
                            if v.history
                                .as_ref()
                                .is_some_and(|r| r.iter().any(|r| r.number == n))
                            {
                                v.fetch(Kind::Revision(n), w, cx);
                            }
                        })),
                    );
                }
                page = page.child(list);
            }
        }
        div()
            .id("mission-brief-workspace")
            .test_support()
            .track_focus(&self.focus)
            .key_context("MissionBrief")
            .size_full()
            .relative()
            .min_w_0()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .on_action(cx.listener(|v, _: &SaveBrief, w, cx| {
                v.save(w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|v, _: &CloseBrief, w, cx| {
                v.close(w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|_, _: &gpui_kit::base::input::Copy, w, cx| {
                let text = gpui_kit::base::TextSelection::selected_text(w, cx);
                if text.is_empty() {
                    cx.propagate();
                } else {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
            }))
            .child(div().id(content_scope).min_w_0().w_full().child(page))
            .child(pointer_fence)
    }
}

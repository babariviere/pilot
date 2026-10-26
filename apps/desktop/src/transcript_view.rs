#[path = "conversation_images_view.rs"]
pub(crate) mod conversation_images_view;
use std::{collections::HashMap, time::Duration};

use gpui_kit::{
    App, AppContext, ClipboardItem, Context, Entity, EntityInputHandler, InteractiveElement,
    IntoElement, KeyBinding, ParentElement, Render, SharedString, StyleRefinement, Styled,
    Subscription, Task, Window,
    component::{
        ActiveTheme, Disableable, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::{InputEvent, Textarea, TextareaState},
        message_scroller::{MessageScrolled, MessageScroller, MessageScrollerState},
        text::{TextView, TextViewState},
    },
    div, px,
};

use crate::model::{Message, TICK_MS, Transcript};

gpui_kit::actions!(fixture, [Quit, FocusComposer]);
pub(crate) struct ArtifactOpen(pub(crate) crate::artifact_model::Reference);
impl gpui_kit::EventEmitter<ArtifactOpen> for TranscriptView {}
pub(crate) struct HistoryTop(pub(crate) u64);
impl gpui_kit::EventEmitter<HistoryTop> for TranscriptView {}
pub(crate) struct LatestRequested(pub(crate) u64);
impl gpui_kit::EventEmitter<LatestRequested> for TranscriptView {}
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct HistoryControls {
    pub(crate) limited: bool,
    pub(crate) refreshing: bool,
    pub(crate) recovery: bool,
}

type HistoryGuard = std::rc::Rc<dyn Fn(&mut Window, &mut App) -> bool>;
pub struct TranscriptView {
    transcript: Transcript,
    images: conversation_images_view::Preview,
    // The whole proof is bounded to 128 rows. A2 must evaluate a bounded cache
    // for real histories rather than retaining one parser per historical row.
    text_states: Vec<Option<Entity<TextViewState>>>,
    scroller: Entity<MessageScrollerState>,
    composer: Entity<TextareaState>,
    _subscriptions: Vec<Subscription>,
    stream_task: Option<Task<()>>,
    readonly: bool,
    history_scope: u64,
    history_controls: HistoryControls,
    history_guard: Option<HistoryGuard>,
    history_slack: gpui_kit::Pixels,
    text_subscriptions: HashMap<u64, Subscription>,
    work_ui: crate::work_view::WorkUi,
    #[cfg(feature = "native-probes")]
    render_count: u64,
}

impl TranscriptView {
    /// Cheap Arc-backed capture of the mounted, bounded reader window.
    pub(crate) fn link_snapshot_rows(&self) -> Vec<Message> {
        self.transcript.messages().to_vec()
    }

    /// Readiness probe for the bounded offscreen harness, not a render-time gate.
    pub fn text_parsers_ready(&self, cx: &App) -> bool {
        self.work_ui.parsers_ready(cx)
            && self
                .transcript
                .messages()
                .iter()
                .zip(&self.text_states)
                .all(|(row, state)| {
                    state.as_ref().is_none_or(|state| {
                        state.read(cx).rendered_text().source() == row.display_source()
                    })
                })
    }

    pub fn bind_keys(cx: &mut App) {
        cx.bind_keys([
            KeyBinding::new("secondary-q", Quit, None),
            KeyBinding::new("secondary-l", FocusComposer, None),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
    }

    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::with_fixture(None, window, cx)
    }

    pub fn with_fixture(
        extra: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self::build(extra, false, window, cx)
    }

    pub(crate) fn readonly(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(None, true, window, cx)
    }

    fn build(
        extra: Option<String>,
        readonly: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut transcript = if readonly {
            Transcript::readonly()
        } else {
            Transcript::new()
        };
        if let Some(source) = extra {
            transcript.extra_fixture(source);
        }
        let scroller = cx.new(|cx| MessageScrollerState::new(transcript.messages().len(), cx));
        let composer = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx)
                .placeholder("Type here. Nothing leaves this window.")
                .auto_grow(2, 6);
            state.set_submit_on_enter(true, cx);
            state
        });
        let image_release = cx.on_release(|view, cx| view.clear_image(cx));
        let subscription =
            cx.subscribe_in(
                &composer,
                window,
                |this, _, event, window, cx| match event {
                    InputEvent::PressEnter { shift: false, .. } => this.submit(window, cx),
                    InputEvent::Change => cx.notify(),
                    _ => {}
                },
            );
        let scroll_subscription = cx.observe(&scroller, |_, _, cx| cx.notify());
        let fonts_subscription =
            cx.observe_global::<crate::typography::CommittedFonts>(|view, cx| {
                let count = view.transcript.messages().len();
                view.scroller.update(cx, |state, cx| {
                    state.remeasure_items(0..count, cx);
                });
                cx.notify();
            });
        let history_scroll = cx.subscribe(&scroller, |view, state, _: &MessageScrolled, cx| {
            if state.read(cx).is_following_tail() && view.history_slack > px(0.) {
                view.history_slack = px(0.);
                cx.notify();
            }
            if view.readonly && !state.read(cx).is_following_tail() && view.at_history_top(cx) {
                cx.emit(HistoryTop(view.history_scope));
            }
        });
        let mut view = Self {
            transcript,
            images: Default::default(),
            text_states: Vec::new(),
            scroller,
            composer,
            _subscriptions: vec![
                subscription,
                image_release,
                scroll_subscription,
                history_scroll,
                fonts_subscription,
            ],
            stream_task: None,
            readonly,
            history_scope: 0,
            history_controls: HistoryControls::default(),
            history_guard: None,
            history_slack: px(0.),
            text_subscriptions: HashMap::new(),
            work_ui: Default::default(),
            #[cfg(feature = "native-probes")]
            render_count: 0,
        };
        view.text_states = (0..view.transcript.messages().len())
            .map(|ix| view.create_text_state(ix, cx))
            .collect();
        if !readonly {
            view.composer
                .update(cx, |state, cx| state.focus(window, cx));
        }
        view
    }

    fn create_text_state(
        &mut self,
        ix: usize,
        cx: &mut Context<Self>,
    ) -> Option<Entity<TextViewState>> {
        let row = &self.transcript.messages()[ix];
        if row.work_data().is_some() || row.artifact_data().is_some() || row.image_data().is_some()
        {
            return None;
        }
        // User input is not Markdown: a typed image URL cannot trigger a fetch.
        if row.label().starts_with("You") && !self.readonly {
            return None;
        }
        let id = row.id();
        let text = cx.new(|cx| {
            let state = if row.is_plain() {
                TextViewState::html(row.display_source(), cx)
            } else {
                TextViewState::markdown(row.source(), cx)
            };
            state
                .images_enabled(!self.readonly)
                .retain_selection_on_unmount(true, cx)
        });
        self.text_subscriptions.insert(
            id,
            cx.observe(&text, move |this, _, cx| {
                if let Some(ix) = this
                    .transcript
                    .messages()
                    .iter()
                    .position(|row| row.id() == id)
                {
                    this.scroller.update(cx, |state, cx| {
                        state.remeasure_items(ix..ix + 1, cx);
                    });
                }
            }),
        );
        Some(text)
    }

    pub(crate) fn replace_readonly(
        &mut self,
        rows: Vec<Message>,
        reset: bool,
        cx: &mut Context<Self>,
    ) {
        assert!(self.readonly);
        if reset
            || self
                .images
                .selected_id_source_missing(&rows, self.history_scope)
        {
            self.clear_image(cx);
        }
        if reset {
            self.history_slack = px(0.);
        }
        if !reset && self.transcript.messages() == rows.as_slice() {
            return;
        }
        let old = self.transcript.messages();
        let old_ids: Vec<_> = old.iter().map(Message::id).collect();
        let new_ids: Vec<_> = rows.iter().map(Message::id).collect();
        let mut retained: HashMap<_, _> = old
            .iter()
            .cloned()
            .zip(self.text_states.drain(..))
            .map(|(row, state)| (row.id(), (row, state)))
            .collect();
        if reset {
            retained.clear();
            self.text_subscriptions.clear();
        }
        self.transcript.replace_readonly(rows);
        let adopted = retained
            .iter()
            .filter_map(|(id, (row, state))| {
                state
                    .as_ref()
                    .filter(|state| state.read(cx).selected_source_range().is_some())
                    .map(|state| (*id, (state.clone(), row.shared_source())))
            })
            .collect();
        self.work_ui.sync(
            self.transcript
                .messages()
                .iter()
                .filter_map(|row| row.work_data().cloned())
                .collect(),
            reset,
            &adopted,
            cx,
        );
        for ix in 0..self.transcript.messages().len() {
            let row = &self.transcript.messages()[ix];
            let state = if row.work_data().is_some()
                || row.artifact_data().is_some()
                || row.image_data().is_some()
            {
                self.text_subscriptions.remove(&row.id());
                None
            } else if let Some((old, state)) = retained.remove(&row.id()) {
                if state.is_none() {
                    self.create_text_state(ix, cx)
                } else {
                    if old.source() != row.source() {
                        if let Some(text) = &state {
                            text.update(cx, |state, cx| state.set_text(row.display_source(), cx));
                        }
                        self.scroller.update(cx, |state, cx| {
                            state.remeasure_items(ix..ix + 1, cx);
                        });
                    }
                    state
                }
            } else {
                self.create_text_state(ix, cx)
            };
            self.text_states.push(state);
        }
        self.text_subscriptions.retain(|id, _| new_ids.contains(id));
        self.scroller.update(cx, |state, cx| {
            if reset {
                state.reset(new_ids.len(), cx);
            } else if old_ids != new_ids {
                let prefix = old_ids
                    .iter()
                    .zip(&new_ids)
                    .take_while(|(a, b)| a == b)
                    .count();
                let suffix = old_ids[prefix..]
                    .iter()
                    .rev()
                    .zip(new_ids[prefix..].iter().rev())
                    .take_while(|(a, b)| a == b)
                    .count();
                state.splice(
                    prefix..old_ids.len() - suffix,
                    new_ids.len() - prefix - suffix,
                    cx,
                );
            }
        });
        cx.notify();
    }

    pub(crate) fn latest(&mut self, cx: &mut Context<Self>) {
        self.history_slack = px(0.);
        self.scroller
            .update(cx, |state, cx| state.scroll_to_end(cx));
        cx.notify();
    }
    pub(crate) fn set_history_controls(&mut self, value: HistoryControls, cx: &mut Context<Self>) {
        if self.history_controls != value {
            self.history_controls = value;
            cx.notify();
        }
    }
    pub(crate) fn set_history_guard(
        &mut self,
        guard: impl Fn(&mut Window, &mut App) -> bool + 'static,
    ) {
        self.history_guard = Some(std::rc::Rc::new(guard));
    }
    pub(crate) fn reading_mark(&self, cx: &App) -> Option<crate::navigation::ReadingMark> {
        let s = self.scroller.read(cx);
        let top = s.logical_scroll_top();
        self.transcript
            .messages()
            .get(top.item_ix)
            .map(|m| crate::navigation::ReadingMark {
                message: m.reader_key(),
                offset: f32::from(top.offset_in_item),
                following: s.is_following_tail(),
            })
    }
    pub(crate) fn restore_reading(
        &mut self,
        mark: crate::navigation::ReadingMark,
        cx: &mut Context<Self>,
    ) -> bool {
        if mark.following {
            self.latest(cx);
            return true;
        }
        let Some(key) = mark.message else {
            return false;
        };
        // Missing or ambiguous projection identities never choose another row.
        let Some(ix) = crate::model::reader_index(self.transcript.messages(), &key) else {
            return false;
        };
        let offset = if mark.offset.is_finite() {
            mark.offset.clamp(0., 1_000_000.)
        } else {
            0.
        };
        self.scroller
            .update(cx, |s, cx| s.restore_anchor(ix, px(offset), cx))
    }

    pub(crate) fn history_scope(&mut self, generation: u64) {
        if self.history_scope != generation {
            self.history_slack = px(0.);
        }
        self.history_scope = generation;
    }
    fn at_history_top(&self, cx: &App) -> bool {
        let state = self.scroller.read(cx);
        let top = state.logical_scroll_top();
        state.item_count() > 0 && top.item_ix == 0 && top.offset_in_item <= px(1.)
    }
    pub(crate) fn hold_for_history(&mut self, cx: &mut Context<Self>) {
        if self.history_slack == px(0.) {
            self.history_slack = self.scroller.read(cx).unused_tail_space();
        }
        self.scroller
            .update(cx, |state, cx| state.hold_for_disclosure(cx));
        cx.notify();
    }
    pub(crate) fn history_scrollbar_released(&mut self, cx: &mut Context<Self>) {
        if !self.readonly || !self.scroller.read(cx).dragging_scrollbar_at_start() {
            return;
        }
        let scope = self.history_scope;
        let view = cx.weak_entity();
        // Run after the scrollbar's own final offset/end-drag handler. A sparse
        // unmeasured prefix must not leave its top at an arbitrary measured row.
        cx.defer(move |cx| {
            let _ = view.update(cx, |view, cx| {
                if view.history_scope != scope {
                    return;
                }
                view.scroller.update(cx, |state, cx| {
                    state.scroll_to_item(0, cx);
                });
                cx.emit(HistoryTop(scope));
            });
        });
    }

    fn append_text_states(&mut self, from: usize, cx: &mut Context<Self>) {
        for ix in from..self.transcript.messages().len() {
            let state = self.create_text_state(ix, cx);
            self.text_states.push(state);
        }
        let count = self.transcript.messages().len() - from;
        self.scroller.update(cx, |state, cx| {
            state.append(count, cx);
        });
        cx.notify();
    }

    fn prepend(&mut self, cx: &mut Context<Self>) {
        if self.readonly {
            return;
        }
        let count = self.transcript.prepend();
        let states: Vec<_> = (0..count)
            .map(|ix| self.create_text_state(ix, cx))
            .collect();
        self.text_states.splice(0..0, states);
        self.scroller.update(cx, |state, cx| {
            state.prepend(count, cx);
        });
        cx.notify();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.readonly {
            return;
        }
        // The pointer Send path must also refuse submission during marked text.
        let composing = self.composer.update(cx, |state, cx| {
            state.marked_text_range(window, cx).is_some()
        });
        if composing {
            return;
        }
        let input = self.composer.read(cx).value();
        if let Some(range) = self.transcript.submit(&input) {
            self.composer.update(cx, |state, cx| {
                state.set_value("", window, cx);
                state.focus(window, cx);
            });
            self.append_text_states(range.start, cx);
            // Sending does not steal the reading position. Latest is explicit.
            self.start_stream(cx);
        }
    }

    fn demo(&mut self, cx: &mut Context<Self>) {
        if self.readonly {
            return;
        }
        let from = self.transcript.messages().len();
        if self.transcript.demo() {
            self.append_text_states(from, cx);
            self.start_stream(cx);
        }
    }

    fn tick(&mut self, cx: &mut Context<Self>) -> bool {
        if let Some(ix) = self.transcript.tick() {
            if let Some(text) = &self.text_states[ix] {
                text.update(cx, |state, cx| {
                    state.set_text(self.transcript.messages()[ix].source(), cx)
                });
            }
            self.scroller.update(cx, |state, cx| {
                state.remeasure_items(ix..ix + 1, cx);
            });
            cx.notify();
        }
        self.transcript.is_streaming()
    }

    fn start_stream(&mut self, cx: &mut Context<Self>) {
        self.stream_task = Some(cx.spawn(async |view, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(TICK_MS))
                    .await;
                match view.update(cx, |view, cx| view.tick(cx)) {
                    Ok(true) => {}
                    _ => break,
                }
            }
        }));
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        self.stream_task = None;
        self.transcript.stop();
        cx.notify();
    }

    pub(crate) fn work_changed(
        &mut self,
        change: &crate::work_view::Change,
        cx: &mut Context<Self>,
    ) {
        use crate::{tool_presentation::Step, work_view::Change};
        if matches!(change, Change::Disclosure(_)) {
            self.scroller
                .update(cx, |state, cx| state.hold_for_disclosure(cx));
        }
        let index = self.transcript.messages().iter().position(|row| {
            row.work_data().is_some_and(|work| match change {
                Change::Group(id) => work.id == *id,
                Change::Step(id) | Change::Disclosure(id) => {
                    work.steps.iter().any(|step| match step {
                        Step::Tool(tool) => format!("call:{}", tool.id) == *id,
                        Step::Note { id: key, .. } => format!("note:{key}") == *id,
                    }) || *id == format!("group:{}", work.id)
                }
            })
        });
        if let Some(index) = index {
            self.scroller
                .update(cx, |state, cx| state.remeasure_items(index..index + 1, cx));
        }
        cx.notify();
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn disclosure_probe_step(&self, id: &str, cx: &App) -> (bool, usize) {
        self.work_ui.step_info(id, cx)
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn presentation_probe_counts(&self) -> (usize, usize) {
        (
            self.transcript.messages().len(),
            self.text_states.iter().flatten().count(),
        )
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_render_count(&self) -> u64 {
        self.render_count
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn history_probe_row(&self, id: u64) -> Entity<TextViewState> {
        let ix = self
            .transcript
            .messages()
            .iter()
            .position(|row| row.id() == id)
            .unwrap();
        self.text_states[ix].as_ref().unwrap().clone()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn history_probe_anchor(&self, cx: &App) -> (usize, f32, bool, f32) {
        let state = self.scroller.read(cx);
        let top = state.logical_scroll_top();
        (
            top.item_ix,
            f32::from(top.offset_in_item),
            state.is_following_tail(),
            f32::from(self.history_slack),
        )
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn disclosure_probe_state(
        &self,
        id: u64,
        cx: &App,
    ) -> (usize, f32, bool, bool, gpui_kit::EntityId) {
        let s = self.scroller.read(cx);
        let p = s.logical_scroll_top();
        (
            p.item_ix,
            p.offset_in_item.into(),
            s.is_following_tail(),
            self.work_ui.group_open(id, cx),
            self.work_ui.groups[&id].entity_id(),
        )
    }
    fn render_row(
        &self,
        ix: usize,
        cx: &App,
        owner: gpui_kit::WeakEntity<Self>,
    ) -> impl IntoElement + use<> {
        let row = &self.transcript.messages()[ix];
        if row.image_data().is_some() {
            return div()
                .id(("message", row.id()))
                .w_full()
                .min_w_0()
                .child(self.render_image(row, cx, owner));
        }
        if let Some(reference) = row.artifact_data() {
            let reference = (**reference).clone();
            return div()
                .id(("message", row.id()))
                .w_full()
                .min_w_0()
                .p_3()
                .border_1()
                .rounded(px(crate::appearance::Radius::CARD))
                .bg(crate::appearance::card(cx))
                .border_color(cx.theme().border)
                .child(
                    Button::new(("open-artifact", row.id()))
                        .ghost()
                        .label(SharedString::from(format!(
                            "Open {} · r{}",
                            reference.title, reference.revision
                        )))
                        .on_click(move |_, _, cx| {
                            let _ =
                                owner.update(cx, |_, cx| cx.emit(ArtifactOpen(reference.clone())));
                        }),
                );
        }
        if let Some(view) = self.work_ui.groups.get(&row.id()) {
            return div()
                .id(("message", row.id()))
                .w_full()
                .min_w_0()
                .child(view.clone());
        }
        let source = row.shared_source();
        let user = row.label().starts_with("You");
        div()
            .id(("message", row.id()))
            .v_flex()
            .rounded(px(crate::appearance::Radius::BUBBLE))
            .when(user, |this| this.bg(cx.theme().muted).p_3())
            .gap_2()
            .w_full()
            .min_w_0()
            .child(
                div()
                    .h_flex()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(SharedString::from(row.display_label().to_owned())),
                    )
                    .child(
                        Button::new(("copy-source", row.id()))
                            .ghost()
                            .small()
                            .label("Copy source")
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(
                                    source.as_ref().clone(),
                                ))
                            }),
                    ),
            )
            .child(match &self.text_states[ix] {
                Some(state) => crate::typography::rich(
                    TextView::new(state),
                    crate::typography::current(cx),
                    if row.is_plain() && (user || row.label().starts_with("Automatic input")) {
                        crate::typography::Content::PlainChat
                    } else {
                        crate::typography::Content::Chat
                    },
                    cx,
                )
                .selectable(true)
                .scrollable(false)
                .stream_fade(true)
                .on_link_click(|_, _, _, _| {})
                .into_any_element(),
                None => div()
                    .w_full()
                    .child(SharedString::from(row.source().to_string()))
                    .into_any_element(),
            })
    }
}

impl Render for TranscriptView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(feature = "native-probes")]
        {
            self.render_count += 1;
        }
        let busy = self.transcript.is_streaming();
        let full = self.transcript.is_full();
        let weak = cx.weak_entity();
        let scope = self.history_scope;
        let viewport = div()
            .id("viewport")
            .flex_1()
            .min_h_0()
            .min_w_0()
            // A fitting list lets wheel packets bubble instead of invoking the
            // bounce callback. Only upward intent at the top requests history.
            .on_scroll_wheel(cx.listener(
                move |view, event: &gpui_kit::ScrollWheelEvent, _, cx| {
                    if view.readonly
                        && view.history_scope == scope
                        && event.delta.pixel_delta(px(20.)).y > px(0.)
                        && view.at_history_top(cx)
                    {
                        cx.emit(HistoryTop(scope));
                    }
                },
            ));
        #[cfg(any(test, feature = "native-probes"))]
        let viewport = {
            use gpui_kit::test::TestSupportExt;
            viewport.test_support()
        };
        let following = self.scroller.read(cx).is_following_tail();
        // With Kit's default vertical list padding, pinned GPUI fails to resume
        // following after wheel-scrolling back to the bottom. Keep the list
        // itself unpadded; the existing row spacing remains unchanged.
        // Retain only pre-existing short-document empty space while reading
        // older history. Latest/genuine bottom/reset remove it before Tail.
        let list_style = StyleRefinement::default().py_0().pb(self.history_slack);
        if self.readonly {
            return div()
                .relative()
                .v_flex()
                .size_full()
                .min_h_0()
                .min_w_0()
                .child(
                    viewport.child(
                        MessageScroller::new(
                            "transcript",
                            self.scroller.clone(),
                            move |ix, _, cx| {
                                weak.upgrade()
                                    .map(|view| {
                                        view.read(cx)
                                            .render_row(ix, cx, weak.clone())
                                            .into_any_element()
                                    })
                                    .unwrap_or_else(|| div().into_any_element())
                            },
                        )
                        .with_scrollbar_mode(gpui_kit::component::scroll::ScrollbarMode::Scrolling)
                        .with_list_style(list_style)
                        .jump_button(false),
                    ),
                )
                .when(
                    self.history_guard.is_some()
                        && (!following
                            || self.history_controls.limited
                            || self.history_controls.refreshing
                            || self.history_controls.recovery),
                    |v| {
                        v.child(
                            div()
                                .absolute()
                                .bottom_3()
                                .right_3()
                                .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                                    if v.history_guard.as_ref().is_some_and(|guard| !guard(w, cx)) {
                                        cx.stop_propagation();
                                    }
                                }))
                                .child(
                                    crate::ui::action(
                                        "latest",
                                        if self.history_controls.refreshing {
                                            "Retry latest"
                                        } else if self.history_controls.limited {
                                            "Refresh latest"
                                        } else {
                                            "Latest"
                                        },
                                        crate::ui::Action::Secondary,
                                    )
                                    .icon(crate::app_icon::AppIcon::Latest.asset())
                                    .on_click(cx.listener(
                                        move |_, _, _, cx| cx.emit(LatestRequested(scope)),
                                    )),
                                ),
                        )
                    },
                )
                .into_any_element();
        }
        div().v_flex().size_full().min_w_0().bg(cx.theme().background).text_color(cx.theme().foreground)
            .on_action(cx.listener(|this, _: &FocusComposer, window, cx| {
                if this.readonly { return; }
                this.composer.update(cx, |state, cx| state.focus(window, cx));
            }))
            .child(div().v_flex().p_4().gap_2().border_b_1().border_color(cx.theme().border)
                .child(div().font_semibold().child("Transcript fixture"))
                .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Memory only. No live connection. Swift and user data are untouched."))
                .child(div().h_flex().flex_wrap().gap_2()
                    .child(Button::new("earlier").small().label("Earlier (+12)")
                        .disabled(self.transcript.earlier() == 0 || full)
                        .on_click(cx.listener(|this, _, _, cx| this.prepend(cx))))
                    .child(Button::new("stream").small().label("Stream fixture")
                        .disabled(busy || full).on_click(cx.listener(|this, _, _, cx| this.demo(cx))))
                    .child(Button::new("stop").small().label("Stop").disabled(!busy)
                        .on_click(cx.listener(|this, _, _, cx| this.stop(cx))))
                    .child(Button::new("latest").small().label("Latest")
                        .on_click(cx.listener(|this, _, _, cx| this.scroller.update(cx, |state, cx| state.scroll_to_end(cx)))))
                    .child(div().text_sm().child(if following { "Following tail" } else { "Reading above tail" }))))
            .child(viewport.child(
                MessageScroller::new("transcript", self.scroller.clone(), move |ix, _, cx| {
                    weak.upgrade().map(|view| view.read(cx).render_row(ix, cx,weak.clone()).into_any_element())
                        .unwrap_or_else(|| div().into_any_element())
                }).with_scrollbar_mode(gpui_kit::component::scroll::ScrollbarMode::Scrolling)
                        .with_list_style(list_style).jump_button(false)))
            .child(div().v_flex().p_4().gap_2().border_t_1().border_color(cx.theme().border)
                .child(Textarea::new(&self.composer).accessibility_id("composer").aria_label("Local echo composer"))
                .child(div().h_flex().justify_between().gap_2()
                    .child(div().text_sm().text_color(cx.theme().muted_foreground).child(if full {
                        "Fixture capacity reached. Relaunch to reset; no rows are evicted."
                    } else if busy { "Streaming 100 characters at 4/s. Composer stays editable." }
                    else { "Enter: local echo. Shift-Enter: newline. Cmd/Ctrl-L: composer." }))
                    .child(Button::new("send").primary().label("Echo locally")
                        .disabled(busy || full || self.composer.read(cx).value().trim().is_empty())
                        .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))))).into_any_element()
    }
}

#[cfg(test)]
#[path = "readonly_tests.rs"]
mod readonly_tests;

#[cfg(test)]
#[path = "work_tests.rs"]
mod work_tests;

#[cfg(test)]
mod tests {
    #[test]
    fn retained_layout_sweep_threshold_liveness_and_cross_thread_drop() {
        gpui_kit::base::text::assert_retained_layout_sweep_invariants();
    }
    use super::TranscriptView;
    use gpui_kit::{
        AppContext, Bounds, ScrollDelta, TestAppContext, WindowBounds, WindowOptions, point, px,
        size,
        test::{TestQueryExt, TestWindowExt},
    };

    pub(super) fn setup(
        cx: &mut TestAppContext,
    ) -> (gpui_kit::AnyWindowHandle, gpui_kit::Entity<TranscriptView>) {
        setup_extra(cx, None)
    }

    fn setup_extra(
        cx: &mut TestAppContext,
        extra: Option<String>,
    ) -> (gpui_kit::AnyWindowHandle, gpui_kit::Entity<TranscriptView>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            TranscriptView::bind_keys(cx);
        });
        let result = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(960.), px(760.)),
                    ))),
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| TranscriptView::with_fixture(extra, window, cx)),
            )
            .unwrap()
        });
        cx.run_until_parked();
        result
    }

    #[gpui_kit::test]
    fn composer_echo_buttons_and_keyboard_preserve_busy_draft(cx: &mut TestAppContext) {
        let (handle, view) = setup(cx);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let input = window.find_by_label("Local echo composer");
            assert!(input.bounds().size.height > px(0.));
            assert!(window.find("send").disabled().unwrap_or(false));
            // Focus was assigned on construction; use the real keyboard path.
            window.input("Hello 日本語", cx);
            window.press("shift-enter", cx);
            window.input("second line", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            assert_eq!(
                view.read(cx).composer.read(cx).value().as_ref(),
                "Hello 日本語\nsecond line"
            );
            window.click("send", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            assert!(view.read(cx).transcript.is_streaming());
            assert_eq!(view.read(cx).transcript.messages().len(), 26);
            assert_eq!(
                view.read(cx).transcript.messages()[24].source(),
                "Hello 日本語\nsecond line"
            );
            window.input("next draft", cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            assert_eq!(view.read(cx).transcript.messages().len(), 26);
            assert_eq!(
                view.read(cx).composer.read(cx).value().as_ref(),
                "next draft"
            );
            window.click("stop", cx);
            window.press("secondary-l", cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update(|cx| {
            assert_eq!(view.read(cx).transcript.messages().len(), 28);
            assert!(view.read(cx).composer.read(cx).value().is_empty());
        });
    }

    #[gpui_kit::test]
    fn wheel_back_to_bottom_resumes_stream_following(cx: &mut TestAppContext) {
        let (handle, view) = setup(cx);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.click("stream", cx);
            window.scroll("viewport", ScrollDelta::Pixels(point(px(0.), px(450.))), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update(|cx| assert!(!view.read(cx).scroller.read(cx).is_following_tail()));
        for _ in 0..4 {
            cx.executor()
                .advance_clock(std::time::Duration::from_millis(250));
            cx.run_until_parked();
        }
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.scroll(
                "viewport",
                ScrollDelta::Pixels(point(px(0.), px(-10000.))),
                cx,
            );
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert!(
                view.read(cx).scroller.read(cx).is_following_tail(),
                "wheel back to bottom must resume following without Latest"
            );
        })
        .unwrap();
        for _ in 0..16 {
            cx.executor()
                .advance_clock(std::time::Duration::from_millis(250));
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let state = view.read(cx);
                let viewport = window.find("viewport").bounds();
                let reply = state
                    .text_states
                    .last()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .bounds();
                assert!(state.scroller.read(cx).is_following_tail());
                assert!(
                    reply.bottom() <= viewport.bottom() + px(1.),
                    "reply bottom must remain visible: reply={reply:?}, viewport={viewport:?}"
                );
            })
            .unwrap();
        }
    }

    #[gpui_kit::test]
    fn streaming_stays_physically_at_tail_after_reply_exceeds_viewport(cx: &mut TestAppContext) {
        let (handle, view) = setup(cx);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.click("stream", cx);
        })
        .unwrap();
        cx.run_until_parked();
        let mut grew_past_viewport = false;
        for _ in 0..20 {
            cx.executor()
                .advance_clock(std::time::Duration::from_millis(250));
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let state = view.read(cx);
                let viewport = window.find("viewport").bounds();
                let reply = state.text_states.last().unwrap().as_ref().unwrap().read(cx).bounds();
                grew_past_viewport |= reply.size.height > viewport.size.height;
                assert!(state.scroller.read(cx).is_following_tail());
                assert!(reply.bottom() <= viewport.bottom() + px(1.),
                    "reply bottom must stay visible, not merely report follow=true: reply={reply:?}, viewport={viewport:?}");
            }).unwrap();
        }
        assert!(
            grew_past_viewport,
            "exercise a reply taller than its viewport"
        );
    }

    #[gpui_kit::test]
    fn wheel_reading_anchor_survives_prepend_and_stream_then_latest(cx: &mut TestAppContext) {
        let (handle, view) = setup(cx);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert!(view.read(cx).scroller.read(cx).is_following_tail());
            window.scroll("viewport", ScrollDelta::Pixels(point(px(0.), px(450.))), cx);
        })
        .unwrap();
        cx.run_until_parked();
        let before = cx
            .update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let state = view.read(cx);
                assert!(!state.scroller.read(cx).is_following_tail());
                let top = state.scroller.read(cx).logical_scroll_top();
                let anchor = (
                    state.transcript.messages()[top.item_ix].id(),
                    top.offset_in_item,
                );
                window.click("earlier", cx);
                anchor
            })
            .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let state = view.read(cx);
            let top = state.scroller.read(cx).logical_scroll_top();
            assert_eq!(
                (
                    state.transcript.messages()[top.item_ix].id(),
                    top.offset_in_item
                ),
                before
            );
            assert_eq!(state.transcript.messages().len(), 36);
            window.click("stream", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(250));
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let state = view.read(cx);
            assert!(!state.scroller.read(cx).is_following_tail());
            assert!(
                !state
                    .transcript
                    .messages()
                    .last()
                    .unwrap()
                    .source()
                    .is_empty()
            );
            let top = state.scroller.read(cx).logical_scroll_top();
            assert_eq!(
                (
                    state.transcript.messages()[top.item_ix].id(),
                    top.offset_in_item
                ),
                before
            );
            window.click("latest", cx);
            assert!(view.read(cx).scroller.read(cx).is_following_tail());
            window.click("stop", cx);
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn composer_backspace_deletes_whole_combining_grapheme(cx: &mut TestAppContext) {
        let (handle, view) = setup(cx);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.input("e\u{301}", cx);
            window.press("backspace", cx);
            assert_eq!(
                view.read(cx).composer.read(cx).value().as_ref(),
                "",
                "Backspace must delete the entire grapheme, not leave its base"
            );
        })
        .unwrap();
    }

    /// Selection belongs to the retained message, not its current row element.
    #[gpui_kit::test]
    fn selection_and_copy_survive_unmount_prepend_and_remount(cx: &mut TestAppContext) {
        use gpui_kit::base::TextSelection;
        let (handle, view) = setup(cx);
        let selected = cx
            .update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let text = view
                    .read(cx)
                    .text_states
                    .last()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .clone();
                let bounds = text.read(cx).bounds();
                let start = bounds.origin + point(px(3.), px(10.));
                window.drag(start, start + point(px(80.), px(0.)), cx);
                assert!(
                    !TextSelection::selected_text(window, cx).is_empty(),
                    "drag must select actual rendered text"
                );
                let selection = TextSelection::selected_text(window, cx);
                let range = text
                    .read(cx)
                    .selected_source_range()
                    .expect("exact source range");
                window.press("secondary-c", cx);
                let copied = cx.read_from_clipboard().unwrap().text().unwrap();
                window.scroll(
                    "viewport",
                    ScrollDelta::Pixels(point(px(0.), px(10000.))),
                    cx,
                );
                (selection, range, copied)
            })
            .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(
                TextSelection::selected_text(window, cx),
                selected.0,
                "copy must survive unmount"
            );
            window.press("secondary-c", cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                selected.2
            );
            view.update(cx, |view, cx| view.prepend(cx));
            window.scroll(
                "viewport",
                ScrollDelta::Pixels(point(px(0.), px(-10000.))),
                cx,
            );
            assert_eq!(
                TextSelection::selected_text(window, cx),
                selected.0,
                "copy must survive remount and prepend"
            );
            let text = view.read(cx).text_states.last().unwrap().as_ref().unwrap();
            assert_eq!(
                text.read(cx).selected_source_range(),
                Some(selected.1.clone())
            );
            window.press("secondary-c", cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                selected.2
            );
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn unicode_selection_keeps_message_identity_during_stream_and_dismisses_on_click(
        cx: &mut TestAppContext,
    ) {
        use gpui_kit::{MouseButton, base::TextSelection, test::TestEventExt};
        let source = "Éé 🇫🇷 👨‍👩‍👧 👍🏽 e\u{301} 안녕 repeat repeat\n\nA second paragraph.\n".to_string();
        let (handle, view) = setup_extra(cx, Some(source.clone()));
        let (id, selected, range, copied) = cx
            .update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let state = view.read(cx);
                let row = state.text_states.last().unwrap().as_ref().unwrap().clone();
                let id = state.transcript.messages().last().unwrap().id();
                let bounds = row.read(cx).bounds();
                window.drag(
                    bounds.origin + point(px(2.), px(10.)),
                    bounds.origin + point(px(480.), px(10.)),
                    cx,
                );
                let selected = TextSelection::selected_text(window, cx);
                assert!(
                    selected.contains("🇫🇷") && selected.contains("👨‍👩‍👧"),
                    "Unicode selection must be exercised: {selected:?}"
                );
                let range = row.read(cx).selected_source_range().unwrap();
                assert!(source.is_char_boundary(range.start) && source.is_char_boundary(range.end));
                window.press("secondary-c", cx);
                let copied = cx.read_from_clipboard().unwrap().text().unwrap();
                window.scroll(
                    "viewport",
                    ScrollDelta::Pixels(point(px(0.), px(10000.))),
                    cx,
                );
                (id, selected, range, copied)
            })
            .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            assert!(
                window.try_find(("copy-source", id)).is_none(),
                "selected row must actually be unmounted"
            );
            assert_eq!(TextSelection::selected_text(window, cx), selected);
            window.press("secondary-c", cx);
            assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
            view.update(cx, |view, cx| view.demo(cx));
        })
        .unwrap();
        for _ in 0..4 {
            cx.executor()
                .advance_clock(std::time::Duration::from_millis(250));
            cx.run_until_parked();
        }
        cx.update_window(handle, |_, window, cx| {
            assert_eq!(TextSelection::selected_text(window, cx), selected);
            assert!(
                view.read(cx)
                    .text_states
                    .last()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .selected_source_range()
                    .is_none(),
                "new message cannot adopt another ID's selection"
            );
            window.scroll(
                "viewport",
                ScrollDelta::Pixels(point(px(0.), px(-10000.))),
                cx,
            );
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let state = view.read(cx);
            let ix = state
                .transcript
                .messages()
                .iter()
                .position(|row| row.id() == id)
                .unwrap();
            assert_eq!(
                state.text_states[ix]
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .selected_source_range(),
                Some(range)
            );
            let bounds = window.find_by_label("Local echo composer").bounds();
            window.pointer_down(bounds.center(), MouseButton::Left, cx);
            window.pointer_up(bounds.center(), MouseButton::Left, cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            assert!(TextSelection::selected_text(window, cx).is_empty());
            for text in view.read(cx).text_states.iter().flatten() {
                assert!(text.read(cx).selected_source_range().is_none());
            }
            view.update(cx, |view, cx| view.stop(cx));
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn selection_in_streaming_message_keeps_source_range_and_copy(cx: &mut TestAppContext) {
        use gpui_kit::base::TextSelection;
        let (handle, view) = setup(cx);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.click("stream", cx);
        })
        .unwrap();
        for _ in 0..3 {
            cx.executor()
                .advance_clock(std::time::Duration::from_millis(250));
            cx.run_until_parked();
        }
        let (range, copied) = cx
            .update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let row = view
                    .read(cx)
                    .text_states
                    .last()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .clone();
                let start = row.read(cx).bounds().origin + point(px(2.), px(10.));
                window.drag(start, start + point(px(80.), px(0.)), cx);
                assert!(!TextSelection::selected_text(window, cx).is_empty());
                let range = row.read(cx).selected_source_range().unwrap();
                window.press("secondary-c", cx);
                (range, cx.read_from_clipboard().unwrap().text().unwrap())
            })
            .unwrap();
        for _ in 0..12 {
            cx.executor()
                .advance_clock(std::time::Duration::from_millis(250));
            cx.run_until_parked();
        }
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.scroll(
                "viewport",
                ScrollDelta::Pixels(point(px(0.), px(10000.))),
                cx,
            );
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let row = view
                .read(cx)
                .text_states
                .last()
                .unwrap()
                .as_ref()
                .unwrap()
                .clone();
            assert_eq!(row.read(cx).selected_source_range(), Some(range));
            window.press("secondary-c", cx);
            assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn dragging_across_messages_does_not_widen_selection_scope(cx: &mut TestAppContext) {
        use gpui_kit::base::TextSelection;
        let (handle, view) = setup(cx);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let state = view.read(cx);
            let last = state.text_states.last().unwrap().as_ref().unwrap().clone();
            let previous = state.text_states[state.text_states.len() - 2]
                .as_ref()
                .unwrap()
                .clone();
            let start = last.read(cx).bounds().origin + point(px(70.), px(10.));
            let end = previous.read(cx).bounds().origin + point(px(30.), px(10.));
            window.drag(start, end, cx);
            assert!(!TextSelection::selected_text(window, cx).is_empty());
            assert!(last.read(cx).selected_source_range().is_some());
            assert!(
                previous.read(cx).selected_source_range().is_none(),
                "a drag must remain within the starting message"
            );
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn explicit_send_refuses_marked_text_until_commit(cx: &mut TestAppContext) {
        use gpui_kit::{ElementInputHandler, test::TestInput};
        let (handle, view) = setup(cx);
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let composer = view.read(cx).composer.clone();
            let bounds = window.find_by_label("Local echo composer").bounds();
            let handler = ElementInputHandler::new(bounds, composer.clone());
            let mut input = TestInput::new(handler, window);
            input.compose_text(None, "にほん", Some(3..3), cx);
            assert!(input.marked_text_range(cx).is_some());
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.click("send", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            assert_eq!(view.read(cx).transcript.messages().len(), 24);
            assert_eq!(view.read(cx).composer.read(cx).value().as_ref(), "にほん");
            let composer = view.read(cx).composer.clone();
            let bounds = window.find_by_label("Local echo composer").bounds();
            let handler = ElementInputHandler::new(bounds, composer);
            TestInput::new(handler, window).commit_text("日本", cx);
            window.click("send", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update(|cx| {
            assert_eq!(view.read(cx).transcript.messages().len(), 26);
            assert_eq!(view.read(cx).transcript.messages()[24].source(), "日本");
        });
    }
}

#[cfg(test)]
#[path = "composer_tests.rs"]
mod composer_tests;
use gpui_kit::prelude::FluentBuilder;

//! Native NSH Find controls and canonical list navigation. No alternate reader.
use super::*;
use pilot_desktop::nsh_adapter::{Message, ReaderKey};
use std::collections::HashMap;
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, PartialEq)]
struct Mark {
    key: ReaderKey,
    inset: f32,
}
fn reader_index(snapshot: &Snapshot, key: &ReaderKey) -> Option<usize> {
    let mut rows = snapshot
        .messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.reader.as_ref() == Some(key));
    let (index, _) = rows.next()?;
    rows.next().is_none().then_some(index)
}
#[derive(Default)]
pub(super) struct Readings {
    marks: HashMap<String, Mark>,
}
#[derive(Clone)]
pub(super) struct Reader {
    ui: Ui,
    location: Location,
    list: ElementRef,
    rows: Rc<RefCell<HashMap<ReaderKey, ElementRef>>>,
    first: Signal<Option<ReaderKey>>,
    following: Signal<bool>,
    pending: Signal<Option<Mark>>,
    measuring: Stored<bool>,
}
impl Reader {
    pub fn new(ui: Ui, location: Location, list: ElementRef) -> Self {
        let mark = ui
            .readings
            .with(|r| r.marks.get(&location.session).cloned());
        let reader = Self {
            ui,
            location,
            list,
            rows: Default::default(),
            first: signal(None),
            following: signal(mark.is_none()),
            pending: signal(mark),
            measuring: stored(false),
        };
        let restore = reader.clone();
        effect(move || {
            let Some(mark) = restore.pending.get() else {
                return;
            };
            let s = ui.snapshot.get();
            if !s.history_loaded {
                return;
            }
            if reader_index(&s, &mark.key).is_some() {
                let restore = restore.clone();
                // Rows/measurements must reach the native list before restoring
                // the mark. A command in the row-splice commit was overridden
                // by bottom alignment in the isolated native prepend fixture.
                after_answer(move || {
                    if restore.pending.get_untracked().as_ref() == Some(&mark) {
                        let index = ui.snapshot.with_untracked(|s| {
                            (s.location.as_ref() == Some(&restore.location))
                                .then(|| reader_index(s, &mark.key))
                                .flatten()
                        });
                        let Some(index) = index else {
                            return;
                        };
                        list.scroll_to_index(index as u32, percentage(0.), px(mark.inset), false);
                        restore.pending.set(None);
                        restore.following.set(false);
                    }
                });
            } else if s.earlier && !s.loading_earlier && s.history_status.is_empty() {
                ui.adapter.with(|a| {
                    a.earlier(&restore.location);
                });
                ui.publish();
            }
        });
        let prefix = computed(move || {
            ui.snapshot
                .with(|s| s.messages.first().and_then(|m| m.reader.clone()))
        });
        let prepend = reader.clone();
        effect(move || {
            prefix.get();
            if prepend.pending.get_untracked().is_none() && !prepend.following.get_untracked() {
                let mark = ui
                    .readings
                    .with(|r| r.marks.get(&prepend.location.session).cloned());
                prepend.pending.set(mark);
            }
        });
        reader
    }
    pub fn row(&self, row: Memo<Option<Message>>) -> ElementRef {
        let reference = element_ref();
        let rows = self.rows.clone();
        let remove = rows.clone();
        effect(move || {
            // A recycled cell changes its ref's canonical association atomically.
            {
                let mut rows = rows.borrow_mut();
                rows.retain(|_, r| *r != reference);
                if let Some(key) = row.with(|m| m.as_ref().and_then(|m| m.reader.clone())) {
                    rows.insert(key, reference);
                }
            }
        });
        // Row cleanup can run after the conversation's reactive values are
        // disposed. This small registry follows its actual callbacks' lifetime.
        cleanup(move || remove.borrow_mut().retain(|_, r| *r != reference));
        reference
    }
    pub fn visible(&self, items: &nsh_core::element::ViewableItems) {
        self.first.set(items.viewable.and_then(|(first, _)| {
            self.ui
                .snapshot
                .with_untracked(|s| s.messages.get(first).and_then(|m| m.reader.clone()))
        }));
        self.capture();
    }
    pub fn scrolled(&self, following: bool) {
        self.following.set(following);
        if following && self.pending.get_untracked().is_none() {
            self.latest();
        } else {
            self.capture();
        }
    }
    pub fn latest(&self) {
        self.pending.set(None);
        self.ui.readings.with(|r| {
            r.marks.remove(&self.location.session);
        });
    }
    fn capture(&self) {
        if self.pending.get_untracked().is_some()
            || self.following.get_untracked()
            || self.measuring.with(|busy| *busy)
        {
            return;
        }
        let Some(key) = self.first.get_untracked() else {
            return;
        };
        let Some(row) = self.rows.borrow().get(&key).copied() else {
            return;
        };
        let reader = self.clone();
        self.measuring.with(|busy| *busy = true);
        let row = row.measure();
        let list = self.list.measure();
        spawn(async move {
            let (Some(row), Some(list)) = (row.await, list.await) else {
                reader.measuring.with(|busy| *busy = false);
                return;
            };
            reader.measuring.with(|busy| *busy = false);
            if reader
                .ui
                .snapshot
                .with_untracked(|s| s.location.as_ref() == Some(&reader.location))
                && reader.first.get_untracked().as_ref() == Some(&key)
                && !reader.following.get_untracked()
                && reader.pending.get_untracked().is_none()
            {
                reader.ui.readings.with(|r| {
                    r.marks.insert(
                        reader.location.session.clone(),
                        Mark {
                            key,
                            inset: row.page.y.0 - list.page.y.0,
                        },
                    );
                });
            }
        });
    }
}

#[derive(Clone)]
pub(super) struct Controls {
    ui: Ui,
    location: Location,
    input: ElementRef,
    editor: ElementRef,
    list: ElementRef,
    reader: Reader,
}
impl Controls {
    pub fn new(
        ui: Ui,
        location: Location,
        list: ElementRef,
        editor: ElementRef,
        reader: Reader,
    ) -> Self {
        let controls = Self {
            ui,
            location,
            input: element_ref(),
            editor,
            list,
            reader,
        };
        let open = controls.clone();
        on_key("mod+f", move |_| open.open());
        let navigation = computed(move || ui.snapshot.with(|s| s.find.navigation));
        let previous = stored(navigation.get_untracked());
        effect(move || {
            let serial = navigation.get();
            let changed = previous.with(|p| {
                let changed = *p != serial;
                *p = serial;
                changed
            });
            if !changed {
                return;
            }
            // Data updates never issue scroll commands. Resolve an explicit
            // navigation against the current exact source and canonical key.
            after_answer(move || {
                let target = ui.snapshot.with_untracked(|s| {
                    if !s.find.open || s.find.navigation != serial {
                        return None;
                    }
                    let hit = s.find.target.as_ref()?;
                    let index = reader_index(s, &hit.key)?;
                    (s.messages[index].source == *hit.source).then_some(index)
                });
                if let Some(index) = target {
                    list.scroll_to_index(index as u32, percentage(0.), px(0.), false);
                }
            });
        });
        controls
    }
    fn open(&self) {
        if self.ui.composing.get_untracked() {
            return;
        }
        self.reader.pending.set(None);
        self.ui.adapter.with(|a| a.find_open(&self.location, true));
        self.ui.publish();
        self.input.focus();
    }
    fn close(&self) {
        if self.ui.composing.get_untracked() {
            return;
        }
        if self.ui.snapshot.with_untracked(|s| s.editable) {
            self.editor.focus();
        } else {
            self.list.focus();
        }
        self.ui.adapter.with(|a| a.find_open(&self.location, false));
        self.ui.publish();
    }
    fn step(&self, previous: bool) {
        if self.ui.composing.get_untracked() {
            return;
        }
        self.ui
            .adapter
            .with(|a| a.find_step(&self.location, previous));
        self.ui.publish();
    }
    pub fn trigger(&self) -> impl IntoElement + use<> {
        let this = self.clone();
        button()
            .accessibility_label("Find in conversation (⌘F)")
            .h(px(28.))
            .px(px(8.))
            .on_press(move || this.open())
            .child(label("Find", 12.).text_color(META))
    }
    pub fn bar(&self) -> impl IntoElement + use<> {
        let this = self.clone();
        let ui = self.ui;
        when(
            move || ui.snapshot.with(|s| s.find.open),
            move || {
                let query = this.clone();
                let submit = this.clone();
                let previous = this.clone();
                let next = this.clone();
                let close = this.clone();
                let loading = this.clone();
                let focused = signal(false);
                let keys = this.clone();
                view()
                    .px(px(24.))
                    .py(px(8.))
                    .gap(px(4.))
                    .bg(TRAY)
                    .child(
                        view()
                            .flex_row()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                input()
                                    .test_id("transcript-find")
                                    .label("Find source (case-sensitive)")
                                    .element_ref(&this.input)
                                    .auto_focus(true)
                                    .submit_behavior(SubmitBehavior::Submit)
                                    .placeholder("Find source (case-sensitive)")
                                    .value(move || ui.snapshot.with(|s| s.find.query.clone()))
                                    .on_change(move |value: &str| {
                                        ui.adapter.with(|a| a.find_query(&query.location, value));
                                        ui.publish();
                                    })
                                    .on_composition_change(move |event: &Composition| {
                                        ui.compose(event)
                                    })
                                    .on_focus(move || focused.set(true))
                                    .on_blur(move || focused.set(false))
                                    .on_submit(move |_: &str| submit.step(false))
                                    .flex_1()
                                    .min_w(px(0.))
                                    .h(px(30.))
                                    .px(px(8.))
                                    .rounded(px(6.))
                                    .bg(CARD)
                                    .text_color(INK)
                                    .text_size(px(13.)),
                            )
                            .child(
                                button()
                                    .accessibility_label("Previous match (Shift-Enter)")
                                    .disabled(move || {
                                        ui.snapshot.with(|s| s.find.busy || s.find.count == 0)
                                    })
                                    .h(px(28.))
                                    .px(px(8.))
                                    .on_press(move || previous.step(true))
                                    .child(icon("send").text_color(META)),
                            )
                            .child(
                                button()
                                    .accessibility_label("Next match (Enter)")
                                    .disabled(move || {
                                        ui.snapshot.with(|s| s.find.busy || s.find.count == 0)
                                    })
                                    .h(px(28.))
                                    .px(px(8.))
                                    .on_press(move || next.step(false))
                                    .child(icon("latest").text_color(META)),
                            )
                            .child(
                                button()
                                    .accessibility_label("Close find (Escape)")
                                    .h(px(28.))
                                    .px(px(8.))
                                    .on_press(move || close.close())
                                    .child(label("Close", 12.).text_color(META)),
                            ),
                    )
                    .child(
                        view()
                            .flex_row()
                            .flex_wrap()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                label(move || ui.snapshot.with(|s| s.find.coverage.clone()), 11.)
                                    .text_color(META),
                            )
                            .child(when(
                                move || ui.snapshot.with(|s| s.earlier || s.find.loading),
                                move || {
                                    let loading = loading.clone();
                                    button()
                                        .accessibility_label(move || {
                                            Some(SharedString::from(
                                                if ui.snapshot.with(|s| s.find.loading) {
                                                    "Stop loading history"
                                                } else {
                                                    "Load full history"
                                                },
                                            ))
                                        })
                                        .h(px(24.))
                                        .on_press(move || {
                                            if !ui.composing.get_untracked() {
                                                let load =
                                                    !ui.snapshot.with_untracked(|s| s.find.loading);
                                                ui.adapter.with(|a| {
                                                    a.find_history(&loading.location, load)
                                                });
                                                ui.publish();
                                            }
                                        })
                                        .child(
                                            label(
                                                move || {
                                                    if ui.snapshot.with(|s| s.find.loading) {
                                                        "Stop loading history"
                                                    } else {
                                                        "Load full history"
                                                    }
                                                },
                                                11.,
                                            )
                                            .text_color(META),
                                        )
                                },
                            ))
                            .child(
                                label(move || ui.snapshot.with(|s| s.find.status.clone()), 11.)
                                    .text_color(META),
                            ),
                    )
                    .child(when(
                        move || focused.get(),
                        move || {
                            let escape = keys.clone();
                            let previous = keys.clone();
                            on_key_with(
                                "escape",
                                KeyOptions {
                                    when: nsh_core::keymap::When::Always,
                                    ..Default::default()
                                },
                                move |_| escape.close(),
                            );
                            on_key_with(
                                "shift+enter",
                                KeyOptions {
                                    when: nsh_core::keymap::When::Always,
                                    ..Default::default()
                                },
                                move |_| previous.step(true),
                            );
                            view()
                        },
                    ))
            },
        )
    }
}

pub(super) fn context(
    ui: Ui,
    message: ReadSignal<pilot_desktop::nsh_adapter::Message>,
) -> impl IntoElement {
    let context = computed(move || {
        ui.snapshot.with(|s| {
            if !s.find.open {
                return None;
            }
            let hit = s.find.target.as_ref()?;
            message.with(|m| {
                if m.reader.as_ref() != Some(&hit.key) || m.source != *hit.source {
                    return None;
                }
                let before: String = hit.source[..hit.range.start]
                    .chars()
                    .rev()
                    .take(32)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                let after: String = hit.source[hit.range.end..].chars().take(32).collect();
                Some(
                    format!(
                        "Source match {}: …{}[{}]{}…",
                        s.find.active + 1,
                        before,
                        &hit.source[hit.range.clone()],
                        after
                    )
                    .replace(['\n', '\r'], " "),
                )
            })
        })
    });
    when(
        move || context.with(|s| s.is_some()),
        move || label(move || context.get().unwrap_or_default(), 11.).text_color(META),
    )
}

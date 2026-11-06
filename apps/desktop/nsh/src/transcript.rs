//! Native disclosure over prepared production work groups. No tool parsing here.
use super::*;
use nsh_base::collapsible;
use pilot_desktop::nsh_adapter::{Call, Message, Work};
use std::collections::{BTreeMap, BTreeSet};

const DANGER: AdaptiveColor = AdaptiveColor::rgb(0xb42318, 0xf28b82);
const TAIL: usize = 5;

/// User intent lives outside recycled cells, keyed by chat and canonical call.
/// Like production, the latest group choice follows calls through splits/merges.
#[derive(Clone, Default, PartialEq)]
pub(super) struct Choices {
    sequence: u64,
    groups: BTreeMap<(String, String), (u64, bool)>,
    calls: BTreeSet<(String, String)>,
    selected: BTreeSet<(String, String)>,
    reads: BTreeSet<(String, String)>,
    code: BTreeSet<(String, String)>,
}
impl Choices {
    fn choice(&self, session: &str, work: &Work) -> Option<bool> {
        work.calls
            .iter()
            .filter_map(|call| self.groups.get(&(session.into(), call.id.clone())))
            .max_by_key(|(sequence, _)| *sequence)
            .map(|(_, open)| *open)
    }
    fn choose(&mut self, session: &str, work: &Work, open: bool) {
        self.sequence += 1;
        for call in &work.calls {
            self.selected.remove(&(session.into(), call.id.clone()));
            self.groups
                .insert((session.into(), call.id.clone()), (self.sequence, open));
        }
    }
    fn shown(&self, session: &str, work: &Work) -> (Vec<Vec<usize>>, usize) {
        match self.choice(session, work) {
            Some(true) => ((0..work.calls.len()).map(|i| vec![i]).collect(), 0),
            None if work.active => {
                let hidden = work.units.len().saturating_sub(TAIL);
                (work.units[hidden..].to_vec(), hidden)
            }
            _ => (Vec::new(), 0),
        }
    }
}
fn flip(set: &mut BTreeSet<(String, String)>, key: (String, String)) {
    if !set.remove(&key) {
        set.insert(key);
    }
}
fn current(ui: Ui, location: &Location) -> bool {
    ui.snapshot
        .with_untracked(|s| s.location.as_ref() == Some(location))
}
fn trigger(
    id: String,
    title: impl IntoReactive<SharedString>,
    open: impl IntoReactive<bool>,
    action: impl Fn() + 'static,
) -> impl IntoElement {
    let open = open.into_reactive();
    let open = computed(move || open.get());
    let title = title.into_reactive();
    let title = computed(move || title.get());
    button()
        .accessibility_label(move || title.get())
        .selected(open)
        .on_press(action)
        .min_h(px(28.))
        .py(px(4.))
        .min_w(px(0.))
        .child(
            view()
                .test_id(&id)
                .flex_row()
                .items_center()
                .gap(px(6.))
                .min_w(px(0.))
                .child(
                    when(open, || icon("down").size(px(13.)).text_color(META))
                        .otherwise(|| icon("right").size(px(13.)).text_color(META)),
                )
                .child(label(title, 12.).text_color(META)),
        )
}

fn section(ui: Ui, location: Location, call: Memo<Call>, name: &'static str) -> impl IntoElement {
    let source = computed(move || {
        call.with(|c| match name {
            "Output" => c.output.clone(),
            "Replacement / patch preview" => c.diff.clone(),
            "Arguments" => c.arguments.clone().unwrap_or_default(),
            _ => c
                .input
                .as_ref()
                .map(|(_, text)| text.clone())
                .unwrap_or_default(),
        })
    });
    view()
        .min_w(px(0.))
        .gap(px(6.))
        .p(px(10.))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .child(when(!matches!(name, "Code" | "Command"), move || {
                    label(name, 11.).text_color(META)
                }))
                .child(when(name == "Output", move || {
                    label(
                        move || {
                            call.with(|c| {
                                [c.status.to_owned(), c.duration.clone().unwrap_or_default()]
                                    .into_iter()
                                    .filter(|s| !s.is_empty())
                                    .collect::<Vec<_>>()
                                    .join(" · ")
                            })
                        },
                        11.,
                    )
                    .text_color(move || {
                        if call.with(|c| c.failed) {
                            DANGER
                        } else {
                            META
                        }
                    })
                }))
                .child(view().flex_1())
                .child(
                    button()
                        .accessibility_label(format!("Copy {}", name.to_lowercase()))
                        .on_press(move || {
                            if current(ui, &location) {
                                set_clipboard(source.with_untracked(|s| s.as_ref().clone()));
                            }
                        })
                        .min_h(px(24.))
                        .px(px(4.))
                        .child(label("Copy", 11.).text_color(META)),
                ),
        )
        .child(
            scroll().max_h(px(260.)).min_w(px(0.)).child(
                text_view()
                    .document(move || {
                        Some(plain(if name == "Output" {
                            call.with(|c| {
                                if c.shown_output.is_empty() {
                                    "No output.".into()
                                } else {
                                    c.shown_output.as_ref().clone()
                                }
                            })
                        } else {
                            source.with(|s| s.as_ref().clone())
                        }))
                    })
                    .selectable(true)
                    .font_family("JetBrains Mono")
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(INK),
            ),
        )
}

fn call_view(ui: Ui, location: Location, call: ReadSignal<Call>) -> impl IntoElement {
    let key = (
        location.session.clone(),
        call.with_untracked(|c| c.id.clone()),
    );
    let call = computed(move || call.get());
    let open_key = key.clone();
    let open = computed(move || ui.disclosures.with(|c| c.calls.contains(&open_key)));
    let code_key = key.clone();
    let code_open = computed(move || ui.disclosures.with(|c| c.code.contains(&code_key)));
    let toggle_location = location.clone();
    let code_location = location.clone();
    let code_toggle_key = key.clone();
    collapsible()
        .open(open)
        .child(trigger(
            format!("call-{}", key.1),
            move || {
                call.with(|c| {
                    if c.status.is_empty() {
                        c.caption.clone()
                    } else {
                        format!("{} · {}", c.caption, c.status)
                    }
                })
            },
            open,
            move || {
                if current(ui, &toggle_location) {
                    ui.disclosures.update(|c| flip(&mut c.calls, key.clone()));
                }
            },
        ))
        .content(
            view()
                .test_id(&format!("detail-{}", code_toggle_key.1))
                .min_w(px(0.))
                .ml(px(18.))
                .rounded(px(6.))
                .bg(TRAY)
                .child(section(ui, location.clone(), call, "Output"))
                .child(each(
                    move || {
                        call.with(|c| {
                            c.input
                                .as_ref()
                                .map(|(label, _)| *label)
                                .into_iter()
                                .collect::<Vec<_>>()
                        })
                    },
                    |name| *name,
                    move |name, _| {
                        let name = name.get();
                        let location = code_location.clone();
                        let toggle = code_toggle_key.clone();
                        collapsible()
                            .open(code_open)
                            .border_t_1()
                            .border_color(LINE)
                            .child(trigger(
                                format!("source-{}", code_toggle_key.1),
                                name,
                                code_open,
                                move || {
                                    if current(ui, &location) {
                                        ui.disclosures
                                            .update(|c| flip(&mut c.code, toggle.clone()));
                                    }
                                },
                            ))
                            .content(section(ui, code_location.clone(), call, name))
                    },
                ))
                .child(when(move || call.with(|c| !c.diff.is_empty()), {
                    let location = location.clone();
                    move || section(ui, location.clone(), call, "Replacement / patch preview")
                }))
                .child(when(move || call.with(|c| c.arguments.is_some()), {
                    let location = location.clone();
                    move || section(ui, location.clone(), call, "Arguments")
                }))
                .child(when(
                    move || call.with(|c| c.limited),
                    || {
                        label(
                            "Details are bounded. Some content was not retained by this viewer.",
                            11.,
                        )
                        .p(px(10.))
                        .text_color(META)
                    },
                )),
        )
}

fn work_view(ui: Ui, location: Location, message: ReadSignal<Message>) -> impl IntoElement {
    let work = computed(move || message.with(|m| m.work.clone().expect("keyed work")));
    let session = location.session.clone();
    let mode_session = session.clone();
    let choice = computed(move || {
        ui.disclosures
            .with(|c| c.choice(&mode_session, &work.get()))
    });
    let shown_session = session.clone();
    let shown = computed(move || {
        let work = work.get();
        let (units, hidden) = ui.disclosures.with(|c| c.shown(&shown_session, &work));
        // Carry identities through reactive regions, never indices into a newer
        // group. A late Note can split the group before each updates its members.
        (
            units
                .into_iter()
                .map(|unit| {
                    unit.into_iter()
                        .map(|i| work.calls[i].id.clone())
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>(),
            hidden,
        )
    });
    let choose_location = location.clone();
    let earlier_location = location.clone();
    let error_location = location.clone();
    let error_session = session.clone();
    let selected_session = session.clone();
    let units = computed(move || {
        let mut units = shown.get().0;
        // A failure selected from a folded line opens only that call.
        if units.is_empty() {
            ui.disclosures.with(|c| {
                work.with(|w| {
                    for call in &w.calls {
                        let key = (selected_session.clone(), call.id.clone());
                        if c.selected.contains(&key) && c.calls.contains(&key) {
                            units.push(vec![call.id.clone()]);
                        }
                    }
                })
            });
        }
        units
    });
    view()
        .min_w(px(0.))
        .gap(px(6.))
        .child(trigger(
            format!("work-{}", message.with_untracked(|m| m.id)),
            move || work.with(|w| w.title.clone()),
            move || choice.get() == Some(true),
            move || {
                if current(ui, &choose_location) {
                    ui.disclosures.update(|c| {
                        c.choose(
                            &choose_location.session,
                            &work.get_untracked(),
                            choice.get_untracked() != Some(true),
                        )
                    });
                }
            },
        ))
        .child(when(
            move || shown.get().1 > 0,
            move || {
                let location = earlier_location.clone();
                button()
                    .accessibility_label("Show earlier work steps")
                    .min_h(px(28.))
                    .on_press(move || {
                        if current(ui, &location) {
                            ui.disclosures.update(|c| {
                                c.choose(&location.session, &work.get_untracked(), true)
                            });
                        }
                    })
                    .child(
                        label(move || format!("Show {} earlier steps", shown.get().1), 11.)
                            .text_color(META),
                    )
            },
        ))
        .child(when(
            move || {
                choice.get().is_none()
                    && !work.with(|w| w.active)
                    && units.with(|u| u.is_empty())
                    && work.with(|w| w.first_error.is_some())
            },
            move || {
                let location = error_location.clone();
                let session = error_session.clone();
                button()
                    .accessibility_label("Show failed call")
                    .min_h(px(24.))
                    .on_press(move || {
                        if current(ui, &location) {
                            let w = work.get_untracked();
                            if let Some((index, _)) = w.first_error {
                                ui.disclosures.update(|c| {
                                    let key = (session.clone(), w.calls[index].id.clone());
                                    c.selected.insert(key.clone());
                                    c.calls.insert(key);
                                });
                            }
                        }
                    })
                    .child(
                        label(
                            move || {
                                work.with(|w| {
                                    w.first_error
                                        .as_ref()
                                        .map(|(_, text)| text.clone())
                                        .unwrap_or_default()
                                })
                            },
                            11.,
                        )
                        .text_color(DANGER),
                    )
            },
        ))
        .child(each(
            move || units.get(),
            |unit| unit[0].clone(),
            move |unit, _| {
                let members = unit;
                let location = location.clone();
                let session = location.session.clone();
                let reads_session = session.clone();
                let read_open = computed(move || {
                    ui.disclosures.with(|c| {
                        members.with(|ids| {
                            ids.iter().any(|id| {
                                c.reads.contains(&(reads_session.clone(), id.clone()))
                                    || c.calls.contains(&(reads_session.clone(), id.clone()))
                            })
                        })
                    })
                });
                view()
                    .min_w(px(0.))
                    .pl(px(16.))
                    .border_l_1()
                    .border_color(LINE)
                    .child(when(move || members.with(|ids| ids.len() > 1), {
                        let location = location.clone();
                        move || {
                            let location = location.clone();
                            let session = session.clone();
                            trigger(
                                format!("reads-{}", members.with_untracked(|m| m[0].clone())),
                                move || {
                                    unit.with(|u| {
                                        work.with(|w| {
                                            format!(
                                                "Read {}",
                                                u.iter()
                                                    .filter_map(|id| w
                                                        .calls
                                                        .iter()
                                                        .find(|c| &c.id == id))
                                                    .map(|call| call
                                                        .caption
                                                        .strip_prefix("Read ")
                                                        .unwrap_or(&call.caption))
                                                    .collect::<Vec<_>>()
                                                    .join(", ")
                                            )
                                        })
                                    })
                                },
                                read_open,
                                move || {
                                    if current(ui, &location) {
                                        let open = !read_open.get_untracked();
                                        ui.disclosures.update(|c| {
                                            for id in members.get_untracked() {
                                                let key = (session.clone(), id);
                                                if open {
                                                    c.reads.insert(key);
                                                } else {
                                                    c.reads.remove(&key);
                                                    c.calls.remove(&key);
                                                }
                                            }
                                        });
                                    }
                                },
                            )
                        }
                    }))
                    .child(when(
                        move || members.with(|ids| ids.len() == 1) || read_open.get(),
                        move || {
                            let location = location.clone();
                            each(
                                move || {
                                    members.with(|ids| {
                                        work.with(|w| {
                                            ids.iter()
                                                .filter_map(|id| {
                                                    w.calls.iter().find(|c| &c.id == id).cloned()
                                                })
                                                .collect::<Vec<_>>()
                                        })
                                    })
                                },
                                |call| call.id.clone(),
                                move |call, _| call_view(ui, location.clone(), call),
                            )
                        },
                    ))
            },
        ))
}

/// The inner keyed region must change with a recycled cell's canonical row.
pub(super) fn row(ui: Ui, location: Location, row: Memo<Option<Message>>) -> impl IntoElement {
    each(
        move || row.get().into_iter().collect::<Vec<_>>(),
        |m| (m.reader.clone(), m.reader.is_none().then_some(m.id)),
        move |message, _| {
            if message.with_untracked(|m| m.work.is_some()) {
                work_view(ui, location.clone(), message).into_element()
            } else {
                view()
                    .min_w(px(0.))
                    .child(super::history::context(ui, message))
                    .style_when(
                        move || message.with(|m| m.mine),
                        |v| {
                            v.self_end()
                                .w(nsh_core::geometry::auto())
                                .max_w(relative(0.85))
                                .rounded(px(12.))
                                .p(px(14.))
                                .bg(TRAY)
                        },
                    )
                    .child(
                        text_view()
                            .markdown(move || {
                                message.with(|m| {
                                    (!m.plain).then(|| SharedString::from(m.source.clone()))
                                })
                            })
                            .document(move || {
                                message.with(|m| m.plain.then(|| plain(m.source.clone())))
                            })
                            .options(move || MarkdownOptions {
                                streaming: ui.snapshot.with(|s| {
                                    s.working
                                        && Some(message.with(|m| m.id))
                                            == s.messages.last().map(|m| m.id)
                                }),
                                ..Default::default()
                            })
                            .selectable(true)
                            .font_family("Inter")
                            .text_size(px(15.))
                            .line_height(px(23.))
                            .text_color(INK)
                            .gap(px(12.)),
                    )
                    .into_element()
            }
        },
    )
}

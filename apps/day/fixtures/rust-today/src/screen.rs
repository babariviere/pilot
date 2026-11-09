//! Today: what needs the user, which missions move, what landed and what
//! comes next. The Rust form of the TSX app's `TodayScreen.tsx`, section
//! for section. Read-only over the read model, except through intents.

use nsh_base::theme;
use nsh_core::{LineHeight, prelude::*};
use pilot_day_native::model::{
    Decision, DecisionKind, Delivery, DoneEntry, MissionRow, MissionState, Progress, Scenario,
    Scheduled, Tone,
};

use crate::{
    card::{decision_card, decision_mark},
    day::Day,
    ui::{COLUMN_WIDTH, MarkKind, evidence_chip, inline_action, mark, section_title, token, track},
};

fn state_words(state: MissionState) -> &'static str {
    match state {
        MissionState::Moving => "Moving",
        MissionState::Waiting => "Waiting for you",
        MissionState::Stuck => "Stuck",
        MissionState::Unconfirmed => "Unconfirmed",
        MissionState::Paused => "Paused",
        MissionState::Later => "Starts later",
    }
}

fn state_mark(state: MissionState) -> MarkKind {
    match state {
        MissionState::Moving => MarkKind::Moving,
        MissionState::Waiting => MarkKind::Needs,
        MissionState::Stuck => MarkKind::Failed,
        MissionState::Unconfirmed => MarkKind::Unknown,
        MissionState::Paused => MarkKind::Paused,
        MissionState::Later => MarkKind::Later,
    }
}

fn state_ink(state: MissionState) -> AdaptiveColor {
    match state {
        MissionState::Waiting | MissionState::Unconfirmed => token("needs-ink"),
        MissionState::Stuck => token("failed-ink"),
        MissionState::Moving | MissionState::Paused | MissionState::Later => {
            theme().muted_foreground
        }
    }
}

fn action_for(decision: Option<&Decision>) -> &'static str {
    match decision {
        None => "",
        Some(d) if d.kind == DecisionKind::Review => "Review it",
        Some(d) if d.kind == DecisionKind::Unknown || d.delivery == Delivery::Unknown => "Check it",
        Some(_) => "Decide",
    }
}

const WORDS: [&str; 10] = [
    "No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
];

/// The headline: the coordinators' summary, until the user starts answering.
fn headline(day: Day) -> String {
    day.with_today(|today| {
        let left = today.decisions.len();
        if today.notes.is_empty() {
            today.headline.clone()
        } else if left == 0 {
            "That was everything. Pilot is back on it.".to_owned()
        } else if left == 1 {
            "One thing left.".to_owned()
        } else {
            let word = WORDS
                .get(left)
                .map_or_else(|| left.to_string(), |w| (*w).to_owned());
            format!("{word} things left.")
        }
    })
}

fn total(p: &Progress) -> u32 {
    p.done + p.review + p.active + p.blocked + p.todo
}

fn mission_line(day: Day, row: ReadSignal<MissionRow>) -> impl IntoElement {
    let decision = move || {
        let id = row.with(|r| r.decision_id.clone());
        day.with_today(|t| {
            t.decisions
                .iter()
                .find(|d| Some(&d.id) == id.as_ref())
                .cloned()
        })
    };
    let state = move || row.with(|r| r.state);
    view()
        .gap_1p5()
        .border_t_1()
        .border_color(move || theme().border)
        .py_3p5()
        .child(
            view()
                .flex_row()
                .items_baseline()
                .gap_3()
                .child(
                    text(move || row.with(|r| r.title.clone()))
                        .flex_1()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(move || theme().foreground),
                )
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap_1p5()
                        .child(mark(move || state_mark(state())))
                        .child(
                            text(move || state_words(state()))
                                .text_xs()
                                .text_color(move || state_ink(state())),
                        ),
                ),
        )
        .child(
            view()
                .flex_row()
                .flex_wrap()
                .items_baseline()
                .gap_x_1p5()
                .child(
                    text(move || row.with(|r| r.line.clone()))
                        .text_sm()
                        .text_color(move || theme().muted_foreground),
                )
                .child(when(
                    move || decision().is_some(),
                    move || {
                        inline_action(
                            move || action_for(decision().as_ref()),
                            move || day.focus(row.with_untracked(|r| r.decision_id.clone())),
                        )
                    },
                )),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .pt_1()
                .child(track(move || row.with(|r| r.progress)))
                .child(
                    text(move || row.with(|r| r.stage.clone()))
                        .flex_1()
                        .text_xs()
                        .text_color(move || token("faint")),
                )
                .child(
                    text(move || {
                        row.with(|r| format!("{} of {} done", r.progress.done, total(&r.progress)))
                    })
                    .text_xs()
                    .text_color(move || token("faint")),
                ),
        )
}

fn decisions_section(day: Day) -> impl IntoElement {
    let decisions = computed(move || day.with_today(|t| t.decisions.clone()));
    let front = computed(move || {
        let focused = day.focused();
        decisions.with(|all| {
            all.iter()
                .find(|d| Some(&d.id) == focused.as_ref())
                .or(all.first())
                .cloned()
        })
    });
    let rest = move || {
        let front = front.with(|f| f.as_ref().map(|d| d.id.clone()));
        decisions.with(|all| {
            all.iter()
                .filter(|d| Some(&d.id) != front.as_ref())
                .cloned()
                .collect::<Vec<_>>()
        })
    };
    view()
        .gap_4()
        .child(section_title("Decisions", move || decisions.with(Vec::len)))
        .child(each(
            move || day.with_today(|t| t.notes.clone()),
            |note: &String| note.clone(),
            |note, _| {
                view()
                    .flex_row()
                    .items_center()
                    .gap_2p5()
                    .rounded_xl()
                    .bg(move || token("ok-soft"))
                    .px_4()
                    .py_3()
                    .child(mark(|| MarkKind::Ready))
                    .child(
                        text(move || note.get())
                            .flex_1()
                            .text_sm()
                            .text_color(move || token("ok-ink")),
                    )
            },
        ))
        .child(
            when(
                move || front.with(Option::is_some),
                move || {
                    each(
                        move || front.get().into_iter().collect::<Vec<_>>(),
                        |d: &Decision| d.id.clone(),
                        move |d, _| decision_card(day, d, decisions),
                    )
                },
            )
            .otherwise(|| {
                text("No decisions waiting. Pilot keeps going on its own.")
                    .text_base()
                    .text_color(move || theme().foreground)
            }),
        )
        .child(when(
            move || !rest().is_empty(),
            move || {
                view().gap_0p5().child(each(
                    rest,
                    |d: &Decision| d.id.clone(),
                    |d, _| {
                        view()
                            .flex_row()
                            .items_center()
                            .gap_2p5()
                            .py_1p5()
                            .child(mark(move || d.with(decision_mark)))
                            .child(
                                text("Up next: ")
                                    .flex_1()
                                    .text_sm()
                                    .text_color(move || theme().muted_foreground)
                                    .child(
                                        text(move || d.with(|d| d.title.clone()))
                                            .text_color(move || theme().foreground),
                                    ),
                            )
                            .child(
                                text(move || d.with(|d| d.effort.clone()))
                                    .text_xs()
                                    .text_color(move || token("faint")),
                            )
                    },
                ))
            },
        ))
}

fn mission_group(
    day: Day,
    label: &'static str,
    rows: impl Fn() -> Vec<MissionRow> + Copy + 'static,
) -> View {
    view()
        .child(
            text(move || format!("{label}  {}", rows().len()))
                .pb_1p5()
                .text_xs()
                .text_color(move || token("faint")),
        )
        .child(each(
            rows,
            |m: &MissionRow| m.id.clone(),
            move |m, _| mission_line(day, m),
        ))
}

fn missions_section(day: Day) -> impl IntoElement {
    let moving = move || day.with_today(|t| t.moving.clone());
    let not_moving = move || day.with_today(|t| t.not_moving.clone());
    view()
        .gap_3()
        .child(section_title("Missions", move || {
            day.with_today(|t| t.moving.len() + t.not_moving.len())
        }))
        .child(when(
            move || day.with_today(|t| !t.moving.is_empty()),
            move || mission_group(day, "Moving", moving),
        ))
        .child(when(
            move || day.with_today(|t| !t.not_moving.is_empty()),
            move || mission_group(day, "Not moving", not_moving).pt_3(),
        ))
}

fn done_mark(entry: &DoneEntry) -> MarkKind {
    if entry.evidence.iter().any(|e| e.tone == Tone::Bad) {
        MarkKind::Failed
    } else if entry.evidence.iter().any(|e| e.tone == Tone::Warn) {
        MarkKind::Needs
    } else {
        MarkKind::Done
    }
}

fn done_section(day: Day) -> impl IntoElement {
    view()
        .gap_1()
        .child(
            view()
                .flex_row()
                .items_baseline()
                .gap_2()
                .pb_2()
                .child(
                    text("Done since you looked")
                        .role(AccessibilityRole::Header)
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(move || theme().muted_foreground),
                )
                .child(
                    text(move || day.with_today(|t| t.last_looked.clone()))
                        .text_sm()
                        .text_color(move || token("faint")),
                ),
        )
        .child(each(
            move || day.with_today(|t| t.done.clone()),
            |e: &DoneEntry| e.id.clone(),
            |e, _| {
                view()
                    .flex_row()
                    .gap_3()
                    .py_2p5()
                    .child(view().pt_1p5().child(mark(move || e.with(done_mark))))
                    .child(
                        view()
                            .flex_1()
                            .gap_2()
                            .child(
                                text(move || e.with(|e| e.text.clone()))
                                    .text_sm()
                                    .text_color(move || theme().foreground),
                            )
                            .child(
                                view()
                                    .flex_row()
                                    .flex_wrap()
                                    .items_center()
                                    .gap_1p5()
                                    .child(each(
                                        move || e.with(|e| e.evidence.clone()),
                                        |x: &pilot_day_native::model::Evidence| x.label.clone(),
                                        |x, _| evidence_chip(x),
                                    ))
                                    .child(
                                        text(move || e.with(|e| e.mission_title.clone()))
                                            .text_xs()
                                            .text_color(move || token("faint")),
                                    ),
                            ),
                    )
            },
        ))
        .child(when(
            move || day.with_today(|t| t.done_hidden > 0),
            move || {
                text(move || {
                    day.with_today(|t| {
                        format!("{} earlier results are not shown here.", t.done_hidden)
                    })
                })
                .pt_1()
                .text_xs()
                .text_color(move || token("faint"))
            },
        ))
        .child(when(
            move || day.with_today(|t| !t.finished.is_empty()),
            move || {
                text(move || day.with_today(|t| format!("Finished: {}", t.finished.join(", "))))
                    .pt_2()
                    .text_xs()
                    .text_color(move || theme().muted_foreground)
            },
        ))
}

fn coming_up_section(day: Day) -> impl IntoElement {
    view()
        .gap_1()
        .child(view().pb_2().child(section_title("Coming up", || 0)))
        .child(each(
            move || day.with_today(|t| t.coming_up.clone()),
            |s: &Scheduled| s.id.clone(),
            |s, _| {
                view()
                    .flex_row()
                    .gap_3()
                    .py_2()
                    .child(
                        view()
                            .flex_1()
                            .gap_0p5()
                            .child(
                                text(move || s.with(|s| s.text.clone()))
                                    .text_sm()
                                    .text_color(move || theme().foreground),
                            )
                            .child(when(
                                move || s.with(|s| s.note.is_some()),
                                move || {
                                    text(move || s.with(|s| s.note.clone().unwrap_or_default()))
                                        .text_xs()
                                        .text_color(move || token("faint"))
                                },
                            )),
                    )
                    .child(
                        text(move || s.with(|s| s.when.clone()))
                            .text_xs()
                            .text_color(move || token("faint")),
                    )
            },
        ))
}

/// The whole Today screen for a store opened on `scenario`, with the
/// update workload running when `pulse` holds.
pub fn today(scenario: Scenario, pulse: bool) -> impl IntoElement {
    let day = Day::open(scenario);
    if pulse {
        day.pulse();
    }
    scroll().flex_1().bg(move || theme().background).child(
        view()
            .w_full()
            .max_w(px(COLUMN_WIDTH))
            .self_center()
            .gap_12()
            .px_6()
            .pb_24()
            .pt_6()
            .child(
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(view().size_4().rounded_md().bg(move || theme().primary))
                    .child(
                        text("Pilot")
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(move || theme().foreground),
                    )
                    .child(view().flex_1())
                    .child(
                        text("Mock data")
                            .text_xs()
                            .text_color(move || token("faint")),
                    ),
            )
            .child(
                view()
                    .gap_3()
                    .pt_6()
                    .child(
                        text(move || day.with_today(|t| t.date_line.clone()))
                            .text_xs()
                            .text_color(move || theme().muted_foreground),
                    )
                    .child(
                        text(move || headline(day))
                            .role(AccessibilityRole::Header)
                            .text_3xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            // Tailwind's leading-tight and tracking-tight (-0.025em of 30pt).
                            .line_height(LineHeight::Multiple(1.25))
                            .letter_spacing(px(-0.75))
                            .text_color(move || theme().foreground),
                    )
                    .child(
                        text(move || day.with_today(|t| t.summary.clone()))
                            .text_base()
                            // Tailwind's leading-relaxed.
                            .line_height(LineHeight::Multiple(1.625))
                            .text_color(move || theme().muted_foreground),
                    )
                    .child(when(
                        move || day.with_today(|t| t.left_off.is_some() && t.decisions.is_empty()),
                        move || {
                            text(move || day.with_today(|t| t.left_off.clone().unwrap_or_default()))
                                .text_xs()
                                .text_color(move || theme().primary)
                        },
                    )),
            )
            .child(decisions_section(day))
            .child(missions_section(day))
            .child(done_section(day))
            .child(coming_up_section(day))
            .child(
                text("That is everything for now. Pilot will tell you if something needs you.")
                    .border_t_1()
                    .border_color(move || theme().border)
                    .pt_5()
                    .text_xs()
                    .text_color(move || token("faint")),
            ),
    )
}

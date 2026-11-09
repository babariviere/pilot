//! The decision in front: what Pilot asks, help to decide, the choices, and
//! where the answer is. The Rust form of the TSX spike's
//! `DecisionCard.tsx`. The desk decides every state change; this card
//! sends intents and shows the outcome the desk publishes.

use nsh_base::{input, radio, radio_group, theme};
use nsh_core::{LineHeight, prelude::*};
use pilot_day_native::model::{
    Answer, DecideIntent, Decision, DecisionKind, DecisionOption, DecisionRef, Delivery, Evidence,
};

use crate::{
    day::{Day, Help},
    ui::{MarkKind, action, evidence_chip, help_chip, mark, token},
};

/// The mark a decision shows.
pub fn decision_mark(decision: &Decision) -> MarkKind {
    if decision.kind == DecisionKind::Unknown || decision.delivery == Delivery::Unknown {
        MarkKind::Unknown
    } else if decision.kind == DecisionKind::Failure {
        MarkKind::Failed
    } else if decision.kind == DecisionKind::Review {
        MarkKind::Ready
    } else {
        MarkKind::Needs
    }
}

fn commit_label(decision: &Decision) -> &'static str {
    match decision.kind {
        DecisionKind::Review => "Approve",
        DecisionKind::Approval => "Confirm",
        _ => "Decide",
    }
}

/// One sentence about where the user's answer is, or nothing while idle.
fn delivery_line(decision: &Decision) -> &'static str {
    match decision.delivery {
        Delivery::Sending => "Sending your answer…",
        Delivery::Checking => "Checking. This only reads; it changes nothing.",
        Delivery::Unknown if decision.kind != DecisionKind::Unknown => {
            "Pilot sent your answer but heard nothing back. It will not send it again until it checks."
        }
        _ => "",
    }
}

fn reason_ink(kind: MarkKind) -> AdaptiveColor {
    match kind {
        MarkKind::Needs | MarkKind::Unknown => token("needs-ink"),
        MarkKind::Failed => token("failed-ink"),
        MarkKind::Ready => token("ok-ink"),
        _ => theme().muted_foreground,
    }
}

/// A muted panel inside the card.
fn panel() -> View {
    view().rounded_xl().bg(move || theme().muted).px_4().py_3()
}

fn option_row(
    day: Day,
    d: ReadSignal<Decision>,
    o: ReadSignal<DecisionOption>,
) -> impl IntoElement {
    let checked = move || d.with(|d| day.chosen(d)) == o.with(|o| o.id.clone());
    let idle = move || d.with(|d| d.delivery == Delivery::Idle);
    radio()
        .checked(checked)
        .disabled(move || !idle())
        .on_change(move |_: &bool| {
            day.pick(
                &d.with_untracked(|d| d.id.clone()),
                &o.with_untracked(|o| o.id.clone()),
            );
        })
        .flex_row()
        .gap_3()
        .rounded_xl()
        .px_3()
        .py_2p5()
        .hover(|s| s.bg(theme().accent))
        // Hover outranks checked, and typed styles have no combined state
        // (the radio's `checked` is its prop), so the TSX classes reach
        // them, as the guides allow for states only a class can name.
        .app_class("checked:bg-selection checked:hover:bg-selection")
        .disabled_style(|s| s.opacity(0.7))
        .focus(|s| s.ring(px(2.0)).ring_color(theme().ring.opacity(0.4)))
        .child(
            view()
                .mt_0p5()
                .size_4()
                .items_center()
                .justify_center()
                .rounded_full()
                .border_1()
                .border_color(move || theme().input)
                .style_when(checked, |s| s.border_color(theme().primary))
                .child(
                    view()
                        .size_2()
                        .rounded_full()
                        .style_when(checked, |s| s.bg(theme().primary)),
                ),
        )
        .child(
            view()
                .flex_1()
                .gap_0p5()
                .child(
                    view()
                        .flex_row()
                        .flex_wrap()
                        .items_baseline()
                        .gap_2()
                        .child(
                            text(move || o.with(|o| o.label.clone()))
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(move || theme().card_foreground),
                        )
                        .child(when(
                            move || o.with(|o| o.recommended),
                            || {
                                text("Recommended")
                                    .text_xs()
                                    .text_color(move || theme().muted_foreground)
                            },
                        )),
                )
                .child(
                    text(move || o.with(|o| o.detail.clone()))
                        .text_xs()
                        .text_color(move || theme().muted_foreground),
                ),
        )
}

/// The decision `d`, one of `decisions`.
pub fn decision_card(
    day: Day,
    d: ReadSignal<Decision>,
    decisions: Memo<Vec<Decision>>,
) -> impl IntoElement {
    let id = move || d.with(|d| d.id.clone());
    let idle = move || d.with(|d| d.delivery == Delivery::Idle);
    let needs_check = move || d.with(|d| d.delivery == Delivery::Unknown);
    let checking = move || d.with(|d| d.delivery == Delivery::Checking);
    let count = move || decisions.with(Vec::len);
    let index = move || {
        let id = id();
        decisions.with(|all| all.iter().position(|x| x.id == id).unwrap_or(0))
    };
    let kind = move || d.with(decision_mark);
    let open = move |help: Help| day.help_open(&id(), help);
    let toggle = move |help: Help| move |on: bool| day.set_help(&id(), help, on);
    let reference = move || {
        d.with_untracked(|d| DecisionRef {
            decision_id: d.id.clone(),
            revision: d.revision,
        })
    };

    let decide = move || {
        let (intent, id) = d.with_untracked(|now| {
            (
                DecideIntent {
                    decision_id: now.id.clone(),
                    revision: now.revision,
                    option_id: day.chosen(now),
                },
                now.id.clone(),
            )
        });
        day.say(&id, "");
        day.decide(intent, move |outcome| day.say(&id, &outcome.message));
    };
    let check = move || {
        let intent = reference();
        let id = intent.decision_id.clone();
        day.say(&id, "");
        day.check(intent, move |outcome| day.say(&id, &outcome.message));
    };
    let later = move || {
        let intent = reference();
        let id = intent.decision_id.clone();
        let outcome = day.later(intent);
        day.say(&id, &outcome.message);
    };
    let ask = move || day.send_question(&d.with_untracked(|d| d.id.clone()));

    view()
        .test_id("decision")
        .gap_4()
        .rounded_2xl()
        .border_1()
        .border_color(move || token("border-strong"))
        .bg(move || theme().card)
        .px_6()
        .py_6()
        // Title, reason, mission and place in the queue.
        .child(
            view()
                .gap_2()
                .child(
                    text(move || d.with(|d| d.title.clone()))
                        .role(AccessibilityRole::Header)
                        .text_xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        // Tailwind's leading-snug.
                        .line_height(LineHeight::Multiple(1.375))
                        .text_color(move || theme().card_foreground),
                )
                .child(
                    view()
                        .flex_row()
                        .flex_wrap()
                        .items_center()
                        .gap_1p5()
                        .child(mark(kind))
                        .child(
                            text(move || d.with(|d| d.reason.clone()))
                                .text_xs()
                                .text_color(move || reason_ink(kind())),
                        )
                        .child(
                            text(move || {
                                d.with(|d| format!("· {} · {}", d.mission_title, d.effort))
                            })
                            .text_xs()
                            .text_color(move || theme().muted_foreground),
                        )
                        .child(view().flex_1())
                        .child(when(
                            move || count() > 1,
                            move || {
                                text(move || format!("{} of {}", index() + 1, count()))
                                    .text_xs()
                                    .text_color(move || token("faint"))
                            },
                        )),
                ),
        )
        .child(
            text(move || {
                if open(Help::Simpler) {
                    d.with(|d| d.simpler.clone())
                } else {
                    d.with(|d| d.context.clone())
                }
            })
            .text_sm()
            .line_height(LineHeight::Multiple(1.625))
            .text_color(move || theme().card_foreground),
        )
        // Help to decide.
        .child(
            view()
                .flex_row()
                .flex_wrap()
                .gap_1p5()
                .child(help_chip(
                    "Say it simpler",
                    move || open(Help::Simpler),
                    toggle(Help::Simpler),
                ))
                .child(help_chip(
                    "More context",
                    move || open(Help::More),
                    toggle(Help::More),
                ))
                .child(help_chip(
                    "Ask a question",
                    move || open(Help::Ask),
                    toggle(Help::Ask),
                ))
                .child(when(
                    move || d.with(|d| d.details.is_some()),
                    move || {
                        help_chip(
                            "What was pushed",
                            move || open(Help::Details),
                            toggle(Help::Details),
                        )
                    },
                )),
        )
        .child(when(
            move || open(Help::More),
            move || {
                panel().gap_1p5().child(each(
                    move || d.with(|d| d.more.clone()),
                    |line: &String| line.clone(),
                    |line, _| {
                        text(move || line.get())
                            .text_sm()
                            .text_color(move || theme().foreground)
                    },
                ))
            },
        ))
        .child(when(
            move || open(Help::Details) && d.with(|d| d.details.is_some()),
            move || {
                panel().child(
                    text(move || d.with(|d| d.details.clone().unwrap_or_default()))
                        .text_sm()
                        .text_color(move || theme().foreground),
                )
            },
        ))
        .child(when(
            move || open(Help::Ask),
            move || {
                panel()
                    .gap_3()
                    .child(each(
                        move || d.with(|d| d.answers.clone()),
                        |a: &Answer| format!("{}\u{0}{}", a.question, a.answer),
                        |a, _| {
                            view()
                                .gap_1()
                                .child(
                                    text(move || a.with(|a| a.question.clone()))
                                        .text_sm()
                                        .text_color(move || theme().muted_foreground),
                                )
                                .child(
                                    text(move || a.with(|a| a.answer.clone()))
                                        .text_sm()
                                        .text_color(move || theme().foreground),
                                )
                        },
                    ))
                    .child(
                        view()
                            .flex_row()
                            .items_center()
                            .gap_2()
                            .child(
                                input()
                                    .test_id("question")
                                    .value(move || day.draft(&id()))
                                    .on_change(move |text: &str| day.set_draft(&id(), text))
                                    .on_submit(move |_: &str| ask())
                                    .submit_behavior(SubmitBehavior::Submit)
                                    .placeholder("Ask about this decision")
                                    .min_h_8()
                                    .flex_1()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(move || theme().input)
                                    .bg(move || theme().background)
                                    .px_3()
                                    .py_1p5()
                                    .text_sm()
                                    .text_color(move || theme().foreground)
                                    .focus(|s| s.border_color(theme().primary)),
                            )
                            .child(action(
                                move || {
                                    if day.asking(&id()) {
                                        "Asking…"
                                    } else {
                                        "Ask"
                                    }
                                },
                                false,
                                move || day.asking(&id()),
                                ask,
                            )),
                    )
            },
        ))
        .child(when(
            move || d.with(|d| !d.tried.is_empty()),
            move || {
                view().gap_1().pl_1().child(each(
                    move || d.with(|d| d.tried.clone()),
                    |line: &String| line.clone(),
                    |line, _| {
                        text(move || format!("• {}", line.get()))
                            .text_xs()
                            .text_color(move || theme().muted_foreground)
                    },
                ))
            },
        ))
        .child(
            text(move || d.with(|d| d.boundary.clone()))
                .text_xs()
                .line_height(LineHeight::Multiple(1.625))
                .text_color(move || theme().muted_foreground),
        )
        // The choices.
        .child(when(
            move || d.with(|d| d.options.len() > 1),
            move || {
                radio_group().gap_1().child(each(
                    move || d.with(|d| d.options.clone()),
                    |o: &DecisionOption| o.id.clone(),
                    move |o, _| option_row(day, d, o),
                ))
            },
        ))
        // Where the answer is.
        .child(when(
            move || !d.with(delivery_line).is_empty(),
            move || {
                text(move || d.with(delivery_line))
                    .role(AccessibilityRole::Alert)
                    .text_sm()
                    .text_color(move || theme().muted_foreground)
            },
        ))
        .child(when(
            move || !day.message(&id()).is_empty(),
            move || {
                text(move || day.message(&id()))
                    .role(AccessibilityRole::Alert)
                    .text_sm()
                    .text_color(move || token("needs-ink"))
            },
        ))
        // The commit, a check, or Later.
        .child(
            view()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap_2()
                .child(
                    when(
                        move || needs_check() || checking(),
                        move || action("Check again", true, checking, check),
                    )
                    .otherwise(move || {
                        action(move || d.with(commit_label), true, move || !idle(), decide)
                    }),
                )
                .child(when(
                    move || count() > 1,
                    move || action("Later", false, move || !idle(), later),
                )),
        )
        .child(when(
            move || d.with(|d| !d.evidence.is_empty()),
            move || {
                view().flex_row().flex_wrap().gap_1p5().child(each(
                    move || d.with(|d| d.evidence.clone()),
                    |e: &Evidence| e.label.clone(),
                    |e, _| evidence_chip(e),
                ))
            },
        ))
}

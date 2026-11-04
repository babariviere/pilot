//! Decisions share Browser's already-bounded reader, scroll and mounted focus owner.
use super::*;
use crate::{
    mission_decision_resolve::{self as resolve, Attempts, Choice, Outcome},
    mission_decisions::{
        Decision, Kind, Proposal as Suggestion, Retired, Section, Text as BoundedText,
    },
};
use gpui_kit::component::ActiveTheme;
use std::{cell::RefCell, collections::HashSet, rc::Rc};

#[derive(Default)]
pub(crate) struct Disclosure {
    pub(super) opened: bool,
    source: bool,
    expanded: HashSet<String>,
    decisions: usize,
    proposals: usize,
    /// Retired (withdrawn or replaced) rows, behind their own disclosure.
    retired: bool,
    retired_rows: usize,
    /// Element a Needs you row asked to bring to the top, until it paints.
    reveal: Rc<RefCell<Option<String>>>,
    /// User responses to withdrawal proposals. Kept across refresh; never replayed.
    attempts: Attempts,
    sending: Option<Task<()>>,
}
#[derive(Clone, Copy)]
enum More {
    Current,
    Retired,
    Proposals,
}
impl Disclosure {
    pub(super) fn reconcile(&mut self, d: &Detail) {
        if let Ok(s) = &d.decisions {
            let ids: HashSet<String> = s
                .decisions
                .rows
                .iter()
                .flatten()
                .map(|d| format!("current-{}", d.id))
                .chain(
                    s.proposals
                        .rows
                        .iter()
                        .flatten()
                        .map(|p| format!("proposal-{}", p.id)),
                )
                .collect();
            self.expanded.retain(|id| ids.contains(id));
        }
    }
    /// The mission whose withdrawal response is still unanswered.
    pub(super) fn sending(&self) -> Option<&Key> {
        self.attempts.sending().map(|s| &s.source.key)
    }
}
impl Browser {
    pub(super) fn can_review(&self, generation: u64) -> bool {
        self.generation == generation && self.decision_source().is_some()
    }
    /// Opens Decisions on one pending proposal, or on the pending proposals,
    /// and scrolls it to the top of the page once it paints.
    pub(super) fn reveal_proposal(
        &mut self,
        id: Option<String>,
        generation: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_review(generation) || self.brief_marked(w, cx) {
            return;
        }
        let index = self.decision_source().and_then(|d| {
            let s = d.decisions.as_ref().ok()?;
            s.proposals
                .rows
                .iter()
                .flatten()
                .position(|p| Some(&p.id) == id.as_ref())
        });
        let key = match (id, index) {
            (Some(id), Some(i)) => {
                self.decisions.proposals = self.decisions.proposals.max(i + 1);
                self.decisions.expanded.insert(format!("proposal-{id}"));
                format!("proposal-{id}")
            }
            _ => "proposals".to_owned(),
        };
        self.decisions.opened = true;
        *self.decisions.reveal.borrow_mut() = Some(key);
        self.focus.focus(w, cx);
        cx.notify();
    }
    /// Scrolls the page so this element's top meets the viewport's, once.
    fn reveal_anchor(&self, key: String) -> Option<impl IntoElement + use<>> {
        (self.decisions.reveal.borrow().as_ref() == Some(&key)).then(|| {
            let (reveal, handle) = (self.decisions.reveal.clone(), self.detail_scroll.clone());
            gpui_kit::canvas(
                move |b, w, _| {
                    if reveal.borrow_mut().take_if(|k| *k == key).is_some() {
                        let top = b.top() - handle.offset().y;
                        let y = (handle.bounds().top() - top).min(px(0.));
                        handle.set_offset(gpui_kit::point(handle.offset().x, y));
                        w.refresh();
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_0()
        })
    }
    fn decision_source(&self) -> Option<&Arc<Detail>> {
        let d = self.detail.as_ref()?;
        (self.route == Some(Route::Detail(d.key.clone()))
            && self.local_home().as_ref() == Some(&d.key.home)
            && self.catalog.as_ref().is_some_and(|c| {
                c.rows.iter().any(|r| {
                    r.key == d.key
                        && r.sources
                            .iter()
                            .any(|s| s.canonical && s.home == d.key.home && s.project == d.project)
                })
            }))
        .then_some(d)
    }
    fn decision_matches(&self, d: &Arc<Detail>, generation: u64) -> bool {
        self.generation == generation
            && self
                .decision_source()
                .is_some_and(|current| Arc::ptr_eq(current, d))
    }
    fn decision_text(&self, id: String, text: &BoundedText) -> impl IntoElement {
        let focus = self.focus.clone();
        div().id(SharedString::from(id.clone())).test_support().w_full().min_w_0()
            .text_size(px(Text::Body.size())).line_height(px(Text::Body.size() * 1.6))
            .on_mouse_down(gpui_kit::MouseButton::Left, move |_, w, cx| focus.focus(w, cx))
            .child(SelectableText::new(
                SharedString::from(format!("{id}-{}", self.generation)),
                SharedString::from(if text.value.is_empty() {
                    if text.clipped { "(Text omitted by the viewing limit)".into() } else { "(Empty text)".into() }
                } else { text.value.clone() }),
            ))
            .children(text.clipped.then(|| Notice::new("Text capped. Copy includes only the displayed text, not the full saved content.").tone(Tone::Warning)))
    }
    fn decision_copy(
        &self,
        id: String,
        text: String,
        label: &'static str,
        d: &Arc<Detail>,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let d = d.clone();
        let generation = self.generation;
        ui::action(SharedString::from(id), label, Action::Quiet)
            .self_start()
            .on_click(cx.listener(move |v, _, _, cx| {
                if v.decision_matches(&d, generation) {
                    cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                }
            }))
    }
    fn decision_toggle(
        &self,
        id: String,
        label: String,
        d: &Arc<Detail>,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let d = d.clone();
        let generation = self.generation;
        ui::action(
            SharedString::from(format!("decisions-toggle-{id}")),
            SharedString::from(label),
            Action::Secondary,
        )
        .self_start()
        .on_click(cx.listener(move |v, _, w, cx| {
            if !v.decision_matches(&d, generation) || v.brief_marked(w, cx) {
                return;
            }
            v.focus.focus(w, cx);
            if !v.decisions.expanded.remove(&id) {
                v.decisions.expanded.insert(id.clone());
            }
            cx.notify();
        }))
    }
    pub(super) fn decisions_view(&self, cx: &Context<Self>) -> impl IntoElement {
        let generation = self.generation;
        let mut section = div()
            .id("mission-decisions")
            .test_support()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if v.brief_marked(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .v_flex()
            .w_full()
            .min_w_0()
            .gap(px(Space::CONTROL))
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .flex_wrap()
                    .children(self.decisions.opened.then(|| {
                        div().flex_1().child(ui::heading(
                            "decisions-heading",
                            "Decisions",
                            Text::Headline,
                        ))
                    }))
                    .child(
                        div()
                            .h_flex()
                            .flex_wrap()
                            .gap_2()
                            .child(
                                ui::action(
                                    "mission-decisions-open",
                                    if self.decisions.opened {
                                        "Hide"
                                    } else {
                                        "Read decisions"
                                    },
                                    if self.decisions.opened {
                                        Action::Quiet
                                    } else {
                                        Action::Secondary
                                    },
                                )
                                .on_click(cx.listener(
                                    move |v, _, w, cx| {
                                        if v.generation != generation || v.brief_marked(w, cx) {
                                            return;
                                        }
                                        v.focus.focus(w, cx);
                                        v.decisions.opened = !v.decisions.opened;
                                        cx.notify();
                                    },
                                )),
                            )
                            .children(self.completion_action(generation, cx)),
                    ),
            );
        if !self.decisions.opened {
            return section;
        }
        section = section.child(
            ui::text(Text::Caption, "Binding decisions override the brief.")
                .text_color(cx.theme().muted_foreground),
        );
        let Some(d) = self.decision_source() else {
            return section.child(
                Notice::new(
                    "Decision source differs or is unavailable. No decision details are shown.",
                )
                .tone(Tone::Warning),
            );
        };
        if self.busy || self.error.is_some() || !self.online {
            section = section.child(
                div().id("decisions-stale").test_support().child(
                    Notice::new("Retained snapshot, not current. Refresh the mission to update.")
                        .tone(Tone::Warning),
                ),
            );
        }
        let source = d.clone();
        section = section.child(
            ui::action(
                "decisions-source",
                if self.decisions.source {
                    "Hide source"
                } else {
                    "Show source"
                },
                Action::Quiet,
            )
            .self_start()
            .on_click(cx.listener(move |v, _, w, cx| {
                if !v.decision_matches(&source, generation) || v.brief_marked(w, cx) {
                    return;
                }
                v.focus.focus(w, cx);
                v.decisions.source = !v.decisions.source;
                cx.notify();
            })),
        );
        if self.decisions.source {
            section = section.child(self.decision_text("decisions-source-text".into(), &BoundedText {
                value: format!("Mission {}\nProject {}\nHome {} / {}\nLocal mission detail GET · snapshot {}\nNo decision revision or compare-and-swap token is supplied. Proposal targets refer to the current snapshot, not a captured target revision.", d.key.id, d.project, d.key.home.daemon, d.key.home.lineage, generation),
                clipped: false,
            }));
        }
        let snapshot = match &d.decisions {
            Ok(s) => s,
            Err(e) => {
                return section.child(
                    div()
                        .id("decisions-error")
                        .test_support()
                        .child(Notice::new(*e).tone(Tone::Error)),
                );
            }
        };
        let all = snapshot.decisions.rows.as_deref().unwrap_or_default();
        let retired: Vec<&Decision> = all.iter().filter(|r| !r.active()).collect();
        section = section
            .child(
                ui::text(Text::Label, "Current decisions")
                    .font_semibold()
                    .id("decisions-current-heading")
                    .test_support(),
            )
            .child(coverage(
                &snapshot.decisions,
                "decisions",
                retired.len(),
                cx,
            ));
        let current: Vec<&Decision> = all.iter().filter(|r| r.active()).collect();
        let limit = self.decisions.decisions.max(8);
        for item in current.iter().take(limit) {
            section = section.child(self.decision_row(item, all, d, cx));
        }
        if current.len() > limit {
            section = section.child(self.decision_more(More::Current, d, cx));
        }
        if !retired.is_empty() {
            let source = d.clone();
            section = section.child(
                ui::action(
                    "decisions-retired",
                    if self.decisions.retired {
                        "Hide retired".to_owned()
                    } else {
                        format!("Show retired ({})", retired.len())
                    },
                    Action::Quiet,
                )
                .self_start()
                .on_click(cx.listener(move |v, _, w, cx| {
                    if !v.decision_matches(&source, generation) || v.brief_marked(w, cx) {
                        return;
                    }
                    v.focus.focus(w, cx);
                    v.decisions.retired = !v.decisions.retired;
                    cx.notify();
                })),
            );
            if self.decisions.retired {
                let limit = self.decisions.retired_rows.max(8);
                for item in retired.iter().take(limit) {
                    section = section.child(self.decision_row(item, all, d, cx));
                }
                if retired.len() > limit {
                    section = section.child(self.decision_more(More::Retired, d, cx));
                }
            }
        }
        section = section
            .child(
                div()
                    .relative()
                    .child(
                        ui::text(Text::Label, "Pending proposals")
                            .font_semibold()
                            .id("decisions-proposals-heading")
                            .test_support(),
                    )
                    .children(self.reveal_anchor("proposals".into())),
            )
            .child(
                ui::text(
                    Text::Caption,
                    "Untrusted suggestions. Current decisions stay binding.",
                )
                .text_color(cx.theme().muted_foreground),
            )
            .child(coverage(&snapshot.proposals, "pending proposals", 0, cx));
        if let Some(rows) = &snapshot.proposals.rows {
            for proposal in rows.iter().take(self.decisions.proposals.max(8)) {
                let id = format!("proposal-{}", proposal.id);
                let expanded = self.decisions.expanded.contains(&id);
                let target_row = all.iter().find(|d| d.id == proposal.target);
                let target = target_row
                    .map(|d| format!("D{}", d.number))
                    .unwrap_or_else(|| "Unknown (missing, removed or outside this window)".into());
                let mut row = div()
                    .id(SharedString::from(format!(
                        "decisions-proposal-{}",
                        proposal.id
                    )))
                    .test_support()
                    .relative()
                    .v_flex()
                    .w_full()
                    .min_w_0()
                    .gap(px(Space::CONTROL))
                    .p(px(Space::SIDEBAR))
                    .bg(ui::Surface::Tray.color(cx))
                    .rounded(px(ui::Radius::ROW))
                    .children(self.reveal_anchor(id.clone()))
                    .child(
                        ui::text(
                            Text::Body,
                            match proposal.kind {
                                Kind::Edit => "Proposed edit",
                                Kind::Remove => "Proposed removal",
                                Kind::Withdraw => "Proposed withdrawal",
                            },
                        )
                        .font_semibold(),
                    )
                    .child(
                        ui::text(Text::Caption, "Pending · Unadopted")
                            .text_color(cx.theme().muted_foreground),
                    )
                    .child(ui::text(
                        Text::Caption,
                        SharedString::from(format!("Target: {target}")),
                    ));
                if expanded {
                    row = row
                        .child(
                            div()
                                .h_flex()
                                .items_center()
                                .justify_between()
                                .child(ui::text(Text::Label, "Reason").font_semibold())
                                .child(self.decision_copy(
                                    format!("proposal-copy-reason-{}", proposal.id),
                                    proposal.reason.value.clone(),
                                    "Copy reason",
                                    d,
                                    cx,
                                )),
                        )
                        .child(self.decision_text(
                            format!("proposal-reason-{}", proposal.id),
                            &proposal.reason,
                        ));
                    match proposal.kind {
                        Kind::Remove => {
                            row =
                                row.child(ui::text(Text::Body, "Suggests removing this decision."))
                        }
                        Kind::Withdraw => {
                            row = row.child(ui::text(
                                Text::Body,
                                "Retires this decision. Its text and history stay.",
                            ))
                        }
                        Kind::Edit => {}
                    }
                    if let Some(text) = &proposal.text {
                        row = row
                            .child(
                                div()
                                    .h_flex()
                                    .items_center()
                                    .justify_between()
                                    .child(ui::text(Text::Label, "Proposed text").font_semibold())
                                    .child(self.decision_copy(
                                        format!("proposal-copy-{}", proposal.id),
                                        text.value.clone(),
                                        "Copy proposed text",
                                        d,
                                        cx,
                                    )),
                            )
                            .child(
                                self.decision_text(format!("proposal-text-{}", proposal.id), text),
                            );
                    } else if proposal.kind == Kind::Edit {
                        row = row.child(Notice::new("No proposed text supplied."));
                    }
                    if proposal.kind == Kind::Withdraw {
                        row = row.child(self.withdrawal_actions(proposal, target_row, d, cx));
                    }
                    row = row.child(
                        ui::text(
                            Text::Caption,
                            SharedString::from(match &proposal.operation {
                                Some(op) => format!(
                                    "Proposal {} · target {} · operation {op}",
                                    proposal.id, proposal.target
                                ),
                                None => {
                                    format!("Proposal {} · target {}", proposal.id, proposal.target)
                                }
                            }),
                        )
                        .text_color(cx.theme().muted_foreground),
                    );
                } else {
                    row = row.child(ui::text(
                        Text::Body,
                        SharedString::from(format!("Reason: {}", preview(&proposal.reason))),
                    ));
                }
                row = row.child(self.decision_toggle(
                    id,
                    if expanded {
                        "Show less".into()
                    } else {
                        "Read proposal".into()
                    },
                    d,
                    cx,
                ));
                section = section.child(row);
            }
            if rows.len() > self.decisions.proposals.max(8) {
                section = section.child(self.decision_more(More::Proposals, d, cx));
            }
        }
        section
    }
    /// One decision. Retired rows keep their original text; the reason and the
    /// successor link are explicit, never inferred or copied from another row.
    fn decision_row(
        &self,
        item: &Decision,
        all: &[Decision],
        d: &Arc<Detail>,
        cx: &Context<Self>,
    ) -> gpui_kit::AnyElement {
        let id = format!("current-{}", item.id);
        let expanded = self.decisions.expanded.contains(&id);
        let muted = cx.theme().muted_foreground;
        let status = match &item.retired {
            None => None,
            Some(Retired::Withdrawn { .. }) => Some("Withdrawn".to_owned()),
            Some(Retired::Replaced { number, .. }) => Some(format!("Replaced by D{number}")),
        };
        let mut row = div()
            .id(SharedString::from(format!("decisions-row-{}", item.id)))
            .test_support()
            .relative()
            .v_flex()
            .min_w_0()
            .gap(px(Space::CONTROL))
            .py(px(Space::SIDEBAR))
            .border_b_1()
            .border_color(cx.theme().border)
            .children(self.reveal_anchor(id.clone()))
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(Space::CONTROL))
                    .child(
                        ui::text(Text::Body, SharedString::from(format!("D{}", item.number)))
                            .font_semibold(),
                    )
                    .child(ui::text(Text::Caption, item.audience).text_color(muted))
                    .children(status.map(|s| {
                        ui::text(Text::Caption, SharedString::from(s))
                            .font_semibold()
                            .id(SharedString::from(format!("decisions-status-{}", item.id)))
                            .test_support()
                    })),
            );
        if expanded {
            row = row.child(self.decision_text(format!("decisions-text-{}", item.id), &item.text));
            if let Some(Retired::Withdrawn { reason, proposal }) = &item.retired {
                row = row
                    .child(
                        div()
                            .h_flex()
                            .items_center()
                            .justify_between()
                            .child(ui::text(Text::Label, "Reason").font_semibold())
                            .child(self.decision_copy(
                                format!("decisions-copy-reason-{}", item.id),
                                reason.value.clone(),
                                "Copy reason",
                                d,
                                cx,
                            )),
                    )
                    .child(self.decision_text(format!("decisions-reason-{}", item.id), reason))
                    .child(
                        ui::text(
                            Text::Caption,
                            SharedString::from(format!("Accepted proposal {proposal}")),
                        )
                        .text_color(muted),
                    );
            }
        } else {
            let text = ui::text(Text::Body, SharedString::from(preview(&item.text)));
            row = row.child(if item.active() {
                text
            } else {
                text.text_color(muted)
            });
        }
        let successor = match &item.retired {
            Some(Retired::Replaced { id, number }) => Some((id, *number)),
            _ => None,
        };
        row.child(
            div()
                .h_flex()
                .flex_wrap()
                .items_center()
                .gap(px(Space::CONTROL))
                .child(self.decision_toggle(
                    id,
                    if expanded {
                        "Show less".into()
                    } else {
                        "Read full text".into()
                    },
                    d,
                    cx,
                ))
                .children(expanded.then(|| {
                    self.decision_copy(
                        format!("decisions-copy-{}", item.id),
                        item.text.value.clone(),
                        "Copy text",
                        d,
                        cx,
                    )
                }))
                .children(successor.map(|(next, number)| {
                    if all.iter().any(|r| &r.id == next) {
                        let (source, next, generation) = (d.clone(), next.clone(), self.generation);
                        ui::action(
                            SharedString::from(format!("decisions-successor-{}", item.id)),
                            SharedString::from(format!("Go to D{number}")),
                            Action::Quiet,
                        )
                        .on_click(cx.listener(move |v, _, w, cx| {
                            v.go_to_decision(&source, generation, &next, w, cx)
                        }))
                        .into_any_element()
                    } else {
                        ui::text(
                            Text::Caption,
                            SharedString::from(format!("D{number} isn't in this view.")),
                        )
                        .text_color(muted)
                        .into_any_element()
                    }
                })),
        )
        .into_any_element()
    }
    /// Expands and scrolls to a decision listed in this exact snapshot.
    fn go_to_decision(
        &mut self,
        d: &Arc<Detail>,
        generation: u64,
        id: &str,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.decision_matches(d, generation) || self.brief_marked(w, cx) {
            return;
        }
        let Ok(s) = &d.decisions else {
            return;
        };
        let all = s.decisions.rows.as_deref().unwrap_or_default();
        let Some(target) = all.iter().find(|r| r.id == id) else {
            return;
        };
        let index = all
            .iter()
            .filter(|r| r.active() == target.active())
            .position(|r| r.id == id)
            .unwrap_or_default();
        if target.active() {
            self.decisions.decisions = self.decisions.decisions.max(index + 1);
        } else {
            self.decisions.retired = true;
            self.decisions.retired_rows = self.decisions.retired_rows.max(index + 1);
        }
        let key = format!("current-{id}");
        self.decisions.expanded.insert(key.clone());
        *self.decisions.reveal.borrow_mut() = Some(key);
        self.focus.focus(w, cx);
        cx.notify();
    }
    fn can_resolve(&self, d: &Arc<Detail>, generation: u64) -> bool {
        self.decision_matches(d, generation)
            && self.online
            && !self.busy
            && self.error.is_none()
            && self.catalog_current
            && self.decisions.attempts.sending().is_none()
    }
    /// Explicit user response to one exact pending withdrawal. Only a confirmed
    /// POST reports success; a refresh shows the durable state.
    fn withdrawal_actions(
        &self,
        p: &Suggestion,
        target: Option<&Decision>,
        d: &Arc<Detail>,
        cx: &Context<Self>,
    ) -> gpui_kit::AnyElement {
        let generation = self.generation;
        let attempt = self
            .brief_source()
            .and_then(|s| self.decisions.attempts.get(&s, &p.id));
        let open = attempt.is_none_or(|(_, o)| matches!(o, Outcome::NotSent(_)));
        let ready = open && self.can_resolve(d, generation);
        let mut block = div().v_flex().min_w_0().gap(px(Space::CONTROL));
        if let Some((send, outcome)) = attempt {
            let (text, tone) = match outcome {
                Outcome::Pending => ("Sending…".to_owned(), Tone::Normal),
                Outcome::Ack if send.choice == Choice::Accept => {
                    ("Withdrawn. Refresh to update.".to_owned(), Tone::Success)
                }
                Outcome::Ack => ("Kept. Refresh to update.".to_owned(), Tone::Success),
                Outcome::NotSent(e) => ((*e).to_owned(), Tone::Error),
                Outcome::Unknown(e) => (
                    format!("Outcome unknown. {e} Refresh to check; don't repeat it."),
                    Tone::Warning,
                ),
            };
            block = block.child(
                div()
                    .id(SharedString::from(format!("proposal-result-{}", p.id)))
                    .test_support()
                    .child(Notice::new(SharedString::from(text)).tone(tone)),
            );
        }
        if !open {
            return block.into_any_element();
        }
        let number = target.map(|t| t.number);
        let action = |choice: Choice| {
            let (d, id) = (d.clone(), p.id.clone());
            cx.listener(move |v: &mut Self, _: &gpui_kit::ClickEvent, w, cx| {
                v.resolve_withdrawal(&d, generation, &id, choice, w, cx)
            })
        };
        block
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap(px(Space::CONTROL))
                    .child(
                        ui::action(
                            SharedString::from(format!("proposal-withdraw-{}", p.id)),
                            SharedString::from(
                                number.map_or("Withdraw".into(), |n| format!("Withdraw D{n}")),
                            ),
                            Action::Secondary,
                        )
                        .disabled(!ready || !target.is_some_and(Decision::active))
                        .tooltip("Accept this withdrawal")
                        .on_click(action(Choice::Accept)),
                    )
                    .child(
                        ui::action(
                            SharedString::from(format!("proposal-keep-{}", p.id)),
                            SharedString::from(
                                number.map_or("Keep".into(), |n| format!("Keep D{n}")),
                            ),
                            Action::Quiet,
                        )
                        .disabled(!ready)
                        .tooltip("Reject this withdrawal")
                        .on_click(action(Choice::Reject)),
                    ),
            )
            .into_any_element()
    }
    fn resolve_withdrawal(
        &mut self,
        d: &Arc<Detail>,
        generation: u64,
        id: &str,
        choice: Choice,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_resolve(d, generation) || self.brief_marked(w, cx) {
            return;
        }
        let (Some(options), Some(source)) = (self.options.clone(), self.brief_source()) else {
            return;
        };
        if !self.catalog.as_ref().is_some_and(|c| source.canonical(c)) {
            return;
        }
        let Ok(s) = &d.decisions else {
            return;
        };
        let Some(p) = s.proposals.rows.iter().flatten().find(|p| p.id == id) else {
            return;
        };
        let active = s
            .decisions
            .rows
            .iter()
            .flatten()
            .find(|r| r.id == p.target)
            .is_some_and(Decision::active);
        let Ok(send) = self.decisions.attempts.begin(&source, p, active, choice) else {
            return;
        };
        // The pressed control leaves with its row's actions; the page keeps focus.
        self.focus.focus(w, cx);
        match resolve::start(options, send.clone()) {
            Err(e) => {
                self.decisions.attempts.finish(&send, Outcome::NotSent(e));
            }
            Ok(output) => {
                self.decisions.sending = Some(cx.spawn(async move |view, cx| {
                    let outcome = output.recv().await.unwrap_or(Outcome::Unknown(
                        "Couldn't confirm the response. It may have applied.",
                    ));
                    let _ = view.update(cx, |v, cx| {
                        v.decisions.attempts.finish(&send, outcome);
                        cx.notify();
                    });
                }));
            }
        }
        cx.notify();
    }
    fn decision_more(&self, which: More, d: &Arc<Detail>, cx: &Context<Self>) -> impl IntoElement {
        let d = d.clone();
        let generation = self.generation;
        ui::action(
            match which {
                More::Current => "decisions-more-current",
                More::Retired => "decisions-more-retired",
                More::Proposals => "decisions-more-proposals",
            },
            "Show 8 more",
            Action::Quiet,
        )
        .self_start()
        .on_click(cx.listener(move |v, _, w, cx| {
            if !v.decision_matches(&d, generation) || v.brief_marked(w, cx) {
                return;
            }
            let count = match which {
                More::Current => &mut v.decisions.decisions,
                More::Retired => &mut v.decisions.retired_rows,
                More::Proposals => &mut v.decisions.proposals,
            };
            *count = (*count)
                .max(8)
                .saturating_add(8)
                .min(crate::mission_decisions::ITEM_CAP);
            v.focus.focus(w, cx);
            cx.notify();
        }))
    }
}
fn preview(text: &BoundedText) -> String {
    if text.value.is_empty() && text.clipped {
        return "Text omitted by the viewing limit.".into();
    }
    let first = text.value.lines().next().unwrap_or("(Empty text)");
    let mut preview: String = first.chars().take(160).collect();
    if text.value.len() > preview.len() || text.clipped {
        preview.push('…');
    }
    preview
}
fn coverage<T>(section: &Section<T>, noun: &str, retired: usize, cx: &App) -> impl IntoElement {
    let text = match &section.rows {
        None => format!("{noun} not supplied. Coverage is unknown, not empty."),
        Some(rows) if section.capped => format!(
            "{} {noun} shown · first 128 of {} records checked. Capped; more may exist.",
            rows.len(),
            section.received
        ),
        Some(rows) if noun == "decisions" && retired > 0 => {
            format!("{} current · {retired} retired", rows.len() - retired)
        }
        Some(rows) if noun == "decisions" => format!("{} decisions", rows.len()),
        Some(rows) => format!(
            "{} pending · {} records checked",
            rows.len(),
            section.received
        ),
    };
    ui::text(Text::Caption, SharedString::from(text)).text_color(cx.theme().muted_foreground)
}
#[cfg(feature = "native-probes")]
#[path = "mission_decisions_probe.rs"]
pub(crate) mod probe;

#[cfg(test)]
mod mission_decisions_source_tests {
    use super::*;
    use crate::mission_browser_fixture as f;
    use gpui_kit::{AppContext, TestAppContext};
    #[test]
    fn disclosure_retention_and_zero_budget_preview_remain_truthful_and_bounded() {
        let d =
            crate::mission_browser::detail(&f::key("mission-A"), &f::detail("mission-A")).unwrap();
        let mut state = Disclosure::default();
        state
            .expanded
            .extend((0..256).map(|n| format!("removed-{n}")));
        state.reconcile(&d);
        assert!(state.expanded.is_empty());
        assert!(
            preview(&BoundedText {
                value: String::new(),
                clipped: true
            })
            .contains("viewing limit")
        );
        assert!(
            preview(&BoundedText {
                value: String::new(),
                clipped: false
            })
            .contains("Empty text")
        );
    }
    #[gpui_kit::test]
    fn exact_source_project_snapshot_and_generation_fence_callbacks(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let browser = cx.new(Browser::new);
        browser.update(cx, |b, _| {
            b.options(LocalOptions::synthetic(1));
            b.catalog = Some(Arc::new(
                crate::mission_browser::catalog(&f::catalog()).unwrap(),
            ));
            let d = Arc::new(
                crate::mission_browser::detail(&f::key("mission-A"), &f::detail("mission-A"))
                    .unwrap(),
            );
            b.detail = Some(d.clone());
            b.route = Some(Route::Detail(d.key.clone()));
            b.generation = 4;
            assert!(b.decision_matches(&d, 4));
            assert!(!b.decision_matches(&d, 3));
            b.detail = Some(Arc::new((*d).clone()));
            assert!(
                !b.decision_matches(&d, 4),
                "same values are not the captured read revision"
            );
            let mut wrong = (*d).clone();
            wrong.project = "project-B".into();
            b.detail = Some(Arc::new(wrong));
            assert!(b.decision_source().is_none());
            b.detail = Some(d.clone());
            b.route = Some(Route::Detail(f::key("mission-B")));
            assert!(b.decision_source().is_none());
            b.route = Some(Route::Detail(d.key.clone()));
            let mut wrong = (*d).clone();
            wrong.key.home.daemon = "other-daemon".into();
            b.route = Some(Route::Detail(wrong.key.clone()));
            b.detail = Some(Arc::new(wrong));
            assert!(b.decision_source().is_none());
        });
    }
}

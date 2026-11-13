//! Revisit on mock data: a mission's agreement now, the revision Pilot
//! proposes and the rules for confirming it, plus the mock missions that
//! use them. Every name is invented. The daemon's revision records
//! (`packages/protocol/src/mission-revision.ts`) are the authority in
//! production; this mirrors their shape: goal and agreement text, open task
//! edits and drops, decision replacements and withdrawals with a reason,
//! and instruction or permission corrections that are never applied.
//!
//! Asking for a Revisit and answering its questions change nothing. Only a
//! confirmation of the exact revision shown applies it, and only while the
//! mission is what Pilot revised. Finished tasks and earlier decisions stay
//! as history. Nothing here pauses, resumes, starts or permits work.

use crate::plan::{
    ChangeKind, ConfirmState, Correction, CorrectionKind, DecisionAction, DecisionChange,
    PauseNeed, QuestionSection as S, Revision, RevisionLine, Revisit, RevisitStage, RoundKind,
    TaskChange, TextChange,
};
use crate::plan_desk::{Ask, Plan, Round, digest};

fn s(text: &str) -> String {
    text.into()
}

/// One task of the mission as the mock keeps it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Task {
    pub id: String,
    pub number: u32,
    pub title: String,
    pub body: String,
    pub finished: bool,
    pub dropped: bool,
}

/// One decision of the mission as the mock keeps it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Decision {
    pub id: String,
    pub number: u32,
    pub text: String,
    pub active: bool,
}

/// The mission now: what a revision is compared with.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Agreement {
    pub goal: String,
    pub plan: String,
    pub tasks: Vec<Task>,
    pub decisions: Vec<Decision>,
    /// Changes with every change to the mission. A revision names the one it saw.
    pub source: u32,
    pub pause: PauseNeed,
}

/// One open task edit.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct TaskEdit {
    pub id: String,
    pub title: Option<String>,
    pub body: Option<String>,
    pub drop: bool,
}

/// One decision retirement, with its reason.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DecisionEdit {
    pub id: String,
    pub action: DecisionAction,
    pub text: String,
    pub reason: String,
}

/// What a revision changes. Like the daemon's delta, it cannot add tasks,
/// touch finished ones or edit a decision in place.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Delta {
    pub goal: Option<String>,
    pub plan: Option<String>,
    pub tasks: Vec<TaskEdit>,
    pub decisions: Vec<DecisionEdit>,
    pub corrections: Vec<Correction>,
}

/// How the mock service answers a confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ConfirmAck {
    /// It confirms.
    #[default]
    Confirm,
    /// The confirmation applies, but its answer is lost.
    Lose,
    /// Someone changes the mission while the confirmation is on its way.
    Change,
}

/// A proposed revision.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Proposed {
    pub id: String,
    pub summary: String,
    pub delta: Delta,
    /// The mission's source when Pilot proposed it.
    pub source: u32,
    pub confirm: ConfirmState,
    /// Whether a lost confirmation actually applied.
    pub landed: bool,
}

impl Proposed {
    pub(crate) fn digest(&self) -> String {
        digest(&format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{:?}",
            self.id, self.source, self.summary, self.delta
        ))
    }
}

/// A mission's Revisit, as the mock desk keeps it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RevisitDesk {
    pub now: Agreement,
    pub stage: RevisitStage,
    pub proposed: Option<Proposed>,
    pub history: Vec<RevisionLine>,
    pub ack: ConfirmAck,
    /// The new questions Pilot asks for the gaps it finds. None: it finds
    /// none and proposes a revision from earlier answers.
    pub asks: Vec<Ask>,
    /// The suggestions chosen in submitted Revisit rounds: earlier answers
    /// a later revision reuses instead of asking again.
    pub picks: Vec<(String, String)>,
    pub next: u32,
}

impl RevisitDesk {
    fn open(&self) -> impl Iterator<Item = &Task> {
        self.now.tasks.iter().filter(|t| !t.finished && !t.dropped)
    }

    /// Whether the user can ask for a Revisit now.
    pub(crate) fn can_ask(&self) -> bool {
        match self.stage {
            RevisitStage::Idle | RevisitStage::Confirmed => true,
            RevisitStage::Review => self
                .proposed
                .as_ref()
                .is_some_and(|p| p.source != self.now.source && p.confirm == ConfirmState::Open),
            _ => false,
        }
    }

    pub(crate) fn view(&self) -> Revisit {
        Revisit {
            available: true,
            reason: String::new(),
            stage: self.stage,
            can_ask: self.can_ask(),
            goal: self.now.goal.clone(),
            plan: self.now.plan.clone(),
            open_tasks: self.open().count() as u32,
            finished_tasks: self.now.tasks.iter().filter(|t| t.finished).count() as u32,
            decisions: self.now.decisions.iter().filter(|d| d.active).count() as u32,
            // A confirmed revision is history: its preview would compare it
            // with itself. The history line keeps what it replaced.
            revision: self
                .proposed
                .as_ref()
                .filter(|_| self.stage == RevisitStage::Review)
                .map(|p| self.revision(p)),
            history: self.history.clone(),
        }
    }

    fn text(before: &str, after: Option<&String>) -> TextChange {
        let after = after.cloned().unwrap_or_else(|| before.to_owned());
        TextChange {
            kind: if after == before {
                ChangeKind::Stays
            } else {
                ChangeKind::Changes
            },
            before: before.to_owned(),
            after,
        }
    }

    /// The revision as the user reviews it: every open task, what changes
    /// and what stays.
    fn revision(&self, p: &Proposed) -> Revision {
        let now = &self.now;
        let tasks = self
            .open()
            .map(|t| {
                let edit = p.delta.tasks.iter().find(|e| e.id == t.id);
                let mut lines = Vec::new();
                let kind = match edit {
                    Some(e) if e.drop => ChangeKind::Drops,
                    Some(e) => {
                        if let Some(title) = &e.title {
                            lines.push(format!("Title: {} → {title}", t.title));
                        }
                        if let Some(body) = &e.body {
                            lines.push(format!("Description: {body}"));
                        }
                        ChangeKind::Changes
                    }
                    None => ChangeKind::Stays,
                };
                TaskChange {
                    id: t.id.clone(),
                    number: t.number,
                    title: t.title.clone(),
                    kind,
                    lines,
                }
            })
            .collect();
        let decisions: Vec<DecisionChange> = p
            .delta
            .decisions
            .iter()
            .filter_map(|e| {
                let d = now.decisions.iter().find(|d| d.id == e.id)?;
                Some(DecisionChange {
                    id: d.id.clone(),
                    number: d.number,
                    before: d.text.clone(),
                    action: e.action,
                    after: e.text.clone(),
                    reason: e.reason.clone(),
                })
            })
            .collect();
        let active = now.decisions.iter().filter(|d| d.active).count();
        Revision {
            id: p.id.clone(),
            digest: p.digest(),
            summary: p.summary.clone(),
            current: p.source == now.source,
            goal: Self::text(&now.goal, p.delta.goal.as_ref()),
            plan: Self::text(&now.plan, p.delta.plan.as_ref()),
            tasks,
            finished: now.tasks.iter().filter(|t| t.finished).count() as u32,
            kept_decisions: active.saturating_sub(decisions.len()) as u32,
            decisions,
            corrections: p.delta.corrections.clone(),
            pause: now.pause,
            confirm: p.confirm,
        }
    }

    /// The round of new questions a Revisit asks, or None when it finds no gaps.
    pub(crate) fn round(&mut self, mission_id: &str, round: u32) -> Option<Round> {
        if self.asks.is_empty() {
            return None;
        }
        self.next += 1;
        // A question is asked once. A later Revisit reuses its answer.
        let asks = std::mem::take(&mut self.asks)
            .into_iter()
            .map(|mut a| {
                a.new = true;
                a
            })
            .collect();
        Some(Round::new(
            &format!("{mission_id}-revisit-{}", self.next),
            RoundKind::Revisit,
            round,
            asks,
        ))
    }

    /// Pilot proposes a revision from the answers of `round`, or from
    /// earlier answers when it asked nothing new.
    pub(crate) fn propose(&mut self, mission_id: &str, round: Option<&Round>) {
        self.next += 1;
        if let Some(round) = round {
            for a in &round.asks {
                if let Some(choice) = round.chosen(&a.id) {
                    self.picks.retain(|(id, _)| id != &a.id);
                    self.picks.push((a.id.clone(), choice));
                }
            }
        }
        let (summary, delta) = notify_revision(&self.now, &self.picks);
        self.proposed = Some(Proposed {
            id: format!("{mission_id}-revision-{}", self.next),
            summary,
            delta,
            source: self.now.source,
            confirm: ConfirmState::Open,
            landed: false,
        });
        self.stage = RevisitStage::Review;
    }

    /// Someone else changes the mission: a task's words.
    pub(crate) fn change_elsewhere(&mut self) {
        if let Some(t) = self
            .now
            .tasks
            .iter_mut()
            .find(|t| !t.finished && !t.dropped)
        {
            t.body.push_str(" (edited by the coordinator)");
        }
        self.now.source += 1;
    }

    /// Applies the proposed revision exactly. The earlier agreement and
    /// retired decisions stay as history.
    pub(crate) fn apply(&mut self) {
        let Some(p) = self.proposed.as_mut() else {
            return;
        };
        let now = &mut self.now;
        let mut retired = Vec::new();
        let earlier_goal = now.goal.clone();
        let earlier_plan = now.plan.clone();
        if let Some(goal) = &p.delta.goal {
            now.goal = goal.clone();
        }
        if let Some(plan) = &p.delta.plan {
            now.plan = plan.clone();
        }
        for edit in &p.delta.tasks {
            if let Some(t) = now.tasks.iter_mut().find(|t| t.id == edit.id) {
                if let Some(title) = &edit.title {
                    t.title = title.clone();
                }
                if let Some(body) = &edit.body {
                    t.body = body.clone();
                }
                t.dropped |= edit.drop;
            }
        }
        for edit in &p.delta.decisions {
            let next = now.decisions.iter().map(|d| d.number).max().unwrap_or(0) + 1;
            let Some(d) = now.decisions.iter_mut().find(|d| d.id == edit.id) else {
                continue;
            };
            d.active = false;
            match edit.action {
                DecisionAction::Replace => {
                    retired.push(format!(
                        "D{} “{}” replaced by D{next}. {}",
                        d.number, d.text, edit.reason
                    ));
                    now.decisions.push(Decision {
                        id: format!("d{next}"),
                        number: next,
                        text: edit.text.clone(),
                        active: true,
                    });
                }
                DecisionAction::Withdraw => {
                    retired.push(format!(
                        "D{} “{}” withdrawn. {}",
                        d.number, d.text, edit.reason
                    ));
                }
            }
        }
        now.source += 1;
        p.confirm = ConfirmState::Confirmed;
        self.history.insert(
            0,
            RevisionLine {
                id: p.id.clone(),
                summary: p.summary.clone(),
                line: s("Confirmed by you. No work started or resumed."),
                earlier_goal,
                earlier_plan,
                retired,
            },
        );
        self.stage = RevisitStage::Confirmed;
    }
}

const NOTIFY_GOAL: &str =
    "Make notifications quieter: fewer pings, and only the ones that need me.";
const NOTIFY_PLAN: &str = "Pilot notifies only for decisions, failures and finished work. \
Everything else waits on Today. Quiet hours are 22:00 to 07:00. \
Done when a normal day sends fewer than ten notifications.";

fn task(number: u32, title: &str, body: &str, finished: bool) -> Task {
    Task {
        id: format!("notify-{number}"),
        number,
        title: s(title),
        body: s(body),
        finished,
        dropped: false,
    }
}

fn decision(number: u32, text: &str) -> Decision {
    Decision {
        id: format!("d{number}"),
        number,
        text: s(text),
        active: true,
    }
}

fn notify_agreement(pause: PauseNeed) -> Agreement {
    Agreement {
        goal: s(NOTIFY_GOAL),
        plan: s(NOTIFY_PLAN),
        tasks: vec![
            task(
                1,
                "Count today's notifications",
                "Log every notification for a week.",
                true,
            ),
            task(
                2,
                "Group notifications by kind",
                "Decisions, failures, finished work, the rest.",
                true,
            ),
            task(
                3,
                "Mute finished-work pings at night",
                "Hold them until morning.",
                true,
            ),
            task(
                4,
                "Write the rule editor",
                "Let people choose what notifies them.",
                false,
            ),
            task(
                5,
                "Add quiet hours",
                "No notifications from 22:00 to 07:00.",
                false,
            ),
            task(
                6,
                "Batch the rest into a digest",
                "One notice an hour for everything else.",
                false,
            ),
            task(
                7,
                "Email the digest",
                "Send the hourly digest by email too.",
                false,
            ),
            task(
                8,
                "Settings page for rules",
                "Show and edit every rule in one place.",
                false,
            ),
        ],
        decisions: vec![
            decision(1, "Notify only for decisions, failures and finished work."),
            decision(2, "No email or mobile push."),
            decision(3, "Quiet hours are 22:00 to 07:00."),
        ],
        source: 1,
        pause,
    }
}

/// The new questions for the gaps Pilot finds in the notifications mission.
fn notify_asks() -> Vec<Ask> {
    vec![
        Ask::new(
            "mentions",
            S::Outcome,
            "Slack mentions now reach Pilot too. The agreement does not say whether they notify you. Should they?",
            &[
                ("direct", "Only direct mentions of me", true),
                ("all", "Every mention", false),
                ("never", "Never; show them on Today only", false),
            ],
        ),
        Ask::new(
            "email",
            S::NonGoals,
            "Task #7 emails the digest, but decision D2 rules out email. Which should change?",
            &[
                ("drop", "Drop the email digest", true),
                ("allow", "Keep it, and allow email", false),
            ],
        ),
        Ask::new(
            "quiet",
            S::Constraints,
            "You turned on macOS Focus since the plan was agreed. Should quiet hours follow it?",
            &[
                ("focus", "Follow macOS Focus", true),
                ("fixed", "Keep 22:00 to 07:00", false),
            ],
        ),
    ]
}

/// The revision Pilot proposes for the notifications mission, from the
/// Revisit's answers (the recommended ones where none was given). Edits
/// that would change nothing are left out.
fn notify_revision(now: &Agreement, picks: &[(String, String)]) -> (String, Delta) {
    let pick = |id: &str, default: &str| {
        picks
            .iter()
            .find(|(q, _)| q == id)
            .map_or_else(|| default.to_owned(), |(_, c)| c.clone())
    };
    let mentions = pick("mentions", "direct");
    let email = pick("email", "drop");
    let quiet = pick("quiet", "focus");
    let mut delta = Delta::default();
    let mut said = Vec::new();
    let mut plan = s("Pilot notifies only for decisions, failures and finished work");
    match mentions.as_str() {
        "direct" => {
            plan.push_str(", and for Slack messages that mention you directly");
            said.push("notify for direct Slack mentions");
        }
        "all" => {
            plan.push_str(", and for every Slack mention");
            said.push("notify for every Slack mention");
        }
        _ => said.push("keep Slack mentions on Today"),
    }
    plan.push_str(". Everything else waits on Today. ");
    if quiet == "focus" {
        plan.push_str("Quiet hours follow macOS Focus. ");
        said.push("follow macOS Focus for quiet hours");
        delta.tasks.push(TaskEdit {
            id: s("notify-5"),
            title: Some(s("Follow macOS Focus for quiet hours")),
            body: Some(s(
                "Hold notifications while Focus is on, and send them when it ends.",
            )),
            drop: false,
        });
        delta.decisions.push(DecisionEdit {
            id: s("d3"),
            action: DecisionAction::Replace,
            text: s("Quiet hours follow macOS Focus; there are no fixed hours."),
            reason: s("Your Revisit answer: follow macOS Focus."),
        });
        delta.corrections.push(Correction {
            kind: CorrectionKind::Permission,
            text: s("Let Pilot read whether macOS Focus is on."),
        });
    } else {
        plan.push_str("Quiet hours are 22:00 to 07:00. ");
    }
    plan.push_str("Done when a normal day sends fewer than ten notifications.");
    if email == "drop" {
        said.push("drop the email digest");
        delta.tasks.push(TaskEdit {
            id: s("notify-7"),
            drop: true,
            ..TaskEdit::default()
        });
    } else {
        said.push("allow the email digest");
        delta.decisions.push(DecisionEdit {
            id: s("d2"),
            action: DecisionAction::Withdraw,
            text: String::new(),
            reason: s("Your Revisit answer: keep the email digest and allow email."),
        });
    }
    delta.corrections.push(Correction {
        kind: CorrectionKind::Instruction,
        text: s("Ask the coordinator to check new notification sources at the start of each week."),
    });
    if plan != now.plan {
        delta.plan = Some(plan);
    }
    let open = |id: &str| {
        now.tasks
            .iter()
            .any(|t| t.id == id && !t.finished && !t.dropped)
    };
    let active = |id: &str| now.decisions.iter().any(|d| d.id == id && d.active);
    delta.tasks.retain(|e| {
        open(&e.id)
            && (e.drop
                || now.tasks.iter().any(|t| {
                    t.id == e.id
                        && (e.title.as_ref().is_some_and(|x| x != &t.title)
                            || e.body.as_ref().is_some_and(|x| x != &t.body))
                }))
    });
    delta
        .decisions
        .retain(|e| active(&e.id) && !now.decisions.iter().any(|d| d.active && d.text == e.text));
    let mut summary = said.join(", ");
    if let Some(first) = summary.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    summary.push('.');
    (summary, delta)
}

/// The notifications mission: an older mission with a published plan, three
/// tasks finished and five open, and a round of earlier answers.
pub(crate) fn notify(mission_id: &str, pause: PauseNeed) -> Plan {
    let mut plan = Plan::new(
        mission_id,
        "Quieter notifications",
        NOTIFY_GOAL,
        crate::plan::PlanRoute::Interview,
        "Pilot notifies only for things that need you, and batches the rest.",
    );
    let earlier = vec![
        Ask::new(
            "which",
            S::Outcome,
            "Which notifications matter most?",
            &[("needs", "Decisions, failures and finished work", true)],
        )
        .answer(Some("needs"), ""),
        Ask::new(
            "channels",
            S::NonGoals,
            "Which channels are out of scope?",
            &[("email", "Email and mobile push", true)],
        )
        .answer(Some("email"), ""),
        Ask::new(
            "night",
            S::Constraints,
            "When should Pilot stay quiet?",
            &[("fixed", "22:00 to 07:00", true)],
        )
        .answer(Some("fixed"), ""),
    ];
    let first = Round::new(&format!("{mission_id}-1"), RoundKind::Mission, 1, earlier);
    plan.rounds.push(crate::plan::RoundLine {
        id: first.id.clone(),
        title: s("Round 1"),
        line: s("3 answers, submitted"),
        state: crate::plan::RoundState::Submitted,
        answers: first.answers(),
    });
    plan.submitted = crate::plan::StepState::Done;
    plan.continued = crate::plan::StepState::Done;
    plan.approved = crate::plan::StepState::Done;
    plan.published = crate::plan::StepState::Done;
    plan.published_line = s("Published as 8 tasks. No work started.");
    plan.next_round = 2;
    plan.revisit = Some(RevisitDesk {
        now: notify_agreement(pause),
        stage: RevisitStage::Idle,
        proposed: None,
        history: Vec::new(),
        ack: ConfirmAck::Confirm,
        asks: notify_asks(),
        picks: Vec::new(),
        next: 0,
    });
    plan
}

/// A notifications mission whose revision waits for review, answered with
/// the recommended suggestions. Pilot found no new questions for it.
pub(crate) fn notify_review(mission_id: &str, title: &str, pause: PauseNeed) -> Plan {
    let mut plan = notify(mission_id, pause);
    plan.title = s(title);
    let revisit = plan.revisit.as_mut().expect("made above");
    revisit.asks.clear();
    revisit.propose(mission_id, None);
    plan
}

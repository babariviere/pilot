//! The single owner of the Today read model, with no UI and no JS. Each
//! intent is checked against the decision's revision and delivery state
//! before anything changes. In the spike, a mock coordinator answers; in
//! production this is where the daemon adapter would sit, behind the same
//! two-step begin/settle shape.

use std::time::Duration;

use crate::{
    fixture::{Ack, World, world},
    model::{
        Answer, AskIntent, DecideIntent, Decision, DecisionKind, DecisionRef, Delivery, DoneEntry,
        Evidence, IntentOutcome, MissionState, OutcomeStatus, Scenario, Today, Tone,
    },
};

/// The most results Today keeps. Older ones are counted, not sent.
pub const DONE_LIMIT: usize = 20;

/// The longest question a user may ask, in characters.
pub const QUESTION_LIMIT: usize = 500;

/// How often the update workload changes the read model by default.
pub const PULSE_EVERY: Duration = Duration::from_millis(100);

/// How many changes the update workload makes by default.
pub const PULSE_COUNT: u32 = 300;

/// Keeps the newest [`DONE_LIMIT`] results and counts the rest.
pub fn limit_done(today: &mut Today) {
    if today.done.len() > DONE_LIMIT {
        let hidden = today.done.len() - DONE_LIMIT;
        today.done.truncate(DONE_LIMIT);
        today.done_hidden += hidden as u32;
    }
}

/// The owner of the Today read model and the mock coordinator behind it.
#[derive(Debug, Clone)]
pub struct Desk {
    today: Today,
    acks: Vec<(String, Ack)>,
    answers: Vec<(String, String)>,
    pulses: u32,
}

/// A started intent that waits for the coordinator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    /// The decision.
    pub decision_id: String,
    /// How the mock coordinator will answer.
    pub ack: Ack,
}

impl Desk {
    /// The desk for `scenario`.
    pub fn new(scenario: Scenario) -> Self {
        Self::from_world(world(scenario))
    }

    /// The desk for a world built elsewhere (tests, generated loads).
    pub fn from_world(world: World) -> Self {
        let mut today = world.today;
        limit_done(&mut today);
        Desk {
            today,
            acks: world.acks,
            answers: world.answers,
            pulses: 0,
        }
    }

    /// The read model.
    pub fn today(&self) -> &Today {
        &self.today
    }

    fn outcome(&self, status: OutcomeStatus, message: &str) -> IntentOutcome {
        IntentOutcome {
            status,
            revision: self.today.revision,
            message: message.to_owned(),
        }
    }

    fn changed(&mut self) {
        self.today.revision += 1;
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.today.decisions.iter().position(|d| d.id == id)
    }

    /// The decision `id` at `revision`, or why the intent cannot use it.
    fn current(&self, id: &str, revision: u32) -> Result<usize, IntentOutcome> {
        let Some(at) = self.position(id) else {
            return Err(self.outcome(OutcomeStatus::Stale, "This decision is no longer waiting."));
        };
        if self.today.decisions[at].revision != revision {
            return Err(self.outcome(
                OutcomeStatus::Stale,
                "This decision changed. Read it again before you answer.",
            ));
        }
        Ok(at)
    }

    fn touch(&mut self, at: usize) -> &mut Decision {
        self.today.revision += 1;
        let decision = &mut self.today.decisions[at];
        decision.revision += 1;
        decision
    }

    /// Checks a decide intent and marks the decision as sending.
    pub fn begin_decide(&mut self, intent: &DecideIntent) -> Result<Started, IntentOutcome> {
        let at = self.current(&intent.decision_id, intent.revision)?;
        let decision = &self.today.decisions[at];
        match decision.delivery {
            Delivery::Idle => {}
            Delivery::Sending => {
                return Err(self.outcome(
                    OutcomeStatus::Rejected,
                    "Your answer is already on its way.",
                ));
            }
            Delivery::Unknown | Delivery::Checking => {
                return Err(self.outcome(
                    OutcomeStatus::Rejected,
                    "Pilot must check the earlier outcome first. It never sends twice without checking.",
                ));
            }
        }
        if decision.kind == DecisionKind::Unknown {
            return Err(self.outcome(OutcomeStatus::Rejected, "Only a check can settle this."));
        }
        if !decision.options.iter().any(|o| o.id == intent.option_id) {
            return Err(self.outcome(
                OutcomeStatus::Rejected,
                "That answer is not one of the options.",
            ));
        }
        let ack = self
            .acks
            .iter()
            .find(|(id, _)| *id == intent.decision_id)
            .map_or(Ack::Confirm, |(_, ack)| *ack);
        let decision = self.touch(at);
        decision.delivery = Delivery::Sending;
        decision.sent_option = Some(intent.option_id.clone());
        Ok(Started {
            decision_id: intent.decision_id.clone(),
            ack,
        })
    }

    /// Applies the coordinator's answer to a started decide intent.
    pub fn settle_decide(&mut self, started: &Started) -> IntentOutcome {
        let Some(at) = self.position(&started.decision_id) else {
            return self.outcome(
                OutcomeStatus::Unknown,
                "The decision went away while your answer was sent.",
            );
        };
        match started.ack {
            Ack::Confirm => {
                let decision = self.today.decisions.remove(at);
                let label = decision
                    .sent_option
                    .as_deref()
                    .and_then(|id| decision.options.iter().find(|o| o.id == id))
                    .map_or("your answer", |o| o.label.as_str())
                    .to_owned();
                self.today.notes.push(format!(
                    "{} has your answer: {label}.",
                    decision.mission_title
                ));
                self.resume_mission(&decision, "Back on it after your answer.");
                self.changed();
                self.outcome(OutcomeStatus::Accepted, "")
            }
            Ack::Lose => {
                let decision = self.touch(at);
                decision.delivery = Delivery::Unknown;
                self.outcome(
                    OutcomeStatus::Unknown,
                    "Pilot sent your answer but heard nothing back. It will check before it sends anything again.",
                )
            }
        }
    }

    /// Moves a waiting decision to the end of the queue, for later today.
    /// Putting it off does not answer it.
    pub fn later(&mut self, intent: &DecisionRef) -> IntentOutcome {
        let at = match self.current(&intent.decision_id, intent.revision) {
            Ok(at) => at,
            Err(outcome) => return outcome,
        };
        if self.today.decisions[at].delivery != Delivery::Idle {
            return self.outcome(
                OutcomeStatus::Rejected,
                "This decision is waiting on a send or a check.",
            );
        }
        if self.today.decisions.len() < 2 {
            return self.outcome(OutcomeStatus::Rejected, "Nothing else is waiting.");
        }
        let decision = self.today.decisions.remove(at);
        self.today.decisions.push(decision);
        self.changed();
        self.outcome(OutcomeStatus::Accepted, "")
    }

    /// Checks a check intent and marks the decision as checking.
    pub fn begin_check(&mut self, intent: &DecisionRef) -> Result<Started, IntentOutcome> {
        let at = self.current(&intent.decision_id, intent.revision)?;
        if self.today.decisions[at].delivery != Delivery::Unknown {
            return Err(self.outcome(OutcomeStatus::Rejected, "There is nothing to check."));
        }
        let decision = self.touch(at);
        decision.delivery = Delivery::Checking;
        Ok(Started {
            decision_id: intent.decision_id.clone(),
            ack: Ack::Confirm,
        })
    }

    /// Applies what the check read. The mock check always finds that the
    /// earlier send or push landed.
    pub fn settle_check(&mut self, started: &Started) -> IntentOutcome {
        let Some(at) = self.position(&started.decision_id) else {
            return self.outcome(OutcomeStatus::Stale, "This decision is no longer waiting.");
        };
        let decision = self.today.decisions.remove(at);
        let what = if decision.kind == DecisionKind::Unknown {
            "It landed"
        } else {
            "Your answer arrived"
        };
        self.today
            .notes
            .push(format!("Checked {}: {what}.", decision.mission_title));
        self.resume_mission(&decision, "Confirmed. Back on it.");
        self.changed();
        self.outcome(OutcomeStatus::Accepted, "")
    }

    /// Checks a question before it is sent.
    pub fn begin_ask(&mut self, intent: &AskIntent) -> Result<(), IntentOutcome> {
        if self.position(&intent.decision_id).is_none() {
            return Err(self.outcome(OutcomeStatus::Stale, "This decision is no longer waiting."));
        }
        let question = intent.question.trim();
        if question.is_empty() {
            return Err(self.outcome(OutcomeStatus::Rejected, "Write a question first."));
        }
        if question.chars().count() > QUESTION_LIMIT {
            return Err(self.outcome(
                OutcomeStatus::Rejected,
                "Keep the question under 500 characters.",
            ));
        }
        Ok(())
    }

    /// Adds Pilot's answer to the question. The question is kept exactly as
    /// written.
    pub fn settle_ask(&mut self, intent: &AskIntent) -> IntentOutcome {
        let Some(at) = self.position(&intent.decision_id) else {
            return self.outcome(OutcomeStatus::Stale, "This decision is no longer waiting.");
        };
        let answer = self
            .answers
            .iter()
            .find(|(id, _)| *id == intent.decision_id)
            .map_or("Pilot will answer from the mission's history.", |(_, a)| {
                a.as_str()
            })
            .to_owned();
        let decision = self.touch(at);
        decision.answers.push(Answer {
            question: intent.question.clone(),
            answer,
        });
        self.outcome(OutcomeStatus::Accepted, "")
    }

    fn resume_mission(&mut self, decision: &Decision, line: &str) {
        let Some(at) = self
            .today
            .not_moving
            .iter()
            .position(|m| m.decision_id.as_deref() == Some(decision.id.as_str()))
        else {
            return;
        };
        let mut mission = self.today.not_moving.remove(at);
        // Another decision may still hold the mission.
        if let Some(next) = self
            .today
            .decisions
            .iter()
            .find(|d| d.mission_id == mission.id)
        {
            mission.decision_id = Some(next.id.clone());
            self.today.not_moving.insert(at, mission);
            return;
        }
        mission.state = MissionState::Moving;
        mission.decision_id = None;
        // The task that waited on the decision is being worked on again.
        mission.progress.active += mission.progress.blocked;
        mission.progress.blocked = 0;
        line.clone_into(&mut mission.line);
        self.today.moving.push(mission);
    }

    /// One step of the update workload, the same for both Today screens:
    /// the next moving mission (in turn) moves one task on and says so,
    /// and every fourth step adds a result at the top. Decisions do not
    /// change, so a pulse never races an intent. Returns the step's number.
    pub fn pulse(&mut self) -> u32 {
        self.pulses += 1;
        let step = self.pulses;
        let rows = if self.today.moving.is_empty() {
            &mut self.today.not_moving
        } else {
            &mut self.today.moving
        };
        if !rows.is_empty() {
            let at = (step as usize - 1) % rows.len();
            let row = &mut rows[at];
            let p = &mut row.progress;
            if p.todo > 0 {
                p.todo -= 1;
                p.active += 1;
            } else if p.active > 0 {
                p.active -= 1;
                p.done += 1;
            } else {
                p.todo = p.done;
                p.done = 0;
            }
            row.line = format!("Working on update {step}.");
            if step.is_multiple_of(4) {
                let entry = DoneEntry {
                    id: format!("pulse-{step}"),
                    text: format!("Update {step} landed with its checks."),
                    mission_title: row.title.clone(),
                    evidence: vec![Evidence {
                        label: format!("{step:07x}"),
                        tone: Tone::Neutral,
                    }],
                };
                self.today.done.insert(0, entry);
                limit_done(&mut self.today);
            }
        }
        self.changed();
        step
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decide(id: &str, revision: u32, option: &str) -> DecideIntent {
        DecideIntent {
            decision_id: id.into(),
            revision,
            option_id: option.into(),
        }
    }

    #[test]
    fn a_confirmed_answer_removes_the_decision_and_moves_the_mission() {
        let mut desk = Desk::new(Scenario::Decisions);
        let started = desk.begin_decide(&decide("q1", 1, "a")).unwrap();
        let q1 = &desk.today().decisions[0];
        assert_eq!((q1.delivery, q1.revision), (Delivery::Sending, 2));
        let outcome = desk.settle_decide(&started);
        assert_eq!(outcome.status, OutcomeStatus::Accepted);
        assert!(desk.today().decisions.iter().all(|d| d.id != "q1"));
        assert!(desk.today().moving.iter().any(|m| m.id == "notify"));
        assert_eq!(
            desk.today().notes,
            ["Quieter notifications has your answer: One summary at 18:00."]
        );
    }

    #[test]
    fn a_stale_or_repeated_answer_changes_nothing() {
        let mut desk = Desk::new(Scenario::Decisions);
        let before = desk.today().clone();
        let stale = desk.begin_decide(&decide("q1", 7, "a")).unwrap_err();
        assert_eq!(stale.status, OutcomeStatus::Stale);
        let wrong = desk.begin_decide(&decide("q1", 1, "z")).unwrap_err();
        assert_eq!(wrong.status, OutcomeStatus::Rejected);
        assert_eq!(desk.today(), &before);
        desk.begin_decide(&decide("q1", 1, "a")).unwrap();
        let twice = desk.begin_decide(&decide("q1", 2, "a")).unwrap_err();
        assert_eq!(twice.status, OutcomeStatus::Rejected);
    }

    #[test]
    fn a_lost_confirmation_stays_unknown_until_a_check() {
        let mut desk = Desk::new(Scenario::Trouble);
        let started = desk.begin_decide(&decide("f1", 1, "a")).unwrap();
        let outcome = desk.settle_decide(&started);
        assert_eq!(outcome.status, OutcomeStatus::Unknown);
        let f1 = desk.today().decisions[0].clone();
        assert_eq!(
            (f1.delivery, f1.sent_option.as_deref()),
            (Delivery::Unknown, Some("a"))
        );
        // No resend, not even of the same answer.
        let again = desk
            .begin_decide(&decide("f1", f1.revision, "a"))
            .unwrap_err();
        assert_eq!(again.status, OutcomeStatus::Rejected);
        let check = desk
            .begin_check(&DecisionRef {
                decision_id: "f1".into(),
                revision: f1.revision,
            })
            .unwrap();
        assert_eq!(desk.settle_check(&check).status, OutcomeStatus::Accepted);
        assert!(desk.today().decisions.iter().all(|d| d.id != "f1"));
    }

    #[test]
    fn later_reorders_without_answering() {
        let mut desk = Desk::new(Scenario::Decisions);
        let outcome = desk.later(&DecisionRef {
            decision_id: "q1".into(),
            revision: 1,
        });
        assert_eq!(outcome.status, OutcomeStatus::Accepted);
        let ids: Vec<_> = desk
            .today()
            .decisions
            .iter()
            .map(|d| d.id.as_str())
            .collect();
        assert_eq!(ids, ["q2", "r1", "q1"]);
        assert!(desk.today().notes.is_empty());
    }

    #[test]
    fn questions_keep_their_exact_text() {
        let mut desk = Desk::new(Scenario::Decisions);
        let ask = AskIntent {
            decision_id: "q2".into(),
            question: "  Does it touch my data?\nReally? ".into(),
        };
        desk.begin_ask(&ask).unwrap();
        desk.settle_ask(&ask);
        assert_eq!(desk.today().decisions[1].answers[0].question, ask.question);
        let empty = AskIntent {
            decision_id: "q2".into(),
            question: " \n ".into(),
        };
        assert_eq!(
            desk.begin_ask(&empty).unwrap_err().status,
            OutcomeStatus::Rejected
        );
    }

    #[test]
    fn large_worlds_keep_today_limited() {
        let desk = Desk::new(Scenario::Large);
        assert_eq!(desk.today().done.len(), DONE_LIMIT);
        assert_eq!(desk.today().done_hidden, 103);
        assert_eq!(
            desk.today().moving.len() + desk.today().not_moving.len(),
            203
        );
    }

    #[test]
    fn pulses_change_missions_and_results_but_never_decisions() {
        let mut desk = Desk::new(Scenario::Large);
        let before = desk.today().clone();
        let total = |p: &crate::model::Progress| p.done + p.review + p.active + p.blocked + p.todo;
        for _ in 0..8 {
            desk.pulse();
        }
        let after = desk.today();
        assert_eq!(after.revision, before.revision + 8);
        assert_eq!(after.decisions, before.decisions);
        assert_eq!(after.done.len(), DONE_LIMIT);
        assert_eq!(after.done_hidden, before.done_hidden + 2);
        assert_eq!(after.done[0].id, "pulse-8");
        assert_eq!(after.moving[7].line, "Working on update 8.");
        for (a, b) in after.moving.iter().zip(&before.moving) {
            assert_eq!(total(&a.progress), total(&b.progress));
        }
        // The same steps give the same model: both screens see one workload.
        let mut again = Desk::new(Scenario::Large);
        for _ in 0..8 {
            again.pulse();
        }
        assert_eq!(again.today(), after);
    }
}

//! Human actions: what only the user can do outside Pilot, such as an
//! upload to a store. They are not decisions or approvals. The user saves
//! progress, puts them off, or reports them done; Pilot waits for that
//! report and never treats opening a link or a file as one.
//!
//! [`Actions`] plays both sides of the daemon's human-action contract
//! (`packages/protocol/src/decision-assistance.ts`): the mock service's
//! rows and receipts, and Day's own journal of commands it sent. Each
//! command names the exact revision and digest the user saw and carries a
//! new operation ID, recorded before it is sent. A lost answer stays
//! unknown until a lookup by that operation ID reads the receipt; nothing
//! sends a command twice. A user's report is the user's word, not proof
//! that the upload worked.

use std::hash::{DefaultHasher, Hash, Hasher};

use crate::{
    desk::Desk,
    model::{
        ActionAsk, ActionCheck, ActionFile, ActionRef, ActionState, CompleteIntent, Delivery,
        Destination, HumanAction, IntentOutcome, Origin, OutcomeStatus, ProgressIntent,
    },
};

/// The longest progress note or report, in characters.
pub const REPORT_LIMIT: usize = 2000;

/// What an agent asks the user to do. Replacing it is a new revision.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct Content {
    /// What to do, as a title.
    pub title: String,
    /// Why Pilot needs the user.
    pub why: String,
    /// The one next step.
    pub next_step: String,
    /// How long it takes.
    pub effort: String,
    /// The files, pinned by version and digest.
    pub files: Vec<(String, String, String)>,
    /// Where: label, link and target.
    pub destination: (String, String, String),
    /// Who asked: chat title, chat link and mission title.
    pub origin: (String, String, String),
    /// What the user reports back.
    pub needs: Vec<String>,
}

impl Content {
    fn digest(&self) -> String {
        let mut hasher = DefaultHasher::new();
        self.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    }
}

/// How the mock service answers a report that an action is done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ack {
    /// It applies the command and the answer arrives.
    Confirm,
    /// It applies the command, but the answer never arrives.
    Lose,
    /// The asking agent replaced the request just before the command
    /// arrived, so the service refuses it as stale.
    Replace(Box<Content>),
}

/// A user's report that the action is done. Not external proof.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Completion {
    operation_id: String,
    report: String,
}

/// One row of the mock service.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Record {
    id: String,
    revision: u32,
    digest: String,
    content: Content,
    state: ActionState,
    progress: String,
    completion: Option<Completion>,
    /// What the last replacement changed, until the user acts on the new
    /// revision.
    replaced: Option<String>,
}

/// What the service did with a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Result {
    /// Applied; the row is at this revision now.
    Applied(u32),
    /// The row changed or ended first. Nothing was done.
    Stale,
}

/// The service's saved result of one command, by operation.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Receipt {
    operation_id: String,
    result: Result,
}

/// A command Day recorded before sending it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Command {
    operation_id: String,
    action_id: String,
    revision: u32,
    digest: String,
    ask: ActionAsk,
    text: String,
    /// Day applied its result. An unsettled command after a restart is
    /// unknown, never resent.
    settled: bool,
}

/// Where Day's request for one action is, in memory only.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Flight {
    action_id: String,
    operation_id: String,
    ask: ActionAsk,
    delivery: Delivery,
}

/// A command that was recorded and sent, and waits for its answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedAction {
    /// The action.
    pub action_id: String,
    /// The command's operation, recorded before the send.
    pub operation_id: String,
}

/// The mock human-action service and Day's journal of what it sent.
#[derive(Debug, Clone, Default)]
pub struct Actions {
    rows: Vec<Record>,
    receipts: Vec<Receipt>,
    journal: Vec<Command>,
    flights: Vec<Flight>,
    acks: Vec<(String, Vec<Ack>)>,
    next_operation: u32,
}

fn reject(status: OutcomeStatus, message: &str) -> (OutcomeStatus, String) {
    (status, message.to_owned())
}

impl Actions {
    /// The service with one row per `(id, content)`, each pending at
    /// revision 1, answering commands as `acks` says, in order, then
    /// confirming.
    pub fn new(rows: Vec<(String, Content)>, acks: Vec<(String, Vec<Ack>)>) -> Self {
        Actions {
            rows: rows
                .into_iter()
                .map(|(id, content)| Record {
                    id,
                    revision: 1,
                    digest: content.digest(),
                    content,
                    state: ActionState::Pending,
                    progress: String::new(),
                    completion: None,
                    replaced: None,
                })
                .collect(),
            acks,
            ..Actions::default()
        }
    }

    /// The same service and journal after Day restarts: requests that were
    /// in flight are unknown until a check reads them. Nothing resends.
    pub fn restart(&self) -> Self {
        let flights = self
            .journal
            .iter()
            .filter(|c| !c.settled)
            .map(|c| Flight {
                action_id: c.action_id.clone(),
                operation_id: c.operation_id.clone(),
                ask: c.ask,
                delivery: Delivery::Unknown,
            })
            .collect();
        Actions {
            flights,
            ..self.clone()
        }
    }

    /// How many commands the service applied. A resend would show here.
    pub fn applied(&self) -> usize {
        self.receipts
            .iter()
            .filter(|r| matches!(r.result, Result::Applied(_)))
            .count()
    }

    /// The actions still waiting, in order, as Today shows them.
    pub fn view(&self) -> Vec<HumanAction> {
        self.rows
            .iter()
            // A completed row stays while Day has not read its own receipt:
            // until then, the user sees an unknown request, not a result.
            .filter(|r| r.completion.is_none() || self.flight(&r.id).is_some())
            .map(|r| {
                let flight = self.flight(&r.id);
                let c = &r.content;
                HumanAction {
                    id: r.id.clone(),
                    revision: r.revision,
                    title: c.title.clone(),
                    why: c.why.clone(),
                    next_step: c.next_step.clone(),
                    effort: c.effort.clone(),
                    files: c
                        .files
                        .iter()
                        .map(|(name, version, digest)| ActionFile {
                            name: name.clone(),
                            version: version.clone(),
                            digest: digest.clone(),
                        })
                        .collect(),
                    destination: Destination {
                        label: c.destination.0.clone(),
                        link: c.destination.1.clone(),
                        target: c.destination.2.clone(),
                    },
                    origin: Origin {
                        chat_title: c.origin.0.clone(),
                        chat_link: c.origin.1.clone(),
                        mission_title: c.origin.2.clone(),
                    },
                    needs: c.needs.clone(),
                    progress: r.progress.clone(),
                    state: r.state,
                    replaced: r.replaced.clone(),
                    delivery: flight.map_or(Delivery::Idle, |f| f.delivery),
                    asked: flight.map(|f| f.ask),
                }
            })
            .collect()
    }

    fn flight(&self, id: &str) -> Option<&Flight> {
        self.flights.iter().find(|f| f.action_id == id)
    }

    fn flight_mut(&mut self, id: &str) -> Option<&mut Flight> {
        self.flights.iter_mut().find(|f| f.action_id == id)
    }

    fn row(&self, id: &str) -> Option<&Record> {
        self.rows
            .iter()
            .find(|r| r.id == id && r.completion.is_none())
    }

    /// Checks a command against the revision shown, records it, and marks
    /// it sending.
    fn begin(
        &mut self,
        id: &str,
        revision: u32,
        ask: ActionAsk,
        text: &str,
    ) -> std::result::Result<StartedAction, (OutcomeStatus, String)> {
        match self.flight(id).map(|f| f.delivery) {
            None | Some(Delivery::Idle) => {}
            Some(Delivery::Sending) => {
                return Err(reject(
                    OutcomeStatus::Rejected,
                    "Your last request is on its way.",
                ));
            }
            Some(Delivery::Unknown | Delivery::Checking) => {
                return Err(reject(
                    OutcomeStatus::Rejected,
                    "Pilot must check your last request first. It never sends twice without checking.",
                ));
            }
        }
        let Some(row) = self.row(id) else {
            return Err(reject(
                OutcomeStatus::Stale,
                "This action is no longer waiting.",
            ));
        };
        if row.revision != revision {
            return Err(reject(
                OutcomeStatus::Stale,
                "This action changed. Read it again first.",
            ));
        }
        if text.chars().count() > REPORT_LIMIT {
            return Err(reject(
                OutcomeStatus::Rejected,
                "Keep it under 2,000 characters.",
            ));
        }
        if ask == ActionAsk::Progress && text.trim().is_empty() {
            return Err(reject(
                OutcomeStatus::Rejected,
                "Write what you did so far first.",
            ));
        }
        if ask == ActionAsk::Complete && !row.content.needs.is_empty() && text.trim().is_empty() {
            return Err(reject(
                OutcomeStatus::Rejected,
                "Say what you did first. Pilot needs it to go on.",
            ));
        }
        let (revision, digest) = (row.revision, row.digest.clone());
        self.next_operation += 1;
        let operation_id = format!("action-op-{}", self.next_operation);
        // Recorded before it is sent, so a restart knows it may have landed.
        self.journal.push(Command {
            operation_id: operation_id.clone(),
            action_id: id.to_owned(),
            revision,
            digest,
            ask,
            text: text.to_owned(),
            settled: false,
        });
        self.flights.retain(|f| f.action_id != id);
        self.flights.push(Flight {
            action_id: id.to_owned(),
            operation_id: operation_id.clone(),
            ask,
            delivery: Delivery::Sending,
        });
        Ok(StartedAction {
            action_id: id.to_owned(),
            operation_id,
        })
    }

    /// The mock service: runs a command once and saves its receipt. A
    /// command it already ran returns the saved receipt.
    fn execute(&mut self, operation_id: &str) -> Receipt {
        if let Some(receipt) = self
            .receipts
            .iter()
            .find(|r| r.operation_id == operation_id)
        {
            return receipt.clone();
        }
        let command = self
            .journal
            .iter()
            .find(|c| c.operation_id == operation_id)
            .expect("only recorded commands are sent")
            .clone();
        let at = self
            .rows
            .iter()
            .position(|r| r.id == command.action_id && r.completion.is_none());
        let result = match at {
            Some(at)
                if self.rows[at].revision == command.revision
                    && self.rows[at].digest == command.digest =>
            {
                let row = &mut self.rows[at];
                row.revision += 1;
                row.replaced = None;
                match command.ask {
                    ActionAsk::Progress => row.progress = command.text.clone(),
                    ActionAsk::Later => {
                        row.state = ActionState::Deferred;
                        let row = self.rows.remove(at);
                        self.rows.push(row);
                    }
                    ActionAsk::Complete => {
                        row.completion = Some(Completion {
                            operation_id: command.operation_id.clone(),
                            report: command.text.clone(),
                        })
                    }
                }
                let revision = self
                    .rows
                    .iter()
                    .find(|r| r.id == command.action_id)
                    .map_or(0, |r| r.revision);
                Result::Applied(revision)
            }
            _ => Result::Stale,
        };
        let receipt = Receipt {
            operation_id: operation_id.to_owned(),
            result,
        };
        self.receipts.push(receipt.clone());
        receipt
    }

    /// The asking agent replaces a request: new content, a new revision and
    /// digest. Progress saved for the old request no longer applies.
    pub fn replace(&mut self, id: &str, content: Content) {
        let Some(row) = self
            .rows
            .iter_mut()
            .find(|r| r.id == id && r.completion.is_none())
        else {
            return;
        };
        let file = content
            .files
            .first()
            .map_or_else(String::new, |(name, version, _)| {
                format!(" {name} (version {version})")
            });
        let mut note = format!("Pilot replaced this request with a new file:{file}.");
        if !row.progress.is_empty() {
            note.push_str(" The progress you saved was for the old one, so Pilot cleared it.");
        }
        row.revision += 1;
        row.digest = content.digest();
        row.content = content;
        row.progress.clear();
        row.replaced = Some(note);
    }

    /// The scripted answer to a report; progress and Later always land.
    fn next_ack(&mut self, id: &str, ask: ActionAsk) -> Ack {
        if ask != ActionAsk::Complete {
            return Ack::Confirm;
        }
        match self.acks.iter_mut().find(|(at, _)| at == id) {
            Some((_, script)) if !script.is_empty() => script.remove(0),
            _ => Ack::Confirm,
        }
    }

    /// Applies a receipt to Day's side. Returns the outcome and, for a
    /// completion, the note Today shows.
    fn apply(
        &mut self,
        operation_id: &str,
        receipt: &Receipt,
    ) -> (OutcomeStatus, String, Option<String>) {
        let Some(command) = self
            .journal
            .iter_mut()
            .find(|c| c.operation_id == operation_id)
        else {
            return (OutcomeStatus::Unknown, String::new(), None);
        };
        command.settled = true;
        let command = command.clone();
        self.flights.retain(|f| f.operation_id != operation_id);
        match receipt.result {
            Result::Stale => (
                OutcomeStatus::Stale,
                "Nothing was saved: this action changed before your request arrived. Read it again.".to_owned(),
                None,
            ),
            Result::Applied(_) => match command.ask {
                ActionAsk::Progress => (OutcomeStatus::Accepted, "Progress saved. This is not done yet.".to_owned(), None),
                ActionAsk::Later => (OutcomeStatus::Accepted, String::new(), None),
                ActionAsk::Complete => {
                    let row = self.rows.iter().find(|r| r.id == command.action_id);
                    let (title, place) = row.map_or((String::new(), String::new()), |r| {
                        (r.content.title.clone(), r.content.destination.0.clone())
                    });
                    (
                        OutcomeStatus::Accepted,
                        String::new(),
                        Some(format!("You reported done: {title}. Pilot has not checked {place} itself.")),
                    )
                }
            },
        }
    }

    /// Answers a started command as the mock service would.
    pub fn settle(&mut self, started: &StartedAction) -> (OutcomeStatus, String, Option<String>) {
        let ask = self
            .flight(&started.action_id)
            .map_or(ActionAsk::Complete, |f| f.ask);
        match self.next_ack(&started.action_id, ask) {
            Ack::Replace(content) => {
                self.replace(&started.action_id, *content);
                let receipt = self.execute(&started.operation_id);
                self.apply(&started.operation_id, &receipt)
            }
            Ack::Lose => {
                self.execute(&started.operation_id);
                if let Some(flight) = self.flight_mut(&started.action_id) {
                    flight.delivery = Delivery::Unknown;
                }
                (
                    OutcomeStatus::Unknown,
                    "Pilot sent your request but heard nothing back. It will check before it sends anything again.".to_owned(),
                    None,
                )
            }
            Ack::Confirm => {
                let receipt = self.execute(&started.operation_id);
                self.apply(&started.operation_id, &receipt)
            }
        }
    }

    /// Starts a lookup of an unknown request. It only reads.
    pub fn begin_check(
        &mut self,
        id: &str,
    ) -> std::result::Result<String, (OutcomeStatus, String)> {
        let Some(flight) = self.flight_mut(id) else {
            return Err(reject(
                OutcomeStatus::Rejected,
                "There is nothing to check.",
            ));
        };
        if flight.delivery != Delivery::Unknown {
            return Err(reject(
                OutcomeStatus::Rejected,
                "There is nothing to check.",
            ));
        }
        flight.delivery = Delivery::Checking;
        Ok(flight.operation_id.clone())
    }

    /// Reads the receipt of operation `operation_id`. Without one, the
    /// request stays unknown; it is never sent again.
    pub fn settle_check(
        &mut self,
        id: &str,
        operation_id: &str,
    ) -> (OutcomeStatus, String, Option<String>) {
        let receipt = self
            .receipts
            .iter()
            .find(|r| r.operation_id == operation_id)
            .cloned();
        match receipt {
            Some(receipt) => self.apply(operation_id, &receipt),
            None => {
                if let Some(flight) = self.flight_mut(id) {
                    flight.delivery = Delivery::Unknown;
                }
                (
                    OutcomeStatus::Unknown,
                    "Pilot found no record of your request yet. It did not send it again."
                        .to_owned(),
                    None,
                )
            }
        }
    }
}

impl Desk {
    fn action_outcome(&mut self, result: (OutcomeStatus, String, Option<String>)) -> IntentOutcome {
        let (status, message, note) = result;
        if let Some(note) = note {
            self.note(note);
        }
        self.changed_actions();
        self.outcome_now(status, &message)
    }

    fn begin_action(
        &mut self,
        id: &str,
        revision: u32,
        ask: ActionAsk,
        text: &str,
    ) -> std::result::Result<StartedAction, IntentOutcome> {
        match self.actions_mut().begin(id, revision, ask, text) {
            Ok(started) => {
                self.changed_actions();
                Ok(started)
            }
            Err((status, message)) => Err(self.outcome_now(status, &message)),
        }
    }

    /// Records and sends a progress note. It does not complete the action.
    pub fn begin_progress(
        &mut self,
        intent: &ProgressIntent,
    ) -> std::result::Result<StartedAction, IntentOutcome> {
        self.begin_action(
            &intent.action_id,
            intent.revision,
            ActionAsk::Progress,
            &intent.progress,
        )
    }

    /// Records and sends a Later. The action still waits.
    pub fn begin_action_later(
        &mut self,
        intent: &ActionRef,
    ) -> std::result::Result<StartedAction, IntentOutcome> {
        self.begin_action(&intent.action_id, intent.revision, ActionAsk::Later, "")
    }

    /// Records and sends the user's report that the action is done.
    pub fn begin_complete(
        &mut self,
        intent: &CompleteIntent,
    ) -> std::result::Result<StartedAction, IntentOutcome> {
        self.begin_action(
            &intent.action_id,
            intent.revision,
            ActionAsk::Complete,
            &intent.report,
        )
    }

    /// Applies the service's answer to a started action request.
    pub fn settle_action(&mut self, started: &StartedAction) -> IntentOutcome {
        let result = self.actions_mut().settle(started);
        self.action_outcome(result)
    }

    /// Starts a read-only check of an unknown action request.
    pub fn begin_check_action(
        &mut self,
        intent: &ActionCheck,
    ) -> std::result::Result<String, IntentOutcome> {
        match self.actions_mut().begin_check(&intent.action_id) {
            Ok(operation) => {
                self.changed_actions();
                Ok(operation)
            }
            Err((status, message)) => Err(self.outcome_now(status, &message)),
        }
    }

    /// Applies what the check read.
    pub fn settle_check_action(&mut self, action_id: &str, operation_id: &str) -> IntentOutcome {
        let result = self.actions_mut().settle_check(action_id, operation_id);
        self.action_outcome(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{fixture, model::Scenario};

    const CWS: &str = "cws";

    fn now(desk: &Desk) -> HumanAction {
        desk.today()
            .actions
            .iter()
            .find(|a| a.id == CWS)
            .cloned()
            .expect("waiting")
    }

    fn complete(desk: &Desk, report: &str) -> CompleteIntent {
        CompleteIntent {
            action_id: CWS.into(),
            revision: now(desk).revision,
            report: report.into(),
        }
    }

    #[test]
    fn progress_and_later_keep_the_action_waiting() {
        let mut desk = Desk::new(Scenario::Actions);
        let a = now(&desk);
        let started = desk
            .begin_progress(&ProgressIntent {
                action_id: CWS.into(),
                revision: a.revision,
                progress: "Opened the dashboard. Not uploaded yet.".into(),
            })
            .unwrap();
        assert_eq!(now(&desk).delivery, Delivery::Sending);
        assert_eq!(desk.settle_action(&started).status, OutcomeStatus::Accepted);
        let a = now(&desk);
        assert_eq!(a.progress, "Opened the dashboard. Not uploaded yet.");
        assert_eq!(a.delivery, Delivery::Idle);
        let started = desk
            .begin_action_later(&ActionRef {
                action_id: CWS.into(),
                revision: a.revision,
            })
            .unwrap();
        desk.settle_action(&started);
        let a = now(&desk);
        assert_eq!(a.state, ActionState::Deferred);
        assert!(desk.today().notes.is_empty(), "nothing was reported done");
    }

    #[test]
    fn a_report_needs_words_and_the_revision_shown() {
        let mut desk = Desk::new(Scenario::Actions);
        let empty = desk.begin_complete(&complete(&desk, "  ")).unwrap_err();
        assert_eq!(empty.status, OutcomeStatus::Rejected);
        let mut old = complete(&desk, "Uploaded");
        old.revision += 5;
        assert_eq!(
            desk.begin_complete(&old).unwrap_err().status,
            OutcomeStatus::Stale
        );
        assert_eq!(desk.actions_mut().applied(), 0);
    }

    #[test]
    fn a_replaced_file_refuses_the_old_report_then_a_lost_answer_is_only_checked() {
        let mut desk = Desk::new(Scenario::Actions);
        let first = desk
            .begin_complete(&complete(&desk, "Uploaded 1.4.2"))
            .unwrap();
        let outcome = desk.settle_action(&first);
        assert_eq!(outcome.status, OutcomeStatus::Stale);
        let a = now(&desk);
        assert_eq!(a.files[0].name, "pilot-helper-1.4.3.zip");
        assert!(a.replaced.as_deref().unwrap_or("").contains("1.4.3"));
        assert_eq!(
            desk.actions_mut().applied(),
            0,
            "the old report did nothing"
        );

        let second = desk
            .begin_complete(&complete(&desk, "Uploaded 1.4.3"))
            .unwrap();
        let lost = desk.settle_action(&second);
        assert_eq!(lost.status, OutcomeStatus::Unknown);
        assert_eq!(now(&desk).delivery, Delivery::Unknown);
        // No resend, not even of the same report.
        let again = desk
            .begin_complete(&complete(&desk, "Uploaded 1.4.3"))
            .unwrap_err();
        assert_eq!(again.status, OutcomeStatus::Rejected);
        let operation = desk
            .begin_check_action(&ActionCheck {
                action_id: CWS.into(),
            })
            .unwrap();
        assert_eq!(now(&desk).delivery, Delivery::Checking);
        let checked = desk.settle_check_action(CWS, &operation);
        assert_eq!(checked.status, OutcomeStatus::Accepted);
        assert!(desk.today().actions.iter().all(|a| a.id != CWS));
        assert_eq!(desk.actions_mut().applied(), 1, "applied exactly once");
        assert_eq!(
            desk.today().notes,
            [
                "You reported done: Upload Pilot Helper 1.4.3 to the Chrome Web Store. Pilot has not checked the Chrome Web Store itself."
            ]
        );
    }

    #[test]
    fn a_restart_keeps_saved_progress_and_leaves_an_unanswered_request_unknown() {
        let mut desk = Desk::new(Scenario::Actions);
        let saved = desk
            .begin_progress(&ProgressIntent {
                action_id: CWS.into(),
                revision: 1,
                progress: "Zip downloaded.".into(),
            })
            .unwrap();
        desk.settle_action(&saved);
        // Sent, then Day stops before any answer.
        desk.begin_complete(&complete(&desk, "Uploaded")).unwrap();
        let mut desk = desk.restart();
        let a = now(&desk);
        assert_eq!(a.progress, "Zip downloaded.");
        assert_eq!(
            (a.delivery, a.asked),
            (Delivery::Unknown, Some(ActionAsk::Complete))
        );
        let operation = desk
            .begin_check_action(&ActionCheck {
                action_id: CWS.into(),
            })
            .unwrap();
        // The service never received it: still unknown, and not resent.
        let checked = desk.settle_check_action(CWS, &operation);
        assert_eq!(checked.status, OutcomeStatus::Unknown);
        assert_eq!(now(&desk).delivery, Delivery::Unknown);
        assert_eq!(desk.actions_mut().applied(), 1, "only the progress note");
    }

    #[test]
    fn a_confirmed_report_completes_once_and_says_it_was_not_checked() {
        let mut world = fixture::world(Scenario::Actions);
        world.actions = fixture::actions(Vec::new());
        let mut desk = Desk::from_world(world);
        let started = desk
            .begin_complete(&complete(&desk, "Uploaded 1.4.2"))
            .unwrap();
        assert_eq!(desk.settle_action(&started).status, OutcomeStatus::Accepted);
        assert!(desk.today().actions.is_empty());
        assert!(
            desk.today().notes[0].ends_with("Pilot has not checked the Chrome Web Store itself.")
        );
    }
}

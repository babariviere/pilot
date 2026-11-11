//! The native side of TodayFeed's decision and action cards: the trusted
//! host, what this run is doing with the cards, and saved drafts. Rust only;
//! TSX reaches it through TodayFeed's typed intents and never sees a
//! request, an operation ID or a credential.
//!
//! Drafts save after a short pause and on flush, never on every key, so the
//! host's append-only ledger grows slowly. A draft queued before close is
//! written during the host's joined drain.

use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    pin::pin,
    rc::Rc,
    time::Duration,
};

use nsh_core::prelude::*;
use serde_json::{Value, json};

use crate::{
    attention_host::{self as ah, Local, Sending},
    host::{Error, NativeHost, attention::DraftKey},
    model::{
        ActionAsk, Decision, DecisionKind, Draft, DraftIntent, HumanAction, IntentOutcome,
        OutcomeStatus, Today,
    },
};

/// How long a draft waits for the next key before it is saved.
pub const DRAFT_DELAY: Duration = Duration::from_millis(800);

pub(crate) type Listeners = Rc<RefCell<Vec<(u64, Callback<Today>)>>>;

/// The host and this run's card state. Clones share both.
#[derive(Clone)]
pub(crate) struct Native {
    pub host: NativeHost,
    pub local: Rc<RefCell<Local>>,
    pub listeners: Listeners,
    /// The owner the feed was made under, so saving outlives a card.
    owner: Owner,
    saver: Rc<RefCell<Option<Spawned<()>>>>,
    saving: Rc<Cell<bool>>,
    wake: (async_channel::Sender<()>, async_channel::Receiver<()>),
    delay: Rc<Cell<Duration>>,
}

/// Clears a request's on-its-way mark even if the caller goes away.
struct Mark {
    native: Native,
    item: String,
    checking: bool,
}
impl Drop for Mark {
    fn drop(&mut self) {
        let (native, item, checking) = (self.native.clone(), self.item.clone(), self.checking);
        native.change(|l| {
            if checking {
                l.checking.remove(&item);
            } else {
                l.sending.remove(&item);
                l.asking.remove(&item);
            }
        });
    }
}

fn missions(today: &Today) -> Vec<(String, String)> {
    today
        .moving
        .iter()
        .chain(&today.not_moving)
        .chain(&today.unreported)
        .map(|m| (m.id.clone(), m.title.clone()))
        .collect()
}

fn read_error(error: Error) -> String {
    match error {
        Error::Unavailable => "This Pilot service does not share what needs you yet.".into(),
        Error::Offline => "Pilot could not reach its service to read what needs you.".into(),
        Error::Identity => {
            "The selected Pilot service changed. Reopen it to read what needs you.".into()
        }
        _ => "Pilot could not read what needs you.".into(),
    }
}

fn refused(error: Error) -> (OutcomeStatus, String) {
    match error {
        Error::Unknown => (
            OutcomeStatus::Unknown,
            "Pilot sent this but heard nothing back. It will not send it again; Check again only reads.".into(),
        ),
        Error::Stale => (
            OutcomeStatus::Stale,
            "Pilot changed this since you read it. Nothing was sent; your words stay.".into(),
        ),
        Error::Capacity => (OutcomeStatus::Rejected, format!("{error}. Nothing was sent.")),
        Error::Closed => (OutcomeStatus::Rejected, "Pilot is closing. Nothing was sent.".into()),
        Error::Busy => (
            OutcomeStatus::Rejected,
            "Pilot is busy with another request. Nothing was sent; try again.".into(),
        ),
        Error::Unavailable => (
            OutcomeStatus::Rejected,
            "This is not available right now. Nothing was sent.".into(),
        ),
        _ => (
            OutcomeStatus::Rejected,
            "Pilot could not send this. Nothing was sent; your words stay.".into(),
        ),
    }
}

impl Native {
    /// Starts the first attention read. Later reads follow the host's own
    /// authoritative refreshes.
    pub fn new(host: NativeHost, listeners: Listeners) -> Self {
        Self {
            host,
            local: Rc::default(),
            listeners,
            owner: Owner::current(),
            saver: Rc::default(),
            saving: Rc::default(),
            wake: async_channel::bounded(1),
            delay: Rc::new(Cell::new(DRAFT_DELAY)),
        }
    }

    /// Rust-only: how long drafts wait before saving. Tests with a manual
    /// clock use zero.
    pub fn set_draft_delay(&self, delay: Duration) {
        self.delay.set(delay);
    }

    /// The host's Today with this read's cards.
    pub fn snapshot(&self) -> Today {
        let mut today = self.host.snapshot();
        let local = self.local.borrow();
        let read = self.host.attention_snapshot();
        let view = ah::project(
            read.as_ref(),
            &self.host.attention_operations(),
            &self.host.attention_drafts(),
            &missions(&today),
            &local,
        );
        for row in today
            .moving
            .iter_mut()
            .chain(today.not_moving.iter_mut())
            .chain(today.unreported.iter_mut())
        {
            if row.decision_id.is_none() {
                row.decision_id = view
                    .decisions
                    .iter()
                    .find(|d| d.mission_id == row.id && d.kind != DecisionKind::Unknown)
                    .map(|d| d.id.clone());
            }
        }
        today.decisions = view.decisions;
        today.actions = view.actions;
        today.attention = view.attention;
        today.notes.extend(local.notes.iter().cloned());
        today.revision = today.revision.wrapping_add(local.revision);
        today
    }

    pub fn publish(&self) {
        let today = self.snapshot();
        for (_, listener) in self.listeners.borrow().iter() {
            listener.post(today.clone());
        }
    }

    fn change(&self, f: impl FnOnce(&mut Local)) {
        {
            let mut local = self.local.borrow_mut();
            f(&mut local);
            local.touch();
        }
        self.publish();
    }

    pub fn outcome(&self, status: OutcomeStatus, message: impl Into<String>) -> IntentOutcome {
        IntentOutcome {
            status,
            revision: self.snapshot().revision,
            message: message.into(),
        }
    }

    fn refusal(&self, refusal: ah::Refusal) -> IntentOutcome {
        self.outcome(refusal.status, refusal.message)
    }

    /// The read the cards show, or a refusal when there is none.
    fn shown(&self) -> Result<Value, IntentOutcome> {
        self.host.attention_snapshot().ok_or_else(|| {
            self.outcome(
                OutcomeStatus::Stale,
                "Pilot has not read what needs you yet. Nothing was sent.",
            )
        })
    }

    /// Reads attention again. A failed read keeps the last one, marked stale.
    pub async fn reread(&self) {
        let result = self.host.read_attention().recv().await;
        let error = match result {
            Ok(Ok(_)) => None,
            Ok(Err(e)) => Some(read_error(e)),
            Err(_) => Some(read_error(Error::Closed)),
        };
        self.change(|l| l.read_error = error);
    }

    fn decision(&self, id: &str) -> Option<Decision> {
        self.snapshot().decisions.into_iter().find(|d| d.id == id)
    }

    fn action(&self, id: &str) -> Option<HumanAction> {
        self.snapshot().actions.into_iter().find(|a| a.id == id)
    }

    /// Sends one exact request, rereads, and says what happened. Only an
    /// acknowledged receipt is accepted.
    /// Sends "request". When the host refused only because its read moved
    /// on before anything was sent, reads again and, if "rebuild" still
    /// finds the item at the revision shown, sends once more.
    async fn submit(
        &self,
        request: Value,
        rebuild: &dyn Fn(&Value) -> Result<Value, ah::Refusal>,
    ) -> Result<Result<IntentOutcome, Error>, ah::Refusal> {
        let once = |r: Result<Result<IntentOutcome, Error>, async_channel::RecvError>| {
            r.unwrap_or(Err(Error::Unknown))
        };
        let first = once(self.host.send_attention(request).recv().await);
        if first != Err(Error::Stale) {
            return Ok(first);
        }
        self.reread().await;
        let read = self.host.attention_snapshot().unwrap_or_default();
        let request = rebuild(&read)?;
        Ok(once(self.host.send_attention(request).recv().await))
    }

    async fn send(
        &self,
        item: &str,
        sending: Option<Sending>,
        request: Value,
        rebuild: &dyn Fn(&Value) -> Result<Value, ah::Refusal>,
    ) -> (OutcomeStatus, String) {
        let before: BTreeSet<String> = self
            .host
            .attention_operations()
            .iter()
            .filter_map(|op| op["id"].as_str().map(str::to_owned))
            .collect();
        if let Some(sending) = sending {
            self.change(|l| {
                l.sending.insert(item.to_owned(), sending);
            });
        }
        let mark = Mark {
            native: self.clone(),
            item: item.to_owned(),
            checking: false,
        };
        let result = self.submit(request, rebuild).await;
        self.reread().await;
        drop(mark);
        let result = match result {
            Ok(result) => result,
            Err(refusal) => return (refusal.status, refusal.message.to_owned()),
        };
        let op = self
            .host
            .attention_operations()
            .into_iter()
            .find(|op| op["id"].as_str().is_some_and(|id| !before.contains(id)));
        match result {
            Ok(outcome) => match outcome.status {
                OutcomeStatus::Accepted => (OutcomeStatus::Accepted, String::new()),
                OutcomeStatus::Unknown => refused(Error::Unknown),
                OutcomeStatus::Stale => refused(Error::Stale),
                OutcomeStatus::Rejected => {
                    let receipt = op
                        .as_ref()
                        .map(|op| op["receipt"].clone())
                        .unwrap_or_default();
                    if receipt["error"]["code"] == "stale" {
                        refused(Error::Stale)
                    } else if receipt["value"]["state"] == "rejected" {
                        (
                            OutcomeStatus::Rejected,
                            "The chat did not take this answer. Nothing changed; your words stay."
                                .into(),
                        )
                    } else if receipt["error"]["code"] == "unavailable" {
                        refused(Error::Unavailable)
                    } else {
                        (
                            OutcomeStatus::Rejected,
                            "Pilot refused this. Nothing changed; your words stay.".into(),
                        )
                    }
                }
            },
            Err(e) => refused(e),
        }
    }

    /// Answers question card "id" with its picks, the user's words or both.
    /// Only a question that takes several takes more than one pick.
    pub async fn answer(
        &self,
        id: &str,
        revision: u32,
        picks: Vec<String>,
        text: &str,
    ) -> IntentOutcome {
        let read = match self.shown() {
            Ok(read) => read,
            Err(outcome) => return outcome,
        };
        let Some(decision) = self.decision(id) else {
            return self.refusal(ah::Refusal {
                status: OutcomeStatus::Stale,
                message: "This is no longer waiting. Nothing was sent.",
            });
        };
        if decision.revision != revision {
            return self.outcome(
                OutcomeStatus::Stale,
                "This decision changed. Read it again before you answer.",
            );
        }
        if decision.delivery != crate::model::Delivery::Idle
            || decision.kind == DecisionKind::Unknown
        {
            return self.outcome(
                OutcomeStatus::Rejected,
                "Pilot must check the earlier answer first. It never sends twice without checking.",
            );
        }
        let build = |r: &Value| ah::answer_request(r, id, &picks, text);
        let request = match build(&read) {
            Ok(request) => request,
            Err(refusal) => return self.refusal(refusal),
        };
        let key = ah::find_question(&read, id).and_then(ah::question_key);
        let (status, message) = self
            .send(id, Some(Sending::Answer(picks.clone())), request, &build)
            .await;
        if status == OutcomeStatus::Accepted {
            if let Some(key) = key {
                self.clear_draft(key);
            }
            self.change(|l| {
                l.notes.push(format!(
                    "Your answer to “{}” reached the chat.",
                    decision.title
                ))
            });
        }
        self.outcome(status, message)
    }

    /// Puts question card "id" off: it goes after the others. The Later is
    /// saved with the question's draft, so it lasts past a restart, until
    /// an answer is sent. The chat still waits and is told nothing.
    pub fn later(&self, id: &str, revision: u32) -> IntentOutcome {
        let Some(decision) = self.decision(id) else {
            return self.outcome(OutcomeStatus::Stale, "This decision is no longer waiting.");
        };
        if decision.revision != revision {
            return self.outcome(
                OutcomeStatus::Stale,
                "This decision changed. Read it again first.",
            );
        }
        if decision.delivery != crate::model::Delivery::Idle {
            return self.outcome(
                OutcomeStatus::Rejected,
                "This decision is waiting on a send or a check.",
            );
        }
        let key = self
            .host
            .attention_snapshot()
            .and_then(|r| ah::find_question(&r, id).and_then(ah::question_key));
        if let Some(key) = key {
            let mut value = self
                .current_draft(&key)
                .unwrap_or_else(|| ah::draft_value(&Draft::default()));
            value["later"] = json!(true);
            self.queue_draft(key, value);
            self.flush();
        }
        self.change(|l| {
            l.later.retain(|d| d != id);
            l.later.push(id.to_owned());
        });
        self.outcome(OutcomeStatus::Accepted, "")
    }

    /// Reads the saved operation of an unconfirmed request. Never resends.
    async fn lookup(&self, item: &str, op: Option<String>, fresh: bool) -> IntentOutcome {
        let Some(op) = op else {
            return self.outcome(OutcomeStatus::Rejected, "There is nothing to check.");
        };
        self.change(|l| {
            l.checking.insert(item.to_owned());
        });
        let mark = Mark {
            native: self.clone(),
            item: item.to_owned(),
            checking: true,
        };
        let result = self.host.check_attention(op.clone()).recv().await;
        if fresh {
            self.reread().await;
        }
        drop(mark);
        match result {
            Ok(Ok(outcome)) if outcome.status == OutcomeStatus::Accepted => {
                let summary = self
                    .host
                    .attention_operations()
                    .into_iter()
                    .find(|o| o["id"] == op);
                let report = summary.as_ref().and_then(|s| {
                    let value = &s["receipt"]["value"];
                    let record = if value["record"].is_object() {
                        &value["record"]
                    } else {
                        value
                    };
                    (s["request"]["command"]["kind"] == "complete"
                        && record["completion"]["source"] == "user_report")
                        .then(|| record["content"]["action"].as_str().unwrap_or_default().to_owned())
                });
                if let Some(title) = report {
                    self.change(|l| {
                        l.notes.push(format!(
                            "You reported done: {title}. Pilot keeps your words; it has not checked the result."
                        ))
                    });
                }
                self.outcome(
                    OutcomeStatus::Accepted,
                    "Checked. Pilot read the saved receipt; nothing was sent again.",
                )
            }
            Ok(Ok(outcome)) => self.outcome(
                outcome.status,
                "Checked. The saved request was refused; nothing changed and nothing was sent again.",
            ),
            _ => self.outcome(
                OutcomeStatus::Unknown,
                "Still not confirmed. Pilot will not send it again; check later.",
            ),
        }
    }

    /// Checks the unconfirmed answer on question card "id".
    pub async fn check_answer_of(&self, id: &str) -> IntentOutcome {
        let op = ah::pending_answer(&self.host.attention_operations(), id)
            .and_then(|op| op["id"].as_str().map(str::to_owned));
        self.lookup(id, op, true).await
    }

    /// Checks one unconfirmed help question.
    pub async fn check_help(&self, answer_id: &str) -> IntentOutcome {
        let known = self
            .host
            .attention_operations()
            .iter()
            .any(|op| op["id"] == answer_id && op["state"] == "unknown");
        self.lookup(answer_id, known.then(|| answer_id.to_owned()), false)
            .await
    }

    /// Asks a help question, only when the daemon has a help producer.
    pub async fn ask(&self, id: &str, revision: u32, question: &str) -> IntentOutcome {
        let read = match self.shown() {
            Ok(read) => read,
            Err(outcome) => return outcome,
        };
        if revision != 1 {
            return self.outcome(
                OutcomeStatus::Stale,
                "This decision changed. Ask about it again.",
            );
        }
        let build = |r: &Value| ah::help_request(r, id, question);
        let request = match build(&read) {
            Ok(request) => request,
            Err(refusal) => return self.refusal(refusal),
        };
        self.change(|l| {
            l.asking.insert(id.to_owned(), question.to_owned());
        });
        let (status, message) = self.send(id, None, request, &build).await;
        self.outcome(status, message)
    }

    /// Saves progress, puts an action off or reports it done.
    pub async fn act(&self, id: &str, revision: u32, ask: ActionAsk, text: &str) -> IntentOutcome {
        let read = match self.shown() {
            Ok(read) => read,
            Err(outcome) => return outcome,
        };
        if let Some(action) = self.action(id)
            && action.delivery != crate::model::Delivery::Idle
        {
            return self.outcome(
                OutcomeStatus::Rejected,
                "Pilot must check the earlier request first. It never sends twice without checking.",
            );
        }
        let build = |r: &Value| ah::action_request(r, id, revision, ask, text);
        let request = match build(&read) {
            Ok(request) => request,
            Err(refusal) => return self.refusal(refusal),
        };
        let shown = ah::find_action(&read, id).cloned().unwrap_or_default();
        let old_key = ah::action_key(&shown);
        let title = shown["record"]["content"]["action"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let (status, message) = self
            .send(id, Some(Sending::Action(ask)), request, &build)
            .await;
        if status != OutcomeStatus::Accepted {
            return self.outcome(status, message);
        }
        let Some(old_key) = old_key else {
            return self.outcome(status, message);
        };
        match ask {
            ActionAsk::Complete => {
                self.clear_draft(old_key);
                self.change(|l| {
                    l.notes.push(format!(
                        "You reported done: {title}. Pilot keeps your words; it has not checked the result."
                    ))
                });
                self.outcome(status, "")
            }
            ActionAsk::Progress => {
                self.clear_draft(old_key);
                self.outcome(status, "Progress saved. The action still waits for you.")
            }
            ActionAsk::Later => {
                // The user's own Later is a new revision: keep their words on it.
                let words = self.draft_now(&old_key);
                let next = self
                    .host
                    .attention_snapshot()
                    .and_then(|r| ah::find_action(&r, id).and_then(ah::action_key));
                if let (Some(words), Some(next)) = (words, next)
                    && next != old_key
                {
                    self.queue_draft(next, words);
                    self.clear_draft(old_key);
                }
                self.outcome(status, "Put off. It still waits for you.")
            }
        }
    }

    /// Checks the unconfirmed request on action "id".
    pub async fn check_action(&self, id: &str) -> IntentOutcome {
        let op = ah::pending_action(&self.host.attention_operations(), id)
            .and_then(|op| op["id"].as_str().map(str::to_owned));
        self.lookup(id, op, true).await
    }

    /// Opens action "id"'s pinned link through the root's opener. Reports nothing.
    pub async fn open_link(&self, id: &str, revision: u32) -> IntentOutcome {
        let read = match self.shown() {
            Ok(read) => read,
            Err(outcome) => return outcome,
        };
        let build = |r: &Value| ah::resource_request(r, id, revision);
        let request = match build(&read) {
            Ok(request) => request,
            Err(refusal) => return self.refusal(refusal),
        };
        let result = self.submit(request, &build).await;
        self.publish();
        match result {
            Err(refusal) => self.refusal(refusal),
            Ok(Ok(outcome)) if outcome.status == OutcomeStatus::Accepted => self.outcome(
                OutcomeStatus::Accepted,
                "Opened the link. That reports nothing; Pilot still waits for your report.",
            ),
            Ok(Ok(_)) | Ok(Err(Error::Stale)) => self.outcome(
                OutcomeStatus::Stale,
                "Pilot changed this request. Read it again; nothing was opened.",
            ),
            _ => self.outcome(
                OutcomeStatus::Rejected,
                "The link did not open. Copy it instead; this reports nothing.",
            ),
        }
    }

    /// The draft value for "key" now, empty or not: unsaved first, then saved.
    fn current_draft(&self, key: &DraftKey) -> Option<Value> {
        let ks = ah::key_string(key);
        self.local
            .borrow()
            .dirty
            .get(&ks)
            .map(|(_, v)| v.clone())
            .or_else(|| self.host.attention_draft(key))
    }

    /// The draft value for "key" now, when it holds words or a pick.
    fn draft_now(&self, key: &DraftKey) -> Option<Value> {
        self.current_draft(key)
            .filter(|v| v["text"].as_str().is_some_and(|t| !t.is_empty()) || !v["pick"].is_null())
    }

    /// Empties a saved draft once its words were sent, Later included.
    /// Writes only when there is something to empty.
    fn clear_draft(&self, key: DraftKey) {
        let empty = ah::draft_value(&Draft::default());
        if self.current_draft(&key).is_some_and(|v| v != empty) {
            self.queue_draft(key, empty);
        }
    }

    /// Keeps what the user picked or wrote, for the revision shown. A
    /// question keeps a Later saved before.
    pub fn save_draft(&self, intent: &DraftIntent) -> IntentOutcome {
        let read = match self.shown() {
            Ok(read) => read,
            Err(outcome) => return outcome,
        };
        let key = match ah::draft_key(&read, &intent.item_id, intent.revision) {
            Ok(key) => key,
            Err(refusal) => return self.refusal(refusal),
        };
        let before = self.current_draft(&key);
        let value = ah::draft_value(&ah::draft_from(&key, intent, before.as_ref()));
        if serde_json::to_vec(&value).map_or(true, |v| v.len() > ah::DRAFT_LIMIT) {
            return self.outcome(
                OutcomeStatus::Rejected,
                "This is too long to save. It stays on screen; copy it before you close Pilot.",
            );
        }
        self.queue_draft(key, value);
        self.outcome(OutcomeStatus::Accepted, "")
    }

    fn queue_draft(&self, key: DraftKey, value: Value) {
        let ks = ah::key_string(&key);
        {
            let mut local = self.local.borrow_mut();
            let same = match local.dirty.get(&ks) {
                Some((_, v)) => *v == value,
                None => self.host.attention_draft(&key).as_ref() == Some(&value),
            };
            if same {
                return;
            }
            local.dirty.insert(ks, (key, value));
            local.touch();
        }
        self.kick();
    }

    /// Saves queued drafts now, without waiting for the pause.
    pub fn flush(&self) {
        let _ = self.wake.0.try_send(());
        self.kick();
    }

    /// Starts the one saver, under the feed's owner, if it is not running.
    /// It saves one draft at a time until nothing is queued.
    fn kick(&self) {
        if self.saving.get() || self.local.borrow().dirty.is_empty() {
            return;
        }
        self.saving.set(true);
        let this = self.clone();
        let task = self.owner.run(|| {
            spawn(async move {
                loop {
                    let delay = this.delay.get();
                    if !delay.is_zero() {
                        let wait = pin!(timer(delay));
                        let woken = pin!(this.wake.1.recv());
                        futures_util::future::select(wait, woken).await;
                    }
                    let batch: Vec<(String, DraftKey, Value)> = this
                        .local
                        .borrow()
                        .dirty
                        .iter()
                        .map(|(ks, (k, v))| (ks.clone(), k.clone(), v.clone()))
                        .collect();
                    let mut failed = batch.is_empty();
                    for (ks, key, value) in batch {
                        let result = this
                            .host
                            .save_attention_draft(key, value.clone())
                            .recv()
                            .await;
                        let mut local = this.local.borrow_mut();
                        if matches!(result, Ok(Ok(_))) {
                            local.unsaved.remove(&ks);
                            if local.dirty.get(&ks).is_some_and(|(_, v)| *v == value) {
                                local.dirty.remove(&ks);
                            }
                        } else {
                            local.unsaved.insert(ks);
                            failed = true;
                        }
                        local.touch();
                    }
                    this.publish();
                    // Nothing left, or a failed save that waits for the
                    // user's next change: no hot retry.
                    if failed || this.local.borrow().dirty.is_empty() {
                        break;
                    }
                }
                this.saving.set(false);
            })
        });
        // A finished saver is replaced here; dropping it cancels nothing live.
        *self.saver.borrow_mut() = Some(task);
    }

    /// Queues every unsaved draft on the host, then closes it. The host
    /// writes queued drafts during its joined drain, then exits.
    pub fn close(&self) -> async_channel::Receiver<Result<(), Error>> {
        if let Some(task) = self.saver.borrow_mut().take() {
            task.cancel();
        }
        let dirty: Vec<(DraftKey, Value)> = self.local.borrow().dirty.values().cloned().collect();
        for (key, value) in dirty {
            let _ = self.host.save_attention_draft(key, value);
        }
        self.host.close()
    }
}

//! The screen's one store: Today's read model as the desk last published
//! it, the intents that change it, and the state the screen owns. The Rust
//! form of the TSX app's `day.ts`, `view.ts` and `TodayFeed`: the same
//! `Desk`, the same two-step begin/settle intents, the same mock latency,
//! and the whole read model published after every change.

use std::{collections::HashMap, time::Duration};

use nsh_core::prelude::*;
use pilot_day_native::{
    desk::{Desk, PULSE_COUNT, PULSE_EVERY},
    feed::MOCK_LATENCY,
    model::{
        AskIntent, DecideIntent, Decision, DecisionRef, IntentOutcome, OutcomeStatus, Scenario,
        Today,
    },
};

/// The help a decision card shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Help {
    Simpler,
    More,
    Ask,
    Details,
}

/// Today's store. `Copy`: closures and rows capture it as a signal.
#[derive(Clone, Copy)]
pub struct Day {
    /// The single owner of the read model and its rules.
    desk: Stored<Desk>,
    /// A mirror of the desk's read model. Only [`Day::publish`] sets it,
    /// and every set notifies, as each post to TSX does.
    today: Signal<Today>,
    /// The root's owner: intents outlive the card that sent them.
    owner: Owner,
    /// The option the user picked, by decision.
    picks: Signal<HashMap<String, String>>,
    /// Open help panels, by decision.
    help: Signal<HashMap<String, Vec<Help>>>,
    /// Unsent questions, exactly as typed, by decision.
    drafts: Signal<HashMap<String, String>>,
    /// The last message an intent returned, by decision.
    messages: Signal<HashMap<String, String>>,
    /// Questions on their way, by decision.
    asking: Signal<HashMap<String, bool>>,
    /// The decision the user brought to the front, if any.
    focused: Signal<Option<String>>,
}

impl Day {
    /// A store of mock data from `scenario`, owned by the component that
    /// opens it.
    pub fn open(scenario: Scenario) -> Self {
        let desk = Desk::new(scenario);
        let today = signal_with(desk.today().clone(), SignalEquals::Never);
        Day {
            desk: stored(desk),
            today,
            owner: Owner::current(),
            picks: signal(HashMap::new()),
            help: signal(HashMap::new()),
            drafts: signal(HashMap::new()),
            messages: signal(HashMap::new()),
            asking: signal(HashMap::new()),
            focused: signal(None),
        }
    }

    /// Reads the read model (tracked in a binding).
    pub fn with_today<R>(&self, f: impl FnOnce(&Today) -> R) -> R {
        self.today.with(f)
    }

    /// Sends the desk's whole read model to the screen.
    fn publish(&self) {
        let today = self.desk.with(|desk| desk.today().clone());
        self.today.set(today);
    }

    /// Runs `future` as a task of the root, not of the caller.
    fn spawn(&self, future: impl Future<Output = ()> + 'static) {
        self.owner.run(|| {
            spawn(future);
        });
    }

    /// Answers a decision with one of its options; `done` hears the
    /// outcome once the coordinator confirms, or `unknown` when no
    /// confirmation came.
    pub fn decide(&self, intent: DecideIntent, done: impl FnOnce(IntentOutcome) + 'static) {
        let started = self.desk.with(|desk| desk.begin_decide(&intent));
        let started = match started {
            Ok(started) => started,
            Err(outcome) => return done(outcome),
        };
        self.publish();
        let day = *self;
        self.spawn(async move {
            timer(MOCK_LATENCY).await;
            let outcome = day.desk.with(|desk| desk.settle_decide(&started));
            day.publish();
            done(outcome);
        });
    }

    /// Puts a decision at the end of the queue. It stays unanswered.
    pub fn later(&self, intent: DecisionRef) -> IntentOutcome {
        let (outcome, changed) = self.desk.with(|desk| {
            let before = desk.today().revision;
            let outcome = desk.later(&intent);
            (outcome, desk.today().revision != before)
        });
        if changed {
            self.publish();
        }
        outcome
    }

    /// Reads whether an unconfirmed send or push landed. Never resends.
    pub fn check(&self, intent: DecisionRef, done: impl FnOnce(IntentOutcome) + 'static) {
        let started = self.desk.with(|desk| desk.begin_check(&intent));
        let started = match started {
            Ok(started) => started,
            Err(outcome) => return done(outcome),
        };
        self.publish();
        let day = *self;
        self.spawn(async move {
            timer(MOCK_LATENCY).await;
            let outcome = day.desk.with(|desk| desk.settle_check(&started));
            day.publish();
            done(outcome);
        });
    }

    /// Asks Pilot a question about a decision; the question joins the
    /// decision's `answers` at once and its answer follows.
    pub fn ask(&self, intent: AskIntent, done: impl FnOnce(IntentOutcome) + 'static) {
        let id = match self.desk.with(|desk| desk.begin_ask(&intent)) {
            Ok(id) => id,
            Err(outcome) => return done(outcome),
        };
        self.publish();
        let day = *self;
        self.spawn(async move {
            timer(MOCK_LATENCY).await;
            let outcome = day
                .desk
                .with(|desk| desk.settle_ask(&intent.decision_id, &id));
            day.publish();
            done(outcome);
        });
    }

    /// Runs the shared update workload with its defaults
    /// ([`PULSE_EVERY`], [`PULSE_COUNT`]), as `TodayFeed.pulse()` does.
    pub fn pulse(&self) {
        self.pulse_with(PULSE_EVERY, PULSE_COUNT);
    }

    /// Runs the update workload: one pulse every `every`, `count` times.
    pub fn pulse_with(&self, every: Duration, count: u32) {
        let day = *self;
        self.spawn(async move {
            for _ in 0..count {
                timer(every).await;
                day.desk.with(Desk::pulse);
                day.publish();
            }
        });
    }

    // The state the screen owns, keyed by decision id, so it survives
    // reordering and the front card changing.

    /// Whether `kind` help is open on decision `id`.
    pub fn help_open(&self, id: &str, kind: Help) -> bool {
        self.help
            .with(|all| all.get(id).is_some_and(|open| open.contains(&kind)))
    }

    /// Opens or closes `kind` help on decision `id`.
    pub fn set_help(&self, id: &str, kind: Help, open: bool) {
        self.help.update(|all| {
            let now = all.entry(id.to_owned()).or_default();
            now.retain(|k| *k != kind);
            if open {
                now.push(kind);
            }
        });
    }

    /// Picks option `option` on decision `id`.
    pub fn pick(&self, id: &str, option: &str) {
        self.picks.update(|all| {
            all.insert(id.to_owned(), option.to_owned());
        });
    }

    /// The option the card shows as chosen: what was sent, else the user's
    /// pick, else Pilot's recommendation.
    pub fn chosen(&self, decision: &Decision) -> String {
        if let Some(sent) = &decision.sent_option {
            return sent.clone();
        }
        let picked = self.picks.with(|all| all.get(&decision.id).cloned());
        if let Some(picked) = picked
            && decision.options.iter().any(|o| o.id == picked)
        {
            return picked;
        }
        decision
            .options
            .iter()
            .find(|o| o.recommended)
            .or(decision.options.first())
            .map(|o| o.id.clone())
            .unwrap_or_default()
    }

    /// The unsent question on decision `id`, exactly as typed.
    pub fn draft(&self, id: &str) -> String {
        self.drafts
            .with(|all| all.get(id).cloned().unwrap_or_default())
    }

    /// Keeps the question typed on decision `id`.
    pub fn set_draft(&self, id: &str, text: &str) {
        self.drafts.update(|all| {
            all.insert(id.to_owned(), text.to_owned());
        });
    }

    /// The last message an intent on decision `id` returned.
    pub fn message(&self, id: &str) -> String {
        self.messages
            .with(|all| all.get(id).cloned().unwrap_or_default())
    }

    /// Shows `message` on decision `id`.
    pub fn say(&self, id: &str, message: &str) {
        self.messages.update(|all| {
            all.insert(id.to_owned(), message.to_owned());
        });
    }

    /// Whether a question on decision `id` is on its way.
    pub fn asking(&self, id: &str) -> bool {
        self.asking
            .with(|all| all.get(id).copied().unwrap_or(false))
    }

    fn set_asking(&self, id: &str, on: bool) {
        self.asking.update(|all| {
            all.insert(id.to_owned(), on);
        });
    }

    /// The decision the user brought to the front.
    pub fn focused(&self) -> Option<String> {
        self.focused.get()
    }

    /// Brings decision `id` to the front.
    pub fn focus(&self, id: Option<String>) {
        self.focused.set(id);
    }

    /// Sends the question typed on decision `id`, once at a time. Clears
    /// only the text that was sent; anything typed meanwhile stays.
    pub fn send_question(&self, id: &str) {
        if self
            .asking
            .with_untracked(|all| all.get(id).copied().unwrap_or(false))
        {
            return;
        }
        let question = self
            .drafts
            .with_untracked(|all| all.get(id).cloned().unwrap_or_default());
        self.set_asking(id, true);
        let day = *self;
        let id = id.to_owned();
        let revision = self.desk.with(|desk| {
            desk.today()
                .decisions
                .iter()
                .find(|d| d.id == id)
                .map_or(0, |d| d.revision)
        });
        let intent = AskIntent {
            decision_id: id.clone(),
            revision,
            question: question.clone(),
        };
        self.ask(intent, move |outcome| {
            day.set_asking(&id, false);
            let unchanged = day
                .drafts
                .with_untracked(|all| all.get(&id).cloned().unwrap_or_default())
                == question;
            if outcome.status == OutcomeStatus::Accepted && unchanged {
                day.set_draft(&id, "");
            }
            day.say(&id, &outcome.message);
        });
    }
}

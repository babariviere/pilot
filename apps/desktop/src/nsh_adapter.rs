//! Native Shell's presentation boundary over the shipping Local reader and courier.
// This module owns presentation only. The existing courier is the sole draft
// writer and the only source of delivery/close acknowledgments.
use crate::{
    LocalOptions,
    delivery_store::{Draft, Store},
    interaction::{Interaction, WriteCommand, WriteState},
    local_client::{Command, LocalClient, Presentation},
    question::{AnswerDraft, Identity, Kind, Projection, Question},
    sidebar_memory::Memory,
    sidebar_tree::{self, Row},
};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    path::PathBuf,
    sync::Arc,
};
#[path = "nsh_find.rs"]
mod find;
pub use find::{FindSnapshot, FindTarget};
#[path = "nsh_images.rs"]
mod images;
#[cfg(feature = "native-probes")]
pub use images::synthetic_images;
#[cfg(feature = "native-probes")]
pub use images::{ImageAdmission, hold_image_previews};
pub use images::{ImagePreview, InlineImage};

/// Canonical committed reader identity, scoped by the selected location.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct ReaderKey(crate::model::ReaderKey);

/// Captured question and navigation identity. Never a user-message destination.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptTarget {
    location: Location,
    identity: Identity,
}
impl PromptTarget {
    /// Native input ownership marker, independent of the visible question prose.
    pub fn key(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.location.session,
            self.location.generation,
            self.identity.entry,
            self.identity.fingerprint
        )
    }
}

/// An offered answer, with no implicit selection or submission.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub label: String,
    pub detail: Option<String>,
    pub suggested: bool,
}

/// The current structured prompt. Only database access has an approval contract.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prompt {
    pub target: PromptTarget,
    pub title: String,
    pub context: Option<String>,
    pub scope: Option<String>,
    pub choices: Vec<Choice>,
    pub multi: bool,
    pub selected: BTreeSet<usize>,
    pub text: String,
    pub revision: u64,
    pub editable: bool,
    pub can_answer: bool,
    pub can_decide: bool,
    pub approval: bool,
    pub message: bool,
    pub allow_label: String,
    pub status: String,
}

/// A captured editor location. Old callbacks cannot edit or send in another chat.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct Location {
    pub session: String,
    generation: u64,
}

/// A native sidebar row, projected from the production sidebar tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidebarRow {
    pub key: String,
    pub title: String,
    pub detail: String,
    pub session: Option<String>,
    pub depth: usize,
    pub heading: bool,
}

/// Exact message source plus presentation identity, never an alternate history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub id: u64,
    pub reader: Option<ReaderKey>,
    pub source: String,
    pub mine: bool,
    pub plain: bool,
    pub work: Option<Work>,
    pub image: Option<InlineImage>,
}

/// Prepared production work presentation, not parsed transcript prose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Work {
    pub title: String,
    pub active: bool,
    pub calls: Vec<Call>,
    /// Swift-style units, including consecutive successful reads as one.
    pub units: Vec<Vec<usize>>,
    pub first_error: Option<(usize, String)>,
}

/// One canonical top-level call. Nested literal names never own its status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call {
    pub id: String,
    pub key: u64,
    pub caption: String,
    pub status: &'static str,
    pub failed: bool,
    pub input: Option<(&'static str, Arc<String>)>,
    pub output: Arc<String>,
    pub shown_output: Arc<String>,
    pub duration: Option<String>,
    pub diff: Arc<String>,
    pub arguments: Option<Arc<String>>,
    pub limited: bool,
}
impl Work {
    fn project(work: &crate::tool_presentation::Work) -> Self {
        use crate::tool_presentation::{self as tools, Status, Unit};
        Self {
            title: work.title.clone(),
            active: work.active,
            units: work
                .units()
                .into_iter()
                .map(|unit| match unit {
                    Unit::Step(index) => vec![index],
                    Unit::Reads(items) => items,
                })
                .collect(),
            first_error: work.first_error(),
            calls: work
                .calls()
                .map(|tool| {
                    let script = (tool.name == "codemode")
                        .then(|| tools::script_output(&tool.output))
                        .flatten();
                    Call {
                        id: tool.id.clone(),
                        key: tool.key,
                        caption: [tools::sentence(tool), tool.meta.clone()]
                            .into_iter()
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join(" · "),
                        status: if tool.status.live() && !work.active {
                            Status::Interrupted.label()
                        } else {
                            tool.status.label()
                        },
                        failed: tool.status == Status::Error,
                        input: tool.input.clone(),
                        output: tool.output.clone(),
                        shown_output: script
                            .as_ref()
                            .map_or_else(|| tool.output.clone(), |s| Arc::new(s.body.to_owned())),
                        duration: script.map(|s| format!("{} s", s.wall)),
                        diff: tool.diff.clone(),
                        arguments: (tool.input.is_none()
                            && tool.diff.is_empty()
                            && !tool.arguments.is_empty())
                        .then(|| tool.arguments.clone()),
                        limited: tool.limited,
                    }
                })
                .collect(),
        }
    }
}

/// Coalesced display state. No consumer can mutate delivery or stored history.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub sidebar: Vec<SidebarRow>,
    pub location: Option<Location>,
    pub title: String,
    pub project: String,
    pub messages: Vec<Message>,
    pub text: String,
    pub recovered: Vec<String>,
    pub prompt: Option<Prompt>,
    pub previous_reply: Option<String>,
    pub status: String,
    pub problem: Option<String>,
    pub editable: bool,
    pub can_send: bool,
    pub can_stop: bool,
    pub working: bool,
    pub submitting: bool,
    pub thinking: bool,
    pub earlier: bool,
    pub loading_earlier: bool,
    pub history_status: String,
    pub history_loaded: bool,
    pub behind: bool,
    pub find: FindSnapshot,
    pub closed: bool,
}

/// Opaque publication from one of the existing production workers.
pub struct Update(Event);
enum Event {
    Read(Box<Presentation>),
    Write(Box<WriteState>),
    Find(find::Reply),
}

/// Event-driven subscriptions. Waiting does not poll or perform UI-thread I/O.
#[derive(Clone)]
pub struct Events {
    reads: async_channel::Receiver<Presentation>,
    writes: async_channel::Receiver<WriteState>,
    finds: async_channel::Receiver<find::Reply>,
}
impl Events {
    /// Wait for the next worker publication, or both workers to close.
    pub async fn next(&self) -> Option<Update> {
        use futures_util::{FutureExt, select};
        let read = self.reads.recv().fuse();
        let write = self.writes.recv().fuse();
        let find = self.finds.recv().fuse();
        futures_util::pin_mut!(read, write, find);
        select! {
            value = find => value.ok().map(|v| Update(Event::Find(v))),
            value = read => match value {
                Ok(value) => Some(Update(Event::Read(Box::new(value)))),
                Err(_) => self.writes.recv().await.ok().map(|v| Update(Event::Write(Box::new(v)))),
            },
            value = write => match value {
                Ok(value) => Some(Update(Event::Write(Box::new(value)))),
                Err(_) => self.reads.recv().await.ok().map(|v| Update(Event::Read(Box::new(v)))),
            },
        }
    }
}

/// Presentation owner for the additive NSH chat slice.
pub struct Adapter {
    reader: LocalClient,
    courier: Interaction,
    events: Events,
    read: Presentation,
    write: WriteState,
    drafts: BTreeMap<String, Draft>,
    waiting: BTreeMap<String, u64>,
    unsaved: HashSet<String>,
    selected: Option<Location>,
    generation: u64,
    request: u64,
    memory: Memory,
    collapsed: HashSet<String>,
    finished: HashSet<String>,
    query: String,
    closing: bool,
    problem: Option<&'static str>,
    access: Vec<crate::database_access::Reply>,
    retiring: BTreeMap<String, u64>,
    find: find::Find,
    earlier_request: Option<(u64, u64)>,
}

impl Adapter {
    /// Start only the established loopback reader and private draft courier.
    /// `state` uses the existing Store format and exclusive writer lock.
    pub fn start(options: LocalOptions, state: PathBuf) -> Self {
        let (reader, reads) = LocalClient::start(options.clone());
        let (courier, writes) = Interaction::start(options, Ok(state));
        let (find, finds) = find::Find::new();
        Self {
            reader,
            courier,
            events: Events {
                reads,
                writes,
                finds,
            },
            read: Presentation::default(),
            write: WriteState::default(),
            drafts: BTreeMap::new(),
            waiting: BTreeMap::new(),
            unsaved: HashSet::new(),
            selected: None,
            generation: 0,
            request: 0,
            memory: Memory::ephemeral(crate::sidebar_memory::now()),
            collapsed: HashSet::new(),
            finished: HashSet::new(),
            query: String::new(),
            closing: false,
            problem: None,
            access: Vec::new(),
            retiring: BTreeMap::new(),
            find,
            earlier_request: None,
        }
    }

    /// The shipping draft location, including its ordinary writer-exclusion lock.
    pub fn default_state() -> Result<PathBuf, &'static str> {
        Store::default_path()
    }

    /// Subscribe before mounting; publications remain owned by this adapter.
    pub fn events(&self) -> Events {
        self.events.clone()
    }

    /// Apply a publication. A late reader generation never replaces another chat.
    pub fn accept(&mut self, update: Update) {
        match update.0 {
            Event::Find(reply) => self.find.accept(reply),
            Event::Read(read) => {
                if read.generation == self.generation {
                    if self.read.reader_revision != read.reader_revision {
                        self.find.invalidate();
                    }
                    if self
                        .earlier_request
                        .is_some_and(|(_, revision)| read.page_revision > revision)
                    {
                        self.earlier_request = None;
                    }
                }
                self.memory.observe(&read.chats);
                if let Some(location) = &self.selected
                    && let Some(chat) = read.chats.iter().find(|c| c.id == location.session)
                {
                    self.memory.note_seen(chat);
                }
                self.read = *read;
            }
            Event::Write(write) => {
                if let Some(reply) = &write.access
                    && let Some(local) = self.access.iter_mut().find(|local| {
                        local.request == reply.request && local.decision == reply.decision
                    })
                {
                    *local = reply.clone();
                }
                if let Some(book) = &write.book {
                    for (key, saved) in &book.drafts {
                        match self.drafts.get_mut(key) {
                            Some(local) if local.revision > saved.revision => {
                                local.pending = saved.pending.clone();
                                local.last = saved.last.clone();
                                local.created = saved.created.clone();
                                local.recovered = saved.recovered.clone();
                                local.recovery_revision = saved.recovery_revision;
                                local.settled_revision = saved.settled_revision;
                            }
                            _ => {
                                self.drafts.insert(key.clone(), saved.clone());
                            }
                        }
                    }
                }
                self.waiting
                    .retain(|key, request| write.handled.get(key).is_none_or(|n| n < request));
                self.write = *write;
            }
        }
        self.retire_answer(false);
        self.refresh_find(false);
        if self.find.loading && !self.read.page_busy && self.earlier_request.is_none() {
            if self.read.page_error
                || self.read.chat_issue
                || self.read.limited
                || self.read.cursor.is_none()
            {
                self.find.loading = false;
            } else if let Some(location) = self.selected.clone() {
                self.earlier(&location);
            }
        }
    }

    /// Select an exact canonical chat without starting its agent.
    pub fn open(&mut self, id: &str) -> bool {
        if self.closing || !self.read.chats.iter().any(|chat| chat.id == id) {
            return false;
        }
        if self
            .selected
            .as_ref()
            .is_some_and(|location| location.session == id)
        {
            return true;
        }
        let generation = self.generation + 1;
        let passive = self
            .read
            .chats
            .iter()
            .any(|c| c.id == id && (c.legacy_ask || c.archived));
        let command = if passive {
            Command::OpenArchive {
                id: id.into(),
                generation,
            }
        } else {
            Command::Open {
                id: id.into(),
                generation,
            }
        };
        if !self.reader.command(command) {
            return false;
        }
        self.generation = generation;
        self.find.reset();
        self.earlier_request = None;
        self.selected = Some(Location {
            session: id.into(),
            generation,
        });
        self.problem = None;
        if let Some(chat) = self.read.chats.iter().find(|c| c.id == id) {
            if let crate::local_model::MissionAssociation::Linked(mission) = &chat.mission {
                self.collapsed.remove(mission);
            }
            self.memory.note_seen(chat);
        }
        true
    }

    /// A filter never changes the selected editor location.
    pub fn search(&mut self, query: &str) {
        self.query = query.to_lowercase();
    }

    /// Toggle a production sidebar group or finished-member disclosure.
    pub fn toggle(&mut self, key: &str) {
        if let Some(group) = key.strip_prefix("group:") {
            let collapsed = !self.memory.group_collapsed(group);
            self.memory.set_group_collapsed(group, collapsed);
        } else if let Some(mission) = key.strip_prefix("fold:") {
            if !self.finished.remove(mission) {
                self.finished.insert(mission.into());
            }
        } else if let Some(mission) = key.strip_prefix("mission:")
            && !self.collapsed.remove(mission)
        {
            self.collapsed.insert(mission.into());
        }
    }

    fn key(location: &Location) -> String {
        format!("chat:{}", location.session)
    }
    fn current(&self, location: &Location) -> bool {
        self.selected.as_ref() == Some(location)
    }

    /// Capture exact native text before navigation, submit or close. Never trim it.
    pub fn edit(&mut self, location: &Location, text: &str) -> bool {
        if !self.current(location) || self.closing || self.write.book.is_none() {
            return false;
        }
        let key = Self::key(location);
        let unchanged = self
            .drafts
            .get(&key)
            .map_or(text.is_empty(), |d| d.text == text);
        if unchanged {
            return true;
        }
        if !self
            .read
            .chats
            .iter()
            .any(|c| c.id == location.session && c.writable && !c.legacy_ask && !c.archived)
        {
            return false;
        }
        let draft = self.drafts.entry(key.clone()).or_default();
        if !draft.editable() || self.waiting.contains_key(&key) {
            return false;
        }
        if draft.text == text {
            return true;
        }
        draft.revision += 1;
        draft.text = text.into();
        if !self.courier.edit(key.clone(), draft.clone()) {
            self.unsaved.insert(key);
            self.problem = Some("Draft not saved. Keep this window open and copy the text.");
            return false;
        }
        self.unsaved.remove(&key);
        self.problem = None;
        true
    }

    /// Existing courier admission and immutable operation/dedupe semantics only.
    fn question(&self, target: &PromptTarget) -> Option<Arc<Question>> {
        if !self.current(&target.location) {
            return None;
        }
        match &self.read.question {
            Projection::Pending(q) if q.identity == target.identity => Some(q.clone()),
            _ => None,
        }
    }

    /// Save exact question text separately from the ordinary composer.
    /// An in-flight native composition may finish into its original saved reply.
    pub fn edit_reply(&mut self, target: &PromptTarget, text: &str) -> bool {
        self.capture_reply(target, None, text)
    }

    /// Select an offered choice. Selection alone never transmits an answer.
    pub fn pick(&mut self, target: &PromptTarget, index: usize, checked: bool) -> bool {
        let Some(prompt) = self
            .snapshot()
            .prompt
            .filter(|p| p.target == *target && p.editable)
        else {
            return false;
        };
        let mut selected = prompt.selected;
        if prompt.multi {
            if checked {
                selected.insert(index);
            } else {
                selected.remove(&index);
            }
        } else {
            selected.clear();
            selected.insert(index);
        }
        self.capture_reply(target, Some(selected), &prompt.text)
    }

    fn capture_reply(
        &mut self,
        target: &PromptTarget,
        selected: Option<BTreeSet<usize>>,
        text: &str,
    ) -> bool {
        if !self.current(&target.location) || self.closing || self.write.book.is_none() {
            return false;
        }
        let key = Self::key(&target.location);
        let mut draft = self.drafts.get(&key).cloned().unwrap_or_default();
        let saved = draft
            .answer
            .as_ref()
            .filter(|a| a.identity.question == target.identity);
        if saved
            .is_some_and(|a| a.text == text && selected.as_ref().is_none_or(|s| *s == a.selected))
        {
            return true;
        }
        if !draft.editable()
            || self.waiting.contains_key(&key)
            || saved.is_some_and(|a| crate::delivery_store::reply_accepted(&draft, &a.identity))
            || !self.read.chats.iter().any(|c| {
                c.id == target.location.session && c.writable && !c.legacy_ask && !c.archived
            })
            || draft
                .answer
                .as_ref()
                .is_some_and(|a| a.identity.question != target.identity)
        {
            return false;
        }
        let revision = draft.revision + 1;
        let answer = if let Some(question) = self.question(target) {
            if question.content.kind != Kind::Message {
                return false;
            }
            AnswerDraft::capture(
                &question,
                revision,
                selected.unwrap_or_else(|| saved.map(|a| a.selected.clone()).unwrap_or_default()),
                text.into(),
            )
        } else if let Some(saved) = saved.filter(|_| selected.is_none()) {
            let mut answer = saved.clone();
            answer.identity.revision = revision;
            answer.text = text.into();
            answer.validate().map(|_| answer)
        } else {
            return false;
        };
        let answer = match answer {
            Ok(a) => a,
            Err(error) => {
                self.problem = Some(error);
                self.unsaved.insert(key);
                return false;
            }
        };
        if draft.settled_revision.is_some_and(|r| draft.revision <= r) {
            draft.settled_revision = Some(revision);
        }
        draft.revision = revision;
        draft.answer = Some(answer);
        self.drafts.insert(key.clone(), draft.clone());
        if !self.courier.edit(key.clone(), draft) {
            self.unsaved.insert(key);
            self.problem = Some("Question reply not saved. Keep this window open and copy it.");
            return false;
        }
        self.unsaved.remove(&key);
        self.problem = None;
        true
    }

    /// Submit only the captured question/reply revision via the existing courier.
    pub fn answer(&mut self, target: &PromptTarget, revision: u64) -> bool {
        let Some(prompt) = self
            .snapshot()
            .prompt
            .filter(|p| p.target == *target && p.can_answer && p.revision == revision)
        else {
            return false;
        };
        let Some(question) = self.question(&prompt.target) else {
            return false;
        };
        let key = Self::key(&target.location);
        let Some(mut draft) = self.drafts.get(&key).cloned() else {
            return false;
        };
        draft.input_generation = self
            .read
            .chats
            .iter()
            .find(|c| c.id == target.location.session)
            .and_then(|c| c.input_generation);
        self.request += 1;
        if !self.courier.command(WriteCommand::Answer {
            key: key.clone(),
            draft: Box::new(draft),
            question,
            request: self.request,
        }) {
            return false;
        }
        self.waiting.insert(key, self.request);
        true
    }

    /// Explicit Allow/Deny for the exact structured database request only.
    /// The production contract is one-shot and its reply is volatile, not durable.
    pub fn decide(&mut self, target: &PromptTarget, allow: bool) -> bool {
        if !self
            .snapshot()
            .prompt
            .is_some_and(|p| p.target == *target && p.can_decide)
        {
            return false;
        }
        let Some(question) = self.question(target) else {
            return false;
        };
        let Some(access) = question.content.access.clone() else {
            return false;
        };
        self.request += 1;
        let decision = crate::database_access::Decision {
            session: target.location.session.clone(),
            question: question.identity.clone(),
            access,
            allow,
        };
        if !self.courier.command(WriteCommand::DatabaseAccess {
            decision: decision.clone(),
            request: self.request,
        }) {
            return false;
        }
        self.access.push(crate::database_access::Reply {
            decision,
            request: self.request,
            outcome: crate::database_access::Outcome::Pending,
        });
        true
    }

    /// Keep an old unsent reply in the existing private recovery list.
    pub fn recover_reply(&mut self, location: &Location) -> bool {
        if !self.current(location) || self.snapshot().previous_reply.is_none() {
            return false;
        }
        self.retiring.remove(&Self::key(location));
        self.retire_answer(true)
    }
    fn retire_answer(&mut self, recover: bool) -> bool {
        let Some(location) = &self.selected else {
            return false;
        };
        let key = Self::key(location);
        let Some(draft) = self.drafts.get(&key) else {
            return false;
        };
        let Some(answer) = &draft.answer else {
            return false;
        };
        let same = matches!(&self.read.question, Projection::Pending(q) if q.identity == answer.identity.question)
            && self.read.generation == location.generation;
        let accepted = crate::delivery_store::reply_accepted(draft, &answer.identity);
        if self.closing
            || self.waiting.contains_key(&key)
            || self.retiring.get(&key) == Some(&draft.revision)
            || (!recover && (same || !accepted))
        {
            return false;
        }
        if self.courier.command(WriteCommand::RetireAnswer {
            key: key.clone(),
            revision: draft.revision,
            identity: answer.identity.clone(),
            recover,
        }) {
            self.retiring.insert(key, draft.revision);
            return true;
        }
        false
    }

    /// Existing courier admission and immutable operation/dedupe semantics only.
    pub fn send(&mut self, location: &Location) -> bool {
        self.submit(location, false)
    }
    /// Stop targets the captured chat, never whichever row is selected later.
    pub fn stop(&mut self, location: &Location) -> bool {
        self.submit(location, true)
    }
    fn submit(&mut self, location: &Location, stop: bool) -> bool {
        let snapshot = self.snapshot();
        if !self.current(location)
            || !(if stop {
                snapshot.can_stop
            } else {
                snapshot.can_send
            })
        {
            return false;
        }
        let key = Self::key(location);
        let mut draft = self.drafts.get(&key).cloned().unwrap_or_default();
        draft.input_generation = self
            .read
            .chats
            .iter()
            .find(|c| c.id == location.session)
            .and_then(|c| c.input_generation);
        self.request += 1;
        if !self.courier.command(WriteCommand::Submit {
            key: key.clone(),
            draft: Box::new(draft),
            follow_up: false,
            stop,
            request: self.request,
        }) {
            self.problem = Some("Action not queued. Your draft is kept.");
            return false;
        }
        self.waiting.insert(key, self.request);
        if !stop {
            self.memory
                .note_sent(&location.session, crate::sidebar_memory::now());
        }
        true
    }

    /// Ask the existing paginated reader for the next older page.
    pub fn earlier(&mut self, location: &Location) -> bool {
        let queued = self.current(location)
            && self.read.generation == location.generation
            && self.read.loaded
            && self.earlier_request.is_none()
            && !self.read.page_busy
            && self.read.cursor.is_some_and(|before| {
                self.reader.command(Command::Earlier {
                    before,
                    generation: location.generation,
                })
            });
        if queued {
            self.earlier_request = Some((location.generation, self.read.page_revision));
            self.read.page_busy = true;
            self.read.page_error = false;
        }
        queued
    }

    /// Top-scroll retries only on a new approach, never loops on a failed page.
    pub fn history_top(&mut self, location: &Location) {
        if !self.read.page_error {
            self.earlier(location);
        }
    }

    /// Reopen only when the production reader omitted newer entries.
    pub fn latest(&mut self, location: &Location) {
        if !self.current(location) {
            return;
        }
        if self.read.behind {
            let generation = self.generation + 1;
            let command = if self.read.passive_history {
                Command::OpenArchive {
                    id: location.session.clone(),
                    generation,
                }
            } else {
                Command::Open {
                    id: location.session.clone(),
                    generation,
                }
            };
            if self.reader.command(command) {
                self.generation = generation;
                self.selected = Some(Location {
                    session: location.session.clone(),
                    generation,
                });
                self.find.reset();
                self.earlier_request = None;
            }
        } else {
            self.follow(location, true);
        }
    }

    pub fn find_open(&mut self, location: &Location, open: bool) {
        if !self.current(location) {
            return;
        }
        if open {
            self.find.open = true;
            self.refresh_find(false);
        } else {
            self.find.reset();
        }
    }
    pub fn find_query(&mut self, location: &Location, query: &str) {
        if !self.current(location) || !self.find.open || self.find.query == query {
            return;
        }
        self.find.invalidate();
        self.find.query = query.into();
        self.refresh_find(true);
    }
    pub fn find_step(&mut self, location: &Location, previous: bool) {
        if self.current(location) {
            self.find.step(previous);
        }
    }
    pub fn find_history(&mut self, location: &Location, loading: bool) {
        if !self.current(location) || !self.find.open {
            return;
        }
        self.find.loading = loading;
        self.find.cancelled = !loading;
        if loading {
            self.earlier(location);
        }
    }
    fn refresh_find(&mut self, navigate: bool) {
        if self.read.generation == self.generation {
            self.find.refresh(&self.read, navigate);
        }
    }
    /// Reading older text must not be dragged to the streaming tail.
    pub fn follow(&self, location: &Location, following: bool) {
        if self.current(location) {
            self.reader.follow(location.generation, following);
        }
    }

    /// Freeze input, then request the courier's real FIFO Close/Flushed boundary.
    /// False means retain this window; never infer success from a deadline.
    pub fn close(&mut self) -> bool {
        if self.closing {
            return true;
        }
        if !self.unsaved.is_empty() || self.write.error.is_some() || self.write.book.is_none() {
            return false;
        }
        if !self.courier.command(WriteCommand::Close) {
            return false;
        }
        self.closing = true;
        self.find.reset();
        true
    }

    /// Current native presentation, derived from the unchanged worker state.
    pub fn snapshot(&self) -> Snapshot {
        let selected = self.selected.as_ref();
        let chat = selected.and_then(|l| self.read.chats.iter().find(|c| c.id == l.session));
        let key = selected.map(Self::key);
        let submitting = key.as_ref().is_some_and(|k| self.waiting.contains_key(k));
        let draft = key.as_ref().and_then(|k| self.drafts.get(k));
        let waiting = key.as_ref().is_some_and(|k| self.waiting.contains_key(k))
            || draft.is_some_and(|d| !d.editable());
        let current = selected.is_some_and(|l| l.generation == self.read.generation);
        let ready = self.write.book.is_some()
            && self.write.error.is_none()
            && self.unsaved.is_empty()
            && !self.closing;
        let fresh = current && self.read.loaded && self.read.summary_fresh && !self.read.chat_issue;
        let writable = chat.is_some_and(|c| c.writable && !c.archived && !c.legacy_ask);
        let supported_draft = draft.is_none_or(|d| d.attachments.is_empty() && d.created.is_none());
        let retained = draft
            .and_then(|d| d.pending.as_ref())
            .and_then(|id| self.write.book.as_ref().and_then(|b| b.pending.get(id)));
        let pending = retained.is_some_and(|i| i.state == "pending");
        let unknown = !submitting
            && (retained.is_some_and(|i| i.state == "unknown")
                || draft.is_some_and(|d| d.last.as_ref().is_some_and(|l| l.state == "unknown")));
        let editable = ready && writable && !waiting && supported_draft;
        let question = current && matches!(self.read.question, Projection::Pending(_));
        let previous_reply = draft.and_then(|d| d.answer.as_ref().filter(|a| {
            !crate::delivery_store::reply_accepted(d, &a.identity)
                && a.has_content()
                && (!current || !matches!(&self.read.question, Projection::Pending(q) if q.identity == a.identity.question))
        })).map(AnswerDraft::recovery);
        let prompt = selected.filter(|_| current).and_then(|location| {
            let Projection::Pending(q) = &self.read.question else {
                return None;
            };
            let answer = draft
                .and_then(|d| d.answer.as_ref())
                .filter(|a| a.identity.question == q.identity);
            let accepted = draft.is_some_and(|d| {
                d.last.as_ref().is_some_and(|l| {
                    l.state == "accepted"
                        && l.answer.as_ref().is_some_and(|a| a.question == q.identity)
                })
            });
            let qfresh = self
                .read
                .question_fresh(Some(&location.session), location.generation);
            let model_pending = self
                .write
                .book
                .as_ref()
                .is_some_and(|b| b.model_changes.contains_key(&location.session));
            let access = q.content.access.as_ref();
            let outcome = self
                .access
                .iter()
                .rev()
                .find(|r| {
                    r.decision.session == location.session && r.decision.question == q.identity
                })
                .map(|r| &r.outcome);
            let editable = ready
                && writable
                && !waiting
                && !unknown
                && qfresh
                && previous_reply.is_none()
                && !accepted
                && !model_pending
                && q.content.kind == Kind::Message;
            let (title, scope, allow_label) = if let Some(access) = access {
                let mode = match access.mode {
                    crate::question::AccessMode::Read => "read",
                    crate::question::AccessMode::Write => "write",
                };
                (
                    format!("Allow {mode} access to the {} database?", access.env),
                    Some(
                        match access.mode {
                            crate::question::AccessMode::Read => {
                                "Read-only, for the rest of this chat."
                            }
                            crate::question::AccessMode::Write => {
                                "Reads and writes, for the rest of this chat."
                            }
                        }
                        .into(),
                    ),
                    format!("Allow {mode} access"),
                )
            } else {
                (q.content.question.clone(), None, String::new())
            };
            use crate::database_access::Outcome;
            let status = if !qfresh {
                "Question is not current. Reply kept.".into()
            } else if q.content.kind == Kind::AccessUnavailable {
                "This access request is malformed or unsupported. A message never grants access."
                    .into()
            } else if let Some(outcome) = outcome {
                match outcome {
                    Outcome::Pending => "Sending decision…".into(),
                    Outcome::Accepted => "Decision sent. Waiting for the agent.".into(),
                    Outcome::Unknown(e) => format!("Decision unknown. {e}"),
                    Outcome::Refused(e) => (*e).into(),
                }
            } else if accepted {
                "Reply sent. Waiting for the agent.".into()
            } else if unknown {
                "Reply delivery unknown. Original reply kept; not resent.".into()
            } else if waiting {
                "Reply delivery pending".into()
            } else if model_pending {
                "A model change is unconfirmed. Your reply is kept.".into()
            } else if draft.is_some_and(|d| {
                d.last.as_ref().is_some_and(|l| {
                    l.state == "rejected"
                        && l.answer.as_ref().is_some_and(|a| a.question == q.identity)
                })
            }) {
                "Reply not accepted. Edit it before sending again.".into()
            } else {
                String::new()
            };
            Some(Prompt {
                target: PromptTarget {
                    location: location.clone(),
                    identity: q.identity.clone(),
                },
                title,
                context: q.content.context.clone(),
                scope,
                choices: if q.content.kind == Kind::Message {
                    q.content
                        .options
                        .iter()
                        .map(|o| Choice {
                            label: o.label.clone(),
                            detail: o.detail.clone(),
                            suggested: o.suggested,
                        })
                        .collect()
                } else {
                    Vec::new()
                },
                multi: q.content.multi,
                selected: answer.map(|a| a.selected.clone()).unwrap_or_default(),
                text: answer.map(|a| a.text.clone()).unwrap_or_default(),
                revision: answer.map_or(0, |a| a.identity.revision),
                can_answer: editable && answer.is_some_and(|a| matches!(a.reply(q), Ok(Some(_)))),
                editable,
                approval: q.content.kind == Kind::Access,
                message: q.content.kind == Kind::Message,
                can_decide: ready
                    && writable
                    && qfresh
                    && !waiting
                    && !unknown
                    && q.content.kind == Kind::Access
                    && !matches!(outcome, Some(Outcome::Pending | Outcome::Accepted)),
                allow_label,
                status,
            })
        });
        let mut problem = self.problem.or(self.write.error).map(str::to_owned);
        if problem.is_none() && unknown {
            problem = Some("Delivery unknown. Original operation kept; no new send.".into());
        }
        if problem.is_none() && !supported_draft {
            problem = Some("This saved draft needs the current app.".into());
        }
        if problem.is_none()
            && current
            && let Projection::Invalid(error) = &self.read.question
        {
            problem = Some((*error).into());
        }
        if problem.is_none() && self.read.chat_issue {
            problem = Some(self.read.chat_status.clone());
        }
        let rows = if current {
            self.read
                .rows
                .iter()
                .map(|m| Message {
                    id: m.id(),
                    reader: m.reader_key().map(ReaderKey),
                    source: if m.artifact_data().is_some() {
                        format!("{}\n\nPreview unavailable in this chat slice.", m.source())
                    } else {
                        m.source().into()
                    },
                    mine: m.label().starts_with("You"),
                    plain: m.is_plain(),
                    work: m.work_data().map(|work| Work::project(work)),
                    image: m
                        .image_data()
                        .map(|source| InlineImage::new(m, source.clone())),
                })
                .collect()
        } else {
            Vec::new()
        };
        Snapshot {
            sidebar: self.sidebar(),
            location: selected.cloned(),
            title: chat
                .map(|c| c.title.clone())
                .unwrap_or_else(|| "Choose a chat".into()),
            project: chat.map(|c| self.project(c)).unwrap_or_default(),
            messages: rows,
            text: draft.map(|d| d.text.clone()).unwrap_or_default(),
            recovered: draft
                .map(|d| d.recovered.as_ref().clone())
                .unwrap_or_default(),
            prompt,
            previous_reply,
            status: if self.closing {
                "Saving drafts…".into()
            } else if submitting {
                "Sending…".into()
            } else if pending {
                "Delivery pending".into()
            } else if unknown {
                "Delivery unknown".into()
            } else if chat.is_some_and(|c| c.legacy_ask) {
                "Read-only Ask".into()
            } else if question {
                String::new()
            } else if !fresh {
                self.read.status.clone()
            } else {
                chat.and_then(|c| c.row_reason().map(str::to_owned))
                    .unwrap_or_default()
            },
            problem,
            editable,
            can_send: editable
                && fresh
                && !unknown
                && !question
                && draft.is_none_or(|d| d.answer.is_none())
                && draft.is_some_and(|d| !d.text.trim().is_empty()),
            can_stop: ready
                && fresh
                && !waiting
                && !unknown
                && chat.is_some_and(|c| c.busy && (c.writable || c.legacy_ask)),
            working: chat.is_some_and(|c| c.busy),
            submitting,
            thinking: current && self.read.thinking,
            earlier: current && self.read.cursor.is_some(),
            loading_earlier: self.read.page_busy,
            history_status: if current && self.read.page_error {
                "Earlier messages unavailable. Try again.".into()
            } else if current && (self.read.limited || self.read.omitted > 0) {
                "History is partial".into()
            } else {
                String::new()
            },
            history_loaded: current && self.read.loaded,
            behind: current && self.read.behind,
            find: self.find.snapshot(&self.read, current),
            closed: self.closing
                && self.write.flushed
                && self.write.error.is_none()
                && self.waiting.is_empty()
                && self.unsaved.is_empty()
                && self.write.delivery_reports.values().all(|r| r.saved)
                && self.write.book.as_ref().is_some_and(|book| {
                    self.drafts.iter().all(|(key, draft)| {
                        book.drafts.get(key) == Some(draft) || *draft == Draft::default()
                    })
                }),
        }
    }

    fn project(&self, chat: &crate::local_model::Chat) -> String {
        chat.project_id
            .as_ref()
            .map(|id| {
                self.read
                    .projects
                    .iter()
                    .find(|p| &p.id == id)
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| id.clone())
            })
            .unwrap_or_else(|| chat.cwd.clone())
    }

    fn sidebar(&self) -> Vec<SidebarRow> {
        let tree = sidebar_tree::build(&sidebar_tree::Input {
            chats: &self.read.chats,
            keep: &|c| !c.archived,
            query: &self.query,
            grouped: true,
            collapsed: &self.collapsed,
            show_finished: &self.finished,
            opened: self.selected.as_ref().map(|l| l.session.as_str()),
            memory: &self.memory,
        });
        tree.rows
            .iter()
            .map(|row| {
                let key = tree.key(*row, &self.read.chats);
                match *row {
                    Row::Group(ix) => {
                        let group = &tree.groups[ix];
                        let title = group
                            .key
                            .strip_prefix("project:")
                            .and_then(|id| {
                                self.read
                                    .projects
                                    .iter()
                                    .find(|p| p.id == id)
                                    .map(|p| p.name.clone())
                            })
                            .unwrap_or_else(|| group.key.trim_start_matches("dir:").to_owned());
                        SidebarRow {
                            key,
                            title,
                            detail: if group.collapsed {
                                format!("{} chats", group.chats)
                            } else {
                                String::new()
                            },
                            session: None,
                            depth: 0,
                            heading: true,
                        }
                    }
                    Row::Fold(ix) => SidebarRow {
                        key,
                        title: if tree.threads[ix].show_finished {
                            "Hide finished".into()
                        } else {
                            format!("+{} finished", tree.threads[ix].finished)
                        },
                        detail: String::new(),
                        session: None,
                        depth: 1,
                        heading: false,
                    },
                    Row::Chat(ix) | Row::Member { chat: ix, .. } => {
                        let chat = &self.read.chats[ix];
                        SidebarRow {
                            key,
                            title: chat.title.clone(),
                            detail: chat
                                .row_reason()
                                .map(|reason| format!("{} · {reason}", self.project(chat)))
                                .unwrap_or_else(|| self.project(chat)),
                            session: Some(chat.id.clone()),
                            depth: usize::from(matches!(row, Row::Member { .. })),
                            heading: false,
                        }
                    }
                    Row::Parent(ix) => {
                        let thread = &tree.threads[ix];
                        SidebarRow {
                            key,
                            title: self
                                .read
                                .mission_titles
                                .as_ref()
                                .and_then(|m| m.get(&thread.mission))
                                .cloned()
                                .unwrap_or_else(|| "Mission".into()),
                            detail: thread.rollup.words(),
                            session: thread.coordinator.map(|ix| self.read.chats[ix].id.clone()),
                            depth: 0,
                            heading: false,
                        }
                    }
                }
            })
            .collect()
    }
}

/// Test-only identity pinning. Still exercises the actual production transports.
#[cfg(feature = "native-probes")]
pub fn synthetic_options(port: u16) -> LocalOptions {
    LocalOptions::synthetic(port)
}

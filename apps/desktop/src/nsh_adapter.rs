//! Native Shell's presentation boundary over the shipping Local reader and courier.
// This module owns presentation only. The existing courier is the sole draft
// writer and the only source of delivery/close acknowledgments.
use crate::{
    LocalOptions,
    delivery_store::{Draft, Store},
    interaction::{Interaction, WriteCommand, WriteState},
    local_client::{Command, LocalClient, Presentation},
    sidebar_memory::Memory,
    sidebar_tree::{self, Row},
};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
};

/// A captured editor location. Old callbacks cannot edit or send in another chat.
#[derive(Clone, Debug, PartialEq, Eq)]
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
    pub source: String,
    pub mine: bool,
    pub plain: bool,
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
    pub closed: bool,
}

/// Opaque publication from one of the existing production workers.
pub struct Update(Event);
enum Event {
    Read(Box<Presentation>),
    Write(Box<WriteState>),
}

/// Event-driven subscriptions. Waiting does not poll or perform UI-thread I/O.
#[derive(Clone)]
pub struct Events {
    reads: async_channel::Receiver<Presentation>,
    writes: async_channel::Receiver<WriteState>,
}
impl Events {
    /// Wait for the next worker publication, or both workers to close.
    pub async fn next(&self) -> Option<Update> {
        use futures_util::{FutureExt, select};
        let read = self.reads.recv().fuse();
        let write = self.writes.recv().fuse();
        futures_util::pin_mut!(read, write);
        select! {
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
}

impl Adapter {
    /// Start only the established loopback reader and private draft courier.
    /// `state` uses the existing Store format and exclusive writer lock.
    pub fn start(options: LocalOptions, state: PathBuf) -> Self {
        let (reader, reads) = LocalClient::start(options.clone());
        let (courier, writes) = Interaction::start(options, Ok(state));
        Self {
            reader,
            courier,
            events: Events { reads, writes },
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
            Event::Read(read) => {
                self.memory.observe(&read.chats);
                if let Some(location) = &self.selected
                    && let Some(chat) = read.chats.iter().find(|c| c.id == location.session)
                {
                    self.memory.note_seen(chat);
                }
                self.read = *read;
            }
            Event::Write(write) => {
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
    pub fn earlier(&self, location: &Location) -> bool {
        self.current(location)
            && self.read.generation == location.generation
            && !self.read.page_busy
            && self.read.cursor.is_some_and(|before| {
                self.reader.command(Command::Earlier {
                    before,
                    generation: location.generation,
                })
            })
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
        let supported_draft = draft
            .is_none_or(|d| d.answer.is_none() && d.attachments.is_empty() && d.created.is_none());
        let retained = draft
            .and_then(|d| d.pending.as_ref())
            .and_then(|id| self.write.book.as_ref().and_then(|b| b.pending.get(id)));
        let pending = retained.is_some_and(|i| i.state == "pending");
        let unknown = !submitting
            && (retained.is_some_and(|i| i.state == "unknown")
                || draft.is_some_and(|d| d.last.as_ref().is_some_and(|l| l.state == "unknown")));
        let editable = ready && writable && !waiting && supported_draft;
        let question = matches!(self.read.question, crate::question::Projection::Pending(_));
        let mut problem = self.problem.or(self.write.error).map(str::to_owned);
        if problem.is_none() && unknown {
            problem = Some("Delivery unknown. Original operation kept; no new send.".into());
        }
        if problem.is_none() && !supported_draft {
            problem = Some("This saved draft needs the current app.".into());
        }
        if problem.is_none() && question {
            problem = Some("Question pending. Answer in the current app.".into());
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
                    source: if m.image_data().is_some() || m.artifact_data().is_some() {
                        format!("{}\n\nPreview unavailable in this chat slice.", m.source())
                    } else {
                        m.source().into()
                    },
                    mine: m.label().starts_with("You"),
                    plain: m.is_plain(),
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

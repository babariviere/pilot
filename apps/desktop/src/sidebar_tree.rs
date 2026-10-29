//! Sidebar rows, built once per list change.
//!
//! Sections: Drafts, Pinned, Chats, then Archived with the Archived filter.
//! Chats holds mission threads and standalone chats, newest first by your own
//! activity (`sidebar_memory`), never by agent activity or state. A thread is
//! one level: its parent is the mission's coordinator chat (else the mission
//! alone), then its unfinished members and revealed finished members, each in
//! creation order. Finished members fold into "+N finished". A search lists
//! matching chats flat, without threads.
//!
//! Across all projects, Chats is split into flat project sections (a label row
//! each, then its rows), once there are two or more. A chat without a project
//! goes in a section for its folder. A thread sits with its coordinator's
//! project. Sections are ordered by your latest send to anything in them, the
//! same order as rows, and a collapsed section is only its label.
use crate::{
    chat_order::{SECTIONS, Section},
    local_model::{Chat, MissionAssociation},
    sidebar_memory::Memory,
    state_mark::Mark,
};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Row {
    /// A two-line chat row. Outside a thread it keeps its mission caption.
    Chat(usize),
    /// A thread's parent row (index into `Tree::threads`).
    Parent(usize),
    /// A one-line member of an expanded thread.
    Member { chat: usize, thread: usize },
    /// "+N finished" or "Hide finished", closing an expanded thread.
    Fold(usize),
    /// A project section's label (index into `Tree::groups`).
    Group(usize),
}

/// What a collapsed parent summarizes about its members.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Rollup {
    pub(crate) needs: usize,
    pub(crate) failed: usize,
    pub(crate) ready: usize,
    pub(crate) working: usize,
    pub(crate) unread: bool,
}
impl Rollup {
    pub(crate) fn add(&mut self, mark: Option<Mark>) {
        match mark.map(Mark::bucket) {
            Some(Mark::NeedsYou) => self.needs += 1,
            Some(Mark::Failed) => self.failed += 1,
            Some(Mark::Ready) => self.ready += 1,
            Some(Mark::Working) => self.working += 1,
            _ => {}
        }
    }
    /// Counts in display order, skipping zeros.
    pub(crate) fn counts(&self) -> Vec<(Mark, usize)> {
        [
            (Mark::NeedsYou, self.needs),
            (Mark::Failed, self.failed),
            (Mark::Ready, self.ready),
            (Mark::Working, self.working),
        ]
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .collect()
    }
    /// Spoken form, for the parent's accessible name.
    pub(crate) fn words(&self) -> String {
        self.counts()
            .into_iter()
            .map(|(mark, n)| match mark {
                Mark::NeedsYou => format!("{n} need you"),
                Mark::Failed => format!("{n} failed"),
                Mark::Ready => format!("{n} ready"),
                _ => format!("{n} working"),
            })
            .chain(self.unread.then(|| "new replies".to_owned()))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Thread {
    pub(crate) mission: String,
    pub(crate) coordinator: Option<usize>,
    /// Every member, in creation order.
    pub(crate) members: Vec<usize>,
    /// Members folded into "+N finished" unless shown.
    pub(crate) finished: usize,
    pub(crate) collapsed: bool,
    pub(crate) show_finished: bool,
    pub(crate) rollup: Rollup,
}

/// A project section of Chats.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Group {
    /// `group_key` of its chats.
    pub(crate) key: String,
    pub(crate) collapsed: bool,
    /// Every chat in it, thread members included.
    pub(crate) chats: usize,
    pub(crate) rollup: Rollup,
}
impl Group {
    /// The most urgent mark in the section.
    pub(crate) fn mark(&self) -> Option<Mark> {
        self.rollup.counts().first().map(|(mark, _)| *mark)
    }
}

/// The section a chat belongs to: its project, else its folder.
pub(crate) fn group_key(chat: &Chat) -> String {
    match &chat.project_id {
        Some(id) => format!("project:{id}"),
        None => format!("dir:{}", chat.cwd),
    }
}

pub(crate) struct Input<'a> {
    pub(crate) chats: &'a [Chat],
    /// Project scope and the Archived filter.
    pub(crate) keep: &'a dyn Fn(&Chat) -> bool,
    /// Lowercased; empty shows threads.
    pub(crate) query: &'a str,
    /// Split Chats into project sections (across all projects).
    pub(crate) grouped: bool,
    pub(crate) collapsed: &'a HashSet<String>,
    pub(crate) show_finished: &'a HashSet<String>,
    pub(crate) opened: Option<&'a str>,
    pub(crate) memory: &'a Memory,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Tree {
    pub(crate) rows: Vec<Row>,
    /// Start of each section in `rows`, plus the end.
    pub(crate) bounds: [usize; SECTIONS.len() + 1],
    pub(crate) threads: Vec<Thread>,
    /// Project sections, when Chats is split into them.
    pub(crate) groups: Vec<Group>,
}
impl Tree {
    #[cfg(test)]
    pub(crate) fn section_rows(&self, section: usize) -> &[Row] {
        &self.rows[self.bounds[section]..self.bounds[section + 1]]
    }
    /// The stable identity of a row, for selection across rebuilds: a chat's
    /// id (a parent's coordinator), else its mission.
    pub(crate) fn key(&self, row: Row, chats: &[Chat]) -> String {
        match row {
            Row::Chat(chat) | Row::Member { chat, .. } => chats[chat].id.clone(),
            Row::Parent(thread) => match self.threads[thread].coordinator {
                Some(chat) => chats[chat].id.clone(),
                None => format!("mission:{}", self.threads[thread].mission),
            },
            Row::Fold(thread) => format!("fold:{}", self.threads[thread].mission),
            Row::Group(group) => format!("group:{}", self.groups[group].key),
        }
    }
    /// The section key of a thread: its coordinator's, else its first member's.
    pub(crate) fn thread_group(&self, thread: usize, chats: &[Chat]) -> Option<String> {
        let t = &self.threads[thread];
        let lead = t.coordinator.or(t.members.first().copied())?;
        Some(group_key(&chats[lead]))
    }
    /// Where the row with `key` is now.
    pub(crate) fn find(&self, key: &str, chats: &[Chat]) -> Option<usize> {
        self.rows
            .iter()
            .position(|row| self.key(*row, chats) == key)
    }
}

/// Members that are quiet, already read and not open fold away.
fn finished(chat: &Chat, opened: Option<&str>, memory: &Memory) -> bool {
    Mark::of(chat).is_none() && !memory.unread(chat) && opened != Some(chat.id.as_str())
}

pub(crate) fn build(input: &Input) -> Tree {
    let Input {
        chats,
        keep,
        query,
        grouped: sectioned,
        collapsed,
        show_finished,
        opened,
        memory,
    } = *input;
    let shown = |c: &Chat| keep(c) && (query.is_empty() || c.title.to_lowercase().contains(query));
    let newest = |a: &usize, b: &usize| {
        let (a, b) = (&chats[*a], &chats[*b]);
        memory
            .key(b)
            .total_cmp(&memory.key(a))
            .then(b.order.created.cmp(&a.order.created))
            .then_with(|| a.id.cmp(&b.id))
    };
    let mut sections: [Vec<Row>; SECTIONS.len()] = Default::default();
    let mut grouped: [Vec<usize>; SECTIONS.len()] = Default::default();
    for (ix, chat) in chats.iter().enumerate().filter(|(_, c)| shown(c)) {
        grouped[Section::of(chat) as usize].push(ix);
    }
    let [drafts, pinned, chats_ix, archived] = grouped;
    sections[Section::Drafts as usize] = drafts.into_iter().map(Row::Chat).collect();
    let mut pinned = pinned;
    pinned.sort_by(newest);
    sections[Section::Pinned as usize] = pinned.into_iter().map(Row::Chat).collect();
    let mut archived = archived;
    archived.sort_by(|a, b| {
        let (a, b) = (&chats[*a], &chats[*b]);
        b.order
            .archived
            .cmp(&a.order.archived)
            .then_with(|| a.id.cmp(&b.id))
    });
    sections[Section::Archived as usize] = archived.into_iter().map(Row::Chat).collect();

    let mut threads = Vec::new();
    let mut groups = Vec::new();
    let mut top: Vec<(f64, f64, String, Row)> = Vec::new();
    if !query.is_empty() {
        let mut flat = chats_ix;
        flat.sort_by(newest);
        sections[Section::Chats as usize] = flat.into_iter().map(Row::Chat).collect();
    } else {
        let mut by_mission: HashMap<&str, (Vec<usize>, Vec<usize>)> = HashMap::new();
        for ix in chats_ix {
            let chat = &chats[ix];
            match &chat.mission {
                MissionAssociation::Linked(mission) => {
                    let entry = by_mission.entry(mission.as_str()).or_default();
                    if chat.mission_coordinator {
                        entry.0.push(ix);
                    } else {
                        entry.1.push(ix);
                    }
                }
                _ => {
                    let c = &chats[ix];
                    top.push((
                        memory.key(c),
                        c.order.created.0,
                        c.id.clone(),
                        Row::Chat(ix),
                    ));
                }
            }
        }
        for (mission, (mut coordinators, mut members)) in by_mission {
            // The newest coordinator leads; an older one stays as a member.
            coordinators.sort_by(|a, b| {
                chats[*b]
                    .order
                    .created
                    .cmp(&chats[*a].order.created)
                    .then_with(|| chats[*a].id.cmp(&chats[*b].id))
            });
            let coordinator = (!coordinators.is_empty()).then(|| coordinators.remove(0));
            members.extend(coordinators);
            members.sort_by(|a, b| {
                chats[*a]
                    .order
                    .created
                    .cmp(&chats[*b].order.created)
                    .then_with(|| chats[*a].id.cmp(&chats[*b].id))
            });
            let mut rollup = Rollup::default();
            for member in &members {
                rollup.add(Mark::of(&chats[*member]));
                rollup.unread |= memory.unread(&chats[*member]);
            }
            let finished = members
                .iter()
                .filter(|m| finished(&chats[**m], opened, memory))
                .count();
            // A thread moves only when you send to it from this app.
            let sent = members
                .iter()
                .filter_map(|m| memory.sent(&chats[*m].id))
                .reduce(f64::max);
            let (key, created, id) = match coordinator {
                Some(c) => {
                    let chat = &chats[c];
                    (
                        sent.map_or(memory.key(chat), |s| s.max(memory.key(chat))),
                        chat.order.created.0,
                        chat.id.clone(),
                    )
                }
                None => {
                    let first = members
                        .iter()
                        .map(|m| chats[*m].order.created.0)
                        .reduce(f64::min)
                        .unwrap_or(0.);
                    (sent.unwrap_or(first), first, format!("mission:{mission}"))
                }
            };
            top.push((key, created, id, Row::Parent(threads.len())));
            threads.push(Thread {
                mission: mission.to_owned(),
                coordinator,
                members,
                finished,
                collapsed: collapsed.contains(mission),
                show_finished: show_finished.contains(mission),
                rollup,
            });
        }
        top.sort_by(|a, b| {
            b.0.total_cmp(&a.0)
                .then(b.1.total_cmp(&a.1))
                .then_with(|| a.2.cmp(&b.2))
        });
        let emit =
            |rows: &mut Vec<Row>, row: Row| {
                rows.push(row);
                let Row::Parent(t) = row else {
                    return;
                };
                let thread = &threads[t];
                if thread.collapsed {
                    return;
                }
                // Reveal finished chats as a bottom group, not back among active
                // members. Keep creation order within each group and the stored
                // member order (also used to choose coordinator-less group scope).
                for group_finished in [false, true] {
                    if group_finished && !thread.show_finished {
                        break;
                    }
                    for member in thread.members.iter().filter(|member| {
                        finished(&chats[**member], opened, memory) == group_finished
                    }) {
                        rows.push(Row::Member {
                            chat: *member,
                            thread: t,
                        });
                    }
                }
                if thread.finished > 0 {
                    rows.push(Row::Fold(t));
                }
            };
        // Rows are already in your order, so each section first appears at its
        // latest send.
        let lead = |row: Row| match row {
            Row::Parent(t) => {
                let t = &threads[t];
                &chats[t.coordinator.or(t.members.first().copied()).unwrap_or(0)]
            }
            Row::Chat(ix) | Row::Member { chat: ix, .. } => &chats[ix],
            Row::Fold(_) | Row::Group(_) => unreachable!("top-level rows are chats and parents"),
        };
        let mut order: Vec<String> = Vec::new();
        let mut by_group: HashMap<String, Vec<Row>> = HashMap::new();
        for (_, _, _, row) in &top {
            let key = group_key(lead(*row));
            if !by_group.contains_key(&key) {
                order.push(key.clone());
            }
            by_group.entry(key).or_default().push(*row);
        }
        let rows = &mut sections[Section::Chats as usize];
        if sectioned && order.len() > 1 {
            for key in order {
                let members = by_group.remove(&key).unwrap_or_default();
                let mut rollup = Rollup::default();
                let mut count = 0;
                let mut add = |chat: &Chat| {
                    rollup.add(Mark::of(chat));
                    rollup.unread |= memory.unread(chat);
                    count += 1;
                };
                for row in &members {
                    match *row {
                        Row::Parent(t) => {
                            let t = &threads[t];
                            t.coordinator
                                .iter()
                                .chain(&t.members)
                                .for_each(|c| add(&chats[*c]));
                        }
                        row => add(lead(row)),
                    }
                }
                let collapsed = memory.group_collapsed(&key);
                rows.push(Row::Group(groups.len()));
                groups.push(Group {
                    key,
                    collapsed,
                    chats: count,
                    rollup,
                });
                if !collapsed {
                    for row in members {
                        emit(rows, row);
                    }
                }
            }
        } else {
            for (_, _, _, row) in top {
                emit(rows, row);
            }
        }
    }
    let mut tree = Tree {
        threads,
        groups,
        ..Default::default()
    };
    for (section, rows) in sections.into_iter().enumerate() {
        tree.bounds[section] = tree.rows.len();
        tree.rows.extend(rows);
    }
    tree.bounds[SECTIONS.len()] = tree.rows.len();
    tree
}

#[cfg(test)]
#[path = "sidebar_tree_tests.rs"]
mod tests;

//! Sidebar rows, built once per list change.
//!
//! Sections: Drafts, Pinned, Chats, then Archived with the Archived filter.
//! Chats holds mission threads and standalone chats, newest first by your own
//! activity (`sidebar_memory`), never by agent activity or state. A thread is
//! one level: its parent is the mission's coordinator chat (else the mission
//! alone), then its members in creation order. Finished members fold into
//! "+N finished". A search lists matching chats flat, without threads.
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

pub(crate) struct Input<'a> {
    pub(crate) chats: &'a [Chat],
    /// Project scope and the Archived filter.
    pub(crate) keep: &'a dyn Fn(&Chat) -> bool,
    /// Lowercased; empty shows threads.
    pub(crate) query: &'a str,
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
        }
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
        let rows = &mut sections[Section::Chats as usize];
        for (_, _, _, row) in top {
            rows.push(row);
            let Row::Parent(t) = row else {
                continue;
            };
            let thread = &threads[t];
            if thread.collapsed {
                continue;
            }
            for member in &thread.members {
                if thread.show_finished || !finished(&chats[*member], opened, memory) {
                    rows.push(Row::Member {
                        chat: *member,
                        thread: t,
                    });
                }
            }
            if thread.finished > 0 {
                rows.push(Row::Fold(t));
            }
        }
    }
    let mut tree = Tree {
        threads,
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

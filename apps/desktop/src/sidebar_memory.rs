//! Machine-local sidebar memory: when you last looked at each chat (for the
//! "new reply" dot), your own activity order, your project folders, which
//! project sections you collapsed and the width you dragged the sidebar to.
//! Stored privately on this machine only; never
//! sent to the daemon, never a read-status write and never imported from Swift.
//!
//! Order: the daemon's `lastUserMessageAt` also moves on automatic notices, so
//! it only seeds a chat's place the first time this app sees it. After that a
//! chat moves only when you send to it from this app.
use crate::{local_model::Chat, sidebar_folders::Folders};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

pub(crate) const FILE: &str = "sidebar-v1.json";
/// Bounded per map; the oldest stamps go first.
const CAP: usize = 4096;
const BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Saved {
    /// Replies settled before this (epoch ms) never show a dot: the dot starts
    /// with this memory, not with every old result.
    pub(crate) baseline: f64,
    /// The latest reply you saw, per chat.
    #[serde(default)]
    pub(crate) seen: HashMap<String, f64>,
    /// A chat's place when first seen (`lastUserMessageAt`, else creation).
    #[serde(default)]
    pub(crate) seed: HashMap<String, f64>,
    /// When you last sent to a chat from this app.
    #[serde(default)]
    pub(crate) sent: HashMap<String, f64>,
    /// Your project folders.
    #[serde(default)]
    pub(crate) folders: Folders,
    /// Collapsed project sections, by `sidebar_tree::group_key`.
    #[serde(default)]
    pub(crate) collapsed_projects: HashSet<String>,
    /// The width you dragged the sidebar to, in points. None keeps the
    /// responsive default; the window still clamps it (`workbench_view`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sidebar_width: Option<f32>,
}

pub(crate) struct Memory {
    saved: Saved,
    path: Option<PathBuf>,
    loaded: bool,
    dirty: bool,
}
impl Memory {
    /// In-memory only (synthetic and preview windows): nothing is written.
    pub(crate) fn ephemeral(baseline: f64) -> Self {
        Self {
            saved: Saved {
                baseline,
                ..Default::default()
            },
            path: None,
            loaded: true,
            dirty: false,
        }
    }
    /// Backed by `path`; shows no dots and seeds nothing until `restore`.
    pub(crate) fn at(path: PathBuf) -> Self {
        Self {
            saved: Saved::default(),
            path: Some(path),
            loaded: false,
            dirty: false,
        }
    }
    /// Apply what `read` found. A missing or unreadable file starts fresh at
    /// `now`, so old results don't all light up.
    pub(crate) fn restore(&mut self, saved: Option<Saved>, now: f64) {
        match saved {
            Some(saved) => self.saved = saved,
            None => {
                self.saved = Saved {
                    baseline: now,
                    ..Default::default()
                };
                self.dirty = true;
            }
        }
        self.loaded = true;
    }
    /// Seed the place of chats seen for the first time.
    pub(crate) fn observe(&mut self, chats: &[Chat]) {
        if !self.loaded {
            return;
        }
        for chat in chats.iter().filter(|c| !c.local_draft) {
            if !self.saved.seed.contains_key(&chat.id) {
                self.saved.seed.insert(chat.id.clone(), chat.order.user.0);
                self.dirty = true;
            }
        }
        if self.saved.seed.len() > CAP {
            trim(&mut self.saved.seed);
        }
    }
    /// The chat's place in the sidebar: your latest send from this app, else
    /// its seed. Before the memory loads, the daemon's stamp stands in.
    pub(crate) fn key(&self, chat: &Chat) -> f64 {
        let seed = self
            .saved
            .seed
            .get(&chat.id)
            .copied()
            .unwrap_or(chat.order.user.0);
        self.sent(&chat.id).map_or(seed, |sent| sent.max(seed))
    }
    pub(crate) fn sent(&self, id: &str) -> Option<f64> {
        self.saved.sent.get(id).copied()
    }
    /// Whether the saved file has been read, so folder edits can't be lost to it.
    pub(crate) fn loaded(&self) -> bool {
        self.loaded
    }
    pub(crate) fn folders(&self) -> &Folders {
        &self.saved.folders
    }
    pub(crate) fn set_folders(&mut self, folders: Folders) {
        if self.loaded && folders != self.saved.folders {
            self.saved.folders = folders;
            self.dirty = true;
        }
    }
    pub(crate) fn group_collapsed(&self, key: &str) -> bool {
        self.saved.collapsed_projects.contains(key)
    }
    pub(crate) fn set_group_collapsed(&mut self, key: &str, collapsed: bool) {
        let changed = if collapsed {
            self.saved.collapsed_projects.insert(key.to_owned())
        } else {
            self.saved.collapsed_projects.remove(key)
        };
        self.dirty |= changed;
    }
    pub(crate) fn sidebar_width(&self) -> Option<f32> {
        self.saved.sidebar_width.filter(|width| width.is_finite())
    }
    /// Whole points, so a drag settles on one stable value. None restores the default.
    pub(crate) fn set_sidebar_width(&mut self, width: Option<f32>) -> bool {
        let width = width.map(f32::round);
        if !self.loaded || width == self.saved.sidebar_width {
            return false;
        }
        self.saved.sidebar_width = width;
        self.dirty = true;
        true
    }
    pub(crate) fn note_sent(&mut self, id: &str, now: f64) {
        if self.sent(id).is_some_and(|sent| sent >= now) {
            return;
        }
        self.saved.sent.insert(id.to_owned(), now);
        if self.saved.sent.len() > CAP {
            trim(&mut self.saved.sent);
        }
        self.dirty = true;
    }
    /// The agent replied after you last looked at this chat.
    pub(crate) fn unread(&self, chat: &Chat) -> bool {
        self.loaded
            && !chat.local_draft
            && chat.order.reply.is_some_and(|reply| {
                reply.0
                    > self
                        .saved
                        .seen
                        .get(&chat.id)
                        .copied()
                        .unwrap_or(self.saved.baseline)
            })
    }
    /// You are looking at `chat`: its latest reply is seen.
    pub(crate) fn note_seen(&mut self, chat: &Chat) {
        if !self.loaded || !self.unread(chat) {
            return;
        }
        let Some(reply) = chat.order.reply else {
            return;
        };
        self.saved.seen.insert(chat.id.clone(), reply.0);
        if self.saved.seen.len() > CAP {
            trim(&mut self.saved.seen);
        }
        self.dirty = true;
    }
    /// The bytes to write, once per change.
    pub(crate) fn take_save(&mut self) -> Option<(PathBuf, Vec<u8>)> {
        if !self.dirty || !self.loaded {
            return None;
        }
        self.dirty = false;
        let path = self.path.clone()?;
        Some((path, serde_json::to_vec(&self.saved).ok()?))
    }
    #[cfg(test)]
    pub(crate) fn saved(&self) -> &Saved {
        &self.saved
    }
}

fn trim(map: &mut HashMap<String, f64>) {
    let mut stamps: Vec<f64> = map.values().copied().collect();
    stamps.sort_by(|a, b| b.total_cmp(a));
    let floor = stamps[CAP - 1];
    map.retain(|_, stamp| *stamp >= floor);
    while map.len() > CAP {
        let oldest = map
            .iter()
            .min_by(|a, b| a.1.total_cmp(b.1).then_with(|| b.0.cmp(a.0)))
            .map(|(id, _)| id.clone())
            .expect("non-empty");
        map.remove(&oldest);
    }
}

/// Read the saved memory. Missing, oversized or malformed reads as None.
/// Blocking: call off the UI thread.
pub(crate) fn read(path: &Path) -> Option<Saved> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > BYTES {
        return None;
    }
    let saved: Saved = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    saved.baseline.is_finite().then_some(saved)
}

/// Replace the file atomically, private to this user. Blocking: call off the
/// UI thread, one write at a time.
pub(crate) fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::{
        io::Write,
        os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    };
    let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)?;
    let pending = path.with_extension("json.pending");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&pending)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&pending, path)
}

/// Epoch milliseconds now, on this machine's clock.
pub(crate) fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0., |d| d.as_secs_f64() * 1000.)
}

#[cfg(test)]
#[path = "sidebar_memory_tests.rs"]
mod tests;

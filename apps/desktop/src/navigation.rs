//! Window-local IDs and small view-state tokens, never feeds, views or draft bodies.
use std::collections::VecDeque;
pub(crate) const HISTORY_CAP: usize = 100;
pub(crate) const SCOPE_CAP: usize = 64;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Home,
    Missions,
    Mission(crate::mission_browser::Key),
    Inbox(Option<String>),
    Project(String),
    Chat(String),
    Draft(String),
    Empty,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Location {
    pub(crate) scope: Option<String>,
    pub(crate) target: Target,
}
impl Location {
    pub(crate) fn home() -> Self {
        Self {
            scope: None,
            target: Target::Home,
        }
    }
}
#[derive(Clone)]
pub(crate) struct History {
    entries: Vec<Location>,
    index: usize,
}
impl History {
    pub(crate) fn new(initial: Location) -> Self {
        Self {
            entries: vec![initial],
            index: 0,
        }
    }
    pub(crate) fn record(&mut self, location: Location) {
        if self.entries[self.index] == location {
            return;
        }
        self.entries.truncate(self.index + 1);
        self.entries.push(location);
        if self.entries.len() > HISTORY_CAP {
            self.entries.remove(0);
        }
        self.index = self.entries.len() - 1;
    }
    pub(crate) fn can_move(&self, forward: bool) -> bool {
        if forward {
            self.index + 1 < self.entries.len()
        } else {
            self.index > 0
        }
    }
    pub(crate) fn has_destination(
        &self,
        forward: bool,
        accepts: impl Fn(&Location) -> bool,
    ) -> bool {
        if forward {
            self.entries[self.index + 1..].iter().any(accepts)
        } else {
            self.entries[..self.index].iter().rev().any(accepts)
        }
    }
    /// Operate on a candidate clone; a refused transport/IME move must not commit its cursor.
    pub(crate) fn move_to(
        &mut self,
        forward: bool,
        mut accepts: impl FnMut(&Location) -> bool,
    ) -> Option<Location> {
        while self.can_move(forward) {
            let ix = if forward {
                self.index + 1
            } else {
                self.index - 1
            };
            if accepts(&self.entries[ix]) {
                self.index = ix;
                return Some(self.entries[ix].clone());
            }
            self.entries.remove(ix);
            if ix < self.index {
                self.index -= 1;
            }
        }
        None
    }
}
pub(crate) struct Cache<K, V> {
    entries: VecDeque<(K, V)>,
    cap: usize,
}
impl<K: PartialEq, V> Cache<K, V> {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            cap,
        }
    }
    pub(crate) fn get(&self, key: &K) -> Option<&V> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub(crate) fn put(&mut self, key: K, value: V) {
        if let Some(ix) = self.entries.iter().position(|(k, _)| k == &key) {
            self.entries.remove(ix);
        }
        self.entries.push_back((key, value));
        while self.entries.len() > self.cap {
            self.entries.pop_front();
        }
    }
}
#[derive(Clone, Default)]
pub(crate) struct ScopeState {
    pub(crate) target: Option<Target>,
    pub(crate) query: String,
    pub(crate) archived: bool,
    pub(crate) selected: Option<String>,
    pub(crate) sidebar_y: f32,
    pub(crate) overview_y: f32,
}
#[derive(Clone, Debug)]
pub(crate) struct ReadingMark {
    pub(crate) message: Option<crate::model::ReaderKey>,
    pub(crate) offset: f32,
    pub(crate) following: bool,
}
/// A fresh Open binds the retained position to its first admitted snapshot.
pub(crate) struct ReaderRestoration {
    pub(crate) generation: u64,
    pub(crate) owner: String,
    pub(crate) mark: ReadingMark,
    pub(crate) revision: Option<u64>,
}
pub(crate) fn bounded_query(value: &str) -> String {
    value.chars().take(240).collect()
}
pub(crate) fn offset(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(-10_000_000., 0.)
    } else {
        0.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn chat(id: &str) -> Location {
        Location {
            scope: Some("project".into()),
            target: Target::Chat(id.into()),
        }
    }
    #[test]
    fn duplicate_forward_fork_bounded_and_transactional() {
        let mut h = History::new(Location::home());
        h.record(chat("a"));
        h.record(chat("a"));
        h.record(chat("b"));
        assert_eq!(h.entries.len(), 3);
        let mut candidate = h.clone();
        assert_eq!(candidate.move_to(false, |_| true), Some(chat("a")));
        assert_eq!(h.entries[h.index], chat("b"));
        h = candidate;
        h.record(chat("c"));
        assert!(!h.can_move(true));
        for n in 0..300 {
            h.record(chat(&n.to_string()));
        }
        assert_eq!(h.entries.len(), HISTORY_CAP);
        assert_eq!(h.index, HISTORY_CAP - 1);
    }
    #[test]
    fn removed_resources_are_skipped_without_reinterpretation() {
        let mut h = History::new(Location::home());
        h.record(chat("removed"));
        h.record(chat("current"));
        assert_eq!(
            h.move_to(false, |l| l.target != Target::Chat("removed".into())),
            Some(Location::home())
        );
        assert_eq!(h.entries.len(), 2);
        assert_eq!(h.move_to(true, |_| true), Some(chat("current")));
    }
    #[test]
    fn bounded_scopes_and_queries_keep_identity_and_finite_positions() {
        let mut c = Cache::new(SCOPE_CAP);
        for n in 0..200 {
            c.put(n, n);
        }
        assert_eq!(c.entries.len(), SCOPE_CAP);
        assert!(c.get(&0).is_none());
        c.put(199, 2);
        assert_eq!(c.get(&199), Some(&2));
        assert_eq!(bounded_query(&"👩".repeat(300)).chars().count(), 240);
        assert_eq!(offset(f32::NAN), 0.);
        assert_eq!(offset(f32::INFINITY), 0.);
        assert_eq!(offset(-f32::MAX), -10_000_000.);
    }
}

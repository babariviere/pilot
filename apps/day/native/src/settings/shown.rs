//! Settings reads this window showed, so a write refused only because its binding moved
//! can tell whether the part the user edits changed. A binding hashes more than that part
//! (the chats, the project record), so it moves while agents work.
use serde_json::Value;
use std::{collections::VecDeque, sync::Mutex};

/// Reads kept, newest last. A settings screen shows one read at a time and a window has a
/// few of them; eight covers them with room for a read that landed while the user typed.
/// Each is a few KB.
const KEPT: usize = 8;

#[derive(Default)]
pub(super) struct Shown(Mutex<VecDeque<(&'static str, Value)>>);

impl Shown {
    /// Keeps "read" of settings "kind" as shown.
    pub fn remember(&self, kind: &'static str, read: &Value) {
        let mut kept = self.0.lock().expect("shown settings poisoned");
        kept.retain(|(k, v)| !(*k == kind && v["binding"] == read["binding"]));
        if kept.len() == KEPT {
            kept.pop_front();
        }
        kept.push_back((kind, read.clone()));
    }

    /// The current binding when the read shown with "binding" and "current" agree on
    /// "target", the part the user edits. None when that part changed or was never shown.
    pub fn rebind(
        &self,
        kind: &'static str,
        binding: &str,
        current: &Value,
        target: fn(&Value) -> Value,
    ) -> Option<String> {
        let kept = self.0.lock().expect("shown settings poisoned");
        let (_, shown) = kept
            .iter()
            .rev()
            .find(|(k, v)| *k == kind && v["binding"] == binding)?;
        (target(shown) == target(current))
            .then(|| current["binding"].as_str().map(str::to_owned))
            .flatten()
    }
}

/// A read without the fields named in "volatile" and its binding.
pub(super) fn without(read: &Value, volatile: &[&str]) -> Value {
    let mut v = read.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("binding");
        for k in volatile {
            o.remove(*k);
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(read: &Value) -> Value {
        read["settings"].clone()
    }

    #[test]
    fn a_moved_binding_is_rebound_only_when_the_edited_part_is_unchanged() {
        let shown = Shown::default();
        shown.remember(
            "diagnostics",
            &json!({"binding":"a","settings":{"on":true},"chats":[1]}),
        );
        // A chat started: the binding moved, the settings did not.
        let chats = json!({"binding":"b","settings":{"on":true},"chats":[1,2]});
        assert_eq!(
            shown.rebind("diagnostics", "a", &chats, settings),
            Some("b".into())
        );
        // The settings changed elsewhere: refused.
        let changed = json!({"binding":"c","settings":{"on":false},"chats":[1]});
        assert_eq!(shown.rebind("diagnostics", "a", &changed, settings), None);
        // A binding this window never showed, or another kind's: refused.
        assert_eq!(shown.rebind("diagnostics", "z", &chats, settings), None);
        assert_eq!(shown.rebind("slack", "a", &chats, settings), None);
        assert_eq!(without(&chats, &["chats"]), json!({"settings":{"on":true}}));
    }

    #[test]
    fn only_the_last_eight_reads_are_kept() {
        let shown = Shown::default();
        for n in 0..9 {
            shown.remember("models", &json!({"binding":n.to_string(),"x":1}));
        }
        let now = json!({"binding":"new","x":1});
        assert_eq!(shown.rebind("models", "0", &now, |v| v["x"].clone()), None);
        assert_eq!(
            shown.rebind("models", "1", &now, |v| v["x"].clone()),
            Some("new".into())
        );
    }
}

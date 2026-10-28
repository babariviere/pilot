//! Bounded user-message presentation, and automatic input folded to one line
//! by default. Assistant source and loaded-source Find are untouched.
use crate::{
    model::{Message, ReaderKey},
    session_todos::Source,
};
use std::{collections::VecDeque, sync::Arc};
use unicode_segmentation::UnicodeSegmentation;

const PROBE_BYTES: usize = 25_600;
const SCALARS: usize = 6400;
const CACHE_BYTES: usize = 16 * 1024 * 1024;
const CACHE_ROWS: usize = 512;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Preview {
    pub(crate) long: bool,
    pub(crate) text: String,
}
pub(crate) fn preview(source: &str) -> Preview {
    // Segment only a bounded scalar/byte prefix. Drop its last grapheme when
    // incomplete, including a potentially enormous combining/ZWJ sequence.
    let end = source
        .char_indices()
        .take(SCALARS + 1)
        .find_map(|(i, _)| (i >= PROBE_BYTES).then_some(i))
        .unwrap_or_else(|| {
            source
                .char_indices()
                .nth(SCALARS)
                .map_or(source.len(), |(i, _)| i)
        });
    let bounded = end < source.len();
    let mut graphemes = source[..end].graphemes(true).peekable();
    let (mut chars, mut lines, mut prefix_end) = (0, 1, 0);
    let mut long = bounded;
    let mut closed = false;
    while let Some(g) = graphemes.next() {
        if bounded && graphemes.peek().is_none() {
            break;
        }
        chars += 1;
        if matches!(g, "\n" | "\r" | "\r\n" | "\u{2028}" | "\u{2029}") {
            lines += 1;
        }
        if chars > 1600 || lines > 16 {
            long = true;
            break;
        }
        if !closed && chars <= 800 && lines <= 8 && prefix_end + g.len() <= 3200 {
            prefix_end += g.len();
        } else {
            // Once a prefix limit is met it cannot resume after a large cluster.
            closed = true;
        }
    }
    Preview {
        long,
        text: if long {
            source[..prefix_end].into()
        } else {
            source.into()
        },
    }
}
pub(crate) fn plain(source: &str) -> String {
    format!(
        "<pre>{}</pre>",
        source
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    )
}
fn eligible(row: &Message) -> bool {
    (row.label().starts_with("You") || row.automatic().is_some())
        && row.work_data().is_none()
        && row.artifact_data().is_none()
        && row.image_data().is_none()
        && !row.work_note()
        && row.reader_key().is_some()
}
struct Entry {
    scope: Option<Source>,
    key: ReaderKey,
    source: Arc<String>,
    preview: Preview,
    html: String,
    /// Automatic input folds whatever its length; collapsed it shows no source.
    automatic: bool,
    expanded: bool,
}
impl Entry {
    fn foldable(&self) -> bool {
        self.automatic || self.preview.long
    }
}
#[derive(Default)]
pub(crate) struct Folds {
    scope: Option<Source>,
    entries: VecDeque<Entry>,
}
fn same_scope(a: &Option<Source>, b: &Option<Source>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.same_chat(b),
        (None, None) => true,
        _ => false,
    }
}
impl Folds {
    pub(crate) fn scope(&mut self, scope: Option<Source>) -> bool {
        let changed = !same_scope(&self.scope, &scope);
        self.scope = scope;
        changed
    }
    fn index(&self, row: &Message) -> Option<usize> {
        if !eligible(row) {
            return None;
        }
        let key = row.reader_key()?;
        self.entries
            .iter()
            .position(|e| e.key == key && same_scope(&e.scope, &self.scope))
    }
    pub(crate) fn sync(&mut self, rows: &[Message]) {
        for row in rows.iter().filter(|r| eligible(r)) {
            let key = row.reader_key().unwrap();
            if crate::model::reader_index(rows, &key).is_none() {
                if let Some(i) = self.index(row) {
                    self.entries.remove(i);
                }
                continue;
            }
            let prior = self.index(row).and_then(|i| self.entries.remove(i));
            if let Some(e) = prior.as_ref()
                && Arc::ptr_eq(&e.source, &row.shared_source())
            {
                self.entries.push_back(prior.unwrap());
                continue;
            }
            let automatic = row.automatic().is_some();
            let preview = if automatic {
                Preview {
                    long: false,
                    text: String::new(),
                }
            } else {
                preview(row.source())
            };
            let expanded = prior
                .filter(|e| row.source().starts_with(e.source.as_str()))
                .map_or(!(automatic || preview.long), |e| e.expanded);
            self.entries.push_back(Entry {
                scope: self.scope.clone(),
                key: row.reader_key().unwrap(),
                source: row.shared_source(),
                html: if preview.long {
                    plain(&preview.text)
                } else {
                    String::new()
                },
                preview,
                automatic,
                expanded,
            });
            while self.entries.len() > CACHE_ROWS
                || self
                    .entries
                    .iter()
                    .map(|e| e.source.len() + e.html.len())
                    .sum::<usize>()
                    > CACHE_BYTES
            {
                self.entries.pop_front();
            }
        }
    }
    /// Whether the row has a fold control: a long user message or automatic input.
    pub(crate) fn long(&self, row: &Message) -> bool {
        self.index(row).is_some_and(|i| self.entries[i].foldable())
    }
    pub(crate) fn collapsed(&self, row: &Message) -> bool {
        self.index(row)
            .is_some_and(|i| self.entries[i].foldable() && !self.entries[i].expanded)
    }
    pub(crate) fn html(&self, row: &Message) -> Option<&str> {
        self.collapsed(row)
            .then(|| self.entries[self.index(row).unwrap()].html.as_str())
    }
    pub(crate) fn toggle(&mut self, row: &Message) {
        if let Some(i) = self.index(row) {
            self.entries[i].expanded = !self.entries[i].expanded;
        }
    }
}

#[cfg(test)]
#[path = "message_fold_tests.rs"]
mod tests;

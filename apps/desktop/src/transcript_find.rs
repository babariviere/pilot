//! Native adaptation of MonoCode's compact query/count/wrapping navigation.
//! Copyright (c) 2026 Nick, MIT (../licenses/MONOCODE.txt).
//! Upstream 26465c620977f3951d0a532a0f7db32c3c179007:
//! src/features/sessions/{ui/TranscriptFind.tsx,model/transcriptFind.ts}.
//! Unlike upstream: exact literal source occurrences, committed visible messages
//! only, no archive callback, tool search, lowercasing or disclosure changes.
use crate::model::{Message, ReaderKey};
use std::{
    ops::Range,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

const MATCHES: usize = 1000;
pub(crate) const QUERY_BYTES: usize = 1024;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Hit {
    pub(crate) key: ReaderKey,
    pub(crate) source: Arc<String>,
    pub(crate) range: Range<usize>,
}
#[derive(Default)]
pub(crate) struct Results {
    pub(crate) hits: Vec<Hit>,
    pub(crate) limited: bool,
}
pub(crate) fn eligible(row: &Message) -> bool {
    matches!(
        row.reader_key(),
        Some(ReaderKey::Entry { model: Some(_), .. })
    ) && (row.label().starts_with("You")
        || row.label().starts_with("Automatic input")
        || row.is_assistant())
        && row.work_data().is_none()
        && row.artifact_data().is_none()
        && row.image_data().is_none()
}
fn placeholder(source: &str) -> bool {
    [
        "[No text content]",
        "[Unsupported content block]",
        "[Tool call. Actions/arguments are not rendered.]",
        "[Tool metadata unavailable or exceeds capacity]",
        "[Message exceeds the viewer’s 1 MiB source limit. Open it in Swift.]",
    ]
    .iter()
    .any(|s| source.contains(s))
}

pub(crate) fn scan(rows: Vec<Message>, query: &str, cancel: &AtomicBool) -> Results {
    let mut result = Results::default();
    if query.is_empty() || query.len() > QUERY_BYTES {
        return result;
    }
    let mut keys = std::collections::BTreeMap::new();
    for row in &rows {
        if let Some(key) = row.reader_key() {
            *keys.entry(key).or_insert(0_usize) += 1;
        }
    }
    for row in rows.iter().filter(|row| eligible(row)) {
        if cancel.load(Ordering::Relaxed) {
            return Results::default();
        }
        let source = row.shared_source();
        let end = source.len();
        // Placeholder inspection is inside the same byte budget as matching.
        // Ambiguous canonical keys must not advertise unnavigable matches.
        if placeholder(&source[..end]) || keys.get(&row.reader_key().unwrap()) != Some(&1) {
            continue;
        }
        for (start, text) in source[..end].match_indices(query) {
            if cancel.load(Ordering::Relaxed) {
                return Results::default();
            }
            if result.hits.len() == MATCHES {
                result.limited = true;
                return result;
            }
            result.hits.push(Hit {
                key: row.reader_key().unwrap(),
                source: source.clone(),
                range: start..start + text.len(),
            });
        }
    }
    result
}
pub(crate) fn step(active: usize, count: usize, previous: bool) -> usize {
    if count == 0 {
        0
    } else if previous {
        (active + count - 1) % count
    } else {
        (active + 1) % count
    }
}

#[cfg(test)]
#[path = "transcript_find_tests.rs"]
mod tests;

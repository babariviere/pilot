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

pub(super) const ROWS: usize = 512;
const BYTES: usize = 2 * 1024 * 1024;
const MATCHES: usize = 1000;
pub(super) const QUERY_BYTES: usize = 1024;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Hit {
    pub(super) key: ReaderKey,
    pub(super) source: Arc<String>,
    pub(super) range: Range<usize>,
}
#[derive(Default)]
pub(super) struct Results {
    pub(super) hits: Vec<Hit>,
    pub(super) limited: bool,
}
pub(super) fn eligible(row: &Message) -> bool {
    matches!(
        row.reader_key(),
        Some(ReaderKey::Entry { model: Some(_), .. })
    ) && (row.label().starts_with("You")
        || row.label().starts_with("Automatic input")
        || row.is_assistant())
        && row.work_data().is_none()
        && !row.work_note()
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

pub(super) fn scan(rows: Vec<Message>, query: &str, cancel: &AtomicBool) -> Results {
    let mut result = Results::default();
    if query.is_empty() || query.len() > QUERY_BYTES {
        return result;
    }
    let mut bytes = 0;
    for (count, row) in rows.iter().filter(|row| eligible(row)).enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Results::default();
        }
        if count == ROWS || bytes == BYTES {
            result.limited = true;
            break;
        }
        let source = row.shared_source();
        let mut end = source.len().min(BYTES - bytes);
        while !source.is_char_boundary(end) {
            end -= 1;
        }
        bytes += end;
        result.limited |= end < source.len();
        // Placeholder inspection is inside the same byte budget as matching.
        // Ambiguous canonical keys must not advertise unnavigable matches.
        if placeholder(&source[..end])
            || crate::model::reader_index(&rows, &row.reader_key().unwrap()).is_none()
        {
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
pub(super) fn step(active: usize, count: usize, previous: bool) -> usize {
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

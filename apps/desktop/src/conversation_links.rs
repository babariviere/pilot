//! Web-only, bounded inspection of received message text. No resolver or opener.
use crate::model::{Message, ReaderKey};
use std::collections::HashMap;

const ROWS: usize = 512;
const BYTES: usize = 2 * 1024 * 1024;
const ROW_BYTES: usize = 64 * 1024;
const URL_BYTES: usize = 4096;
const LINKS: usize = 64;
const MENTIONS: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Source {
    pub(crate) key: ReaderKey,
    pub(crate) label: String,
}
#[derive(Clone, Debug)]
pub(crate) struct Link {
    /// Exact received spelling, not a service conversion or a guessed target.
    pub(crate) url: String,
    pub(crate) sources: Vec<Source>,
    pub(crate) mentions: usize,
}
#[derive(Default)]
pub(crate) struct Snapshot {
    pub(crate) links: Vec<Link>,
    pub(crate) limited: bool,
    pub(crate) scanned: usize,
}

pub(crate) fn scan(rows: Vec<Message>) -> Snapshot {
    let mut result = Snapshot::default();
    let mut seen = HashMap::<String, usize>::new();
    let mut bytes = 0;
    let mut mentions = 0;
    let eligible = rows.iter().rev().filter(|r| {
        r.work_data().is_none()
            && r.artifact_data().is_none()
            && r.reader_key().is_some()
            && !r.label().starts_with("toolResult")
            && !r.label().starts_with("Tool")
    });
    for row in eligible {
        if result.scanned == ROWS || bytes == BYTES {
            result.limited = true;
            break;
        }
        result.scanned += 1;
        let text = row.source();
        let mut end = text.len().min(ROW_BYTES).min(BYTES - bytes);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        bytes += end;
        result.limited |= end < text.len();
        // Never admit a URL cut at a scan boundary.
        let text = if end < text.len() {
            let prefix = &text[..end];
            &prefix[..prefix.rfind(char::is_whitespace).unwrap_or(0)]
        } else {
            text
        };
        for raw in candidates(text) {
            let Some(key) = safe_url(raw) else {
                continue;
            };
            if mentions == MENTIONS {
                result.limited = true;
                break;
            }
            let ix = if let Some(ix) = seen.get(&key) {
                *ix
            } else {
                if result.links.len() == LINKS {
                    result.limited = true;
                    continue;
                }
                let ix = result.links.len();
                seen.insert(key, ix);
                result.links.push(Link {
                    url: raw.into(),
                    sources: Vec::new(),
                    mentions: 0,
                });
                ix
            };
            mentions += 1;
            let link = &mut result.links[ix];
            link.mentions += 1;
            let source = Source {
                key: row.reader_key().unwrap(),
                label: source_label(row),
            };
            if !link.sources.contains(&source) {
                link.sources.push(source);
            }
        }
        if mentions == MENTIONS {
            result.limited = true;
            break;
        }
    }
    result
}

fn source_label(row: &Message) -> String {
    let key = match row.reader_key().unwrap() {
        ReaderKey::Entry {
            entry,
            model,
            block,
        } => format!(
            "entry {entry}{}{}",
            model
                .map(|m| format!(" · message {}", m + 1))
                .unwrap_or_default(),
            block
                .map(|b| format!(" · block {}", b + 1))
                .unwrap_or_default()
        ),
        ReaderKey::Tool(_) => "tool message".into(),
    };
    let label: String = row
        .display_label()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    format!("{label} · {key}")
}

fn candidates(text: &str) -> impl Iterator<Item = &str> {
    let bytes = text.as_bytes();
    let mut cursor = 0;
    std::iter::from_fn(move || {
        while cursor < bytes.len() {
            let start = cursor;
            cursor += 1;
            let rest = &bytes[start..];
            if !(rest
                .get(..7)
                .is_some_and(|s| s.eq_ignore_ascii_case(b"http://"))
                || rest
                    .get(..8)
                    .is_some_and(|s| s.eq_ignore_ascii_case(b"https://")))
                || text[..start]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric() || "_:/".contains(c))
            {
                continue;
            }
            let mut end = start;
            for (offset, ch) in text[start..].char_indices() {
                if ch.is_whitespace() || "<>\"'`|[]".contains(ch) {
                    break;
                }
                end = start + offset + ch.len_utf8();
            }
            cursor = end.max(cursor);
            let mut url = &text[start..end];
            url = url.trim_end_matches(['.', ',', ';', ':', '!', '?', '*', '~']);
            // Balanced parentheses remain part of the URL; Markdown's closing one doesn't.
            for (open, close) in [('(', ')'), ('{', '}')] {
                let mut extra = url
                    .bytes()
                    .filter(|b| *b == close as u8)
                    .count()
                    .saturating_sub(url.bytes().filter(|b| *b == open as u8).count());
                while extra > 0 && url.ends_with(close) {
                    url = &url[..url.len() - 1];
                    extra -= 1;
                }
            }
            return Some(url);
        }
        None
    })
}

fn safe_url(raw: &str) -> Option<String> {
    if raw.len() > URL_BYTES
        || raw.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        || raw.contains('\\')
    {
        return None;
    }
    // Reject encoded controls too. Never silently repair a copied target.
    for pair in raw.as_bytes().windows(3).filter(|s| s[0] == b'%') {
        if let Ok(hex) = std::str::from_utf8(&pair[1..])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
            && (byte < 32 || byte == 127)
        {
            return None;
        }
    }
    let url = reqwest::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.to_string())
}

#[cfg(test)]
#[path = "conversation_links_tests.rs"]
mod tests;

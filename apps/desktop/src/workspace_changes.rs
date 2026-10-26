//! Passive canonical workspace snapshots. No filesystem paths are ever opened here.
use serde_json::Value;
use std::collections::{HashMap, HashSet};
pub(crate) const WIRE_CAP: usize = 8 * 1024 * 1024;
const FILES: usize = 128;
const PATCH: usize = 512 * 1024;
const FILE_PATCH: usize = 32 * 1024;
const LINES: usize = 200;
#[derive(Debug)]
pub(crate) struct File {
    pub path: String,
    pub previous: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub patch: Option<String>,
}
#[derive(Debug)]
pub(crate) struct Snapshot {
    pub base: String,
    pub branch: Option<String>,
    pub files: Vec<File>,
    pub total: usize,
    pub limited: bool,
}
fn string(v: &Value, cap: usize) -> Result<String, &'static str> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() <= cap)
        .map(str::to_owned)
        .ok_or("Invalid workspace metadata. Changes are unknown.")
}
fn count(v: &Value) -> Result<u64, &'static str> {
    v.as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or("Invalid workspace statistics. Changes are unknown.")
}
// Visible spelling preserves unusual filenames without allowing terminal/bidi controls.
pub(crate) fn display(s: &str) -> String {
    visible(s, false)
}
pub(crate) fn display_patch(s: &str) -> String {
    visible(s, true)
}
pub(crate) fn preview(s: &str) -> String {
    let shown: String = s.chars().take(160).collect();
    let mut shown = display(&shown);
    if s.chars().nth(160).is_some() {
        shown.push('…');
    }
    shown
}
fn visible(s: &str, patch: bool) -> String {
    s.chars()
        .flat_map(|c| {
            if (c.is_control() && !(patch && matches!(c, '\n' | '\t')))
                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                c.escape_unicode().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect()
}
impl Snapshot {
    pub(crate) fn parse(v: Value) -> Result<Self, &'static str> {
        let base = string(&v["base"], 4096)?;
        let branch = if v["branch"].is_null() {
            None
        } else {
            Some(string(&v["branch"], 4096)?)
        };
        let raw = v["files"]
            .as_array()
            .ok_or("Workspace file inventory unavailable.")?;
        if raw.len() > 4096 {
            return Err("Workspace inventory exceeds 4096 files. Changes are unknown, not clean.");
        }
        let diff = v["diff"].as_str().ok_or("Workspace diff unavailable.")?;
        let truncated = v["truncated"]
            .as_bool()
            .ok_or("Workspace truncation state unknown.")?;
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        // Validate the full bounded body, but retain/render only the first128 inventory rows.
        for (ix, f) in raw.iter().enumerate() {
            let path = string(&f["path"], 4096)?;
            if !seen.insert(path.clone()) {
                return Err("Ambiguous workspace file inventory.");
            }
            let previous = if f["previousPath"].is_null() {
                None
            } else {
                Some(string(&f["previousPath"], 4096)?)
            };
            let status = string(&f["status"], 32)?;
            if !matches!(
                status.as_str(),
                "added" | "modified" | "deleted" | "renamed" | "untracked"
            ) {
                return Err("Unknown workspace file status.");
            }
            let additions = count(&f["additions"])?;
            let deletions = count(&f["deletions"])?;
            if ix < FILES {
                files.push(File {
                    path,
                    previous,
                    status,
                    additions,
                    deletions,
                    patch: None,
                });
            }
        }
        let mut limited = truncated || raw.len() > FILES || diff.len() > PATCH;
        let patches = patches(diff, &mut limited);
        for f in &mut files {
            f.patch = patches
                .get(&f.path)
                .and_then(|p| p.as_ref())
                .filter(|p| {
                    let old = f.previous.as_deref().unwrap_or(&f.path);
                    (p.old == old
                        || (p.old == "/dev/null"
                            && matches!(f.status.as_str(), "added" | "untracked")))
                        && (p.new == f.path || (p.new == "/dev/null" && f.status == "deleted"))
                })
                .map(|p| p.body.clone());
        }
        // An inconsistent empty inventory is never called clean.
        limited |= raw.is_empty() && !diff.is_empty();
        Ok(Self {
            base,
            branch,
            files,
            total: raw.len(),
            limited,
        })
    }
}
// Only complete, small sections with a unique exact +++/--- path are displayed.
// Binary patches, missing/malformed hunks stay unavailable.
// No count-sized allocation, syntax highlighting, Markdown, or execution of patch text.
struct Patch {
    old: String,
    new: String,
    body: String,
}
fn patches(diff: &str, limited: &mut bool) -> HashMap<String, Option<Patch>> {
    let mut result = HashMap::new();
    let mut offset = 0;
    for section in diff.split_inclusive("\ndiff --git ") {
        let start = offset;
        offset += section.len();
        if offset > PATCH {
            *limited = true;
            break;
        }
        let section = section.strip_suffix("diff --git ").unwrap_or(section);
        let lines: Vec<_> = section.lines().take(LINES + 1).collect();
        if section.len() > FILE_PATCH || lines.len() > LINES || lines.iter().any(|l| l.len() > 1024)
        {
            *limited = true;
            continue;
        }
        let mut old = None;
        let mut new = None;
        let mut remaining = (0u64, 0u64);
        let mut valid = true;
        let mut hunks = 0;
        for line in &lines {
            if line.starts_with("@@ ") {
                if remaining != (0, 0) || old.is_none() || new.is_none() {
                    valid = false;
                    break;
                }
                let Some(counts) = hunk(line) else {
                    valid = false;
                    break;
                };
                remaining = counts;
                hunks += 1;
            } else if remaining != (0, 0) {
                let delta = match line.as_bytes().first() {
                    Some(b' ') => (1, 1),
                    Some(b'-') => (1, 0),
                    Some(b'+') => (0, 1),
                    Some(b'\\') if *line == "\\ No newline at end of file" => (0, 0),
                    _ => {
                        valid = false;
                        break;
                    }
                };
                let (Some(a), Some(b)) = (
                    remaining.0.checked_sub(delta.0),
                    remaining.1.checked_sub(delta.1),
                ) else {
                    valid = false;
                    break;
                };
                remaining = (a, b);
            } else if let Some(p) = line.strip_prefix("--- ") {
                if old.is_some() || hunks > 0 {
                    valid = false;
                    break;
                }
                old = path(p, "a/");
            } else if let Some(p) = line.strip_prefix("+++ ") {
                if new.is_some() || hunks > 0 {
                    valid = false;
                    break;
                }
                new = path(p, "b/");
            } else if line.starts_with(['+', '-', ' '])
                || (hunks > 0 && *line != "\\ No newline at end of file")
            {
                valid = false;
            }
        }
        if valid
            && remaining == (0, 0)
            && hunks > 0
            && section.ends_with('\n')
            && let (Some(old), Some(new)) = (old, new)
        {
            let key = if new == "/dev/null" {
                old.clone()
            } else {
                new.clone()
            };
            let value = if start == 0 {
                section.to_owned()
            } else {
                format!("diff --git {section}")
            };
            result
                .entry(key)
                .and_modify(|p| *p = None)
                .or_insert(Some(Patch {
                    old,
                    new,
                    body: value,
                }));
        }
    }
    result
}
fn path(p: &str, prefix: &str) -> Option<String> {
    let decoded;
    let p = if p.starts_with('"') {
        let p = p.strip_prefix('"')?.strip_suffix('"')?;
        let mut bytes = p.bytes();
        let mut out = Vec::new();
        while let Some(b) = bytes.next() {
            if b != b'\\' {
                out.push(b);
                continue;
            }
            out.push(match bytes.next()? {
                b'"' => b'"',
                b'\\' => b'\\',
                b'a' => 7,
                b'b' => 8,
                b't' => b'\t',
                b'n' => b'\n',
                b'v' => 11,
                b'f' => 12,
                b'r' => b'\r',
                a @ b'0'..=b'3' => {
                    let b = bytes.next()?;
                    let c = bytes.next()?;
                    if !(b'0'..=b'7').contains(&b) || !(b'0'..=b'7').contains(&c) {
                        return None;
                    }
                    (a - b'0') * 64 + (b - b'0') * 8 + (c - b'0')
                }
                _ => return None,
            });
        }
        decoded = String::from_utf8(out).ok()?;
        decoded.as_str()
    } else {
        p
    };
    if p == "/dev/null" {
        Some(p.into())
    } else {
        p.strip_prefix(prefix)
            .filter(|p| !p.contains('\t'))
            .map(str::to_owned)
    }
}
fn hunk(s: &str) -> Option<(u64, u64)> {
    let mut words = s.split_whitespace();
    if words.next()? != "@@" {
        return None;
    }
    fn range(s: &str, prefix: char) -> Option<u64> {
        let (start, count) = s
            .strip_prefix(prefix)?
            .split_once(',')
            .unwrap_or((s.strip_prefix(prefix)?, "1"));
        start.parse::<u64>().ok()?;
        count.parse::<u64>().ok()
    }
    let old = range(words.next()?, '-')?;
    let new = range(words.next()?, '+')?;
    (words.next()? == "@@").then_some((old, new))
}
#[derive(Default)]
pub(crate) struct State {
    pub serial: u64,
    pub busy: bool,
    pub snapshot: Option<Snapshot>,
    pub error: Option<&'static str>,
}
impl State {
    pub fn begin(&mut self) -> u64 {
        self.serial += 1;
        self.busy = true;
        self.error = None;
        self.serial
    }
    pub fn accept(&mut self, serial: u64, result: Result<Snapshot, &'static str>) -> bool {
        if serial != self.serial {
            return false;
        }
        self.busy = false;
        match result {
            Ok(s) => {
                self.snapshot = Some(s);
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
        true
    }
}
#[cfg(test)]
#[path = "workspace_changes_tests.rs"]
mod tests;

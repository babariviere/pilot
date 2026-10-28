//! Display-only codemode script names. Never evaluates JavaScript or claims
//! that a nested call ran: the outer script's own status is the only status.
//! Literal "tools.<name>(...)" calls are read conservatively; anything that is
//! not a plain string literal is simply not named.
use super::{Kind, command_label, command_subject, cut, patch_diff, patch_paths, replacement};

/// At most this many nested calls are inspected for one label.
const CALL_CAP: usize = 64;

pub(crate) struct Label {
    pub(crate) verb: String,
    pub(crate) subject: String,
    pub(crate) meta: String,
    pub(crate) kind: Kind,
    pub(crate) paths: Vec<String>,
    pub(crate) diff: String,
}

struct Call {
    kind: Kind,
    verb: &'static str,
    subject: Option<String>,
    paths: Vec<String>,
    diff: String,
}

/// Names a script from its literal nested calls when they agree on one kind,
/// else from a leading "//" comment (skipping "// @options"), else from its
/// best-known nested kind, else "Ran a script" with its first code line.
pub(crate) fn script_label(code: &str) -> Label {
    let calls: Vec<Call> = nested_calls(code)
        .into_iter()
        .map(|(name, args)| describe(&name, &args))
        .collect();
    let comment = leading_comment(code);
    let primary = calls
        .iter()
        .map(|call| call.kind)
        .min_by_key(|kind| priority(*kind));
    let same_kind = calls.iter().all(|call| Some(call.kind) == primary);
    if let Some(kind) = primary
        && (same_kind || comment.is_none())
        && let Some(label) = from_calls(&calls, kind)
    {
        return label;
    }
    if let Some(comment) = comment {
        let mut label = primary
            .and_then(|kind| from_calls(&calls, kind))
            .unwrap_or_else(|| empty(primary.unwrap_or(Kind::Script)));
        label.verb = comment;
        label.subject.clear();
        label.meta.clear();
        return label;
    }
    let mut label = empty(Kind::Script);
    label.subject = code
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("//"))
        .map(|line| cut(line, 240))
        .unwrap_or_default();
    label
}

fn empty(kind: Kind) -> Label {
    Label {
        verb: "Ran a script".into(),
        subject: String::new(),
        meta: String::new(),
        kind,
        paths: Vec::new(),
        diff: String::new(),
    }
}

/// Effects first: edits, then commands, searches, fetches and reads.
fn priority(kind: Kind) -> u8 {
    match kind {
        Kind::Edit => 0,
        Kind::Command => 1,
        Kind::Search => 2,
        Kind::Fetch => 3,
        Kind::Read => 4,
        Kind::Other => 5,
        Kind::Script => 6,
    }
}

fn from_calls(calls: &[Call], kind: Kind) -> Option<Label> {
    let named: Vec<&Call> = calls
        .iter()
        .filter(|call| call.kind == kind && call.subject.as_deref().is_some_and(|s| !s.is_empty()))
        .collect();
    let first = named.first()?;
    let mut subjects: Vec<&str> = Vec::new();
    for call in &named {
        let subject = call.subject.as_deref().unwrap_or("");
        if !subjects.contains(&subject) {
            subjects.push(subject);
        }
    }
    let shown = subjects.len().min(2);
    let more = calls.len() - named.len() + subjects.len() - shown;
    let mut paths = Vec::new();
    let mut diff = String::new();
    for call in calls.iter().filter(|call| call.kind == kind) {
        for path in &call.paths {
            if paths.len() < 16 && !paths.contains(path) {
                paths.push(path.clone());
            }
        }
        if !call.diff.is_empty() {
            if !diff.is_empty() {
                diff.push('\n');
            }
            diff.push_str(&call.diff);
        }
    }
    Some(Label {
        verb: first.verb.into(),
        subject: cut(&subjects[..shown].join(", "), 240),
        meta: if more > 0 {
            format!("+{more} more")
        } else {
            String::new()
        },
        kind,
        paths,
        diff: cut(&diff, super::DIFF_CAP),
    })
}

fn leading_comment(code: &str) -> Option<String> {
    let line = code
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("// @options"))?;
    let text = line.strip_prefix("//")?.trim_start_matches('/').trim();
    (!text.is_empty()).then(|| cut(text, 240))
}

fn file_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).into()
}

fn describe(name: &str, args: &str) -> Call {
    let field = |key| literal_field(args, key);
    let mut call = Call {
        kind: Kind::Other,
        verb: "Used tools",
        subject: None,
        paths: Vec::new(),
        diff: String::new(),
    };
    match name {
        "read" => {
            call.kind = Kind::Read;
            call.verb = "Read";
            if let Some(path) = field("path") {
                call.subject = Some(file_name(&path));
                call.paths.push(cut(&path, 1024));
            }
        }
        "bash" => {
            call.kind = Kind::Command;
            call.verb = "Ran";
            if let Some(command) = field("command") {
                if let Some(pattern) = code_search(&command) {
                    call.kind = Kind::Search;
                    call.verb = "Searched code for";
                    call.subject = Some(pattern);
                } else {
                    call.subject = Some(command_subject(&command));
                }
            }
        }
        "applyPatch" => {
            call.kind = Kind::Edit;
            call.verb = "Edited";
            if let Some(patch) = field("patch") {
                call.paths = patch_paths(&patch);
                call.subject = Some(
                    call.paths
                        .iter()
                        .map(|path| file_name(path))
                        .collect::<Vec<_>>()
                        .join(", "),
                );
                call.diff = patch_diff(&patch);
            }
        }
        "edit" | "write" => {
            call.kind = Kind::Edit;
            call.verb = if name == "write" { "Wrote" } else { "Edited" };
            if let Some(path) = field("path") {
                let (old, new) = if name == "write" {
                    (Some(String::new()), field("content"))
                } else {
                    (field("oldText"), field("newText"))
                };
                if let (Some(old), Some(new)) = (old, new) {
                    call.diff = replacement(&path, &old, &new);
                }
                call.subject = Some(file_name(&path));
                call.paths.push(cut(&path, 1024));
            }
        }
        "web" | "web_search" | "fetch_content" => {
            if name == "fetch_content" || field("action").as_deref() == Some("fetch") {
                call.kind = Kind::Fetch;
                call.verb = "Fetched";
                call.subject = field("url");
            } else {
                call.kind = Kind::Search;
                call.verb = "Searched the web for";
                call.subject = field("query");
            }
        }
        _ => {}
    }
    call.subject = call.subject.map(|subject| cut(&subject, 240));
    call
}

/// "rg PATTERN" or "grep PATTERN" as a code search, only for a plain first
/// line whose pattern is the first non-flag word. Anything else is a command.
fn code_search(command: &str) -> Option<String> {
    let line = command
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    if line.contains([';', '&', '|', '`', '$', '(', ')', '<', '>', '\\']) {
        return None;
    }
    if !matches!(
        command_label(line).split_whitespace().next(),
        Some("rg" | "grep")
    ) {
        return None;
    }
    let pattern = line
        .split_whitespace()
        .skip(1)
        .find(|word| !word.starts_with('-'))?;
    let quoted = pattern.len() >= 2
        && ((pattern.starts_with('"') && pattern.ends_with('"'))
            || (pattern.starts_with('\'') && pattern.ends_with('\'')));
    let pattern = if quoted {
        &pattern[1..pattern.len() - 1]
    } else {
        pattern
    };
    (!pattern.is_empty() && !pattern.contains(['"', '\''])).then(|| cut(pattern, 240))
}

/// Literal "tools.<name>(" calls outside "//" comment lines, in source order.
fn nested_calls(code: &str) -> Vec<(String, String)> {
    let source = code
        .lines()
        .map(|line| {
            if line.trim_start().starts_with("//") {
                ""
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let bytes = source.as_bytes();
    let mut calls = Vec::new();
    let mut from = 0;
    while calls.len() < CALL_CAP
        && let Some(offset) = source[from..].find("tools.")
    {
        let start = from + offset;
        from = start + "tools.".len();
        if start > 0
            && (bytes[start - 1].is_ascii_alphanumeric()
                || matches!(bytes[start - 1], b'_' | b'.' | b'$'))
        {
            continue;
        }
        let name_len = source[from..]
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
            .count();
        if name_len == 0 || bytes[from].is_ascii_digit() {
            continue;
        }
        let name = &source[from..from + name_len];
        let Some(rest) = source[from + name_len..].trim_start().strip_prefix('(') else {
            continue;
        };
        calls.push((name.to_owned(), arguments(rest).to_owned()));
    }
    calls
}

/// The argument text up to the call's closing parenthesis, skipping strings.
fn arguments(rest: &str) -> &str {
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;
    for (ix, ch) in rest.char_indices() {
        if let Some(open) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == open {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' | '`' => quote = Some(ch),
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' if depth == 0 => return &rest[..ix],
            ')' | '}' | ']' => depth -= 1,
            _ => {}
        }
    }
    rest
}

/// A "key: literal" pair (the key may be quoted). Single-quoted and template
/// strings count only without escapes or interpolation.
fn literal_field(args: &str, key: &str) -> Option<String> {
    let bytes = args.as_bytes();
    for (start, _) in args.match_indices(key) {
        let before = start.checked_sub(1).map(|ix| bytes[ix]);
        let mut rest = &args[start + key.len()..];
        match before {
            Some(quote @ (b'"' | b'\'')) => {
                let Some(after) = rest.strip_prefix(quote as char) else {
                    continue;
                };
                rest = after;
            }
            Some(b) if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'$') => continue,
            _ => {}
        }
        if rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let Some(value) = rest.trim_start().strip_prefix(':') else {
            continue;
        };
        let value = value.trim_start();
        if value.starts_with('"') {
            return serde_json::Deserializer::from_str(value)
                .into_iter::<String>()
                .next()
                .and_then(Result::ok);
        }
        let quote = value.chars().next().filter(|c| matches!(c, '\'' | '`'))?;
        let body = &value[1..];
        let text = &body[..body.find(quote)?];
        if text.contains('\\') || (quote == '`' && text.contains("${")) {
            return None;
        }
        return Some(text.to_owned());
    }
    None
}

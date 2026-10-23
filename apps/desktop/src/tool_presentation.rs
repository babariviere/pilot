//! Pure bounded summaries. No tool execution, JS evaluation, files or URL opening.
use crate::model::Message;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub(crate) const TOOL_CAP: usize = 256;
pub(crate) const DETAIL_CAP: usize = 2 * 1024 * 1024;
pub(crate) const ARG_CAP: usize = 12 * 1024;
pub(crate) const OUTPUT_CAP: usize = 40 * 1024;
const DIFF_CAP: usize = 12 * 1024;
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    Pending,
    Running,
    Done,
    Error,
    Interrupted,
}
impl Status {
    pub(crate) fn live(self) -> bool {
        matches!(self, Self::Pending | Self::Running)
    }
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Pending => "Pending",
            Self::Running => "Running…",
            Self::Done => "",
            Self::Error => "Failed",
            Self::Interrupted => "Status unknown",
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Read,
    Edit,
    Command,
    Script,
    Search,
    Fetch,
    Other,
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Tool {
    pub(crate) id: String,
    pub(crate) key: u64,
    pub(crate) name: String,
    pub(crate) title: String,
    pub(crate) subject: String,
    paths: Vec<String>,
    pub(crate) kind: Kind,
    pub(crate) status: Status,
    pub(crate) arguments: Arc<String>,
    /// Prepared once with arguments, never parsed during output-only renders.
    /// Full original command/code; raw JSON arguments remain independently available.
    pub(crate) input: Option<(&'static str, Arc<String>)>,
    pub(crate) output: Arc<String>,
    output_complete: bool,
    pub(crate) diff: Arc<String>,
    pub(crate) additions: usize,
    pub(crate) deletions: usize,
    pub(crate) limited: bool,
}
impl Tool {
    fn new(id: &str, key: u64) -> Self {
        Self {
            id: id.into(),
            key,
            name: "tool".into(),
            title: "Used tool".into(),
            subject: String::new(),
            paths: Vec::new(),
            kind: Kind::Other,
            status: Status::Pending,
            arguments: Arc::new(String::new()),
            input: None,
            output: Arc::new(String::new()),
            output_complete: true,
            diff: Arc::new(String::new()),
            additions: 0,
            deletions: 0,
            limited: false,
        }
    }
    fn bytes(&self) -> usize {
        self.id.len()
            + self.name.len()
            + self.title.len()
            + self.subject.len()
            + self.paths.iter().map(String::len).sum::<usize>()
            + self.arguments.len()
            + self.input.as_ref().map_or(0, |(_, source)| source.len())
            + self.output.len()
            + self.diff.len()
    }
    fn describe(&mut self, name: &str, args: &Value) {
        self.subject.clear();
        self.input = None;
        self.paths.clear();
        self.limited |= !args["viewerOmitted"].is_null();
        self.diff = Arc::new(String::new());
        self.additions = 0;
        self.deletions = 0;
        self.name = cut(name, 160);
        let encoded = serde_json::to_string_pretty(args).unwrap_or_default();
        if encoded.len() > ARG_CAP {
            self.arguments = Arc::new("[Arguments exceed the 12 KiB viewer limit]".into());
            self.limited = true;
            self.title = format!("Used {}", self.name);
            return;
        }
        self.arguments = Arc::new(encoded);
        let string = |key: &str| args[key].as_str().unwrap_or("");
        let input = match name {
            "bash" => Some(("Command", string("command"))),
            "codemode" => Some(("Code", string("code"))),
            _ => None,
        };
        self.input = input
            .filter(|(_, text)| !text.is_empty())
            .map(|(label, text)| (label, Arc::new(text.to_owned())));
        let mut subject = String::new();
        let (verb, kind) = match name {
            "read" => {
                subject = string("path").into();
                ("Read", Kind::Read)
            }
            "bash" => {
                subject = command_subject(string("command"));
                ("Ran", Kind::Command)
            }
            "edit" | "write" => {
                subject = string("path").into();
                let old = if name == "write" {
                    ""
                } else {
                    string("oldText")
                };
                let new = if name == "write" {
                    string("content")
                } else {
                    string("newText")
                };
                if !new.is_empty() || !old.is_empty() {
                    self.diff = Arc::new(replacement(&subject, old, new));
                }
                (if name == "write" { "Wrote" } else { "Edited" }, Kind::Edit)
            }
            "applyPatch" => {
                let patch = string("patch");
                subject = patch_paths(patch)
                    .iter()
                    .map(|path| path.rsplit('/').next().unwrap_or(path))
                    .collect::<Vec<_>>()
                    .join(", ");
                self.paths = patch_paths(patch);
                self.diff = Arc::new(patch_diff(patch));
                ("Edited", Kind::Edit)
            }
            "web_search" => {
                subject = string("query").into();
                ("Searched the web for", Kind::Search)
            }
            "fetch_content" => {
                subject = string("url").into();
                ("Fetched", Kind::Fetch)
            }
            "web" => {
                subject = if string("action") == "fetch" {
                    string("url")
                } else {
                    string("query")
                }
                .into();
                if string("action") == "fetch" {
                    ("Fetched", Kind::Fetch)
                } else {
                    ("Searched the web for", Kind::Search)
                }
            }
            "codemode" => {
                let code = string("code");
                subject.clear();
                if code.matches("tools.").count() == 1 && code.contains("tools.read(") {
                    if let Some(path) = js_string(code, "path:") {
                        subject = path;
                        ("Read", Kind::Read)
                    } else {
                        ("Ran a script", Kind::Script)
                    }
                } else if code.matches("tools.").count() == 1 && code.contains("tools.bash(") {
                    if let Some(command) = js_string(code, "command:") {
                        subject = command_subject(&command);
                        ("Ran", Kind::Command)
                    } else {
                        ("Ran a script", Kind::Script)
                    }
                } else if code.matches("tools.").count() == 1 && code.contains("tools.applyPatch(")
                {
                    if let Some(patch) = js_string(code, "patch:") {
                        self.paths = patch_paths(&patch);
                        subject = self
                            .paths
                            .iter()
                            .map(|path| path.rsplit('/').next().unwrap_or(path))
                            .collect::<Vec<_>>()
                            .join(", ");
                        self.diff = Arc::new(patch_diff(&patch));
                        ("Edited", Kind::Edit)
                    } else {
                        ("Ran a script", Kind::Script)
                    }
                } else {
                    ("Ran a script", Kind::Script)
                }
            }
            "subagent" => {
                subject = format!("{} {}", string("action"), string("name"));
                ("Subagent", Kind::Other)
            }
            _ => {
                if let Some(object) = args.as_object() {
                    subject = object
                        .values()
                        .filter_map(Value::as_str)
                        .next()
                        .map(first_line)
                        .unwrap_or_default();
                }
                ("Used", Kind::Other)
            }
        };
        self.kind = kind;
        self.limited |= self.diff.ends_with('…')
            || (matches!(name, "edit" | "write")
                && (string("oldText").lines().count() > 300
                    || string("newText").lines().count() > 300
                    || string("content").lines().count() > 300))
            || (name == "applyPatch" && string("patch").lines().count() > 300);
        if matches!(kind, Kind::Read | Kind::Edit) && self.paths.is_empty() && !subject.is_empty() {
            self.paths.push(cut(&subject, 1024));
        }
        self.title = if matches!(kind, Kind::Other) && name != "subagent" {
            format!("Used {}", name.replace('_', " "))
        } else {
            verb.into()
        };
        if matches!(kind, Kind::Read | Kind::Edit) && !subject.contains(", ") {
            subject = subject.rsplit('/').next().unwrap_or(&subject).into();
        }
        self.subject = cut(&subject, 240);
        self.additions = self
            .diff
            .lines()
            .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
            .count();
        self.deletions = self
            .diff
            .lines()
            .filter(|line| line.starts_with('-') && !line.starts_with("---"))
            .count();
    }
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Step {
    Tool(Arc<Tool>),
    Note {
        id: u64,
        text: Arc<String>,
        thinking: bool,
        streaming: bool,
    },
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Work {
    pub(crate) readers: Vec<crate::model::ReaderKey>,
    pub(crate) id: u64,
    pub(crate) steps: Vec<Step>,
    pub(crate) title: String,
    pub(crate) active: bool,
    pub(crate) failures: usize,
    pub(crate) uncertain: usize,
}
impl Work {
    pub(crate) fn calls(&self) -> impl Iterator<Item = &Arc<Tool>> {
        self.steps.iter().filter_map(|step| {
            if let Step::Tool(tool) = step {
                Some(tool)
            } else {
                None
            }
        })
    }
}
#[derive(Default)]
pub(crate) struct Tools {
    items: BTreeMap<String, Arc<Tool>>,
    groups: BTreeMap<String, u64>,
    orphans: BTreeSet<String>,
}
impl Tools {
    pub(crate) fn contains(&self, id: &str) -> bool {
        self.items.contains_key(id)
    }
    pub(crate) fn key(&self, id: &str) -> Option<u64> {
        self.items.get(id).map(|t| t.key)
    }
    fn change(&mut self, id: &str, key: u64, change: impl FnOnce(&mut Tool)) -> bool {
        if id.is_empty()
            || id.len() > 256
            || (!self.items.contains_key(id) && self.items.len() >= TOOL_CAP)
        {
            return false;
        }
        let mut next = self
            .items
            .get(id)
            .map(|t| (**t).clone())
            .unwrap_or_else(|| Tool::new(id, key));
        change(&mut next);
        let other = self
            .items
            .iter()
            .filter(|(key, _)| *key != id)
            .map(|(_, t)| t.bytes())
            .sum::<usize>();
        if other + next.bytes() > DETAIL_CAP {
            next.arguments =
                Arc::new("[Tool detail capacity reached. Open the full result in Swift.]".into());
            next.output = Arc::new(String::new());
            next.diff = Arc::new(String::new());
            next.input = None;
            next.limited = true;
        }
        if other + next.bytes() > DETAIL_CAP {
            return false;
        }
        self.items.insert(id.into(), Arc::new(next));
        true
    }
    pub(crate) fn call(&mut self, id: &str, key: u64, name: &str, args: &Value) -> bool {
        self.change(id, key, |tool| tool.describe(name, args))
    }
    pub(crate) fn start(&mut self, id: &str, key: u64, name: &str) -> bool {
        if self
            .items
            .values()
            .filter(|tool| tool.status == Status::Running)
            .count()
            >= 32
            && !self
                .items
                .get(id)
                .is_some_and(|tool| tool.status == Status::Running)
        {
            return false;
        }
        self.change(id, key, |tool| {
            if tool.name == "tool" {
                tool.name = cut(name, 160);
                tool.title = format!("Used {}", tool.name);
            }
            if !matches!(tool.status, Status::Done | Status::Error) {
                tool.status = Status::Running;
            }
        })
    }
    pub(crate) fn update(&mut self, id: &str, key: u64, output: &Value) -> bool {
        if self.items.get(id).is_some_and(|tool| {
            matches!(
                tool.status,
                Status::Done | Status::Error | Status::Interrupted
            )
        }) {
            return true;
        }
        if self
            .items
            .values()
            .filter(|tool| tool.status == Status::Running)
            .count()
            >= 32
            && !self
                .items
                .get(id)
                .is_some_and(|tool| tool.status == Status::Running)
        {
            return false;
        }
        self.change(id, key, |tool| {
            if !tool.status.live() {
                return;
            }
            tool.status = Status::Running;
            if let Some(set) = output["set"].as_str() {
                tool.limited |= set.len() > OUTPUT_CAP;
                tool.output_complete = set.len() <= OUTPUT_CAP;
                tool.output = Arc::new(cut(set, OUTPUT_CAP));
            } else {
                if !tool.output_complete {
                    return;
                }
                let trim = output["trimStart"].as_u64().unwrap_or(0) as usize;
                let Some(offset) = utf16_offset(&tool.output, trim) else {
                    tool.limited = true;
                    tool.output_complete = false;
                    tool.output = Arc::new(
                        "[Output trim split a Unicode surrogate; waiting for a full update]".into(),
                    );
                    return;
                };
                let mut next = tool.output[offset..].to_string();
                next.push_str(output["append"].as_str().unwrap_or(""));
                tool.limited |= next.len() > OUTPUT_CAP;
                tool.output_complete = next.len() <= OUTPUT_CAP;
                tool.output = Arc::new(cut(&next, OUTPUT_CAP));
            }
        })
    }
    pub(crate) fn result(&mut self, id: &str, key: u64, name: &str, value: &Value) {
        self.change(id, key, |tool| {
            if tool.name == "tool" && !name.is_empty() {
                tool.name = cut(name, 160);
                tool.title = format!("Used {}", tool.name);
            }
            let output = text(value);
            tool.output_complete = output.len() <= OUTPUT_CAP;
            tool.limited |= output.len() > OUTPUT_CAP;
            tool.output = Arc::new(cut(&output, OUTPUT_CAP));
            tool.status = if value["isError"] == true || tool.status == Status::Error {
                Status::Error
            } else {
                Status::Done
            };
        });
    }
    pub(crate) fn end_unknown(&mut self, id: &str, key: u64, error: bool) {
        self.change(id, key, |tool| {
            if tool.status.live() || error {
                tool.status = if error { Status::Error } else { Status::Done };
            }
        });
    }
    pub(crate) fn interrupt(&mut self) {
        for tool in self.items.values_mut() {
            if tool.status.live() {
                Arc::make_mut(tool).status = Status::Interrupted;
            }
        }
    }
    pub(crate) fn orphan(&mut self, id: &str) {
        if self.items.contains_key(id) {
            self.orphans.insert(id.into());
        }
    }
    pub(crate) fn end_snapshot(&mut self, ids: &BTreeSet<String>) {
        self.orphans.clear();
        self.items
            .retain(|id, tool| ids.contains(id) || tool.status.live());
        self.groups.retain(|id, _| self.items.contains_key(id));
    }
    pub(crate) fn active_refs(&self) -> Vec<Message> {
        let mut items: Vec<_> = self
            .items
            .values()
            .filter(|t| {
                t.status.live() || t.status == Status::Interrupted || self.orphans.contains(&t.id)
            })
            .collect();
        items.sort_by_key(|tool| tool.key);
        items
            .into_iter()
            .take(32)
            .map(|tool| Message::tool_ref(tool.key, &tool.id))
            .collect()
    }
    pub(crate) fn retain(&mut self, ids: &BTreeSet<String>) {
        self.items.retain(|id, tool| {
            ids.contains(id)
                || tool.status.live()
                || tool.status == Status::Interrupted
                || self.orphans.contains(id)
        });
        self.groups.retain(|id, _| self.items.contains_key(id));
    }
    pub(crate) fn project(&mut self, raw: Vec<Message>) -> Vec<Message> {
        let mut rows = Vec::new();
        let mut run = Vec::new();
        let mut seen = BTreeSet::new();
        for row in raw {
            if row.is_assistant() || row.tool_ids().is_some() {
                run.push(row);
            } else {
                self.flush(&mut run, &mut rows, &mut seen);
                rows.push(row);
            }
        }
        self.flush(&mut run, &mut rows, &mut seen);
        rows
    }
    fn flush(
        &mut self,
        run: &mut Vec<Message>,
        rows: &mut Vec<Message>,
        seen: &mut BTreeSet<String>,
    ) {
        let Some(last) = run
            .iter()
            .rposition(|row| row.tool_ids().is_some() || row.work_note())
        else {
            rows.append(run);
            return;
        };
        let tail = run.split_off(last + 1);
        let mut steps = Vec::new();
        let mut readers = Vec::new();
        let mut reader_seen = BTreeSet::new();
        let mut anchor = None;
        let mut first = None;
        for row in run.drain(..) {
            if let Some(key) = row.reader_key()
                && reader_seen.insert(key.clone())
            {
                readers.push(key);
            }
            if row.source() != "[No text content]" && !row.source().is_empty() {
                steps.push(Step::Note {
                    id: row.id(),
                    text: row.shared_source(),
                    thinking: row.work_note(),
                    streaming: row.label().starts_with("Assistant · streaming"),
                });
                first.get_or_insert(row.id());
            }
            for id in row.tool_ids().into_iter().flatten() {
                if !seen.insert(id.clone()) {
                    continue;
                }
                if let Some(tool) = self.items.get(id) {
                    first.get_or_insert(tool.key);
                    if anchor.is_none() {
                        anchor = self.groups.get(id).copied();
                    }
                    steps.push(Step::Tool(tool.clone()));
                }
            }
        }
        if !steps.is_empty() {
            let id = anchor.or(first).expect("nonempty work");
            let active = steps.iter().any(|s| {
                matches!(s,Step::Tool(t) if t.status.live())
                    || matches!(
                        s,
                        Step::Note {
                            streaming: true,
                            ..
                        }
                    )
            });
            let failures = steps
                .iter()
                .filter(|s| matches!(s,Step::Tool(t) if t.status==Status::Error))
                .count();
            let mut counts = [0; 7];
            let mut reads = BTreeSet::new();
            let mut edits = BTreeSet::new();
            let uncertain = steps
                .iter()
                .filter(|s| matches!(s,Step::Tool(t)if t.status==Status::Interrupted))
                .count();
            for step in &steps {
                if let Step::Tool(tool) = step {
                    counts[tool.kind as usize] += 1;
                    if tool.kind == Kind::Read {
                        reads.extend(tool.paths.iter().cloned());
                    }
                    if tool.kind == Kind::Edit {
                        edits.extend(tool.paths.iter().cloned());
                    }
                    self.groups.insert(tool.id.clone(), id);
                }
            }
            let mut parts = Vec::new();
            if counts[0] > 0 {
                counts[0] = reads.len().max(1);
            }
            if counts[1] > 0 {
                counts[1] = edits.len().max(1);
            }
            for (count, verb, noun) in [
                (counts[0], "read", "file"),
                (counts[1], "edited", "file"),
                (counts[2], "ran", "command"),
                (counts[3], "ran", "script"),
                (counts[4], "made", "search"),
                (counts[5], "fetched", "page"),
                (counts[6], "used", "tool"),
            ] {
                if count > 0 {
                    parts.push(format!(
                        "{verb} {count} {noun}{}",
                        if count == 1 { "" } else { "s" }
                    ));
                }
            }
            let title = format!(
                "{}{}{}",
                if active {
                    "Working"
                } else if counts.iter().all(|count| *count == 0) {
                    "Thought"
                } else {
                    "Worked"
                },
                if parts.is_empty() { "" } else { " · " },
                parts.join(", ")
            );
            rows.push(Message::work(Arc::new(Work {
                readers,
                id,
                steps,
                title,
                active,
                failures,
                uncertain,
            })));
        }
        rows.extend(tail);
    }
}
pub(crate) fn cut(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.into();
    }
    let mut end = cap.saturating_sub(3);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}
// Chord's tool-output trim operation uses JavaScript String.slice: UTF-16 units.
fn utf16_offset(text: &str, units: usize) -> Option<usize> {
    let mut consumed = 0;
    for (byte, ch) in text.char_indices() {
        if consumed == units {
            return Some(byte);
        }
        consumed += ch.len_utf16();
        if consumed > units {
            return None;
        }
    }
    Some(text.len())
}
fn first_line(text: &str) -> String {
    cut(
        text.lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim(),
        240,
    )
}
// Adapted from MonoCode GPUI preview tools.rs:17–31 at d9e6e230b0005bff492a18cd2d3404d199e441f1.
// MIT, Copyright (c) 2026 Nick. Full notice: ../licenses/MONOCODE.txt.
// Only std-only caption formatting is reused; no engine, renderer or asset code.
fn command_label(command: &str) -> String {
    let mut words = command.split_whitespace();
    let program = words.next().unwrap_or("");
    let program = program.rsplit('/').next().unwrap_or(program);
    match words.next() {
        Some(sub)
            if !sub.starts_with('-')
                && !sub.contains(['/', '.', '=', '\'', '"'])
                && sub.len() <= 16 =>
        {
            format!("{program} {sub}")
        }
        _ => program.to_owned(),
    }
}
/// Conservative display-only compaction, NOT a shell parser or execution claim.
/// Skip standalone setup lines only when a later meaningful line exists. Complex
/// shell syntax/assignments/quoted programs retain the original line; raw source
/// and every argument remain available on intentional expansion.
fn command_subject(command: &str) -> String {
    let line = command.lines().map(str::trim).find(|line| {
        !line.is_empty()
            && !line.starts_with('#')
            && (line.contains([';', '&', '|', '`', '(', ')', '<', '>'])
                || !matches!(
                    line.split_whitespace().next(),
                    Some("set" | "cd" | "export" | "unset")
                ))
    });
    let Some(line) = line else {
        return first_line(command);
    };
    if line.contains([';', '&', '|', '`', '(', ')', '<', '>'])
        || line.starts_with(['\'', '"'])
        || line
            .split_whitespace()
            .next()
            .is_some_and(|word| word.contains('='))
    {
        return cut(line, 240);
    }
    cut(&command_label(line), 240)
}
fn js_string(code: &str, field: &str) -> Option<String> {
    let tail = code.split_once(field)?.1.trim_start();
    serde_json::Deserializer::from_str(tail)
        .into_iter::<String>()
        .next()?
        .ok()
}
fn patch_paths(patch: &str) -> Vec<String> {
    patch
        .lines()
        .filter_map(|line| {
            ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
                .iter()
                .find_map(|prefix| line.strip_prefix(prefix))
        })
        .take(16)
        .map(|path| cut(path, 1024))
        .collect()
}
fn patch_diff(patch: &str) -> String {
    cut(
        &patch
            .lines()
            .filter(|line| {
                line.starts_with(['+', '-', ' '])
                    || line.starts_with("@@")
                    || line.starts_with("*** Update File:")
                    || line.starts_with("*** Add File:")
                    || line.starts_with("*** Delete File:")
            })
            .take(300)
            .collect::<Vec<_>>()
            .join("\n"),
        DIFF_CAP,
    )
}
fn replacement(path: &str, old: &str, new: &str) -> String {
    let old: Vec<_> = old.lines().take(300).collect();
    let new: Vec<_> = new.lines().take(300).collect();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let mut out = format!("--- {path}\n+++ {path}\n@@ replacement hunk @@\n");
    for line in &old[prefix..old.len() - suffix] {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for line in &new[prefix..new.len() - suffix] {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    cut(&out, DIFF_CAP)
}
pub(crate) fn text(value: &Value) -> String {
    if let Some(s) = value["content"].as_str() {
        return s.into();
    }
    value["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

pub(crate) fn fixture_work() -> Vec<Message> {
    let mut tools = Tools::default();
    let base = 1u64 << 62;
    tools.call(
        "fixture-read",
        base,
        "read",
        &serde_json::json!({"path":"src/editor.rs"}),
    );
    tools.result(
        "fixture-read",
        base,
        "read",
        &serde_json::json!({"content":"Synthetic file contents"}),
    );
    tools.call("fixture-edit",base+1,"edit",&serde_json::json!({"path":"src/editor.rs","oldText":"let ready = false;","newText":"let ready = true;"}));
    tools.result(
        "fixture-edit",
        base + 1,
        "edit",
        &serde_json::json!({"content":"Synthetic edit completed"}),
    );
    tools.call(
        "fixture-test",
        base + 2,
        "bash",
        &serde_json::json!({"command":"cargo test"}),
    );
    tools.start("fixture-test", base + 2, "bash");
    tools.update(
        "fixture-test",
        base + 2,
        &serde_json::json!({"set":"Synthetic test progress, no command was executed."}),
    );
    tools.project(vec![
        Message::tool_ref(base, "fixture-read"),
        Message::tool_ref(base + 1, "fixture-edit"),
        Message::tool_ref(base + 2, "fixture-test"),
    ])
}

#[cfg(test)]
#[path = "tool_presentation_tests.rs"]
mod tests;

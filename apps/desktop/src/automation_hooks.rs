//! Project hooks as the Automations page shows and edits them (docs/automations.md §1).
//! Reads keep each definition's exact JSON; edits change only the fields the editor owns,
//! so a save never drops settings this app doesn't show (cwd, env, timeouts).
use serde_json::{Map, Value, json};
use std::sync::Arc;

/// Daemon limits, checked here only to explain a refusal before sending.
pub(crate) const ITEM_CAP: usize = 32;
const NAME_CHARS: usize = 80;
const SHELL_BYTES: usize = 8 * 1024;
const PATH_CAP: usize = 16;
const PATH_CHARS: usize = 256;
const MESSAGE_CHARS: usize = 2000;
const ERROR_CHARS: usize = 512;

/// What a hook does, in the three shapes the editor offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// Workspace created/restored, shell command.
    Setup,
    /// After a run, shell command (a check when failures go to the agent).
    Check,
    /// After a run with open todos, follow-up message.
    Continue,
}
impl Kind {
    pub(crate) const ALL: [Kind; 3] = [Kind::Setup, Kind::Check, Kind::Continue];
    /// The editor's choice label.
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Setup => "When a workspace is set up",
            Self::Check => "After runs that change files",
            Self::Continue => "After runs with open todos",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Hook {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) enabled: bool,
    /// None for a valid definition the editor can't represent; it stays read-only here.
    pub(crate) kind: Option<Kind>,
    /// The exact saved definition.
    pub(crate) raw: Value,
}
fn one_line(text: &str, cap: usize) -> String {
    let line = text.split(['\n', '\r']).next().unwrap_or("").trim();
    if line.chars().count() > cap {
        line.chars().take(cap - 1).chain(['…']).collect()
    } else {
        line.to_owned()
    }
}
impl Hook {
    fn read(value: &Value) -> Option<Self> {
        let id = value["id"].as_str().filter(|id| {
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })?;
        let on: Vec<&str> = value["on"]
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let action = &value["action"];
        let shell = action["type"] == "shell";
        let setup = !on.is_empty()
            && on
                .iter()
                .all(|t| matches!(*t, "workspace.created" | "workspace.restored"));
        let finished = on == ["run.finished"];
        let when = &value["when"];
        let kind = if setup && shell && when.is_null() {
            Some(Kind::Setup)
        } else if finished && shell && when["openTodos"].is_null() {
            Some(Kind::Check)
        } else if finished
            && action["type"] == "followUp"
            && when["openTodos"] == true
            && when["filesChanged"].is_null()
        {
            Some(Kind::Continue)
        } else {
            None
        };
        Some(Self {
            id: id.to_owned(),
            name: one_line(value["name"].as_str().unwrap_or(id), NAME_CHARS + 1),
            enabled: value["enabled"] == true,
            kind,
            raw: value.clone(),
        })
    }
    /// When it runs, in words.
    pub(crate) fn when(&self) -> String {
        match self.kind {
            Some(Kind::Setup) => {
                let on = self.raw["on"].as_array().map_or(0, Vec::len);
                if on == 2 {
                    "Workspace setup".into()
                } else if self.raw["on"][0] == "workspace.restored" {
                    "After restore".into()
                } else {
                    "New workspaces".into()
                }
            }
            Some(Kind::Check) => {
                let paths = self.paths();
                match (self.raw["when"]["filesChanged"].is_null(), paths.len()) {
                    (true, _) => "After each run".into(),
                    (false, 0) => "After runs that change files".into(),
                    (false, 1) => format!("When {} changes", paths[0]),
                    (false, n) => format!("When {} or {} more change", paths[0], n - 1),
                }
            }
            Some(Kind::Continue) => "When todos remain".into(),
            None => "Custom hook".into(),
        }
    }
    /// The shell command as one editable string. argv items are joined, quoting where needed.
    pub(crate) fn command(&self) -> Option<String> {
        let run = &self.raw["action"]["run"];
        if let Some(shell) = run["shell"].as_str() {
            return Some(shell.to_owned());
        }
        let argv = run["argv"].as_array()?;
        Some(
            argv.iter()
                .map(|a| quote(a.as_str().unwrap_or("")))
                .collect::<Vec<_>>()
                .join(" "),
        )
    }
    pub(crate) fn paths(&self) -> Vec<String> {
        self.raw["when"]["filesChanged"]["paths"]
            .as_array()
            .map(|p| {
                p.iter()
                    .filter_map(|p| p.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
    /// Failures go back to the agent as a follow-up.
    pub(crate) fn sends_failures(&self) -> bool {
        self.raw["action"]["onFailure"] == "followUp"
    }
    pub(crate) fn message(&self) -> Option<&str> {
        self.raw["action"]["message"]
            .as_str()
            .filter(|m| !m.is_empty())
    }
}
fn quote(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./=:,@%+".contains(&b))
    {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

/// One project's saved hooks.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProjectHooks {
    pub(crate) project_id: String,
    /// 0 before anything was saved.
    pub(crate) revision: u64,
    pub(crate) items: Vec<Hook>,
    /// A saved definition that no longer validates. It never runs and can only be replaced.
    pub(crate) error: Option<String>,
}
impl ProjectHooks {
    pub(crate) fn empty(project_id: &str) -> Self {
        Self {
            project_id: project_id.to_owned(),
            revision: 0,
            items: Vec::new(),
            error: None,
        }
    }
    /// `ProjectAutomations`: a revision, at most 32 items, an optional error.
    pub(crate) fn read(project_id: &str, value: &Value) -> Option<Self> {
        let revision = value["revision"].as_u64()?;
        let items = value["items"].as_array()?;
        if items.len() > ITEM_CAP {
            return None;
        }
        let items = items.iter().map(Hook::read).collect::<Option<Vec<_>>>()?;
        let mut ids = std::collections::HashSet::new();
        if !items.iter().all(|h| ids.insert(h.id.clone())) {
            return None;
        }
        Some(Self {
            project_id: project_id.to_owned(),
            revision,
            items,
            error: value["error"]
                .as_str()
                .filter(|e| !e.trim().is_empty())
                .map(|e| one_line(e, ERROR_CHARS)),
        })
    }
    pub(crate) fn raw_items(&self) -> Vec<Value> {
        self.items.iter().map(|h| h.raw.clone()).collect()
    }
}

/// Hooks for every project in `GET /api/projects` that has saved some.
pub(crate) fn parse_projects(value: &Value) -> Result<Vec<ProjectHooks>, &'static str> {
    let projects = value
        .as_array()
        .ok_or("Local's project list is unreadable.")?;
    let mut out = Vec::new();
    for project in projects {
        let Some(id) = project["id"]
            .as_str()
            .filter(|id| crate::local_model::valid_id(id))
        else {
            continue;
        };
        if project["automations"].is_null() {
            continue;
        }
        out.push(
            ProjectHooks::read(id, &project["automations"])
                .ok_or("Local reported hooks Pilot can't read. Nothing was changed.")?,
        );
    }
    Ok(out)
}

/// The editor's fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Draft {
    pub(crate) kind: Kind,
    pub(crate) name: String,
    pub(crate) command: String,
    /// Globs, one per line or comma-separated. Empty: any changed file.
    pub(crate) paths: String,
    pub(crate) send_failures: bool,
    pub(crate) message: String,
}
impl Default for Draft {
    fn default() -> Self {
        Self {
            kind: Kind::Setup,
            name: String::new(),
            command: String::new(),
            paths: String::new(),
            send_failures: true,
            message: String::new(),
        }
    }
}
impl Draft {
    pub(crate) fn of(hook: &Hook) -> Self {
        Self {
            kind: hook.kind.unwrap_or(Kind::Setup),
            name: hook.name.clone(),
            command: hook.command().unwrap_or_default(),
            paths: hook.paths().join("\n"),
            send_failures: hook.kind != Some(Kind::Check) || hook.sends_failures(),
            message: hook.message().unwrap_or("").to_owned(),
        }
    }
}

fn paths(text: &str) -> Result<Vec<String>, &'static str> {
    let paths: Vec<String> = text
        .split(['\n', ','])
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    if paths.len() > PATH_CAP {
        return Err("Use at most 16 paths.");
    }
    if paths.iter().any(|p| {
        p.chars().count() > PATH_CHARS
            || p.starts_with('/')
            || p.contains('\\')
            || p.split('/').any(|s| s == "..")
            || p.contains(['[', ']', '{', '}', '!', '\0'])
    }) {
        return Err("Paths are relative globs using *, ** or ?.");
    }
    Ok(paths)
}

/// A stable new ID from the name, unique in the project.
fn new_id(name: &str, taken: &[Hook]) -> String {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let mut slug = slug
        .trim_end_matches('-')
        .chars()
        .take(56)
        .collect::<String>();
    slug = slug.trim_end_matches('-').to_owned();
    if slug.is_empty() {
        slug = "hook".into();
    }
    let free = |id: &str| taken.iter().all(|h| h.id != id);
    if free(&slug) {
        return slug;
    }
    (2..)
        .map(|n| format!("{slug}-{n}"))
        .find(|id| free(id))
        .expect("an unused suffix")
}

/// The definition the draft saves: `editing` keeps its ID, position and unowned fields.
pub(crate) fn build(
    base: &ProjectHooks,
    editing: Option<&str>,
    draft: &Draft,
) -> Result<Vec<Value>, &'static str> {
    let name = draft.name.trim();
    if name.is_empty() {
        return Err("Name the hook.");
    }
    if name.chars().count() > NAME_CHARS || name.chars().any(char::is_control) {
        return Err("The name is one line of at most 80 characters.");
    }
    let original = match editing {
        Some(id) => Some(
            base.items
                .iter()
                .position(|h| h.id == id)
                .ok_or("This hook was removed. Close and start again.")?,
        ),
        None if base.items.len() >= ITEM_CAP => return Err("A project can have at most 32 hooks."),
        None => None,
    };
    let previous = original.map(|ix| &base.items[ix]);
    let mut item: Map<String, Value> = previous
        .and_then(|h| h.raw.as_object().cloned())
        .unwrap_or_default();
    if previous.is_none() {
        item.insert("id".into(), json!(new_id(name, &base.items)));
        item.insert("enabled".into(), json!(true));
    }
    item.insert("name".into(), json!(name));
    let shell_action = |previous: Option<&Hook>| -> Result<Map<String, Value>, &'static str> {
        let command = draft.command.trim();
        if command.is_empty() {
            return Err("Enter a command.");
        }
        if command.len() > SHELL_BYTES || command.contains('\0') {
            return Err("The command is at most 8 KiB.");
        }
        let mut action = previous
            .filter(|h| h.raw["action"]["type"] == "shell")
            .and_then(|h| h.raw["action"].as_object().cloned())
            .unwrap_or_default();
        action.insert("type".into(), json!("shell"));
        // An unchanged argv command stays argv; edited text runs through /bin/sh.
        let unchanged = previous
            .and_then(Hook::command)
            .is_some_and(|c| c.trim() == command)
            && action.get("run").is_some_and(|r| r.get("argv").is_some());
        if !unchanged {
            action.insert("run".into(), json!({"shell": command}));
        }
        Ok(action)
    };
    let previous_kind = previous.and_then(|h| h.kind);
    match draft.kind {
        Kind::Setup => {
            let mut action = shell_action(previous)?;
            action.remove("onFailure");
            if previous_kind != Some(Kind::Setup) {
                item.insert(
                    "on".into(),
                    json!(["workspace.created", "workspace.restored"]),
                );
            }
            item.remove("when");
            item.insert("action".into(), Value::Object(action));
        }
        Kind::Check => {
            let mut action = shell_action(previous)?;
            if draft.send_failures {
                action.insert("onFailure".into(), json!("followUp"));
            } else {
                action.remove("onFailure");
            }
            let paths = paths(&draft.paths)?;
            item.insert("on".into(), json!(["run.finished"]));
            item.insert(
                "when".into(),
                json!({"filesChanged": if paths.is_empty() { json!(true) } else { json!({"paths": paths}) }}),
            );
            item.insert("action".into(), Value::Object(action));
        }
        Kind::Continue => {
            let message = draft.message.trim();
            if message.chars().count() > MESSAGE_CHARS || message.contains('\0') {
                return Err("The message is at most 2,000 characters.");
            }
            item.insert("on".into(), json!(["run.finished"]));
            item.insert("when".into(), json!({"openTodos": true}));
            let mut action = json!({"type": "followUp"});
            if !message.is_empty() {
                action["message"] = json!(message);
            }
            item.insert("action".into(), action);
        }
    }
    let mut items = base.raw_items();
    match original {
        Some(ix) => items[ix] = Value::Object(item),
        None => items.push(Value::Object(item)),
    }
    Ok(items)
}

/// The list with one hook switched on or off, everything else exact.
pub(crate) fn toggled(base: &ProjectHooks, id: &str, enabled: bool) -> Option<Vec<Value>> {
    let ix = base.items.iter().position(|h| h.id == id)?;
    let mut items = base.raw_items();
    items[ix]["enabled"] = json!(enabled);
    Some(items)
}

pub(crate) fn removed(base: &ProjectHooks, id: &str) -> Option<Vec<Value>> {
    let ix = base.items.iter().position(|h| h.id == id)?;
    let mut items = base.raw_items();
    items.remove(ix);
    Some(items)
}

/// A retained command result from a chat summary (`automationRuns`), without its output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Run {
    pub(crate) automation_id: String,
    pub(crate) state: RunState,
    pub(crate) exit_code: Option<i64>,
    pub(crate) reason: Option<String>,
    /// Ended, else started, epoch ms.
    pub(crate) at: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunState {
    Waiting,
    Running,
    Ok,
    Failed,
    TimedOut,
    Cancelled,
    Interrupted,
    Skipped,
}
impl RunState {
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "waiting" => Self::Waiting,
            "running" => Self::Running,
            "ok" => Self::Ok,
            "failed" => Self::Failed,
            "timed_out" => Self::TimedOut,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            "skipped" => Self::Skipped,
            _ => return None,
        })
    }
}
/// At most the daemon's 20 retained records per chat.
pub(crate) fn runs(summary: &Value) -> Arc<[Run]> {
    let Some(records) = summary["automationRuns"].as_array() else {
        return Arc::new([]);
    };
    records
        .iter()
        .rev()
        .take(20)
        .filter_map(|r| {
            Some(Run {
                automation_id: r["automationId"]
                    .as_str()
                    .filter(|id| id.len() <= 64)?
                    .to_owned(),
                state: RunState::parse(r["state"].as_str()?)?,
                exit_code: r["exitCode"].as_i64(),
                reason: r["reason"]
                    .as_str()
                    .map(|r| one_line(r, 120))
                    .filter(|r| !r.is_empty()),
                at: r["endedAt"].as_u64().or_else(|| r["startedAt"].as_u64())?,
            })
        })
        .collect()
}

/// The newest run of one project's hook, across that project's chats, and its chat.
pub(crate) fn last_run<'a>(
    chats: &'a [crate::local_model::Chat],
    project_id: &str,
    hook_id: &str,
) -> Option<(&'a Run, &'a crate::local_model::Chat)> {
    chats
        .iter()
        .filter(|c| c.project_id.as_deref() == Some(project_id))
        .flat_map(|c| c.automation_runs.iter().map(move |r| (r, c)))
        .filter(|(r, _)| r.automation_id == hook_id)
        .max_by_key(|(r, _)| r.at)
}

/// The row's status words and whether they report a problem.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    Quiet,
    Warning,
    Error,
}
pub(crate) fn status(run: &Run) -> (String, Tone) {
    let cause = || {
        run.exit_code
            .map(|c| format!("exit {c}"))
            .or_else(|| run.reason.clone())
    };
    let with = |label: &str| match cause() {
        Some(cause) => format!("{label} · {cause}"),
        None => label.to_owned(),
    };
    match run.state {
        RunState::Waiting => ("Waiting".into(), Tone::Quiet),
        RunState::Running => ("Running".into(), Tone::Quiet),
        RunState::Ok => ("Passed".into(), Tone::Quiet),
        RunState::Failed => (with("Failed"), Tone::Error),
        RunState::TimedOut => ("Timed out".into(), Tone::Error),
        RunState::Cancelled => ("Cancelled".into(), Tone::Quiet),
        RunState::Interrupted => ("Interrupted".into(), Tone::Warning),
        RunState::Skipped => (
            match &run.reason {
                Some(reason) => format!("Skipped · {reason}"),
                None => "Skipped".into(),
            },
            Tone::Warning,
        ),
    }
}

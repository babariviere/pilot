//! Composer slash commands: precedence, matching and whole-message invocations. No I/O.
//!
//! Byte ranges are UTF-8 offsets into the composer text, like `TextareaState::selected_range`.
use serde_json::Value;
use std::ops::Range;

/// A native action. It is never sent, queued or scheduled as a chat message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Jobs,
    Compact,
    Model,
    Changes,
    Artifacts,
    Help,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// Reserved: a session command cannot take its name.
    Builtin(Action),
    /// Opens an app control unless a session command already has its name.
    App(Action),
    Prompt,
    Skill,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Command {
    pub(crate) name: String,
    pub(crate) kind: Kind,
    pub(crate) description: Option<String>,
    pub(crate) argument_hint: Option<String>,
}

impl Command {
    fn native(name: &str, kind: Kind, description: &str) -> Self {
        Self {
            name: name.into(),
            kind,
            description: Some(description.into()),
            argument_hint: None,
        }
    }
    pub(crate) fn action(&self) -> Option<Action> {
        match self.kind {
            Kind::Builtin(action) | Kind::App(action) => Some(action),
            Kind::Prompt | Kind::Skill => None,
        }
    }
    pub(crate) fn invocation(&self) -> String {
        format!("/{}", self.name)
    }
}

/// Where the composer is: an existing chat, or a new chat that has no session yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    Chat { model: bool },
    NewChat { model: bool },
}

fn model() -> Command {
    Command::native("model", Kind::App(Action::Model), "Choose the model")
}
fn help() -> Command {
    Command::native("help", Kind::App(Action::Help), "Keyboard shortcuts")
}

/// Built-ins, then the app commands this composer supports (unless a session command
/// has the name), then the session's prompt templates and skills. Session commands
/// cannot shadow built-ins; an app command never hides a session prompt or skill.
pub(crate) fn available(scope: Scope, session: &[Command]) -> Vec<Command> {
    let (builtins, app, session) = match scope {
        Scope::Chat { model: has_model } => {
            let builtins = vec![
                Command::native(
                    "jobs",
                    Kind::Builtin(Action::Jobs),
                    "Running background jobs",
                ),
                Command::native("compact", Kind::Builtin(Action::Compact), "Compact context"),
            ];
            let mut app = Vec::new();
            if has_model {
                app.push(model());
            }
            app.push(Command::native(
                "changes",
                Kind::App(Action::Changes),
                "Open Changes",
            ));
            app.push(Command::native(
                "artifacts",
                Kind::App(Action::Artifacts),
                "Open Artifacts",
            ));
            app.push(help());
            let session: Vec<&Command> = session
                .iter()
                .filter(|c| matches!(c.kind, Kind::Prompt | Kind::Skill))
                .filter(|c| !builtins.iter().any(|b| b.name == c.name))
                .collect();
            (builtins, app, session)
        }
        // No session exists yet, so no built-in, inspector or session command.
        Scope::NewChat { model: has_model } => {
            let mut app = Vec::new();
            if has_model {
                app.push(model());
            }
            app.push(help());
            (Vec::new(), app, Vec::new())
        }
    };
    let mut all = builtins;
    all.extend(
        app.into_iter()
            .filter(|a| !session.iter().any(|s| s.name == a.name)),
    );
    all.extend(session.into_iter().cloned());
    all
}

/// The command token being typed: a leading "/" through the caret, before any
/// whitespace, with the caret at the token's end.
pub(crate) fn token(text: &str, selection: Range<usize>) -> Option<Range<usize>> {
    let caret = selection.start;
    if !selection.is_empty()
        || caret == 0
        || caret > text.len()
        || !text.is_char_boundary(caret)
        || !text.starts_with('/')
    {
        return None;
    }
    if text[1..caret].chars().any(char::is_whitespace) {
        return None;
    }
    // Completing inside a token would duplicate its existing suffix.
    if text[caret..]
        .chars()
        .next()
        .is_some_and(|c| !c.is_whitespace())
    {
        return None;
    }
    Some(0..caret)
}

/// Prefix matches first (of the full name, or of a skill's name after "skill:"),
/// then substring matches, each in the given order. An empty query lists everything.
pub(crate) fn matches(query: &str, commands: &[Command], limit: usize) -> Vec<Command> {
    let query = query.to_lowercase();
    let mut prefixed = Vec::new();
    let mut contained = Vec::new();
    for command in commands {
        let name = command.name.to_lowercase();
        let bare = match command.kind {
            Kind::Skill => name.strip_prefix("skill:").unwrap_or(&name),
            _ => &name,
        };
        if name.starts_with(&query) || bare.starts_with(&query) {
            prefixed.push(command.clone());
        } else if name.contains(&query) {
            contained.push(command.clone());
        }
    }
    prefixed.extend(contained);
    prefixed.truncate(limit);
    prefixed
}

/// The native command a whole message invokes among `available`, and its trimmed
/// arguments. Prompt templates, skills and anything else are ordinary messages.
pub(crate) fn invocation<'a>(
    message: &'a str,
    available: &[Command],
) -> Option<(Command, &'a str)> {
    let rest = message.trim().strip_prefix('/')?;
    let (name, arguments) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    available
        .iter()
        .find(|c| c.action().is_some() && c.name == name)
        .map(|c| (c.clone(), arguments.trim()))
}

/// The session's prompt templates and skills from `GET /api/sessions/:id/commands`.
/// Malformed entries are skipped; text is one display line.
pub(crate) fn parse_session(value: &Value) -> Option<Vec<Command>> {
    let line = |v: &Value| {
        v.as_str()
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty())
    };
    let mut commands: Vec<Command> = Vec::new();
    for entry in value["commands"].as_array()? {
        let Some(name) = entry["name"].as_str().filter(|n| valid_name(n)) else {
            continue;
        };
        let kind = match entry["source"].as_str() {
            Some("prompt") => Kind::Prompt,
            Some("skill") => Kind::Skill,
            _ => continue,
        };
        if commands.iter().any(|c| c.name == name) {
            continue;
        }
        commands.push(Command {
            name: name.into(),
            kind,
            description: line(&entry["description"]),
            argument_hint: line(&entry["argumentHint"]),
        });
    }
    Some(commands)
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.starts_with('/')
        && !name.chars().any(|c| c.is_whitespace() || c.is_control())
}

#[cfg(test)]
#[path = "slash_commands_tests.rs"]
mod tests;

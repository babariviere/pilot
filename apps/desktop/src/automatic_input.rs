//! Automatic transcript input: `pi.user` entries carrying the protocol's
//! `origin` provenance. Classification reads only that structured metadata,
//! never the message body. The full exact source stays on the row.
use crate::app_icon::AppIcon;
use serde_json::Value;

/// `InputOrigin` from packages/protocol. Unknown future values stay
/// automatic, named generically like the Swift app's extension input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Origin {
    Job,
    Subagent,
    Extension,
    Coordinator,
    Mission,
    PullRequest,
    /// Project hooks: `<automation>` follow-ups and hook result notes.
    Automation,
    Slack,
    Control,
    Watch,
    /// Kernel-written `pilot.activity` notes, such as PR rebases.
    Activity,
}

impl Origin {
    fn parse(value: &str) -> Self {
        match value {
            "job" => Self::Job,
            "subagent" => Self::Subagent,
            "coordinator" => Self::Coordinator,
            "mission" => Self::Mission,
            "pullRequest" => Self::PullRequest,
            "automation" => Self::Automation,
            "slack" => Self::Slack,
            "control" => Self::Control,
            "watch" => Self::Watch,
            _ => Self::Extension,
        }
    }
    /// The Swift app's source names (InputOriginDisplay.swift).
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Job => "Background job",
            Self::Subagent => "Subagent",
            Self::Extension => "Automatic message",
            Self::Coordinator => "Coordinator",
            Self::Mission => "Mission",
            Self::PullRequest => "PR follow-up",
            Self::Automation => "Automation message",
            Self::Slack => "Slack reply",
            Self::Control => "Control chat",
            Self::Watch => "Watch",
            Self::Activity => "Activity",
        }
    }
    pub(crate) fn icon(self) -> AppIcon {
        match self {
            Self::Job => AppIcon::Command,
            Self::Subagent => AppIcon::Subagent,
            Self::Extension => AppIcon::Tool,
            Self::Coordinator | Self::Control => AppIcon::Coordinator,
            Self::Mission => AppIcon::Mission,
            Self::PullRequest => AppIcon::PullRequest,
            Self::Automation => AppIcon::Automations,
            Self::Slack | Self::Watch => AppIcon::Chats,
            Self::Activity => AppIcon::Info,
        }
    }
}

/// Display-only provenance of one automatic entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Automatic {
    pub(crate) origin: Origin,
    /// The kernel's user-facing event sentence (`data.event.text`), when sent.
    pub(crate) summary: Option<String>,
    /// Sending chat projected from durable submission IDs, when known.
    pub(crate) sender: Option<String>,
    /// A hook result the daemon reported as failed (`automation_failed`).
    pub(crate) failed: bool,
}

impl Automatic {
    /// Some for an entry with a string `origin`, which the kernel sets on
    /// automatic `pi.user` entries alone, and for kernel-written
    /// `pilot.activity` notes (mission decision notices, PR activity).
    pub(crate) fn read(entry: &Value) -> Option<Self> {
        let event = entry["data"]["event"]["kind"].as_str().unwrap_or("");
        let origin = match entry["origin"].as_str() {
            Some(origin) => Origin::parse(origin),
            None if entry["kind"] == "pilot.activity" => {
                if event.starts_with("mission_") {
                    Origin::Mission
                } else if event.starts_with("automation_") {
                    Origin::Automation
                } else {
                    Origin::Activity
                }
            }
            // The user's explicit Retry after a failed automatic handoff: a
            // kernel-written event on their own input, shown as one quiet line.
            None if entry["kind"] == "pi.user" && event == "handoff_retry" => Origin::Activity,
            None => return None,
        };
        let text = |value: &Value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.len() <= 512)
                .map(str::to_owned)
        };
        let summary = text(&entry["data"]["event"]["text"]).or_else(|| {
            (origin == Origin::Automation && entry["kind"] == "pi.user")
                .then(|| follow_up_summary(first_text(entry)?))
                .flatten()
        });
        Some(Self {
            origin,
            summary,
            sender: text(&entry["sourceSessionId"]).filter(|s| s.len() <= 128),
            failed: origin == Origin::Automation && event == "automation_failed",
        })
    }
    /// The row's sentence: the kernel's summary, else the source's name.
    pub(crate) fn sentence(&self) -> &str {
        self.summary.as_deref().unwrap_or(self.origin.title())
    }
    /// A first-line preview after the sentence. A kernel summary already says
    /// what happened, so it stands alone.
    pub(crate) fn preview(&self, source: &str) -> Option<String> {
        self.summary.is_none().then(|| preview(source)).flatten()
    }
}

/// First non-empty line, whitespace collapsed, at most `LIMIT` characters.
fn preview(source: &str) -> Option<String> {
    const LIMIT: usize = 160;
    let line = source
        .lines()
        .take(64)
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|line| !line.is_empty())?;
    Some(if line.chars().count() > LIMIT {
        line.chars().take(LIMIT - 1).chain(['…']).collect()
    } else {
        line
    })
}

/// The first text part of the entry's first model message.
fn first_text(entry: &Value) -> Option<&str> {
    let content = &entry["model"][0]["content"];
    content.as_str().or_else(|| {
        content
            .as_array()?
            .iter()
            .find(|part| part["type"] == "text")?["text"]
            .as_str()
    })
}

/// One line for an `<automation>` follow-up, read from its opening tag only
/// (docs/technical/automations.md §5): `<automation name="…" kind="check|continue" attempt="n/m">`.
/// Anything else reads as the origin's title.
fn follow_up_summary(source: &str) -> Option<String> {
    let line = source.lines().next()?.trim();
    let attributes = line.strip_prefix("<automation ")?.strip_suffix('>')?;
    let mut name = None;
    let mut kind = None;
    let mut attempt = None;
    let mut rest = attributes;
    while !rest.is_empty() {
        let (key, after) = rest.split_once("=\"")?;
        let (value, after) = after.split_once('"')?;
        match key.trim() {
            "name" => name = Some(value),
            "kind" => kind = Some(value),
            "attempt" => attempt = Some(value),
            _ => return None,
        }
        rest = after.trim_start();
    }
    let attempt = attempt.filter(|a| {
        a.split_once('/').is_some_and(|(n, m)| {
            !n.is_empty()
                && !m.is_empty()
                && n.len() <= 3
                && m.len() <= 3
                && n.bytes().chain(m.bytes()).all(|b| b.is_ascii_digit())
        })
    })?;
    let name = unescape(name?);
    let name: String = if name.chars().count() > 160 {
        name.chars().take(159).chain(['…']).collect()
    } else {
        name
    };
    match kind? {
        "check" if !name.trim().is_empty() => {
            Some(format!("Checks failed: {name} · sent to agent ({attempt})"))
        }
        "continue" => Some(format!("Open todos · asked agent to continue ({attempt})")),
        _ => None,
    }
}

/// The three entities the daemon escapes in attribute values.
fn unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(extra: Value) -> Value {
        let mut entry = json!({"id":4,"kind":"pi.user","model":[{"role":"user","content":"x"}]});
        entry
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        entry
    }

    #[test]
    fn only_structured_origin_marks_automatic_input() {
        assert_eq!(Automatic::read(&entry(json!({}))), None);
        // Body text that looks automatic is still the user's.
        let typed = json!({"id":4,"kind":"pi.user","model":[{"role":"user","content":"Pilot automatic PR follow-up (1/3)"}]});
        assert_eq!(Automatic::read(&typed), None);
        assert_eq!(Automatic::read(&entry(json!({"origin": null}))), None);
        assert_eq!(Automatic::read(&entry(json!({"origin": 3}))), None);
        for (raw, origin) in [
            ("job", Origin::Job),
            ("subagent", Origin::Subagent),
            ("extension", Origin::Extension),
            ("coordinator", Origin::Coordinator),
            ("mission", Origin::Mission),
            ("pullRequest", Origin::PullRequest),
            ("automation", Origin::Automation),
            ("slack", Origin::Slack),
            ("control", Origin::Control),
            ("watch", Origin::Watch),
            ("futureOrigin", Origin::Extension),
        ] {
            let read = Automatic::read(&entry(json!({ "origin": raw }))).unwrap();
            assert_eq!(read.origin, origin);
            assert_eq!(read.sentence(), origin.title());
        }
    }

    #[test]
    fn kernel_summary_and_sender_are_display_only_provenance() {
        let mission = Automatic::read(&entry(json!({
            "origin": "mission",
            "sourceSessionId": "chat-1",
            "data": {"event": {"kind": "mission_task_done", "text": "Task #3 marked done"}}
        })))
        .unwrap();
        assert_eq!(mission.sentence(), "Task #3 marked done");
        assert_eq!(mission.sender.as_deref(), Some("chat-1"));
        assert_eq!(mission.preview("Long agent-facing notice"), None);
        let job = Automatic::read(&entry(
            json!({"origin": "job", "data": {"event": {"text": "  "}}}),
        ))
        .unwrap();
        assert_eq!(job.summary, None);
        assert_eq!(
            job.preview("\n  \n- build (j1):   failed, exit code 2.\nOutput: log")
                .as_deref(),
            Some("- build (j1): failed, exit code 2.")
        );
        let long = "é".repeat(400);
        let shown = job.preview(&long).unwrap();
        assert_eq!(shown.chars().count(), 160);
        assert!(shown.ends_with('…'));
        assert_eq!(job.preview(" \n\t"), None);
    }

    #[test]
    fn kernel_activity_entries_are_automatic_without_origin() {
        let decisions = Automatic::read(&json!({
            "kind": "pilot.activity",
            "data": {"text": "Full notice", "event": {"kind": "mission_decisions_changed", "text": "Decisions changed"}},
            "model": [{"role": "user", "content": "Full notice"}]
        }))
        .unwrap();
        assert_eq!(decisions.origin, Origin::Mission);
        assert_eq!(decisions.sentence(), "Decisions changed");
        let note = Automatic::read(&json!({"kind": "pilot.activity", "data": {"text": "Rebased PR #12 onto main"}, "model": []})).unwrap();
        assert_eq!(note.origin, Origin::Activity);
        assert_eq!(
            note.preview("Rebased PR #12 onto main").as_deref(),
            Some("Rebased PR #12 onto main")
        );
        // Other kernel kinds without origin are not automatic input.
        assert_eq!(Automatic::read(&json!({"kind": "pilot.question"})), None);
    }

    #[test]
    fn handoff_retry_input_reads_as_a_quiet_event() {
        let retry = Automatic::read(&json!({
            "kind": "pi.user",
            "data": {"event": {"kind": "handoff_retry", "text": "Retried the automatic handoff"}},
            "model": [{"role": "user", "content": "The automatic context handoff failed…"}]
        }))
        .unwrap();
        assert_eq!(retry.origin, Origin::Activity);
        assert_eq!(retry.sentence(), "Retried the automatic handoff");
        assert_eq!(retry.preview("anything"), None);
        // Only that structured event, never other user entries.
        assert_eq!(
            Automatic::read(&json!({"kind": "pi.user", "data": {"event": {"kind": "other"}}})),
            None
        );
    }

    #[test]
    fn automation_follow_ups_read_only_their_opening_line() {
        let follow_up = |content: Value| {
            Automatic::read(&json!({
                "kind": "pi.user",
                "origin": "automation",
                "model": [{"role": "user", "content": content}]
            }))
            .unwrap()
        };
        let check = follow_up(json!(
            "<automation name=\"Lint &amp; test, A&lt;B &quot;x&quot;\" kind=\"check\" attempt=\"1/3\">\nChecks failed after your last run.\n</automation>"
        ));
        assert_eq!(check.origin, Origin::Automation);
        assert_eq!(
            check.sentence(),
            "Checks failed: Lint & test, A<B \"x\" · sent to agent (1/3)"
        );
        assert_eq!(check.preview("anything"), None);
        assert!(!check.failed);
        let todos = follow_up(json!([{"type": "text", "text":
            "<automation name=\"Continue on open todos\" kind=\"continue\" attempt=\"2/3\">\nYou finished with 3 open todos."}]));
        assert_eq!(
            todos.sentence(),
            "Open todos · asked agent to continue (2/3)"
        );
        for body in [
            "Checks failed: Tests",
            "<automation kind=\"check\" attempt=\"1/3\">",
            "<automation name=\"T\" kind=\"other\" attempt=\"1/3\">",
            "<automation name=\"T\" kind=\"check\" attempt=\"one\">",
            "<automation name=\"T\" kind=\"check\" attempt=\"1/3\" extra=\"x\">",
            "<automation name=\"T kind=\"check\" attempt=\"1/3\">",
        ] {
            let read = follow_up(json!(body));
            assert_eq!(read.summary, None, "{body}");
            assert_eq!(read.sentence(), "Automation message");
        }
        // The same opening line from the user is still the user's.
        assert_eq!(
            Automatic::read(
                &json!({"kind":"pi.user","model":[{"role":"user","content":"<automation name=\"T\" kind=\"check\" attempt=\"1/3\">"}]})
            ),
            None
        );
    }

    #[test]
    fn hook_results_are_automation_events() {
        let read = |kind: &str| {
            Automatic::read(&json!({
                "kind": "pilot.activity",
                "data": {"text": "Checks failed: Tests\n\nTests: failed", "event": {"kind": kind, "text": "Checks failed: Tests"}},
                "model": []
            }))
            .unwrap()
        };
        let failed = read("automation_failed");
        assert_eq!(failed.origin, Origin::Automation);
        assert!(failed.failed);
        assert_eq!(failed.sentence(), "Checks failed: Tests");
        let passed = read("automation_finished");
        assert_eq!(passed.origin, Origin::Automation);
        assert!(!passed.failed);
    }
}

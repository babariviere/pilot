//! Public summary evidence only. Not the authoritative Inbox or private review marks.
use crate::dither::Signal;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Kind {
    Failed,
    Question,
    ScheduledFailure,
    Other,
    Ready,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Attention {
    pub(crate) kind: Kind,
    pub(crate) label: String,
}
impl Kind {
    pub(crate) fn signal(self) -> Signal {
        match self {
            Self::Failed | Self::ScheduledFailure => Signal::Failed,
            Self::Question | Self::Other => Signal::NeedsYou,
            Self::Ready => Signal::Ready,
        }
    }
}
fn first_line(value: &Value) -> Option<String> {
    let line = value
        .as_str()?
        .split([
            '\n', '\r', '\u{000b}', '\u{000c}', '\u{0085}', '\u{2028}', '\u{2029}',
        ])
        .map(str::trim)
        .find(|s| !s.is_empty())?;
    let mut chars = line.chars();
    let prefix: String = chars.by_ref().take(200).collect();
    Some(if chars.next().is_some() {
        format!("{}…", prefix.chars().take(199).collect::<String>())
    } else {
        prefix
    })
}
pub(crate) fn project(value: &Value, signal: Option<Signal>) -> Option<Attention> {
    if !value["archivedAt"].is_null() || !value["continuedTo"].is_null() || value["control"] == true
    {
        return None;
    }
    let reason = value["attentionReason"]["kind"].as_str().unwrap_or("");
    let live = matches!(reason, "long_job" | "mcp" | "tool_stall");
    // Follow SessionSignal precedence. A job, pause or scheduled reply must not
    // resurrect a previous question/failure. Live public attention wins first.
    if !live
        && (signal == Some(Signal::Working)
            || value["scheduledMessage"] == true
            || value["sleepPaused"] == true
            || value["offlinePaused"] == true)
    {
        return (signal == Some(Signal::Ready)).then(|| Attention {
            kind: Kind::Ready,
            label: "Ready to merge · reported by GitHub".into(),
        });
    }
    let detail = first_line(&value["attentionReason"]["detail"]);
    let with_detail = |prefix: &str, fallback: &str| {
        format!("{prefix}: {}", detail.as_deref().unwrap_or(fallback))
    };
    let (explicit_kind, label) = match reason {
        "failed" => (Kind::Failed, with_detail("Failed", "The chat failed")),
        "asks" => (
            Kind::Question,
            with_detail("Asks", "A question is waiting for your answer"),
        ),
        "couldnt_start" => (
            Kind::ScheduledFailure,
            with_detail("Couldn't start", "The scheduled chat could not start"),
        ),
        "long_job" => (
            Kind::Other,
            with_detail("Long job", "A background job has run for over an hour"),
        ),
        "tool_stall" => (
            Kind::Other,
            with_detail(
                "Tool may be stalled",
                "No useful progress has been observed",
            ),
        ),
        "mcp" => (
            Kind::Other,
            with_detail("MCP", "A server this chat uses needs you"),
        ),
        "pr_stuck" => (
            Kind::Other,
            detail.unwrap_or_else(|| "A pull request needs your help".into()),
        ),
        "no_pr" => (Kind::Other, "No PR created".into()),
        "mission" => (
            Kind::Other,
            with_detail("Mission", "A question or blocked task is waiting on you"),
        ),
        "limit" => (Kind::Other, "Limit reached".into()),
        "not_reviewed" => (Kind::Other, "Not reviewed · reported by Local".into()),
        _ => (Kind::Other, String::new()),
    };
    if live {
        return Some(Attention {
            kind: explicit_kind,
            label,
        });
    }
    let kind = match signal {
        Some(Signal::Failed) if reason == "couldnt_start" => Kind::ScheduledFailure,
        Some(Signal::Failed) => Kind::Failed,
        Some(Signal::NeedsYou) if value["outcome"] == "question" => Kind::Question,
        Some(Signal::NeedsYou) => Kind::Other,
        Some(Signal::Ready) => {
            return Some(Attention {
                kind: Kind::Ready,
                label: "Ready to merge · reported by GitHub".into(),
            });
        }
        _ if !label.is_empty() => explicit_kind,
        _ => return None,
    };
    let label = if kind == Kind::Failed && reason != "failed" && reason != "limit" {
        format!(
            "Failed: {}",
            first_line(&value["outcomeReason"])
                .as_deref()
                .unwrap_or("The chat failed")
        )
    } else if kind == Kind::Question && reason != "asks" {
        format!(
            "Asks: {}",
            first_line(&value["outcomeReason"])
                .as_deref()
                .unwrap_or("A question is waiting for your answer")
        )
    } else if label.is_empty() {
        match kind {
            Kind::Failed => "Failed: The chat failed",
            Kind::Question => "Asks: A question is waiting for your answer",
            _ if value["unpublishedWork"] == true => "No PR created",
            _ => "Needs you",
        }
        .into()
    } else {
        label
    };
    Some(Attention { kind, label })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn attention(extra: Value) -> Option<Attention> {
        let mut v = json!({"id":"chat", "state":"idle"});
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        crate::local_model::chat(&v).unwrap().attention
    }
    #[test]
    fn public_attention_priority_and_privacy() {
        assert_eq!(
            attention(json!({"outcome":"failed"})).unwrap().kind,
            Kind::Failed
        );
        assert_eq!(
            attention(json!({"outcome":"question"})).unwrap().kind,
            Kind::Question
        );
        for kind in [
            "failed",
            "asks",
            "couldnt_start",
            "long_job",
            "tool_stall",
            "mcp",
            "pr_stuck",
            "no_pr",
            "mission",
            "limit",
            "not_reviewed",
        ] {
            let a = attention(json!({"attentionReason":{"kind":kind,"detail":"\n  Public reason\nSECRET SECOND LINE", "providerReasoning":"SECRET"}})).unwrap();
            assert!(!a.label.contains("SECRET"));
        }
        for extra in [
            json!({"outcome":"done"}),
            json!({"unread":true}),
            json!({"pendingApprovals":[1,2]}),
            json!({"attentionReason":{"kind":"future","detail":"SECRET"}}),
        ] {
            assert!(attention(extra).is_none());
        }
        for guard in [
            json!({"working":true}),
            json!({"sleepPaused":true}),
            json!({"offlinePaused":true}),
            json!({"scheduledMessage":true}),
            json!({"archivedAt":123}),
            json!({"continuedTo":"other"}),
            json!({"control":true}),
        ] {
            let mut v = json!({"outcome":"question","attentionReason":{"kind":"asks"}});
            v.as_object_mut()
                .unwrap()
                .extend(guard.as_object().unwrap().clone());
            assert!(attention(v).is_none());
        }
        assert!(attention(json!({"working":true,"attentionReason":{"kind":"mcp"}})).is_some());
        let ready = json!({"pullRequest":{"state":"open","readiness":{"state":"ready"}}});
        assert_eq!(attention(ready.clone()).unwrap().kind, Kind::Ready);
        let mut v = ready;
        v["working"] = json!(true);
        assert!(attention(v).is_none());
    }
    #[test]
    fn detail_is_bounded_without_splitting_unicode() {
        let a = attention(json!({"attentionReason":{"kind":"asks", "detail":"🦀".repeat(400)}}))
            .unwrap();
        assert_eq!(a.label.chars().count(), 6 + 200);
        assert!(a.label.ends_with('…'));
        assert_eq!(
            first_line(&json!("🦀".repeat(200))).unwrap(),
            "🦀".repeat(200)
        );
        assert_eq!(
            first_line(&json!("  \u{2028}Visible\u{2029}second line")).unwrap(),
            "Visible"
        );
        assert_eq!(
            attention(
                json!({"outcome":"question","outcomeReason":"Public question\nnot retained"})
            )
            .unwrap()
            .label,
            "Asks: Public question"
        );
        assert_eq!(
            attention(json!({"outcome":"failed","attentionReason":{"kind":"couldnt_start"}}))
                .unwrap()
                .kind,
            Kind::ScheduledFailure
        );
    }
}

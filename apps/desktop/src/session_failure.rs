//! Only public, already-redacted summary diagnostics. Never inspect exceptions or logs.
use serde_json::Value;

pub(crate) const DETAIL_CAP: usize = 8 * 1024;
pub(crate) const MISSING: &str = "No failure reason was reported";

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Failure {
    pub(crate) reason: String,
    pub(crate) source: &'static str,
    pub(crate) at: Option<u64>,
    pub(crate) attempt: Option<String>,
    pub(crate) startup: bool,
    pub(crate) historical: bool,
    pub(crate) truncated: bool,
}
fn time(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0. && *n >= 0. && *n < (1u64 << 53) as f64)
        .map(|n| n as u64)
}
fn detail(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| {
        !s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .is_empty()
    })
}
pub(crate) fn read(value: &Value) -> Option<Failure> {
    let startup = value["canRetryStartup"] == true;
    let failed = value["outcome"] == "failed";
    let state_failed = value["state"] == "failed";
    let attention = value["attentionReason"]["kind"] == "failed";
    if !startup && !failed && !state_failed && !attention {
        return None;
    }
    // error can also describe input/worker errors. Only use it with explicit failure
    // evidence, and prefer the versioned completion diagnostic for a settled run.
    let candidates = if startup {
        [
            ("Startup error", &value["error"]),
            (
                "Completion reason",
                if failed {
                    &value["outcomeReason"]
                } else {
                    &Value::Null
                },
            ),
            (
                "Failure attention detail",
                if attention {
                    &value["attentionReason"]["detail"]
                } else {
                    &Value::Null
                },
            ),
        ]
    } else {
        [
            (
                "Completion reason",
                if failed {
                    &value["outcomeReason"]
                } else {
                    &Value::Null
                },
            ),
            (
                "Chat error",
                if state_failed || failed {
                    &value["error"]
                } else {
                    &Value::Null
                },
            ),
            (
                "Failure attention detail",
                if attention {
                    &value["attentionReason"]["detail"]
                } else {
                    &Value::Null
                },
            ),
        ]
    };
    let (source, raw) = candidates
        .into_iter()
        .find_map(|(source, v)| detail(v).map(|s| (source, s)))
        .unwrap_or(("No public detail", MISSING));
    let mut end = raw.len().min(DETAIL_CAP);
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    let truncated = end < raw.len();
    // Preserve newlines, tabs and Unicode. No Markdown, links or executable content.
    let reason: String = raw[..end]
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
        .collect();
    let reason = if reason.trim().is_empty() {
        MISSING.into()
    } else {
        reason
    };
    let at = (failed || startup)
        .then(|| time(&value["outcomeAt"]))
        .flatten();
    let active = value["attempts"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["active"] == true));
    let attempt = active
        .and_then(|a| a["id"].as_str())
        .filter(|id| crate::local_model::valid_id(id))
        .map(str::to_owned);
    let older_attempt = active
        .and_then(|a| time(&a["createdAt"]))
        .zip(at)
        .is_some_and(|(start, end)| end < start);
    Some(Failure {
        reason,
        source,
        at,
        attempt,
        startup,
        historical: value["archivedAt"].is_number()
            || value["working"] == true
            || matches!(value["state"].as_str(), Some("working" | "starting"))
            || older_attempt,
        truncated,
    })
}

/// A new observed run must not resurrect the same old completion after run_end.
/// No run ID is exposed by SessionCompletion, so never claim an exact run identity.
#[derive(Default)]
pub(crate) struct Fence {
    scope: Option<(String, u64)>,
    run: u64,
    previous: Option<Failure>,
    superseded: Option<Failure>,
}
impl Fence {
    pub(crate) fn observe(
        &mut self,
        chat: &str,
        generation: u64,
        run: u64,
        busy: bool,
        failure: Option<&Failure>,
    ) {
        if self.scope.as_ref() != Some(&(chat.to_owned(), generation)) {
            *self = Self {
                scope: Some((chat.to_owned(), generation)),
                run,
                ..Default::default()
            };
        }
        if run != self.run || busy {
            self.superseded = self.previous.clone();
        }
        self.run = run;
        if let Some(failure) = failure {
            self.previous = Some(failure.clone());
        }
    }
    pub(crate) fn historical(&self, failure: &Failure) -> bool {
        failure.historical
            || self.superseded.as_ref().is_some_and(|old| {
                old.at == failure.at
                    && old.reason == failure.reason
                    && old.attempt == failure.attempt
                    && old.startup == failure.startup
            })
    }
}

#[cfg(test)]
#[path = "session_failure_tests.rs"]
mod tests;

//! One-shot Local conversion intent. This is NOT a daemon idempotency key.
//! Transport must persist Unknown before its sole POST, never replay on recovery.
use crate::delivery_store::{Failure, token};
use serde::{Deserialize, Serialize};

/// ECMAScript TrimString: WhiteSpace + LineTerminator, not Rust White_Space.
/// Mirrors the daemon's missions.ts text() normalization. FEFF is removed;
/// U+0085 (NEXT LINE) is deliberately retained. See ECMA-262 12.2/12.3.
pub(crate) fn trim_text(value: &str) -> &str {
    value.trim_matches(|ch| {
        matches!(ch,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) source: String,
    pub(crate) project: String,
    pub(crate) generation: u64,
}

pub(crate) enum Action {
    Inspect,
    Submit { id: String, request: Request },
    Check,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Inspection {
    Pending,
    Ready { title: String },
    Created { mission_id: String },
    Membership { mission_id: Option<String> },
    Uncertain,
}

#[derive(Clone)]
pub(crate) struct Reply {
    pub(crate) target: Target,
    pub(crate) request: u64,
    pub(crate) result: Result<Inspection, Failure>,
}

/// Live, source/attempt-qualified 201 evidence, independent of private-file I/O
/// and transient form replies. Not a durable receipt or drafting acknowledgement.
#[derive(Clone)]
pub(crate) struct Receipt {
    pub(crate) attempt_id: String,
    pub(crate) project_id: String,
    pub(crate) mission_id: String,
}
impl Receipt {
    pub(crate) fn matches(&self, attempt: &Attempt) -> bool {
        self.attempt_id == attempt.id && self.project_id == attempt.request.project_id
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub(crate) project_id: String,
    pub(crate) from_session_id: String,
    pub(crate) title: String,
    pub(crate) goal: String,
    pub(crate) coordinator: bool,
    pub(crate) draft: bool,
}
impl Request {
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        self.validate_bounds()?;
        if trim_text(&self.title).is_empty() {
            return Err("Mission title must contain 1–200 UTF-16 units");
        }
        Ok(())
    }
    fn validate_retained(&self) -> Result<(), Failure> {
        self.validate_bounds()?;
        // Read-only compatibility with the previous pinned Rust trim validator:
        // an already-recorded BOM-only Unknown must remain visible/non-replayable,
        // not fence every draft on reopen. This NEVER authorizes a new attempt.
        if trim_text(&self.title).is_empty() && self.title.trim().is_empty() {
            return Err("Mission title must contain 1–200 UTF-16 units");
        }
        Ok(())
    }
    fn validate_bounds(&self) -> Result<(), Failure> {
        if !token(&self.project_id) || !token(&self.from_session_id) {
            return Err("An exact Local chat and project are required");
        }
        // Match daemon text limits (JavaScript UTF-16), not bytes/scalars.
        if self.title.encode_utf16().count() > 200 {
            return Err("Mission title must contain 1–200 UTF-16 units");
        }
        if self.goal.encode_utf16().count() > 4_000
            || self.title.len() > 4 * 200 + 1_024
            || self.goal.len() > 4 * 4_000 + 1_024
        {
            return Err("Mission goal exceeds its bounded text limit");
        }
        Ok(())
    }
}

#[cfg(test)]
mod whitespace_tests {
    use super::*;
    #[test]
    fn every_unicode_scalar_matches_the_independent_ecmascript_trim_oracle() {
        let oracle: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/ecmascript-trim.json")).unwrap();
        let points: Vec<u32> = oracle["trimmedCodePoints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u32)
            .collect();
        assert_eq!(points.len(), 25);
        assert!(points.windows(2).all(|p| p[0] < p[1]));
        for codepoint in 0..=0x10ffff {
            if let Some(ch) = char::from_u32(codepoint) {
                let mut bytes = [0; 4];
                assert_eq!(
                    trim_text(ch.encode_utf8(&mut bytes)).is_empty(),
                    points.binary_search(&codepoint).is_ok(),
                    "U+{codepoint:04X}"
                );
            }
        }
        for case in oracle["cases"].as_array().unwrap() {
            assert_eq!(
                trim_text(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Outcome {
    Unknown,
    /// A validated 201 receipt. Does not claim drafting/message delivery.
    Created {
        mission_id: String,
    },
    /// Only a known guarded pre-commit refusal can settle as rejected.
    Rejected,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attempt {
    pub(crate) id: String,
    pub(crate) request: Request,
    pub(crate) outcome: Outcome,
}
impl Attempt {
    pub(crate) fn validate(&self, source: &str) -> Result<(), Failure> {
        self.request.validate_retained()?;
        if source != self.request.from_session_id || !token(&self.id) {
            return Err("Mission attempt source/identity is corrupt");
        }
        if let Outcome::Created { mission_id } = &self.outcome
            && !token(mission_id)
        {
            return Err("Mission receipt identity is corrupt");
        }
        Ok(())
    }
}

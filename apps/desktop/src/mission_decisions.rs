//! Passive projection of the existing mission detail. The only write is the separate,
//! user-confirmed withdrawal resolution in `mission_decision_resolve`.
use serde_json::Value;
use std::collections::HashSet;

pub(crate) const ITEM_CAP: usize = 128;
#[derive(Clone, Debug)]
pub(crate) struct Text {
    pub(crate) value: String,
    pub(crate) clipped: bool,
}
/// Explicit, durable retirement. Absent means active guidance.
#[derive(Clone, Debug)]
pub(crate) enum Retired {
    /// Successor identity only. Its text is read from its own row, never invented.
    Replaced { id: String, number: u64 },
    /// User-accepted withdrawal.
    Withdrawn { reason: Text, proposal: String },
}
#[derive(Clone, Debug)]
pub(crate) struct Decision {
    pub(crate) id: String,
    pub(crate) number: u64,
    pub(crate) audience: &'static str,
    pub(crate) text: Text,
    pub(crate) retired: Option<Retired>,
}
impl Decision {
    pub(crate) fn active(&self) -> bool {
        self.retired.is_none()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Edit,
    /// Hard removal. User-only, never a withdrawal.
    Remove,
    /// Retires guidance while keeping its text and history.
    Withdraw,
}
#[derive(Clone, Debug)]
pub(crate) struct Proposal {
    pub(crate) id: String,
    pub(crate) target: String,
    pub(crate) kind: Kind,
    /// Coordinator retry identity. Display only; never a replay key here.
    pub(crate) operation: Option<String>,
    pub(crate) text: Option<Text>,
    pub(crate) reason: Text,
}
#[derive(Clone, Debug)]
pub(crate) struct Section<T> {
    // None is absent, never a known-empty collection.
    pub(crate) rows: Option<Vec<T>>,
    pub(crate) received: usize,
    pub(crate) capped: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub(crate) decisions: Section<Decision>,
    pub(crate) proposals: Section<Proposal>,
}
fn identifier(v: &Value) -> Result<String, &'static str> {
    v.as_str()
        .filter(|s| crate::local_model::valid_id(s))
        .map(str::to_owned)
        .ok_or("Invalid decision or proposal identity.")
}
fn text(v: &Value) -> Result<Text, &'static str> {
    let s = v
        .as_str()
        .ok_or("Decision text is unavailable or malformed.")?;
    Ok(Text {
        value: s.into(),
        clipped: false,
    })
}
fn number(v: &Value) -> Result<u64, &'static str> {
    v.as_u64()
        .filter(|n| *n > 0 && *n <= 1_000_000_000)
        .ok_or("Invalid decision number.")
}
fn time(v: &Value) -> Result<(), &'static str> {
    v.as_f64()
        .filter(|t| t.is_finite() && *t >= 0.)
        .map(|_| ())
        .ok_or("Invalid decision lifecycle time.")
}
fn retired(d: &Value) -> Result<Option<Retired>, &'static str> {
    // Legacy rows omit both. A present field must be well formed, never a guess.
    let replaced = match d.get("replacement") {
        None => None,
        Some(r) => {
            time(&r["at"])?;
            Some(Retired::Replaced {
                id: identifier(&r["id"])?,
                number: number(&r["number"])?,
            })
        }
    };
    let withdrawn = match d.get("withdrawn") {
        None => None,
        Some(w) => {
            time(&w["at"])?;
            Some(Retired::Withdrawn {
                reason: text(&w["reason"])?,
                proposal: identifier(&w["proposalId"])?,
            })
        }
    };
    match (replaced, withdrawn) {
        (Some(_), Some(_)) => Err("Decision is both replaced and withdrawn."),
        (r, w) => Ok(r.or(w)),
    }
}
fn section<T>(
    v: Option<&Value>,
    mut parse: impl FnMut(&Value) -> Result<Option<T>, &'static str>,
) -> Result<Section<T>, &'static str> {
    let Some(v) = v else {
        return Ok(Section {
            rows: None,
            received: 0,
            capped: false,
        });
    };
    let raw = v
        .as_array()
        .ok_or("Decision collection is malformed, not empty.")?;
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for item in raw.iter().take(ITEM_CAP) {
        if !seen.insert(identifier(&item["id"])?) {
            return Err("Duplicate decision or proposal identity.");
        }
        if let Some(item) = parse(item)? {
            rows.push(item);
        }
    }
    Ok(Section {
        rows: Some(rows),
        received: raw.len(),
        capped: raw.len() > ITEM_CAP,
    })
}
pub(crate) fn project(v: &Value) -> Result<Snapshot, &'static str> {
    let decisions = section(v.get("decisions"), |d| {
        Ok(Some(Decision {
            id: identifier(&d["id"])?,
            number: number(&d["number"])?,
            audience: match d["audience"].as_str() {
                Some("all") => "All chats",
                Some("coordinator") => "Coordinator only",
                Some("reference") => "Reference",
                None if d.get("audience").is_none() => "Unknown (not supplied)",
                _ => return Err("Unsupported decision audience."),
            },
            text: text(&d["text"])?,
            retired: retired(d)?,
        }))
    })?;
    for d in decisions.rows.iter().flatten() {
        if let Some(Retired::Replaced { id, number }) = &d.retired {
            // A listed successor must agree with its own row; a missing one stays unknown.
            let rows = decisions.rows.iter().flatten();
            if id == &d.id || rows.into_iter().any(|s| &s.id == id && s.number != *number) {
                return Err("Decision replacement does not match its successor.");
            }
        }
    }
    let proposals = section(v.get("decisionProposals"), |p| {
        match p["status"].as_str() {
            Some("accepted" | "rejected") => return Ok(None),
            Some("pending") => {}
            _ => return Err("Unsupported proposal status; pending coverage is unknown."),
        }
        let kind = match p["kind"].as_str() {
            Some("edit") => Kind::Edit,
            Some("remove") => Kind::Remove,
            Some("withdraw") => Kind::Withdraw,
            _ => return Err("Unsupported decision proposal kind."),
        };
        let operation = match p.get("operationId") {
            None => None,
            Some(o) => Some(
                o.as_str()
                    .filter(|s| !s.is_empty() && s.chars().count() <= 128)
                    .ok_or("Invalid proposal operation ID.")?
                    .to_owned(),
            ),
        };
        let proposed = p.get("text").map(text).transpose()?;
        if kind == Kind::Withdraw && proposed.is_some() {
            return Err("A withdrawal proposal has no replacement text.");
        }
        Ok(Some(Proposal {
            id: identifier(&p["id"])?,
            target: identifier(&p["decisionId"])?,
            kind,
            operation,
            text: proposed,
            reason: text(&p["reason"])?,
        }))
    })?;
    Ok(Snapshot {
        decisions,
        proposals,
    })
}

#[cfg(test)]
#[path = "mission_decisions_tests.rs"]
mod tests;

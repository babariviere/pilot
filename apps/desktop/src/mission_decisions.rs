//! Passive projection of the existing mission detail. No authority or write contract.
use serde_json::Value;
use std::collections::HashSet;

pub(crate) const ITEM_CAP: usize = 128;
#[derive(Clone, Debug)]
pub(crate) struct Text {
    pub(crate) value: String,
    pub(crate) clipped: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct Decision {
    pub(crate) id: String,
    pub(crate) number: u64,
    pub(crate) audience: &'static str,
    pub(crate) text: Text,
}
#[derive(Clone, Debug)]
pub(crate) struct Proposal {
    pub(crate) id: String,
    pub(crate) target: String,
    pub(crate) kind: &'static str,
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
            number: d["number"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 1_000_000_000)
                .ok_or("Invalid decision number.")?,
            audience: match d["audience"].as_str() {
                Some("all") => "All chats",
                Some("coordinator") => "Coordinator only",
                Some("reference") => "Reference",
                None if d.get("audience").is_none() => "Unknown (not supplied)",
                _ => return Err("Unsupported decision audience."),
            },
            text: text(&d["text"])?,
        }))
    })?;
    let proposals = section(v.get("decisionProposals"), |p| {
        match p["status"].as_str() {
            Some("accepted" | "rejected") => return Ok(None),
            Some("pending") => {}
            _ => return Err("Unsupported proposal status; pending coverage is unknown."),
        }
        Ok(Some(Proposal {
            id: identifier(&p["id"])?,
            target: identifier(&p["decisionId"])?,
            kind: match p["kind"].as_str() {
                Some("edit") => "Edit",
                Some("remove") => "Remove",
                _ => return Err("Unsupported decision proposal kind."),
            },
            text: p.get("text").map(text).transpose()?,
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

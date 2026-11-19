use super::{Error, MAX_SAFE, Owner, Transport, Value, bounded, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Reports,
    Findings,
}
impl Kind {
    fn route(self) -> &'static str {
        match self {
            Self::Reports => "reports",
            Self::Findings => "findings",
        }
    }

    fn record(self) -> &'static str {
        match self {
            Self::Reports => "report",
            Self::Findings => "finding",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Workspace {
    pub owner: Owner,
    revision: u64,
    state: String,
    activation: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(super) enum WorkspaceRead {
    Present(Workspace),
    Absent,
    Blocked,
    Unavailable,
}
impl WorkspaceRead {
    pub fn workspace(&self) -> Result<&Workspace, Error> {
        match self {
            Self::Present(w) => Ok(w),
            _ => Err(Error::Unavailable),
        }
    }
}

pub(super) async fn workspace(t: &Transport, hello: &Value) -> Result<WorkspaceRead, Error> {
    if hello["capabilities"]["insightsWorkspace"] != 2 {
        return Ok(WorkspaceRead::Unavailable);
    }
    let v = match t.get("/api/insights/workspace").await {
        Ok(v) => v,
        Err(Error::Identity) => return Err(Error::Identity),
        Err(_) => return Ok(WorkspaceRead::Unavailable),
    };
    if v["schemaVersion"] != 2 {
        return Err(Error::Invalid);
    }
    match (v["state"].as_str(), v.get("workspace")) {
        (Some("present"), Some(value)) => {
            let w: Workspace = serde_json::from_value(value.clone()).map_err(|_| Error::Invalid)?;
            w.owner.validate(&t.source)?;
            if !(1..=MAX_SAFE).contains(&w.revision)
                || !matches!(w.state.as_str(), "reserved" | "paused" | "revoked")
                || w.activation != "not_activated"
            {
                return Err(Error::Invalid);
            }
            Ok(WorkspaceRead::Present(w))
        }
        (Some("absent"), Some(Value::Null)) => Ok(WorkspaceRead::Absent),
        (Some("blocked"), Some(Value::Null)) => Ok(WorkspaceRead::Blocked),
        (Some("unavailable"), Some(Value::Null)) => Ok(WorkspaceRead::Unavailable),
        _ => Err(Error::Invalid),
    }
}

fn empty_page(unavailable: bool) -> Value {
    if unavailable {
        json!({"items":[],"nextCursor":null,"unavailable":true})
    } else {
        json!({"items":[],"nextCursor":null})
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Item {
    pub key: String,
    title: String,
    pub revision: u64,
    updated_at: u64,
    pub lifecycle: Option<String>,
}

impl Item {
    fn parse(v: &Value, title: Option<&Value>, kind: Kind) -> Result<Self, Error> {
        let item = Self {
            key: v["key"]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or(Error::Invalid)?
                .to_owned(),
            title: bounded(title.unwrap_or(&v["title"]), 4000)?.to_owned(),
            revision: v["revision"]
                .as_u64()
                .filter(|n| (1..=MAX_SAFE).contains(n))
                .ok_or(Error::Invalid)?,
            updated_at: v["updatedAt"]
                .as_u64()
                .filter(|n| *n <= MAX_SAFE)
                .ok_or(Error::Invalid)?,
            lifecycle: match (kind, v.get("lifecycle")) {
                (Kind::Reports, Some(Value::Null)) => None,
                (Kind::Findings, Some(Value::String(s)))
                    if matches!(
                        s.as_str(),
                        "proposed"
                            | "approved"
                            | "in_progress"
                            | "shipped"
                            | "verified"
                            | "dismissed"
                            | "deferred"
                    ) =>
                {
                    Some(s.clone())
                }
                _ => return Err(Error::Invalid),
            },
        };
        Ok(item)
    }
}

pub(super) async fn page(
    t: &Transport,
    scope: &WorkspaceRead,
    kind: Kind,
    cursor: u64,
) -> Result<Value, Error> {
    let w = match scope {
        WorkspaceRead::Present(w) => w,
        WorkspaceRead::Absent if cursor == 0 => return Ok(empty_page(false)),
        _ => return Ok(empty_page(true)),
    };
    let v = match t
        .get(&format!(
            "/api/insights/workspace/{}?cursor={cursor}",
            kind.route()
        ))
        .await
    {
        Ok(v) => v,
        Err(Error::Identity) => return Err(Error::Identity),
        Err(_) => return Ok(empty_page(true)),
    };
    if v["schemaVersion"] != 2 {
        return Err(Error::Invalid);
    }
    if v["state"] == "unavailable" && v["workspace"].is_null() {
        return Ok(empty_page(true));
    }
    if v["state"] != "available" || v["workspace"] != json!(w) {
        return Err(Error::Stale);
    }
    let rows = v["items"]
        .as_array()
        .filter(|rs| rs.len() <= 20)
        .ok_or(Error::Invalid)?;
    let items = rows
        .iter()
        .map(|r| Item::parse(r, None, kind))
        .collect::<Result<Vec<_>, _>>()?;
    if items
        .iter()
        .map(|item| &item.key)
        .collect::<BTreeSet<_>>()
        .len()
        != items.len()
    {
        return Err(Error::Invalid);
    }
    let next = match v.get("nextCursor") {
        Some(Value::Null) => None,
        Some(n) => Some(
            n.as_u64()
                .filter(|n| *n > cursor && *n <= MAX_SAFE && !items.is_empty())
                .ok_or(Error::Invalid)?,
        ),
        None => return Err(Error::Invalid),
    };
    Ok(json!({"items":items,"nextCursor":next}))
}

pub(super) struct Detail {
    pub item: Item,
    pub value: Value,
    pub legacy: bool,
}

fn list(value: &Value, max: usize) -> Result<&Vec<Value>, Error> {
    value
        .as_array()
        .filter(|a| a.len() <= max)
        .ok_or(Error::Invalid)
}

fn positive_entry(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| (1..=MAX_SAFE).contains(n))
}

fn checkpoint_position(checkpoint: &Value) -> Option<String> {
    let entry = positive_entry(&checkpoint["throughEntry"]);
    let before = positive_entry(&checkpoint["before"]);
    match (entry, before) {
        (Some(entry), Some(before)) => Some(format!(
            "Last entry sampled: {entry}. Next older page: before entry {before}."
        )),
        (Some(entry), None) => Some(format!("Last entry sampled: {entry}.")),
        (None, Some(before)) => Some(format!("Older history can continue before entry {before}.")),
        _ => None,
    }
}

/// Gaps can include model text or private runtime details. Keep the coverage
/// category, but never publish the raw string from these fields.
fn gap_text(gap: &Value) -> Result<&'static str, Error> {
    let text = bounded(gap, 2000)?;
    Ok(
        if text.starts_with("Bounded local sample") || text.starts_with("Reader receipt only") {
            "Only part of the source history was read."
        } else if text.starts_with("Artifact source/rendering") {
            "Artifacts, attachments, and private reasoning were not reviewed."
        } else if text.starts_with("Inventory is mutable") {
            "Chats could change during the review."
        } else if text.starts_with("Inventory has further pages") {
            "More source chats are available to review."
        } else if text.starts_with("Inventory unavailable/partial") {
            "The source chat list was incomplete or unavailable."
        } else if text.starts_with("Changed stream ") {
            "A chat's history changed. The report cannot confirm continuity."
        } else if text.starts_with("Truncated source ") {
            "Some source content was omitted by read limits."
        } else if text.starts_with("Unavailable source ")
            || text.starts_with("Unavailable/changed continuation ")
        {
            "Some source history was unavailable. The saved position was kept."
        } else if text.starts_with("Boundary-only probe ") {
            "A saved position was checked without advancing it."
        } else {
            "The report recorded additional limits on coverage."
        },
    )
}

fn diagnostic_entry(reference: &str, session: &str) -> Option<u64> {
    let (named_session, raw) = reference
        .strip_prefix("diagnostic-history:v1:")?
        .split_once(':')?;
    let n: u64 = raw.parse().ok()?;
    (named_session == session && (1..=MAX_SAFE).contains(&n) && n.to_string() == raw).then_some(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insights_report_projects_only_saved_positions_and_safe_gap_text() {
        let mut detail = json!({});
        report(&mut detail, &json!({
            "markdown":"Some text", "status":"partial", "findingKeys":[],
            "gaps":["Unavailable source OTHER-CHAT; private path /private/raw.",
                "Error: backend-private-diagnostic"],
            "checkpoints":[
                {"sessionId":"chat-a","streamId":"private-stream","before":3,"throughEntry":9,
                    "coverage":"partial","gaps":[]},
                {"sessionId":"chat-b","before":null,"throughEntry":null,"coverage":"unavailable","gaps":[]}
            ]
        })).unwrap();
        assert_eq!(
            detail["progress"],
            json!({"sources":2,"positionedSources":1,"unavailableSources":1})
        );
        assert_eq!(
            detail["evidence"][0]["position"],
            "Last entry sampled: 9. Next older page: before entry 3."
        );
        assert!(detail["evidence"][1].get("position").is_none());
        let wire = detail.to_string();
        for raw in [
            "OTHER-CHAT",
            "private-stream",
            "/private/raw",
            "backend-private-diagnostic",
        ] {
            assert!(!wire.contains(raw));
        }
    }

    #[test]
    fn insights_finding_cannot_attach_another_chats_excerpt() {
        let mut detail = json!({});
        finding(&mut detail, &json!({
            "draft":{"proposedChange":"Change","observation":"Seen","uncertainty":"Partial",
                "expectedBenefit":"Less repeated work","targets":[]},
            "evidence":[
                {"sessionId":"chat-a","ref":"diagnostic-history:v1:chat-a:7","classification":"observed","summary":"Kept"},
                {"sessionId":"chat-a","ref":"diagnostic-history:v1:chat-b:8","classification":"observed","summary":"Not kept"}
            ]
        })).unwrap();
        assert_eq!(
            detail["evidence"],
            json!([
                {"sessionId":"chat-a","label":"Reported observation","position":"Entry 7","excerpt":"Kept"}
            ])
        );
        assert!(!detail.to_string().contains("chat-b"));
    }
}

fn report(detail: &mut Value, row: &Value) -> Result<(), Error> {
    detail["markdown"] = json!(bounded(&row["markdown"], 64000)?);
    let mut gaps = Vec::new();
    let mut seen_gaps = BTreeSet::new();
    for gap in list(&row["gaps"], 20)? {
        let text = gap_text(gap)?;
        if seen_gaps.insert(text) {
            gaps.push(text);
        }
    }
    let mut links = Vec::new();
    let mut seen = BTreeSet::new();
    let mut positioned = 0;
    let mut unavailable = 0;
    for checkpoint in list(&row["checkpoints"], 20)? {
        let session = checkpoint["sessionId"]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or(Error::Invalid)?;
        let label = match checkpoint["coverage"].as_str() {
            Some("partial") => "Partially read chat",
            Some("sampled") => "Sampled chat",
            Some("unavailable") => "Unavailable chat",
            _ => return Err(Error::Invalid),
        };
        if seen.insert(session) {
            let mut evidence = json!({"sessionId":session,"label":label});
            if checkpoint["coverage"] == "unavailable" {
                unavailable += 1;
            }
            if let Some(position) = checkpoint_position(checkpoint) {
                positioned += 1;
                evidence["position"] = json!(position);
            }
            links.push(evidence);
        }
        for gap in list(&checkpoint["gaps"], 8)? {
            let text = gap_text(gap)?;
            if seen_gaps.insert(text) {
                gaps.push(text);
            }
        }
    }
    let coverage = match row["status"].as_str() {
        Some("completed") => {
            "Report finished for the sources reviewed. Coverage is limited to the chats and excerpts read."
        }
        Some("partial") => "This report reviewed only part of the available sources.",
        Some("interrupted") => {
            "The report was interrupted. Only the material read before it stopped is shown."
        }
        _ => return Err(Error::Invalid),
    };
    let finding_keys = list(&row["findingKeys"], 20)?
        .iter()
        .map(|id| id.as_str().filter(|s| valid_id(s)).ok_or(Error::Invalid))
        .collect::<Result<Vec<_>, _>>()?;
    detail["progress"] = json!({
        "sources":links.len(),"positionedSources":positioned,"unavailableSources":unavailable,
    });
    detail["evidence"] = json!(links);
    detail["coverage"] = json!(coverage);
    detail["gaps"] = json!(gaps);
    detail["findingKeys"] = json!(finding_keys);
    Ok(())
}

fn finding(detail: &mut Value, raw: &Value) -> Result<(), Error> {
    let row = &raw["draft"];
    let proposal = bounded(&row["proposedChange"], 16000)?;
    let observation = bounded(&row["observation"], 16000)?;
    let uncertainty = bounded(&row["uncertainty"], 16000)?;
    detail["proposal"] = json!(proposal);
    detail["markdown"] = json!(format!("{observation}\n\n{proposal}\n\n{uncertainty}"));
    detail["benefit"] = json!(bounded(&row["expectedBenefit"], 16000)?);
    let targets = list(&row["targets"], 20)?;
    // Multiple referenced projects do not authorize selecting one on behalf of the user.
    if let [target] = targets.as_slice() {
        let id = target["projectId"]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or(Error::Invalid)?;
        detail["projectId"] = json!(id);
    }
    let mut links = Vec::new();
    for ev in list(&raw["evidence"], 20)? {
        let session = ev["sessionId"]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or(Error::Invalid)?;
        let label = match ev["classification"].as_str() {
            Some("observed") => "Reported observation",
            Some("inferred") => "Reported inference",
            _ => return Err(Error::Invalid),
        };
        // Stored reports contain model-authored text, not a new source-history read.
        let reference = bounded(&ev["ref"], 2048)?;
        let position = diagnostic_entry(reference, session);
        if reference.starts_with("diagnostic-history:") && position.is_none() {
            // Do not pair a stored excerpt with a different chat's identifier.
            continue;
        }
        let text = bounded(&ev["summary"], 16000)?;
        let mut evidence = json!({"sessionId":session,"label":label,"excerpt":text});
        if let Some(entry) = position {
            evidence["position"] = json!(format!("Entry {entry}"));
        }
        links.push(evidence);
    }
    detail["evidence"] = json!(links);
    Ok(())
}

fn detail(v: &Value, kind: Kind, key: &str, legacy: bool) -> Result<Detail, Error> {
    if v["kind"] != kind.record() || v["key"] != key {
        return Err(Error::Invalid);
    }
    let raw: Value =
        serde_json::from_str(bounded(&v["request"], 65536)?).map_err(|_| Error::Invalid)?;
    let title = match (kind, raw["action"].as_str()) {
        (Kind::Reports, Some("save_report")) => &raw["record"]["windowEnd"],
        (Kind::Findings, Some("propose" | "amend")) => &raw["draft"]["title"],
        _ => return Err(Error::Invalid),
    };
    if raw["key"] != key {
        return Err(Error::Invalid);
    }
    let item = Item::parse(v, Some(title), kind)?;
    let mut value = json!(item);
    match kind {
        Kind::Reports => report(&mut value, &raw["record"])?,
        Kind::Findings => finding(&mut value, &raw)?,
    };
    let legacy = legacy || v["origin"]["kind"] == "legacy_snapshot";
    if legacy {
        value["legacy"] = json!(true);
    }
    Ok(Detail {
        item,
        value,
        legacy,
    })
}

pub(super) async fn read_item(t: &Transport, kind: Kind, key: &str) -> Result<Detail, Error> {
    detail(
        &t.get(&format!("/api/insights/workspace/{}/{key}", kind.route()))
            .await?,
        kind,
        key,
        false,
    )
}

/// Discovery returns the original selector's passive projection, never a grant.
pub(super) async fn legacy(t: &Transport, cursor: Option<&str>) -> Result<Value, Error> {
    let path = cursor.map_or_else(
        || "/api/insights/day/legacy".into(),
        |n| format!("/api/insights/day/legacy?cursor={n}"),
    );
    match t.get(&path).await {
        Ok(v) => legacy_page(&t.source, &v, cursor),
        Err(Error::Identity) => Err(Error::Identity),
        Err(_) => Ok(legacy_unavailable()),
    }
}

fn legacy_unavailable() -> Value {
    json!({"state":"unavailable","reports":[],"findings":[],"nextCursor":null})
}

fn legacy_page(source: &super::Source, v: &Value, cursor: Option<&str>) -> Result<Value, Error> {
    if v["schemaVersion"] != 1 {
        return Err(Error::Invalid);
    }
    if v["state"] == "unavailable" {
        return Ok(legacy_unavailable());
    }
    if v["state"] != "available" {
        return Err(Error::Invalid);
    }
    let mut reports = Vec::new();
    let mut findings = Vec::new();
    for entry in list(&v["items"], 1)? {
        let (kind, to) = match entry["kind"].as_str() {
            Some("report") => (Kind::Reports, &mut reports),
            Some("finding") => (Kind::Findings, &mut findings),
            _ => return Err(Error::Invalid),
        };
        let p = &entry["projection"];
        let selector = &p["selector"];
        if p["schemaVersion"] != 2
            || p["state"] != "available"
            || p["ownership"] != "legacy_mission"
            || selector["schemaVersion"] != 2
            || selector["expectedHome"] != super::home(source, "daemon")
            || !["projectId", "missionId", "reportSessionId"]
                .into_iter()
                .all(|k| selector[k].as_str().is_some_and(valid_id))
        {
            return Err(Error::Invalid);
        }
        for row in list(&p["items"], 20)? {
            let key = row["key"]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or(Error::Invalid)?;
            if row["kind"] != kind.record() {
                return Err(Error::Invalid);
            }
            let raw: Value = serde_json::from_str(bounded(&row["payload"], 65536)?)
                .map_err(|_| Error::Invalid)?;
            let title = match kind {
                Kind::Reports => &raw["windowEnd"],
                Kind::Findings => &raw["title"],
            };
            let item = Item::parse(
                &json!({
                    "key": key, "revision":row["revision"], "updatedAt":row["updated_at"], "lifecycle":row["lifecycle"]
                }),
                Some(title),
                kind,
            )?;
            let mut projected = json!(item);
            match kind {
                Kind::Reports => {
                    report(&mut projected, &raw)?;
                    // Old finding keys are local to the original mission, not current-workspace links.
                    projected
                        .as_object_mut()
                        .expect("item is an object")
                        .remove("findingKeys");
                }
                // The old passive projection carries a draft, not separate evidence rows.
                Kind::Findings => finding(&mut projected, &json!({"draft":raw,"evidence":[]}))?,
            }
            projected["key"] = json!(super::hash(
                &json!([selector, kind.record(), key]).to_string()
            ));
            projected["legacy"] = json!(true);
            to.push(projected);
        }
    }
    let next = match v.get("nextCursor") {
        Some(Value::Null) => None,
        Some(Value::String(n)) if super::valid_history_cursor(n) && cursor != Some(n) => Some(n),
        _ => return Err(Error::Invalid),
    };
    let more = next.is_some();
    let state = if !more && reports.is_empty() && findings.is_empty() {
        "empty"
    } else {
        "available"
    };
    Ok(json!({"state":state,"reports":reports,"findings":findings,"more":more,"nextCursor":next}))
}

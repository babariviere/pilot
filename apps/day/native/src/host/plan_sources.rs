//! Passive map drilldown. Reuse canonical planning, Decision and Knowledge reads.
//! No cache, ledger, write, navigation effect or generic transport enters the VM.
use super::{Error, Transport, valid_id};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Request {
    pub mission_id: String,
    pub plan_revision: u32,
    pub area: String,
    pub record_id: String,
    pub kind: String,
    pub id: String,
}
impl Request {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if !valid_id(&self.mission_id)
            || !valid_id(&self.record_id)
            || !valid_id(&self.id)
            || self.plan_revision == 0
            || !matches!(self.area.as_str(), "item" | "fog")
            || !matches!(self.kind.as_str(), "decision" | "knowledge")
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

/// Resolve from the exact displayed map, never a label or an arbitrary canonical id.
fn citation<'a>(read: &'a Value, r: &Request) -> Result<(&'a Value, &'a Value), Error> {
    if read["status"] != "available" || read["view"]["plan"]["revision"] != r.plan_revision {
        return Err(Error::Stale);
    }
    let (records, maps) = if r.area == "item" {
        ("questions", "items")
    } else {
        ("fog", "fog")
    };
    let record = array(&read["view"]["plan"][records])
        .iter()
        .find(|q| q["id"] == r.record_id)
        .ok_or(Error::Stale)?;
    let map = array(&read["view"]["map"][maps])
        .iter()
        .find(|q| q["id"] == r.record_id)
        .ok_or(Error::Stale)?;
    let is_source = |s: &&Value| s["kind"] == r.kind && s["id"] == r.id;
    let source = array(&record["sources"])
        .iter()
        .find(is_source)
        .or_else(|| {
            (r.area == "item"
                && r.kind == "decision"
                && record["resolution"]["kind"] == r.kind
                && record["resolution"]["id"] == r.id)
                .then_some(&record["resolution"])
        })
        .ok_or(Error::Stale)?;
    let mapped = array(&map["sources"])
        .iter()
        .find(is_source)
        .or_else(|| {
            (map["settledBy"]["kind"] == r.kind && map["settledBy"]["id"] == r.id)
                .then_some(&map["settledBy"])
        })
        .ok_or(Error::Stale)?;
    Ok((source, mapped))
}

pub(super) async fn read(t: &Transport, r: &Request) -> Result<Value, Error> {
    r.validate()?;
    t.gate(false).await?;
    let before = t.planning(&r.mission_id).await?;
    let (source, mapped) = citation(&before, r)?;
    let mut provenance = vec![format!(
        "Mission {} · map revision {} · {} {}",
        r.mission_id, r.plan_revision, r.area, r.record_id
    )];
    let mut history = Vec::new();
    let mut knowledge_link = None;
    let (title, body, currentness, check) = if r.kind == "decision" {
        let detail = t.get(&format!("/api/missions/{}", r.mission_id)).await?;
        if detail["mission"]["id"] != r.mission_id
            || detail["mission"]["projectId"] != t.source.project_id
        {
            return Err(Error::Identity);
        }
        let d = array(&detail["decisions"])
            .iter()
            .find(|d| d["id"] == r.id)
            .ok_or(Error::Unavailable)?;
        if !d["text"].is_string() {
            return Err(Error::Invalid);
        }
        provenance.push(format!(
            "Decision {} · {} · created {} · updated {}",
            d["number"],
            d["authorSessionId"]
                .as_str()
                .map_or("user".to_owned(), |s| format!("session {s}")),
            d["createdAt"],
            d["updatedAt"]
        ));
        provenance.push(format!(
            "Audience: {} · cited digest: {}",
            text(&d["audience"]),
            text(&source["digest"])
        ));
        if d["replacement"].is_object() {
            history.push(format!("Replaced by Decision {} ({}) at {}. This original record is history, not active guidance.", d["replacement"]["number"], text(&d["replacement"]["id"]), d["replacement"]["at"]));
        }
        if d["withdrawn"].is_object() {
            history.push(format!(
                "Withdrawn at {}: {}",
                d["withdrawn"]["at"],
                text(&d["withdrawn"]["reason"])
            ));
        }
        let current = mapped["state"] == "current"
            && !d["replacement"].is_object()
            && !d["withdrawn"].is_object();
        if !current {
            history.push("The cited decision changed or is no longer active. Showing the original record as it is saved now, not reconstructing earlier text.".into());
        }
        (
            format!("Decision {}", d["number"]),
            text(&d["text"]).to_owned(),
            if current { "current" } else { "stale" },
            String::new(),
        )
    } else {
        // An unlinked/deleted entry is unavailable, never an empty or accepted finding.
        // The map's Knowledge summary is limited to 40 entries. It is not a
        // complete link inventory or an access check for an older cited entry.
        let link = link(t, r).await?;
        if link["linked"] != true {
            return Err(Error::Unavailable);
        }
        let revision = source["revision"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or(Error::Invalid)?;
        let d = t
            .get(&format!(
                "/api/projects/{}/knowledge/{}?revision={revision}",
                t.source.project_id, r.id
            ))
            .await?;
        if d["entry"]["id"] != r.id
            || d["entry"]["projectId"] != t.source.project_id
            || d["revision"]["knowledgeId"] != r.id
            || d["revision"]["revision"] != revision
            || !d["revision"]["body"].is_string()
        {
            return Err(Error::Invalid);
        }
        provenance.push(format!(
            "Knowledge {} · cited revision {revision} · latest revision {}",
            r.id, d["entry"]["revision"]
        ));
        provenance.push(format!(
            "Mission link revision {} · cited link revision {}",
            link["linkRevision"], source["linkRevision"]
        ));
        provenance.push(format!(
            "Recorded at {} · author {}",
            d["revision"]["recordedAt"], d["revision"]["author"]
        ));
        provenance.push(format!("Origin: {}", d["entry"]["origin"]));
        for s in array(&d["revision"]["sources"]) {
            provenance.push(s.to_string());
        }
        if let Some(reason) = d["revision"]["reason"].as_str() {
            history.push(format!("Revision reason: {reason}"));
        }
        let current =
            d["entry"]["revision"] == revision && link["linkRevision"] == source["linkRevision"];
        knowledge_link = Some(link);
        if !current {
            history.push("This is the exact cited revision, kept as history. The entry or its mission link changed since.".into());
        }
        let check = match d["freshness"]["state"].as_str() {
            Some("checked") => format!(
                "Checked for this revision, not proof or acceptance. Coverage: {}",
                text(&d["freshness"]["checked"]["coverage"])
            ),
            Some("needs_check") => "Needs checking. Reading does not check this finding.".into(),
            _ => "Not checked. Reading does not accept this finding.".into(),
        };
        (
            text(&d["revision"]["title"]).to_owned(),
            text(&d["revision"]["body"]).to_owned(),
            if current { "current" } else { "stale" },
            check,
        )
    };
    // Reuse the native planning service's durable membership/project/owner fence.
    // Content is never returned after a scope or source changes while I/O is entered.
    if let Some(before) = knowledge_link {
        if link(t, r).await? != before {
            return Err(Error::Stale);
        }
    }
    t.gate(false).await?;
    let after = t.planning(&r.mission_id).await?;
    citation(&after, r)?;
    if before != after {
        return Err(Error::Stale);
    }
    Ok(
        json!({"missionId":r.mission_id,"planRevision":r.plan_revision,"area":r.area,
        "recordId":r.record_id,"kind":r.kind,"id":r.id,"title":title,"body":body,
        "currentness":currentness,"check":check,"provenance":provenance,"history":history}),
    )
}

async fn link(t: &Transport, r: &Request) -> Result<Value, Error> {
    let value = t
        .get(&format!(
            "/api/missions/{}/knowledge/{}",
            r.mission_id, r.id
        ))
        .await?;
    if value["missionId"] != r.mission_id
        || value["knowledgeId"] != r.id
        || !value["linked"].is_boolean()
        || !value["linkRevision"].is_u64()
    {
        return Err(Error::Invalid);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_map_references_resolve() {
        let mut r: Request = serde_json::from_value(json!({"missionId":"m","planRevision":2,"area":"item","recordId":"q","kind":"knowledge","id":"k"})).unwrap();
        let read = json!({"status":"available","view":{"plan":{"revision":2,"questions":[{"id":"q","sources":[{"kind":"knowledge","id":"k","revision":1,"linkRevision":1}]}]},"map":{"items":[{"id":"q","sources":[{"kind":"knowledge","id":"k"}]}]}}});
        assert_eq!(citation(&read, &r).unwrap().0["revision"], 1);
        r.id = "other".into();
        assert!(citation(&read, &r).is_err());
        r.id = "k".into();
        r.plan_revision = 3;
        assert!(citation(&read, &r).is_err());
        r.area = "../knowledge".into();
        assert!(r.validate().is_err());
    }
}

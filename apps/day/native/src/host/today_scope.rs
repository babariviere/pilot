//! Passive Today reads across the authenticated profile's configured projects.
//! A temporary transport view shares the existing client/identity, never a host,
//! worker, model selection or admission. It cannot change New or the root source.
use super::{Error, Journal, Shared, Source, Transport, attention, intake, new_chat, valid_id};
use crate::{
    attention_host,
    bridge::Gate,
    contract::DayOverview,
    desk::Desk,
    model::{FreshnessState, Today},
    plan::{PlanAvailability, Planning},
    plan_host,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, atomic::Ordering};

#[cfg(test)]
fn selected_transport(t: &Transport, project: &Value) -> Result<Transport, Error> {
    t.for_project(project)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub scope: String,
    pub generation: u64,
}
impl Request {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if !valid_id(&self.scope) || self.generation == 0 || self.generation > 9_007_199_254_740_991
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    /// Called synchronously at enqueue: a later choice fences entered reads too.
    pub(crate) fn select(&self, gate: &mut Gate) -> Result<(), Error> {
        self.validate()?;
        if gate
            .today_scope
            .as_ref()
            .is_some_and(|(n, _)| *n >= self.generation)
        {
            return Err(Error::Stale);
        }
        gate.today_scope = Some((self.generation, self.scope.clone()));
        Ok(())
    }
    fn current(&self, gate: &Gate) -> Result<(), Error> {
        if gate.closed || gate.sealed {
            return Err(Error::Closed);
        }
        if gate.today_scope.as_ref() != Some(&(self.generation, self.scope.clone())) {
            return Err(Error::Stale);
        }
        Ok(())
    }
    fn includes(&self, id: &str) -> bool {
        self.scope == "all" || self.scope == id
    }
}

fn same_project(a: &Source, b: &Source) -> bool {
    a.profile == b.profile
        && a.home == b.home
        && a.project
            .as_ref()
            .zip(b.project.as_ref())
            .is_some_and(|(a, b)| a.project_id == b.project_id)
}

fn scoped_attention(mut read: Value, project: &str, live: bool) -> Result<Value, Error> {
    for q in read["questions"].as_array().ok_or(Error::Invalid)? {
        if q["scope"]["projectId"] != project
            || q["scope"]["subject"]["sessionId"] != q["session"]["id"]
        {
            return Err(Error::Identity);
        }
        if attention_host::question_key(q).is_none() {
            return Err(Error::Invalid);
        }
    }
    for action in read["actions"].as_array().ok_or(Error::Invalid)? {
        if action["record"]["content"]["projectId"] != project {
            return Err(Error::Identity);
        }
        if attention_host::action_key(action).is_none() {
            return Err(Error::Invalid);
        }
    }
    read["current"] = json!(live);
    read["canOpenUrl"] = json!(false);
    Ok(read)
}

fn projection(
    t: &Transport,
    journal: &Journal,
    overview: Option<&DayOverview>,
    read: Option<&Value>,
    live: bool,
) -> Today {
    let mut desk = Desk::native();
    if let Some(overview) = overview {
        desk.set_now(overview.observed_at);
        desk.native_read(overview.clone(), Vec::new());
        if !live {
            desk.lose_read(
                FreshnessState::Stale,
                "The update stream is disconnected. Read again.",
            );
        }
    }
    let mut today = desk.today().clone();
    let missions = today
        .moving
        .iter()
        .chain(&today.not_moving)
        .chain(&today.unreported)
        .map(|m| (m.id.clone(), m.title.clone()))
        .collect::<Vec<_>>();
    let ops = journal
        .attention
        .values()
        .filter(|r| same_project(&r.source, &t.source))
        .map(|r| r.summary())
        .collect::<Vec<_>>();
    let drafts = journal
        .attention_drafts
        .values()
        .filter(|r| same_project(&r.source, &t.source))
        .map(|r| (r.key.clone(), r.value.clone()))
        .collect::<Vec<_>>();
    let view = attention_host::project(
        read,
        &ops,
        &drafts,
        &missions,
        &attention_host::Local::default(),
    );
    today.decisions = view.decisions;
    today.actions = view.actions;
    today.attention = view.attention;
    today
}

/// Count the actual cards plus distinct host problems. A host ask for the same
/// chat is the question card, not a second need. Other failures stay separate.
fn count(
    overview: Option<&DayOverview>,
    read: Option<&Value>,
    today: &Today,
    live: bool,
) -> Option<usize> {
    let overview = overview?;
    let read = read?;
    let section = overview.dashboard.needs_you.as_ref()?;
    if !live || section.total as usize != section.items.len() || read["current"] != true {
        return None;
    }
    let problems = section
        .items
        .iter()
        .filter(|p| {
            p.kind != "unread"
                && p.counts_in_badge != Some(false)
                && !(p.attention_reason.kind == "asks"
                    && read["questions"].as_array().is_some_and(|qs| {
                        qs.iter().any(|q| {
                            p.session_id
                                .as_deref()
                                .is_some_and(|id| q["session"]["id"] == id)
                        })
                    }))
        })
        .count();
    Some(today.decisions.len() + today.actions.len() + problems)
}

fn needs(count: Option<usize>) -> Value {
    json!({"count":count,"complete":count.is_some()})
}

fn outside(rows: &[Value]) -> Value {
    let count = rows
        .iter()
        .filter(|r| r["selected"] == false)
        .try_fold(0u64, |sum, r| {
            r["needsYou"]["count"]
                .as_u64()
                .and_then(|n| sum.checked_add(n))
        });
    json!({"count":count,"complete":count.is_some()})
}

fn label_rows(value: &mut Value, key: &str, project: &Value) {
    if let Some(rows) = value.get_mut(key).and_then(Value::as_array_mut) {
        for row in rows.iter_mut().filter(|row| row.is_object()) {
            row["projectId"] = project["projectId"].clone();
            row["projectName"] = project["name"].clone();
        }
    }
}

fn label_sections(row: &mut Value, project: &Value) {
    for key in [
        "decisions",
        "actions",
        "problems",
        "moving",
        "notMoving",
        "unreported",
        "done",
        "comingUp",
    ] {
        label_rows(&mut row["today"], key, project);
    }
    if let Some(intake) = row["today"].get_mut("intake") {
        label_rows(intake, "requests", project);
    }
    label_rows(&mut row["planning"], "plans", project);
    for key in ["intake", "later", "discarded", "claimed"] {
        if let Some(intake) = row["intake"].get_mut(key) {
            label_rows(intake, "requests", project);
        }
    }
    label_rows(&mut row["results"], "items", project);
}

/// Keep saved checks/starts even when automatic discovery is unavailable.
async fn results(t: &Transport, journal: &Journal) -> Value {
    let mut subjects = std::collections::BTreeMap::new();
    let mut uncertain = std::collections::BTreeSet::new();
    for r in journal
        .planning
        .values()
        .filter(|r| r.source.profile == t.source.profile && r.source.home == t.source.home)
    {
        let p: Value = serde_json::from_str(r.operation["payload"].as_str().unwrap_or(""))
            .unwrap_or(Value::Null);
        let subject = match r.operation["kind"].as_str() {
            Some("user-verification") => p["subject"].clone(),
            Some("intake-start" | "native-chat-create")
                if r.receipt.as_ref().is_some_and(|r| r["state"] == "accepted") =>
            {
                // New's explicit project is part of the saved effect, not the
                // window source (which may be global or another project).
                json!({"kind":"chat","projectId":p["projectId"],"sessionId":r.receipt.as_ref().map(|r| &r["result"]["sessionId"])})
            }
            _ => continue,
        };
        if let Ok(s) = serde_json::from_value::<super::delivery::Subject>(subject.clone()) {
            if t.source
                .project
                .as_ref()
                .is_none_or(|p| s.project() != p.project_id)
            {
                continue;
            }
            if r.operation["kind"] == "user-verification" && r.pending() {
                uncertain.insert(subject.to_string());
            }
            subjects.insert(subject.to_string(), s);
        }
    }
    let mut items = Vec::new();
    // Same candidate limit as the existing delivery feed. No unbounded fanout.
    for subject in subjects.values().take(20) {
        let unsettled =
            serde_json::to_value(subject).is_ok_and(|s| uncertain.contains(&s.to_string()));
        let value = super::delivery::read(t, subject).await;
        items.push(match value {
            Ok(snapshot) => json!({"subject":subject,"snapshot":snapshot,"currentness":"live","unsettled":unsettled}),
            Err(error) => json!({"subject":subject,"snapshot":null,"currentness":"unavailable","unsettled":unsettled,"reason":error.to_string()}),
        });
    }
    let discovered = super::delivery::list(t, &super::delivery::List::default()).await;
    match discovered {
        Ok(v) => {
            for item in v["items"].as_array().into_iter().flatten() {
                if !items
                    .iter()
                    .any(|saved| saved["subject"] == item["subject"])
                {
                    items.push(json!({"subject":item["subject"],"title":item["title"],"snapshot":item["snapshot"],"currentness":v["currentness"]}));
                }
            }
            let complete = v["complete"] == true
                && subjects.len() <= 20
                && items.iter().all(|i| i["currentness"] == "live");
            json!({"complete":complete,"more":v["more"],"baseline":v["baseline"],"items":items,
                "reason":if complete {""} else {"More results may be available in missions. This list is incomplete."}})
        }
        Err(error) => {
            json!({"complete":false,"more":null,"items":items,"reason":format!("New deliveries could not be read: {error}. Saved checks and starts are kept.")})
        }
    }
}

pub(super) async fn read(
    t: &Transport,
    journal: &Journal,
    shared: &Shared,
    request: &Request,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    // Large profiles or an unresponsive project cannot hold the shared worker
    // indefinitely. A deadline refuses the read, never supplies empty counts.
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        read_inner(t, journal, shared, request, gate),
    )
    .await
    .map_err(|_| Error::Offline)?
}

async fn read_inner(
    t: &Transport,
    journal: &Journal,
    shared: &Shared,
    request: &Request,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    // Passive, so not fenced by the event epoch: under a busy stream every
    // read would be refused and the rows would flicker. The newest generation
    // still wins, and a later invalidation reads again.
    let check = || {
        shared.open()?;
        request.current(&gate.lock().expect("bridge gate poisoned"))
    };
    let mut value = read_projects(
        t,
        journal,
        request,
        shared.connected.load(Ordering::SeqCst),
        check,
    )
    .await?;
    // A global window acts on the one project the user chose here. The focus
    // stays when All projects is chosen again; it never sends anything.
    if t.source.project.is_none() && request.scope != "all" {
        let catalog = new_chat::inventory(t).await?;
        let project = catalog["projects"]
            .as_array()
            .and_then(|rows| rows.iter().find(|p| p["projectId"] == request.scope))
            .ok_or(Error::Stale)?;
        let path = project["projectPath"].as_str().ok_or(Error::Invalid)?;
        *shared.focus.lock().expect("native focus poisoned") = Some(super::Project {
            project_id: request.scope.clone(),
            project_path: path.into(),
        });
    }
    let own = match &t.source.project {
        Some(p) => Some(p.project_id.clone()),
        None => shared
            .focus
            .lock()
            .expect("native focus poisoned")
            .as_ref()
            .map(|p| p.project_id.clone()),
    };
    value["own"] = json!(own);
    for row in value["projects"].as_array().into_iter().flatten() {
        if let Some(errors) = row["errors"].as_object().filter(|e| !e.is_empty()) {
            crate::day_log::event(
                "scope.project_errors",
                json!({"project":row["id"],"name":row["name"],"errors":errors}),
            );
        }
    }
    Ok(value)
}

async fn read_projects(
    t: &Transport,
    journal: &Journal,
    request: &Request,
    live: bool,
    check: impl Fn() -> Result<(), Error>,
) -> Result<Value, Error> {
    check()?;
    let catalog = new_chat::inventory(t).await?;
    let projects = catalog["projects"].as_array().ok_or(Error::Invalid)?;
    if request.scope != "all" && !projects.iter().any(|p| p["projectId"] == request.scope) {
        return Err(Error::Invalid);
    }
    let mut rows = Vec::new();
    let mut bytes = 1024usize;
    // Serial on the existing worker. Scope never spawns another worker or daemon.
    for project in projects {
        check()?;
        let selected = request.includes(project["projectId"].as_str().ok_or(Error::Invalid)?);
        let pt = t.for_project(project)?;
        // Each canonical service performs its existing project/owner/access checks.
        let overview = async {
            pt.gate(false).await?;
            pt.overview().await
        }
        .await;
        let attention = attention::snapshot(&pt)
            .await
            .and_then(|v| scoped_attention(v, &pt.source.project()?.project_id, live));
        check()?;
        let today = projection(
            &pt,
            journal,
            overview.as_ref().ok(),
            attention.as_ref().ok(),
            live,
        );
        let planning = pt.planning_inventory().await.and_then(|v| {
            if v["projectId"] != pt.source.project()?.project_id {
                return Err(Error::Identity);
            }
            Ok(Planning {
                availability: if live {
                    PlanAvailability::Live
                } else {
                    PlanAvailability::Stale
                },
                plans: plan_host::inventory_rows(&v)?,
                ..Planning::default()
            })
        });
        check()?;
        let n = count(
            overview.as_ref().ok(),
            attention.as_ref().ok(),
            &today,
            live,
        )
        .zip(planning.as_ref().ok())
        .map(|(n, p)| n + p.plans.iter().filter(|p| p.needs_you).count());
        let mut row = json!({"id":project["projectId"],"name":project["name"],"selected":selected,
            "currentness":if n.is_some() {"live"} else if !live && overview.is_ok() {"stale"} else {"unavailable"},
            "observedAt":overview.as_ref().ok().map(|v| v.observed_at),"needsYou":needs(n),
            "today":null,"planning":null,"intake":null,"results":null,
            "canAct":false,"errors":{}});
        if let Err(error) = &overview {
            row["errors"]["today"] = json!(error.to_string());
        }
        if let Err(error) = &attention {
            row["errors"]["attention"] = json!(error.to_string());
        }
        if let Err(error) = &planning {
            row["errors"]["planning"] = json!(error.to_string());
        }
        let denied = matches!(overview, Err(Error::Identity))
            || matches!(attention, Err(Error::Identity))
            || matches!(planning, Err(Error::Identity));
        if selected && !denied {
            row["today"] = serde_json::to_value(today).map_err(|_| Error::Invalid)?;
            match planning {
                Ok(v) => row["planning"] = serde_json::to_value(v).map_err(|_| Error::Invalid)?,
                Err(_) => {}
            }
            match intake::read(&pt).await {
                Ok(v) => row["intake"] = v,
                Err(error) => row["errors"]["intake"] = json!(error.to_string()),
            }
            row["results"] = results(&pt, journal).await;
            if !live {
                for item in row["results"]["items"].as_array_mut().into_iter().flatten() {
                    item["currentness"] = json!("stale");
                }
            }
            label_sections(&mut row, project);
        }
        bytes =
            bytes.saturating_add(serde_json::to_vec(&row).map_err(|_| Error::Invalid)?.len() + 1);
        if bytes > crate::bridge::MAX_RESPONSE - 1024 {
            return Err(Error::Capacity);
        }
        rows.push(row);
    }
    // Project removal/configuration/permission changes during I/O cannot publish
    // the earlier selection. Inventory never selects models or creates a chat.
    if new_chat::inventory(t).await? != catalog {
        return Err(Error::Stale);
    }
    check()?;
    Ok(
        json!({"version":1,"scope":request.scope,"generation":request.generation,
        "catalogComplete":true,"complete":false,"outsideNeedsYou":outside(&rows),"projects":rows}),
    )
}

#[cfg(test)]
#[path = "today_scope_tests.rs"]
mod tests;

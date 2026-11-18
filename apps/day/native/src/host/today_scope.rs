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
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, atomic::Ordering};

/// At most this many project or delivery reads at a time, on the window's
/// own worker. It limits the load one switch puts on the service; 4 reads of
/// the 5 projects measured at once cut a switch from about 1.8 s to its slowest
/// project (see today_scope_tests.rs).
const READS_AT_ONCE: usize = 4;

#[cfg(test)]
fn selected_transport(t: &Transport, project: &Value) -> Result<Transport, Error> {
    t.for_project(project)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub scope: String,
    pub generation: u64,
    /// The first read of a switch: only the selected project, so it shows at
    /// once. The complete read that follows fills in the other projects.
    #[serde(default, rename = "selectedOnly")]
    pub selected_only: bool,
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
    // Same candidate limit as the existing delivery feed. No unbounded fanout:
    // at most READS_AT_ONCE requests at a time, on this same worker, in order.
    let uncertain = &uncertain;
    let mut items: Vec<Value> = futures_util::stream::iter(subjects.values().take(20))
        .map(|subject| async move {
            let unsettled =
                serde_json::to_value(subject).is_ok_and(|s| uncertain.contains(&s.to_string()));
            match super::delivery::read(t, subject).await {
                Ok(snapshot) => json!({"subject":subject,"snapshot":snapshot,"currentness":"live","unsettled":unsettled}),
                Err(error) => json!({"subject":subject,"snapshot":null,"currentness":"unavailable","unsettled":unsettled,"reason":error.to_string()}),
            }
        })
        .buffered(READS_AT_ONCE)
        .collect()
        .await;
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
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        read_inner(t, journal, shared, request, gate),
    )
    .await
    .map_err(|_| Error::Offline)?;
    // The first read of a switch: how long the chosen project took to show.
    if request.selected_only && result.is_ok() {
        crate::day_log::event(
            "scope.switch",
            json!({"ms":u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)}),
        );
    }
    result
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
    // A global window acts on the one project the user chose here. The focus
    // moves first, before the slow per-project reads: a read that times out
    // under load must not leave the window on the previous project. Only the
    // newest choice moves it. It stays when All projects is chosen again; it
    // never sends anything.
    if t.source.project.is_none() && request.scope != "all" {
        check()?;
        let catalog = new_chat::inventory(t).await?;
        check()?;
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
    let live = shared.connected.load(Ordering::SeqCst);
    // A project list that changed during the reads (a name, a digest) is read
    // again at once, one time; the newest generation still wins.
    let mut value = match read_projects(t, journal, request, live, check).await {
        Err(Error::Stale) if check().is_ok() => {
            read_projects(t, journal, request, live, check).await?
        }
        other => other?,
    };
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
    let first = request.selected_only && request.scope != "all";
    // The selected project first, then the others: its rows are the ones a
    // switch waits for. At most READS_AT_ONCE projects are read at a time, on
    // this same worker. Scope never spawns another worker or daemon.
    let mut order: Vec<(usize, &Value)> = projects.iter().enumerate().collect();
    order.sort_by_key(|(_, p)| !request.includes(p["projectId"].as_str().unwrap_or("")));
    let read: Vec<(usize, Result<Value, Error>)> = futures_util::stream::iter(order)
        .map(|(at, project)| {
            let check = &check;
            async move {
                let selected = match project["projectId"].as_str() {
                    Some(id) => request.includes(id),
                    None => return (at, Err(Error::Invalid)),
                };
                let row = if first && !selected {
                    // Read in the second, complete read: unknown here, never zero.
                    Ok(reading_row(project))
                } else {
                    project_row(t, journal, project, selected, live, check).await
                };
                (at, row)
            }
        })
        .buffered(READS_AT_ONCE)
        .collect()
        .await;
    let mut rows = vec![Value::Null; projects.len()];
    let mut bytes = 1024usize;
    for (at, row) in read {
        let row = row?;
        bytes =
            bytes.saturating_add(serde_json::to_vec(&row).map_err(|_| Error::Invalid)?.len() + 1);
        if bytes > crate::bridge::MAX_RESPONSE - 1024 {
            return Err(Error::Capacity);
        }
        rows[at] = row;
    }
    if !first {
        // A project removed, moved or no longer allowed during the reads cannot
        // publish the earlier list. Inventory never selects models or creates a chat.
        if let Some(error) = catalog_change(&catalog, &new_chat::inventory(t).await?, request) {
            crate::day_log::event(
                "scope.read_refused",
                json!({"error":error.to_string(),"cause":if error == Error::Identity {"project_gone"} else {"catalog_changed"}}),
            );
            return Err(error);
        }
    }
    check()?;
    Ok(
        json!({"version":1,"scope":request.scope,"generation":request.generation,
        "catalogComplete":true,"complete":false,"partial":first,"outsideNeedsYou":outside(&rows),"projects":rows}),
    )
}

/// How the project list changed during a read, if it did. The selected
/// project gone or moved is Identity: what shows is no longer that project.
/// Any other change (a name, a digest, another project) is Stale: read again.
fn catalog_change(before: &Value, after: &Value, request: &Request) -> Option<Error> {
    if before == after {
        return None;
    }
    if request.scope != "all" {
        let find = |c: &Value| {
            c["projects"]
                .as_array()
                .and_then(|rows| rows.iter().find(|p| p["projectId"] == request.scope))
                .map(|p| p["projectPath"].clone())
        };
        if find(after).is_none() || find(after) != find(before) {
            return Some(Error::Identity);
        }
    }
    Some(Error::Stale)
}

/// A project the first read of a switch leaves for the complete read: its
/// counts are unknown, said as reading, never as zero or as unreadable.
fn reading_row(project: &Value) -> Value {
    json!({"id":project["projectId"],"name":project["name"],"selected":false,"currentness":"reading",
        "observedAt":null,"needsYou":needs(None),"today":null,"planning":null,"intake":null,
        "results":null,"working":null,"canAct":false,"errors":{}})
}

/// One project's row. Its reads go out together; each canonical service
/// performs its existing project, owner and access checks.
async fn project_row(
    t: &Transport,
    journal: &Journal,
    project: &Value,
    selected: bool,
    live: bool,
    check: &impl Fn() -> Result<(), Error>,
) -> Result<Value, Error> {
    check()?;
    let pt = t.for_project(project)?;
    let (overview, attention, planning) = futures_util::join!(
        async {
            pt.gate(false).await?;
            pt.overview().await
        },
        async {
            attention::snapshot(&pt)
                .await
                .and_then(|v| scoped_attention(v, &pt.source.project()?.project_id, live))
        },
        pt.planning_inventory(),
    );
    check()?;
    let today = projection(
        &pt,
        journal,
        overview.as_ref().ok(),
        attention.as_ref().ok(),
        live,
    );
    let planning = planning.and_then(|v| {
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
        "today":null,"planning":null,"intake":null,"results":null,"working":null,
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
        row["working"] = working(overview.as_ref().ok(), live);
        row["today"] = serde_json::to_value(today).map_err(|_| Error::Invalid)?;
        if let Ok(v) = planning {
            row["planning"] = serde_json::to_value(v).map_err(|_| Error::Invalid)?;
        }
        let (intake, results) = futures_util::join!(intake::read(&pt), results(&pt, journal));
        match intake {
            Ok(v) => row["intake"] = v,
            Err(error) => row["errors"]["intake"] = json!(error.to_string()),
        }
        row["results"] = results;
        if !live {
            for item in row["results"]["items"].as_array_mut().into_iter().flatten() {
                item["currentness"] = json!("stale");
            }
        }
        label_sections(&mut row, project);
    }
    Ok(row)
}

/// Project/identity checks happened on the enclosing overview. No per-chat reads or subscriptions.
fn working(overview: Option<&DayOverview>, live: bool) -> Value {
    let Some(o) = overview else {
        return json!({"state":"failed","items":[]});
    };
    let Some(items) = &o.working_now else {
        return json!({"state":"unavailable","items":[]});
    };
    let mut seen = std::collections::HashSet::new();
    if !o.complete
        || items.iter().any(|r| {
            !valid_id(&r.session_id) || r.status != "working" || !seen.insert(&r.session_id)
        })
    {
        return json!({"state":"failed","items":[]});
    }
    if !live {
        return json!({"state":"disconnected","items":[]});
    }
    json!({"state":"live","items":items,"waiting":waiting(o)})
}

/// Chats waiting for a coding slot, or null when the service did not say or
/// a row does not read. Waiting rows never make the working list fail.
fn waiting(o: &DayOverview) -> Value {
    let Some(rows) = &o.waiting_now else {
        return Value::Null;
    };
    let mut seen = std::collections::HashSet::new();
    if rows
        .iter()
        .any(|r| !valid_id(&r.session_id) || !r.queue.valid() || !seen.insert(&r.session_id))
    {
        return Value::Null;
    }
    json!(rows)
}

#[cfg(test)]
#[path = "today_scope_tests.rs"]
mod tests;

//! Bounded read projections. Home + canonical ID, never an execution destination.
#[cfg(test)]
#[path = "mission_browser_tests.rs"]
mod tests;
use crate::{delivery_store::Host, local_model::valid_id};
use serde_json::Value;
use std::collections::HashSet;

pub(crate) const CATALOG_BYTES: usize = 128 * 1024;
pub(crate) const MEMBER_BYTES: usize = 1024 * 1024;
pub(crate) const MEMBER_CAP: usize = 128;
pub(crate) const DISPLAY_TASKS: usize = 24;
pub(crate) const DISPLAY_MEMBERS: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct Home {
    pub(crate) daemon: String,
    pub(crate) lineage: String,
}
impl Home {
    pub(crate) fn local(host: &Host) -> Self {
        Self {
            daemon: host.daemon_id.clone(),
            lineage: host.lineage_id.clone(),
        }
    }
    fn parse(v: &Value) -> Result<Self, &'static str> {
        Ok(Self {
            daemon: id(&v["daemonId"])?,
            lineage: id(&v["lineageId"])?,
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct Key {
    pub(crate) home: Home,
    pub(crate) id: String,
}
impl Key {
    pub(crate) fn tag(&self) -> String {
        serde_json::to_string(&[&self.home.daemon, &self.home.lineage, &self.id])
            .expect("string tuple")
    }
    pub(crate) fn valid(&self) -> bool {
        valid_id(&self.id) && valid_id(&self.home.daemon) && valid_id(&self.home.lineage)
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Source {
    pub(crate) home: Home,
    pub(crate) project: String,
    pub(crate) canonical: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct Row {
    pub(crate) key: Key,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) counts: Option<(u64, u64)>,
    pub(crate) sources: Vec<Source>,
}
impl Row {
    pub(crate) fn in_scope(&self, local: &Home, project: Option<&str>) -> bool {
        project.is_none_or(|p| {
            self.sources
                .iter()
                .any(|s| &s.home == local && s.project == p)
        })
    }
    pub(crate) fn local_definition(&self, local: &Home) -> bool {
        &self.key.home == local && self.sources.iter().any(|s| s.canonical && &s.home == local)
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Catalog {
    pub(crate) rows: Vec<Row>,
    pub(crate) total: u64,
    pub(crate) truncated: bool,
}
pub(crate) fn catalog(v: &Value) -> Result<Catalog, &'static str> {
    let raw = v["logicalMissions"]
        .as_array()
        .ok_or("Unsupported mission catalog response.")?;
    if raw.len() > 50 {
        return Err("Mission catalog exceeds the 50-row viewer limit.");
    }
    let total = v["totals"]["logicalMissions"]
        .as_u64()
        .filter(|n| *n <= 1_000_000_000)
        .ok_or("Invalid mission catalog totals.")?;
    let truncated = v["truncated"]
        .as_bool()
        .ok_or("Missing mission catalog completeness.")?;
    if total < raw.len() as u64 || (!truncated && total != raw.len() as u64) {
        return Err("Inconsistent mission catalog completeness.");
    }
    let mut seen = HashSet::new();
    let mut rows = Vec::with_capacity(raw.len());
    for v in raw {
        let key = Key {
            home: Home::parse(&v["mission"]["home"])?,
            id: id(&v["mission"]["missionId"])?,
        };
        let tuple: Vec<String> = serde_json::from_str(
            v["id"]
                .as_str()
                .ok_or("Missing logical mission identity.")?,
        )
        .map_err(|_| "Invalid logical mission identity.")?;
        if tuple
            != [
                key.home.daemon.clone(),
                key.home.lineage.clone(),
                key.id.clone(),
            ]
            || !seen.insert(key.clone())
        {
            return Err("Conflicting logical mission identity.");
        }
        let provenance = v["provenance"]
            .as_array()
            .filter(|p| !p.is_empty() && p.len() <= 16)
            .ok_or("Invalid mission provenance.")?;
        let mut sources = Vec::with_capacity(provenance.len());
        for p in provenance {
            let canonical = match p["kind"].as_str() {
                Some("canonical") => true,
                Some("replica") => false,
                _ => return Err("Unsupported mission provenance."),
            };
            let home = Home::parse(&p["sourceHost"])?;
            if canonical && home != key.home {
                return Err("Mission canonical home differs.");
            }
            sources.push(Source {
                home,
                project: id(&p["projectId"])?,
                canonical,
            });
        }
        rows.push(Row {
            key,
            title: optional_content(&v["title"])?
                .unwrap_or_else(|| "Mission title unavailable".into()),
            status: optional_text(&v["status"], 40)?.unwrap_or_else(|| "Status unavailable".into()),
            counts: counts(v)?,
            sources,
        });
    }
    rows.sort_by(|a, b| {
        (a.status != "active", a.title.to_lowercase(), &a.key).cmp(&(
            b.status != "active",
            b.title.to_lowercase(),
            &b.key,
        ))
    });
    Ok(Catalog {
        rows,
        total,
        truncated,
    })
}
#[derive(Clone, Debug)]
pub(crate) struct Task {
    pub(crate) id: String,
    pub(crate) number: u64,
    pub(crate) title: String,
    pub(crate) status: String,
    /// Swift's workStatus: the stored status when phase gating projects Blocked.
    pub(crate) work_status: String,
    pub(crate) owner: Option<String>,
    pub(crate) order: f64,
    /// Position in the detail's phase order; None for no phase.
    pub(crate) phase: Option<usize>,
}
/// Progress bar order: finished work first, then review, active, blocked and waiting.
pub(crate) const BAR_ORDER: [&str; 6] = [
    "done",
    "in_review",
    "in_progress",
    "blocked",
    "todo",
    "delegated",
];
/// Overview summary over every received task, not only the displayed rows.
#[derive(Clone, Debug, Default)]
pub(crate) struct Summary {
    /// Work-status counts in bar order, zeros omitted, dropped excluded.
    pub(crate) counts: Vec<(&'static str, usize)>,
    /// In progress, then in review, each in task order.
    pub(crate) working: Vec<Task>,
    /// Blocked by their own status (phase gating is planned waiting).
    pub(crate) blocked: Vec<Task>,
}
impl Summary {
    pub(crate) fn total(&self) -> usize {
        self.counts.iter().map(|c| c.1).sum()
    }
    pub(crate) fn done(&self) -> usize {
        self.counts
            .iter()
            .find(|c| c.0 == "done")
            .map_or(0, |c| c.1)
    }
    fn new(tasks: &[Task]) -> Self {
        let counts = BAR_ORDER
            .iter()
            .map(|s| (*s, tasks.iter().filter(|t| t.work_status == *s).count()))
            .filter(|c| c.1 > 0)
            .collect();
        let with = |status: &'static str| {
            tasks
                .iter()
                .filter(move |t| t.work_status == status)
                .cloned()
        };
        Self {
            counts,
            working: with("in_progress").chain(with("in_review")).collect(),
            blocked: with("blocked").collect(),
        }
    }
}
use crate::mission_comments::Comment;
#[derive(Clone, Debug)]
pub(crate) struct Proposal {
    pub(crate) id: String,
    pub(crate) number: u64,
    pub(crate) reason: String,
}
#[derive(Clone, Debug)]
pub(crate) struct Ticket {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) reason: String,
}
/// Needs you beyond chats and blocked tasks, as in Swift's MissionNeedsYou:
/// paused or failed mission-level managed Linear tickets, open agent comments
/// addressed to nobody while the user coordinates, and pending proposals.
#[derive(Clone, Debug, Default)]
pub(crate) struct Attention {
    pub(crate) tickets: Vec<Ticket>,
    pub(crate) comments: Vec<Comment>,
    pub(crate) proposals: Vec<Proposal>,
}
fn attention(
    v: &Value,
    coordinator: bool,
    comments: &Result<Option<Vec<Comment>>, &'static str>,
    decisions: &Result<crate::mission_decisions::Snapshot, &'static str>,
) -> Result<Attention, &'static str> {
    let decisions = decisions.as_ref().map_err(|e| *e)?;
    let comments = comments.as_ref().map_err(|e| *e)?;
    let list = |name: &str| match v.get(name) {
        None => Ok(&[][..]),
        Some(v) => v
            .as_array()
            .map(Vec::as_slice)
            .ok_or("Mission links are malformed."),
    };
    let mut tickets = Vec::new();
    for r in list("resources")? {
        let state = r["linearSync"]["state"].as_str();
        if !r["taskId"].is_null()
            || r["kind"] != "linear.issue"
            || r["linearRole"] != "managed"
            || !matches!(state, Some("paused" | "error"))
        {
            continue;
        }
        let created = r["createdAt"]
            .as_f64()
            .ok_or("Invalid mission link time.")?;
        let label = [&r["externalId"], &r["title"]]
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let sync = &r["linearSync"];
        let reason = if state == Some("paused") {
            match first_sentence(sync["reason"].as_str()) {
                Some(s) => format!("Linear updates paused. {s}."),
                None => "Linear updates paused.".into(),
            }
        } else {
            let why = first_line(sync["error"].as_str())
                .or_else(|| sync["reason"].as_str().filter(|s| !s.is_empty()))
                .unwrap_or("unknown error");
            format!("Couldn't update Linear: {why}")
        };
        tickets.push((
            created,
            Ticket {
                id: id(&r["id"])?,
                label: if label.is_empty() {
                    "Linear ticket".into()
                } else {
                    bounded(&label, 512)
                },
                reason: bounded(&reason, 1024),
            },
        ));
    }
    tickets.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    // With a coordinator, comments addressed to nobody go to it, not the user.
    // The user's own comments are not waiting on the user.
    let comments = comments
        .iter()
        .flatten()
        .filter(|c| !coordinator && c.open() && c.target.is_none() && c.author.is_some())
        .cloned()
        .collect();
    let current = decisions.decisions.rows.as_deref().unwrap_or_default();
    let proposals = decisions
        .proposals
        .rows
        .iter()
        .flatten()
        .filter_map(|p| {
            let number = current.iter().find(|d| d.id == p.target)?.number;
            Some(Proposal {
                id: p.id.clone(),
                number,
                reason: p.reason.value.clone(),
            })
        })
        .collect();
    Ok(Attention {
        tickets: tickets.into_iter().map(|t| t.1).collect(),
        comments,
        proposals,
    })
}
fn first_line(s: Option<&str>) -> Option<&str> {
    s?.lines().map(str::trim).find(|s| !s.is_empty())
}
/// Swift's MissionTicketSyncLine: the text before the first ". ", without a final period.
fn first_sentence(s: Option<&str>) -> Option<&str> {
    let s = s?;
    let s = s.split(". ").next().unwrap_or(s);
    Some(s.strip_suffix('.').unwrap_or(s)).filter(|s| !s.is_empty())
}
#[derive(Clone, Debug)]
pub(crate) struct Detail {
    pub(crate) decisions: Result<crate::mission_decisions::Snapshot, &'static str>,
    /// Every received comment; None when the response omits them.
    pub(crate) comments: Result<Option<Vec<Comment>>, &'static str>,
    pub(crate) attention: Result<Attention, &'static str>,
    pub(crate) key: Key,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) project: String,
    pub(crate) goal: String,
    pub(crate) brief: Option<String>,
    pub(crate) clipped: bool,
    pub(crate) coordinator: Option<String>,
    pub(crate) tasks: Vec<Task>,
    pub(crate) task_count: usize,
    pub(crate) counts: Option<(u64, u64)>,
    pub(crate) summary: Summary,
    /// The Overview's phase rows: phases with tasks that count, in order, and
    /// "No phase" last. Empty for a mission without phases.
    pub(crate) phases: Vec<crate::mission_phases::Group>,
}
pub(crate) fn detail(key: &Key, v: &Value) -> Result<Detail, &'static str> {
    let m = &v["mission"];
    if id(&m["id"])? != key.id {
        return Err("Mission response belongs to a different canonical ID.");
    }
    // Every received task counts; only the overview preview is short.
    let raw = v["tasks"]
        .as_array()
        .ok_or("Mission task context is unavailable.")?;
    let mut seen = HashSet::new();
    let mut tasks = Vec::with_capacity(raw.len());
    let mut membership = Vec::with_capacity(raw.len());
    for t in raw {
        let id = id(&t["id"])?;
        if !seen.insert(id.clone()) {
            return Err("Duplicate mission task identity.");
        }
        let number = t["number"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 1_000_000_000)
            .ok_or("Invalid task number.")?;
        let order = t["order"]
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or("Invalid task order.")?;
        let status = text(&t["status"], 40)?;
        tasks.push(Task {
            id,
            number,
            title: content(&t["title"])?,
            work_status: if t["storedStatus"].is_null() {
                status.clone()
            } else {
                text(&t["storedStatus"], 40)?
            },
            status,
            owner: optional_id(&t["sessionId"])?,
            order,
            phase: None,
        });
        membership.push((t["phaseId"].as_str(), t["milestone"].as_str()));
    }
    let mut tasks: Vec<_> = tasks.into_iter().zip(membership).collect();
    tasks.sort_by(|(a, _), (b, _)| {
        a.order
            .total_cmp(&b.order)
            .then(a.number.cmp(&b.number))
            .then(a.id.cmp(&b.id))
    });
    let index = crate::mission_phases::Index::new(&v["phases"], tasks.iter().map(|(_, m)| m.1))?;
    let tasks: Vec<Task> = tasks
        .into_iter()
        .map(|(mut t, (phase, milestone))| {
            t.phase = index.of(phase, milestone);
            t
        })
        .collect();
    let mut phases: Vec<_> = index
        .groups(
            &tasks
                .iter()
                .map(|t| (t.phase, t.work_status.as_str()))
                .collect::<Vec<_>>(),
        )
        .into_iter()
        .filter(|g| g.total > 0)
        .collect();
    // A lone "No phase" row says less than the overall bar and legend.
    if phases
        .iter()
        .all(|g: &crate::mission_phases::Group| g.phase.is_none())
    {
        phases.clear();
    }
    let summary = Summary::new(&tasks);
    let goal = content(&m["goal"])?;
    let brief = if v["brief"].is_null() {
        None
    } else {
        if id(&v["brief"]["missionId"])? != key.id {
            return Err("Brief belongs to another mission.");
        }
        Some(content(&v["brief"]["markdown"])?)
    };
    let decisions = crate::mission_decisions::project(v);
    let comments = crate::mission_comments::project(v);
    let coordinator = optional_id(&m["coordinatorSessionId"])?;
    Ok(Detail {
        attention: attention(v, coordinator.is_some(), &comments, &decisions),
        comments,
        decisions,
        key: key.clone(),
        title: content(&m["title"])?,
        status: text(&m["status"], 40)?,
        project: id(&m["projectId"])?,
        goal,
        brief,
        clipped: false,
        coordinator,
        task_count: tasks.len(),
        tasks: tasks.into_iter().take(DISPLAY_TASKS).collect(),
        counts: counts(m)?,
        summary,
        phases,
    })
}
#[derive(Clone, Debug)]
pub(crate) struct Member {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) archived: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct Members {
    pub(crate) rows: Vec<Member>,
    pub(crate) total: usize,
    /// Every received member ID, for exact links beyond the displayed rows.
    pub(crate) ids: HashSet<String>,
}
pub(crate) fn members(d: &Detail, v: &Value) -> Result<Members, &'static str> {
    let raw = v.as_array().ok_or("Member chats are unavailable.")?;
    if raw.len() > MEMBER_CAP {
        return Err("Member context exceeds the 128-chat viewer limit.");
    }
    let mut seen = HashSet::new();
    let mut rows = Vec::with_capacity(raw.len());
    for m in raw {
        let id = id(&m["id"])?;
        if !seen.insert(id.clone()) || m["missionId"] != d.key.id || m["projectId"] != d.project {
            return Err("Member chat identity or membership differs.");
        }
        rows.push(Member {
            id,
            title: optional_text(&m["title"], 512)?.unwrap_or_else(|| "Untitled chat".into()),
            archived: !m["archivedAt"].is_null(),
        });
    }
    rows.sort_by(|a, b| {
        (
            d.coordinator.as_ref() != Some(&a.id),
            a.title.to_lowercase(),
            &a.id,
        )
            .cmp(&(
                d.coordinator.as_ref() != Some(&b.id),
                b.title.to_lowercase(),
                &b.id,
            ))
    });
    let total = rows.len();
    let ids = rows.iter().map(|m| m.id.clone()).collect();
    rows.truncate(DISPLAY_MEMBERS);
    Ok(Members { rows, total, ids })
}
fn id(v: &Value) -> Result<String, &'static str> {
    v.as_str()
        .filter(|s| valid_id(s))
        .map(str::to_owned)
        .ok_or("Invalid canonical mission context identity.")
}
fn optional_id(v: &Value) -> Result<Option<String>, &'static str> {
    if v.is_null() {
        Ok(None)
    } else {
        id(v).map(Some)
    }
}
fn text(v: &Value, cap: usize) -> Result<String, &'static str> {
    v.as_str()
        .map(|s| bounded(s, cap))
        .ok_or("Invalid mission context text.")
}
fn optional_text(v: &Value, cap: usize) -> Result<Option<String>, &'static str> {
    if v.is_null() {
        Ok(None)
    } else {
        text(v, cap).map(Some)
    }
}
fn content(v: &Value) -> Result<String, &'static str> {
    v.as_str().map(str::to_owned).ok_or("Invalid mission text.")
}
fn optional_content(v: &Value) -> Result<Option<String>, &'static str> {
    if v.is_null() {
        Ok(None)
    } else {
        content(v).map(Some)
    }
}
pub(crate) fn bounded(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.into();
    }
    let mut n = cap.saturating_sub(3);
    while !s.is_char_boundary(n) {
        n -= 1;
    }
    format!("{}…", &s[..n])
}
fn counts(v: &Value) -> Result<Option<(u64, u64)>, &'static str> {
    match (v.get("tasksDone"), v.get("tasksTotal")) {
        (None, None) => Ok(None),
        (Some(d), Some(t)) => {
            let d = d.as_u64().ok_or("Invalid task count.")?;
            let t = t
                .as_u64()
                .filter(|n| *n <= 1_000_000_000)
                .ok_or("Invalid task count.")?;
            if d > t {
                return Err("Inconsistent task count.");
            }
            Ok(Some((d, t)))
        }
        _ => Err("Incomplete task count."),
    }
}

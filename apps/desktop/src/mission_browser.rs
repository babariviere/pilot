//! Bounded read projections. Home + canonical ID, never an execution destination.
#[cfg(test)]
#[path = "mission_browser_tests.rs"]
mod tests;
use crate::{delivery_store::Host, local_model::valid_id};
use serde_json::Value;
use std::collections::HashSet;

pub(crate) const CATALOG_BYTES: usize = 128 * 1024;
pub(crate) const DETAIL_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MEMBER_BYTES: usize = 1024 * 1024;
pub(crate) const TASK_CAP: usize = 256;
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
            title: optional_text(&v["title"], 512)?
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
    pub(crate) owner: Option<String>,
    pub(crate) order: f64,
}
#[derive(Clone, Debug)]
pub(crate) struct Detail {
    pub(crate) decisions: Result<crate::mission_decisions::Snapshot, &'static str>,
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
}
pub(crate) fn detail(key: &Key, v: &Value) -> Result<Detail, &'static str> {
    let m = &v["mission"];
    if id(&m["id"])? != key.id {
        return Err("Mission response belongs to a different canonical ID.");
    }
    let raw = v["tasks"]
        .as_array()
        .ok_or("Mission task context is unavailable.")?;
    if raw.len() > TASK_CAP {
        return Err("Mission detail exceeds the 256-task viewer limit.");
    }
    let mut seen = HashSet::new();
    let mut tasks = Vec::with_capacity(raw.len());
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
        tasks.push(Task {
            id,
            number,
            title: text(&t["title"], 512)?,
            status: text(&t["status"], 40)?,
            owner: optional_id(&t["sessionId"])?,
            order,
        });
    }
    tasks.sort_by(|a, b| {
        a.order
            .total_cmp(&b.order)
            .then(a.number.cmp(&b.number))
            .then(a.id.cmp(&b.id))
    });
    let mut clipped = false;
    let goal = clip_text(&m["goal"], 8192, &mut clipped)?;
    let brief = if v["brief"].is_null() {
        None
    } else {
        if id(&v["brief"]["missionId"])? != key.id {
            return Err("Brief belongs to another mission.");
        }
        Some(clip_text(&v["brief"]["markdown"], 32768, &mut clipped)?)
    };
    Ok(Detail {
        decisions: crate::mission_decisions::project(v),
        key: key.clone(),
        title: text(&m["title"], 800)?,
        status: text(&m["status"], 40)?,
        project: id(&m["projectId"])?,
        goal,
        brief,
        clipped,
        coordinator: optional_id(&m["coordinatorSessionId"])?,
        task_count: tasks.len(),
        tasks: tasks.into_iter().take(DISPLAY_TASKS).collect(),
        counts: counts(m)?,
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
    rows.truncate(DISPLAY_MEMBERS);
    Ok(Members { rows, total })
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
fn clip_text(v: &Value, cap: usize, clipped: &mut bool) -> Result<String, &'static str> {
    let s = v.as_str().ok_or("Invalid mission text.")?;
    *clipped |= s.len() > cap;
    Ok(bounded(s, cap))
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

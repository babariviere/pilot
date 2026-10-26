//! Content-private membership metadata from the existing, pinned Local stream.
//! No requests, persistence, navigation or inferred/title-based membership.
#[cfg(test)]
#[path = "mission_inspector_tests.rs"]
mod tests;
use crate::{
    local_model::valid_id,
    mission_browser::{Home, Key},
};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum Link {
    #[default]
    Unknown,
    Malformed,
    Unlinked,
    Mission {
        project: String,
        mission: String,
    },
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Metadata {
    rows: BTreeMap<String, Link>,
    fallback: Link,
}
impl Metadata {
    pub(crate) fn link(&self, id: &str) -> &Link {
        self.rows.get(id).unwrap_or(&self.fallback)
    }
    pub(crate) fn accept(current: &mut Arc<Self>, wire: &Value) {
        let id = |v: &Value| v.as_str().filter(|v| valid_id(v)).map(str::to_owned);
        let link = |v: &Value| {
            if v["missionId"].is_null() {
                return Link::Unlinked;
            }
            match (id(&v["projectId"]), id(&v["missionId"])) {
                (Some(project), Some(mission)) => Link::Mission { project, mission },
                _ => Link::Malformed,
            }
        };
        let next = match wire["type"].as_str() {
            Some("sessions") => {
                let mut next = Self::default();
                let raw = wire["sessions"]
                    .as_array()
                    .filter(|v| v.len() <= crate::local_model::SESSION_CAP);
                if let Some(raw) = raw {
                    for row in raw {
                        let Some(id) = id(&row["id"]) else {
                            next.rows.clear();
                            next.fallback = Link::Malformed;
                            break;
                        };
                        if next.rows.insert(id, link(row)).is_some() {
                            next.rows.clear();
                            next.fallback = Link::Malformed;
                            break;
                        }
                    }
                } else {
                    next.fallback = Link::Malformed;
                }
                next
            }
            Some("session") => {
                let row = &wire["session"];
                let Some(id) = id(&row["id"]) else {
                    return;
                };
                if !current.rows.contains_key(&id)
                    && current.rows.len() >= crate::local_model::SESSION_CAP
                {
                    return;
                }
                let value = link(row);
                if current.rows.get(&id) == Some(&value) {
                    return;
                }
                let mut next = (**current).clone();
                next.rows.insert(id, value);
                next
            }
            _ => return,
        };
        if **current != next {
            *current = Arc::new(next);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Source {
    pub(crate) home: Home,
    pub(crate) chat: String,
    pub(crate) project: String,
    pub(crate) mission: String,
    pub(crate) selection: u64,
}
impl Source {
    pub(crate) fn key(&self) -> Key {
        Key {
            home: self.home.clone(),
            id: self.mission.clone(),
        }
    }
    pub(crate) fn matches(&self, metadata: &Metadata, id: &str) -> bool {
        metadata.link(id)
            == &Link::Mission {
                project: self.project.clone(),
                mission: self.mission.clone(),
            }
    }
    pub(crate) fn canonical(&self, catalog: &crate::mission_browser::Catalog) -> bool {
        catalog.rows.iter().any(|r| {
            r.key == self.key()
                && r.sources
                    .iter()
                    .any(|p| p.canonical && p.home == self.home && p.project == self.project)
        })
    }
}

/// Runtime geometry, not a new spacing scale. Keep chat >=420pt beside a pane;
/// narrow windows dock below, spending at most a third of the available height.
pub(crate) fn placement(width: f32, height: f32) -> (bool, f32) {
    let side = width >= 420. + 280.;
    (
        side,
        if side {
            300_f32.min(width - 420.)
        } else {
            (height / 3.).min(240.).min((height - 360.).max(0.))
        },
    )
}

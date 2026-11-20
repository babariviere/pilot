use super::{MAX_SAFE, valid_id};
use serde::{Deserialize, Deserializer};
use std::collections::BTreeSet;

const MAX_BYTES: usize = 28 * 1024;
const MAX_SOURCE_IDS: usize = 20;
const MAX_ALLOWANCE_TEXT: usize = 128;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum WorkKind {
    Fix,
    Plan,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum PickMode {
    Ask,
    Build,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Work {
    #[serde(rename = "kind")]
    _kind: WorkKind,
    key: String,
    revision: u64,
    title: String,
    project_id: String,
    source_ids: Vec<String>,
    #[serde(deserialize_with = "nullable")]
    other: Option<Other>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Other {
    goal: String,
    #[serde(deserialize_with = "nullable")]
    pick: Option<Pick>,
    #[serde(deserialize_with = "nullable")]
    replaces: Option<Replaces>,
    #[serde(deserialize_with = "nullable")]
    request: Option<Request>,
    #[serde(deserialize_with = "nullable")]
    funding: Option<Funding>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pick {
    project_id: String,
    #[serde(rename = "mode")]
    _mode: PickMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replaces {
    mission_id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    item_id: String,
    revision: u32,
    title: String,
    source: String,
    #[serde(default, rename = "manageStatus")]
    _manage_status: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Funding {
    project: String,
    quick_fix: String,
    #[serde(deserialize_with = "nullable")]
    mission: Option<String>,
}

fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}

fn title(text: &str) -> bool {
    text.encode_utf16().count() <= crate::model::MAX_MISSION_TITLE && !text.contains('\0')
}

fn allowance(text: &str) -> bool {
    // Kept as draft text. A subsequent explicit New intent still checks the amount.
    text.len() <= MAX_ALLOWANCE_TEXT && !text.contains('\0')
}

impl Other {
    fn valid(&self) -> bool {
        self.goal.len() <= 12_000
            && self.goal.chars().count() <= crate::plan_desk::MAX_TEXT
            && !self.goal.contains('\0')
            && self.pick.as_ref().is_none_or(|p| valid_id(&p.project_id))
            && self
                .replaces
                .as_ref()
                .is_none_or(|r| valid_id(&r.mission_id) && title(&r.title))
            && self.request.as_ref().is_none_or(|r| {
                valid_id(&r.item_id)
                    && r.revision > 0
                    && r.title.len() <= 4096
                    && !r.title.contains('\0')
                    && !r.source.trim().is_empty()
                    && r.source.len() <= 128
                    && !r.source.contains('\0')
            })
            && self.funding.as_ref().is_none_or(|f| {
                valid_id(&f.project)
                    && allowance(&f.quick_fix)
                    && f.mission.as_deref().is_none_or(allowance)
            })
    }
}

/// View-local references and the user's previous New form, never an operation or a grant.
pub(crate) fn valid_work_draft(text: &str) -> bool {
    text.is_empty()
        || (text.len() <= MAX_BYTES
            && serde_json::from_str::<Work>(text).is_ok_and(|w| {
                valid_id(&w.key)
                    && (1..=MAX_SAFE).contains(&w.revision)
                    && !w.title.trim().is_empty()
                    && title(&w.title)
                    && valid_id(&w.project_id)
                    && w.source_ids.len() <= MAX_SOURCE_IDS
                    && w.source_ids.iter().all(|id| valid_id(id))
                    && w.source_ids.iter().collect::<BTreeSet<_>>().len() == w.source_ids.len()
                    && w.other.as_ref().is_none_or(Other::valid)
            }))
}

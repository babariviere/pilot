//! Passive project selection and an explicit standalone chat permission choice.
use nsh_core::prelude::JsObject;
use serde::{Deserialize, Serialize};

/// One selected project and permission level. A saved choice is not execution authority.
#[derive(Debug, Clone, Default, PartialEq, JsObject, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[prop(exact)]
#[non_exhaustive]
pub struct ChatChoice {
    /// Exact local draft/session identity. Never replace it after an uncertain creation.
    pub draft_id: String,
    /// Canonical daemon project ID, never a mission ID or name.
    pub project_id: String,
    /// Root shown when the user selected the project, not a cwd override.
    pub project_path: String,
    /// Exact saved project configuration digest.
    pub context_digest: String,
    /// Explicit permission choice: ask (read only) or build (project defaults).
    pub mode: String,
    /// Model selected by the existing task-model policy.
    pub model: String,
    /// Model thinking level selected by that policy.
    pub thinking: String,
}
impl ChatChoice {
    pub(crate) fn validate(&self) -> bool {
        uuid::Uuid::parse_str(&self.draft_id).is_ok()
            && crate::host::valid_id(&self.project_id)
            && self.project_path.starts_with('/')
            && self.project_path.len() <= 4096
            && self.context_digest.len() == 64
            && self.context_digest.bytes().all(|b| b.is_ascii_hexdigit())
            && matches!(self.mode.as_str(), "ask" | "build")
            && !self.model.is_empty()
            && self.model.len() <= 256
            && self.thinking.len() <= 128
    }
    pub(crate) fn text_bytes(&self) -> usize {
        self.draft_id.len()
            + self.project_id.len()
            + self.project_path.len()
            + self.context_digest.len()
            + self.mode.len()
            + self.model.len()
            + self.thinking.len()
    }
}

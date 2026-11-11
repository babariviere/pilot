//! Passive, exact saved window state. Never startup/update authority.
use super::{Error, Source};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedWindow {
    pub kind: String,
    pub version: u32,
    pub source: Source,
    pub window: String,
    pub generation: u32,
    pub save_sequence: u64,
    pub view: serde_json::Value,
}
impl SavedWindow {
    pub(super) fn key(source: &Source) -> Result<String, Error> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(source).map_err(|_| Error::Storage)?)
        ))
    }
    pub(super) fn validate(&self) -> Result<(), Error> {
        if self.kind != "window-capture"
            || self.version != 1
            || self.generation == 0
            || uuid::Uuid::parse_str(&self.window).is_err()
        {
            return Err(Error::Storage);
        }
        let view: crate::update::SavedView =
            nsh_core::element::from_json(&self.view).map_err(|_| Error::Storage)?;
        super::updates::validate_view(&view).map_err(|_| Error::Storage)
    }
    pub(super) fn follows(&self, old: &Self) -> bool {
        self.source == old.source
            && (self.window != old.window
                || (self.generation >= old.generation && self.save_sequence >= old.save_sequence))
    }
}

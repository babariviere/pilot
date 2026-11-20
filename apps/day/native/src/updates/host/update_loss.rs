//! Stored Force update loss records. Production never wrote one (Force was
//! always refused), but the journal still reads and checks any stored line.
use super::{Error, Source};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub loss_version: u32,
    pub operation: String,
    pub confirmation: String,
    pub source: Source,
    pub window: String,
    pub target: Value,
    pub closed: bool,
}

impl Record {
    pub(super) fn validate(&self) -> Result<(), Error> {
        if self.loss_version != 1
            || uuid::Uuid::parse_str(&self.operation).is_err()
            || uuid::Uuid::parse_str(&self.confirmation).is_err()
            || uuid::Uuid::parse_str(&self.window).is_err()
            || self.target.as_object().is_none()
            || self.target["source"].as_str().is_none_or(|s| {
                s.len() != 40
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
            || self.target["build"]
                .as_str()
                .is_none_or(|s| pilot_desktop_updater::manifest::Build::parse(s).is_err())
        {
            return Err(Error::Invalid);
        }
        super::window::SavedWindow::key(&self.source)?;
        Ok(())
    }
    pub(super) fn follows(&self, prior: &Self) -> bool {
        let mut fixed = self.clone();
        fixed.closed = prior.closed;
        fixed == *prior && !prior.closed && self.closed
    }
    pub(super) fn payload(&self) -> Value {
        json!({"schema":1,"operationId":self.operation,"confirmation":self.confirmation,
            "unsavedUI":true,"unfinishedWork":true})
    }
}

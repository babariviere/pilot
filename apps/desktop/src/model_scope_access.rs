//! Narrow existing native host-action file contract. Never exposed as a tool/API.
use crate::{LocalOptions, delivery_store::Failure};

#[path = "../../native-daemon/credentials.rs"]
mod credentials;

impl LocalOptions {
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn with_scope_home(mut self, path: std::path::PathBuf) -> Self {
        self.native_home = Some(path);
        self
    }
    pub(crate) fn model_scope_capability(&self) -> Result<String, Failure> {
        let home = self
            .native_home
            .as_ref()
            .ok_or("Native scoped-model authorization is unavailable for this source.")?;
        credentials::capability(home, &self.daemon_id, &self.lineage_id)
    }
}

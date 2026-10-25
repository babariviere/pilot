//! Narrow existing native host-action file contract. Never exposed as a tool/API.
use crate::{LocalOptions, delivery_store::Failure};
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
};
impl LocalOptions {
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn with_scope_home(mut self, path: std::path::PathBuf) -> Self {
        self.native_home = Some(path);
        self
    }
    pub(crate) fn model_scope_capability(&self) -> Result<String, Failure> {
        // Called only on the scope worker after hello and explicit Save.
        let home = self
            .native_home
            .as_ref()
            .ok_or("Native scoped-model authorization is unavailable for this source.")?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(home.join("github-app-capability"))
            .map_err(|_| "Native scoped-model authorization is unavailable.")?;
        let meta = file
            .metadata()
            .map_err(|_| "Native scoped-model authorization is unavailable.")?;
        if !meta.is_file()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
            || meta.len() > 4096
        {
            return Err("Native scoped-model authorization failed its private-file checks.");
        }
        let mut bytes = Vec::new();
        file.take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| "Native scoped-model authorization could not be read.")?;
        if bytes.len() > 4096 {
            return Err("Native scoped-model authorization exceeds its bound.");
        }
        let v: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Native scoped-model authorization is malformed.")?;
        let host = self.host();
        if v["daemonId"] != host.daemon_id || v["lineageId"] != host.lineage_id {
            return Err("Native scoped-model authorization belongs to another Local installation.");
        }
        let token = v["token"]
            .as_str()
            .filter(|t| {
                t.len() == 64
                    && t.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or("Native scoped-model authorization is malformed.")?;
        Ok(token.into())
    }
}

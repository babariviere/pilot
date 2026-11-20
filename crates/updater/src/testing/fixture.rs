//! Explicit native-test transport. Never compiled into normal distribution builds.
//! The entire worker, signed download, staging, helper and restart protocol remain real.
use crate::{
    Error,
    helper::compiled_trust,
    manifest::{ARCHIVE_ASSET, MANIFEST_ASSET, VerifiedManifest},
    transport::{Network, Reply},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::{
    fs::{self, OpenOptions},
    io::Cursor,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::PathBuf,
};

pub fn enabled() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("PILOT_NEXT_UPDATER_FIXTURE").is_some()
}
pub(crate) struct Fixture {
    root: PathBuf,
    release: Vec<u8>,
}
impl Fixture {
    pub(crate) fn open() -> Result<Self, Error> {
        Self::for_target(&crate::layout::running_root()?)
    }
    fn for_target(target: &std::path::Path) -> Result<Self, Error> {
        let trust = compiled_trust()?;
        // Public synthetic seed42 key only. Never use repository signing secrets.
        if trust.application_id != "com.example.synthetic.next"
            || trust.repository != "synthetic/fixture-only"
            || STANDARD.encode(trust.public_key) != "GX9rI+FshTLGq8g4+s1ep4m+DHaykgM0A5v6iz02jWE="
        {
            return Err(Error::Identity);
        }
        let root =
            PathBuf::from(std::env::var_os("PILOT_NEXT_UPDATER_FIXTURE").ok_or(Error::Identity)?)
                .canonicalize()
                .map_err(|_| Error::Identity)?;
        let temporary = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| Error::Identity)?;
        let meta = fs::symlink_metadata(&root).map_err(|_| Error::Identity)?;
        if !root.starts_with(temporary)
            || !root
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.starts_with("next-owned-gui-update-"))
            || !meta.is_dir()
            || meta.mode() & 0o077 != 0
            || meta.uid() != unsafe { libc::geteuid() }
            || target.parent().and_then(|p| p.parent()) != Some(root.as_path())
        {
            return Err(Error::Identity);
        }
        let raw = fs::read(root.join("envelope.json")).map_err(|_| Error::Filesystem)?;
        let manifest = VerifiedManifest::parse(&raw, &trust, 12)?;
        let release = serde_json::to_vec(&serde_json::json!({"draft":false,"prerelease":false,"tag_name":format!("v{}",manifest.manifest().short_version),"assets":[{"id":11,"name":MANIFEST_ASSET,"state":"uploaded"},{"id":12,"name":ARCHIVE_ASSET,"state":"uploaded"}]})).map_err(|_| Error::Identity)?;
        Ok(Self { root, release })
    }
    #[cfg(all(target_os = "linux", feature = "native-linux"))]
    pub(crate) fn relaunch_output(target: &std::path::Path) -> Result<std::fs::File, Error> {
        let fixture = Self::for_target(target)?;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(fixture.root.join("relaunch-wayland.log"))
            .map_err(|_| Error::Filesystem)
    }
}
impl Network for Fixture {
    fn get(&self, url: &url::Url, token: Option<&str>) -> Result<Reply, Error> {
        if url.scheme() != "https" || url.host_str() != Some("api.github.com") || token.is_some() {
            return Err(Error::Identity);
        }
        if url.path() == "/repos/synthetic/fixture-only/releases/latest" {
            return Ok(Reply {
                status: 200,
                location: None,
                length: Some(self.release.len() as u64),
                body: Box::new(Cursor::new(self.release.clone())),
            });
        }
        let name = match url.path() {
            "/repos/synthetic/fixture-only/releases/assets/11" => "envelope.json",
            "/repos/synthetic/fixture-only/releases/assets/12" => "archive.zip",
            _ => return Err(Error::Identity),
        };
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.root.join(name))
            .map_err(|_| Error::Filesystem)?;
        let meta = file.metadata().map_err(|_| Error::Filesystem)?;
        if !meta.is_file() || meta.nlink() != 1 {
            return Err(Error::Identity);
        }
        Ok(Reply {
            status: 200,
            location: None,
            length: Some(meta.len()),
            body: Box::new(file),
        })
    }
}

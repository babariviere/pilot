//! Worker-only, bounded HTTPS. All redirects are manually admitted. No implicit auth.
use crate::{
    Error,
    manifest::{ARCHIVE_ASSET, MANIFEST_ASSET, MAX_MANIFEST, Trust, VerifiedManifest},
};
use reqwest::{
    blocking::Client,
    header::{ACCEPT, AUTHORIZATION, LOCATION},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use url::Url;

#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn check(&self) -> Result<(), Error> {
        if self.0.load(Ordering::Acquire) {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Fresh explicit approved provider output. Not Debug, Clone or serialized.
pub struct Access(String);
impl Access {
    pub fn from_approved_provider(token: String) -> Result<Self, Error> {
        if token.is_empty()
            || token.len() > 65536
            || !token.bytes().all(|b| (0x21..=0x7e).contains(&b))
        {
            return Err(Error::Authentication);
        }
        Ok(Self(token))
    }
}

pub(crate) struct Reply {
    pub status: u16,
    pub location: Option<String>,
    pub length: Option<u64>,
    pub body: Box<dyn Read + Send>,
}
pub(crate) trait Network: Send + Sync {
    fn get(&self, url: &Url, token: Option<&str>) -> Result<Reply, Error>;
}
struct Reqwest {
    client: Client,
}
impl Network for Reqwest {
    fn get(&self, url: &Url, token: Option<&str>) -> Result<Reply, Error> {
        let accept = if url.path().ends_with("/releases/latest") {
            "application/vnd.github+json"
        } else {
            "application/octet-stream"
        };
        let mut request = self.client.get(url.clone()).header(ACCEPT, accept);
        if let Some(token) = token {
            request = request
                .header(AUTHORIZATION, format!("Bearer {token}"))
                .header("X-GitHub-Api-Version", "2022-11-28");
        }
        let response = request.send().map_err(|_| Error::Offline)?;
        Ok(Reply {
            status: response.status().as_u16(),
            location: response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned),
            length: response.content_length(),
            body: Box::new(response),
        })
    }
}
pub struct Transport {
    network: Box<dyn Network>,
}

impl Transport {
    pub fn new() -> Result<Self, Error> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .user_agent("Pilot-Next-Updater/1")
            .build()
            .map_err(|_| Error::Offline)?;
        Ok(Self {
            network: Box::new(Reqwest { client }),
        })
    }
}
impl Transport {
    #[cfg(test)]
    pub(crate) fn synthetic(network: impl Network + 'static) -> Self {
        Self {
            network: Box::new(network),
        }
    }

    fn response(
        &self,
        start: Url,
        trust: &Trust,
        access: &Access,
        cancel: &Cancellation,
    ) -> Result<Reply, Error> {
        let mut url = start;
        for _ in 0..=3 {
            cancel.check()?;
            let authenticated = permits_api(&url, &trust.repository);
            if !authenticated && !permits_cdn(&url) {
                return Err(Error::RedirectDenied);
            }
            let response = self
                .network
                .get(&url, authenticated.then_some(access.0.as_str()))?;
            cancel.check()?;
            match response.status {
                200 => return Ok(response),
                401 | 403 | 404 => return Err(Error::Authentication),
                301 | 302 | 303 | 307 | 308 => {
                    let next = url
                        .join(response.location.as_deref().ok_or(Error::RedirectDenied)?)
                        .map_err(|_| Error::RedirectDenied)?;
                    // API→CDN only; never let a CDN redirect back to a credential origin.
                    if !permits_cdn(&next) {
                        return Err(Error::RedirectDenied);
                    }
                    url = next;
                }
                _ => return Err(Error::InvalidResponse),
            }
        }
        Err(Error::RedirectDenied)
    }

    pub fn discover(
        &self,
        trust: &Trust,
        access: &Access,
        cancel: &Cancellation,
    ) -> Result<Option<VerifiedManifest>, Error> {
        trust.validate()?;
        let latest = Url::parse(&format!(
            "https://api.github.com/repos/{}/releases/latest",
            trust.repository
        ))
        .map_err(|_| Error::Unconfigured)?;
        let mut response = self.response(latest, trust, access, cancel)?;
        let bytes = bounded(&mut response.body, 1024 * 1024, cancel)?;
        let release: Release =
            serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
        let assets = release.assets(trust)?;
        let mut response = self.response(asset_url(trust, assets.0)?, trust, access, cancel)?;
        let bytes = bounded(&mut response.body, MAX_MANIFEST, cancel)?;
        let manifest = VerifiedManifest::parse(&bytes, trust, assets.1)?;
        if release.tag_name != format!("desktop-v{}", manifest.manifest().short_version) {
            return Err(Error::Version);
        }
        let offered = crate::manifest::Build::parse(&manifest.manifest().build)?;
        let current = crate::manifest::Build::parse(&trust.current_build)?;
        if offered < current {
            return Err(Error::Version);
        }
        Ok((offered > current).then_some(manifest))
    }

    pub fn download(
        &self,
        manifest: &VerifiedManifest,
        trust: &Trust,
        access: &Access,
        path: &Path,
        cancel: &Cancellation,
    ) -> Result<(), Error> {
        let metadata = manifest.manifest();
        let mut response = self.response(
            asset_url(trust, metadata.archive_asset_id)?,
            trust,
            access,
            cancel,
        )?;
        if response
            .length
            .is_some_and(|length| length != metadata.archive_size)
        {
            return Err(Error::InvalidResponse);
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| Error::Filesystem)?;
        let result = (|| {
            let mut total = 0_u64;
            let mut buffer = [0_u8; 65536];
            let mut digest = Sha256::new();
            loop {
                cancel.check()?;
                let count = response
                    .body
                    .read(&mut buffer)
                    .map_err(|_| Error::Offline)?;
                if count == 0 {
                    break;
                }
                total = total
                    .checked_add(count as u64)
                    .ok_or(Error::InvalidResponse)?;
                if total > metadata.archive_size {
                    return Err(Error::InvalidResponse);
                }
                digest.update(&buffer[..count]);
                file.write_all(&buffer[..count])
                    .map_err(|_| Error::Filesystem)?;
            }
            if total != metadata.archive_size || hex(&digest.finalize()) != metadata.archive_sha256
            {
                return Err(Error::Signature);
            }
            cancel.check()?;
            file.sync_all().map_err(|_| Error::Filesystem)
        })();
        if result.is_err() {
            drop(file);
            let _ = std::fs::remove_file(path);
        }
        result
    }
}

pub fn verify_archive(
    path: &Path,
    manifest: &VerifiedManifest,
    cancel: &Cancellation,
) -> Result<(), Error> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| Error::Filesystem)?;
    if !file.metadata().map_err(|_| Error::Filesystem)?.is_file() {
        return Err(Error::Filesystem);
    }
    let mut total = 0_u64;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        cancel.check()?;
        let count = file.read(&mut buffer).map_err(|_| Error::Filesystem)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > manifest.manifest().archive_size {
            return Err(Error::Signature);
        }
        digest.update(&buffer[..count]);
    }
    if total != manifest.manifest().archive_size
        || hex(&digest.finalize()) != manifest.manifest().archive_sha256
    {
        return Err(Error::Signature);
    }
    Ok(())
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn bounded(
    reader: &mut impl Read,
    maximum: usize,
    cancel: &Cancellation,
) -> Result<Vec<u8>, Error> {
    let mut result = Vec::new();
    let mut buffer = [0_u8; 16384];
    loop {
        cancel.check()?;
        let count = reader.read(&mut buffer).map_err(|_| Error::Offline)?;
        if count == 0 {
            return Ok(result);
        }
        if result.len() + count > maximum {
            return Err(Error::InvalidResponse);
        }
        result.extend_from_slice(&buffer[..count]);
    }
}

pub(crate) fn permits_api(url: &Url, repository: &str) -> bool {
    if !plain_https(url, "api.github.com") || url.query().is_some() {
        return false;
    }
    let prefix = format!("/repos/{repository}/releases/");
    url.path().strip_prefix(&prefix).is_some_and(|path| {
        path == "latest"
            || path.strip_prefix("assets/").is_some_and(|id| {
                !id.is_empty() && !id.starts_with('0') && id.bytes().all(|b| b.is_ascii_digit())
            })
    })
}
pub(crate) fn permits_cdn(url: &Url) -> bool {
    plain_https(url, "release-assets.githubusercontent.com") && url.path().len() > 1
}
fn plain_https(url: &Url, host: &str) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}
fn asset_url(trust: &Trust, id: u64) -> Result<Url, Error> {
    if id == 0 {
        return Err(Error::Identity);
    }
    Url::parse(&format!(
        "https://api.github.com/repos/{}/releases/assets/{id}",
        trust.repository
    ))
    .map_err(|_| Error::Identity)
}

#[derive(Deserialize)]
struct Release {
    draft: bool,
    prerelease: bool,
    tag_name: String,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    id: u64,
    name: String,
    state: String,
}
impl Release {
    fn assets(&self, _trust: &Trust) -> Result<(u64, u64), Error> {
        if self.draft || self.prerelease || !self.tag_name.starts_with("desktop-v") {
            return Err(Error::Identity);
        }
        let select = |name: &str| {
            let mut selected = self
                .assets
                .iter()
                .filter(|asset| asset.name == name && asset.state == "uploaded" && asset.id > 0);
            let id = selected.next().ok_or(Error::Identity)?.id;
            if selected.next().is_some() {
                return Err(Error::Identity);
            }
            Ok(id)
        };
        let feed = select(MANIFEST_ASSET)?;
        let archive = select(ARCHIVE_ASSET)?;
        if feed == archive {
            return Err(Error::Identity);
        }
        Ok((feed, archive))
    }
}

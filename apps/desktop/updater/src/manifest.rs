//! Signed bytes bind identity, channel, target, monotonically ordered build and payload.
use crate::Error;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};

#[cfg(not(target_os = "linux"))]
pub const MANIFEST_ASSET: &str = "desktop-macos-arm64-update.json";
#[cfg(not(target_os = "linux"))]
pub const ARCHIVE_ASSET: &str = "Pilot-Next-macos-arm64.zip";
#[cfg(target_os = "linux")]
pub const MANIFEST_ASSET: &str = "desktop-linux-x64-update.json";
#[cfg(target_os = "linux")]
pub const ARCHIVE_ASSET: &str = "Pilot-Next-linux-x64.zip";
pub const PLATFORM: &str = if cfg!(target_os = "linux") {
    "linux"
} else {
    "macos"
};
pub const ARCHITECTURE: &str = if cfg!(target_os = "linux") {
    "x86_64"
} else {
    "aarch64"
};
pub const MAX_MANIFEST: usize = 128 * 1024;
pub const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Build([u32; 4]);

impl Build {
    pub fn parse(value: &str) -> Result<Self, Error> {
        let mut result = [0; 4];
        let parts: Vec<_> = value.split('.').collect();
        if parts.is_empty() || parts.len() > 4 {
            return Err(Error::Version);
        }
        for (index, part) in parts.iter().enumerate() {
            if part.is_empty()
                || part.len() > 9
                || !part.bytes().all(|b| b.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
            {
                return Err(Error::Version);
            }
            result[index] = part.parse().map_err(|_| Error::Version)?;
        }
        Ok(Self(result))
    }
}

/// This trust root comes from separately approved compiled/bundled release configuration,
/// never from an update response. No usable default points at the Swift app or channel.
#[derive(Clone)]
pub struct Trust {
    pub repository: String,
    pub application_id: String,
    pub channel: String,
    pub current_build: String,
    pub bundle_name: String,
    pub public_key: [u8; 32],
    /// Platform requirement, e.g. identifier plus approved Developer ID team.
    /// Ad-hoc private builds need an explicit identifier requirement and signed manifest.
    pub code_requirement: String,
}

impl Trust {
    pub fn validate(&self) -> Result<(), Error> {
        let parts: Vec<_> = self.repository.split('/').collect();
        if parts.len() != 2
            || parts.iter().any(|p| {
                p.is_empty()
                    || *p == "."
                    || *p == ".."
                    || p.len() > 100
                    || !p
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            })
        {
            return Err(Error::Unconfigured);
        }
        if self.application_id == "com.babariviere.pilot"
            || self.application_id.len() > 200
            || !self.application_id.contains('.')
            || !self
                .application_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            || self.channel != "desktop-stable"
            || !matches!(self.bundle_name.as_str(), "Pilot Next.app" | "Pilot Next")
            || self.public_key == [0; 32]
            || self.code_requirement.is_empty()
            || self.code_requirement.len() > 2048
            || self.code_requirement.contains('\0')
        {
            return Err(Error::Unconfigured);
        }
        Build::parse(&self.current_build)?;
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub signed: String,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub application_id: String,
    pub channel: String,
    pub platform: String,
    pub architecture: String,
    pub build: String,
    pub short_version: String,
    pub bundle_name: String,
    pub archive_name: String,
    pub archive_asset_id: u64,
    pub archive_size: u64,
    pub archive_sha256: String,
}

/// Only produced after ring has verified the exact raw manifest bytes.
#[derive(Clone)]
pub struct VerifiedManifest {
    manifest: Manifest,
    envelope: Vec<u8>,
}

impl VerifiedManifest {
    pub fn parse(bytes: &[u8], trust: &Trust, expected_asset: u64) -> Result<Self, Error> {
        trust.validate()?;
        if bytes.len() > MAX_MANIFEST {
            return Err(Error::InvalidResponse);
        }
        let envelope: Envelope =
            serde_json::from_slice(bytes).map_err(|_| Error::InvalidResponse)?;
        let signed = STANDARD
            .decode(&envelope.signed)
            .map_err(|_| Error::Signature)?;
        let signature = STANDARD
            .decode(&envelope.signature)
            .map_err(|_| Error::Signature)?;
        if signed.len() > MAX_MANIFEST || signature.len() != 64 {
            return Err(Error::Signature);
        }
        UnparsedPublicKey::new(&ED25519, trust.public_key)
            .verify(&signed, &signature)
            .map_err(|_| Error::Signature)?;
        let manifest: Manifest =
            serde_json::from_slice(&signed).map_err(|_| Error::InvalidResponse)?;
        if manifest.schema != 1
            || manifest.application_id != trust.application_id
            || manifest.channel != trust.channel
            || manifest.platform != PLATFORM
            || manifest.architecture != ARCHITECTURE
            || manifest.bundle_name != trust.bundle_name
            || manifest.archive_name != ARCHIVE_ASSET
            || expected_asset == 0
            || manifest.archive_asset_id != expected_asset
        {
            return Err(Error::Identity);
        }
        if cfg!(target_os = "linux")
            && !manifest.source.as_deref().is_some_and(|s| {
                s.len() == 40
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(Error::Identity);
        }
        // Version metadata is covered by the same signature as the archive digest.
        Build::parse(&manifest.build)?;
        if manifest.short_version.is_empty()
            || manifest.short_version.len() > 64
            || !manifest
                .short_version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
        {
            return Err(Error::Version);
        }
        if manifest.archive_size == 0
            || manifest.archive_size > MAX_ARCHIVE
            || manifest.archive_sha256.len() != 64
            || !manifest
                .archive_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::InvalidResponse);
        }
        Ok(Self {
            manifest,
            envelope: bytes.to_vec(),
        })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn envelope(&self) -> &[u8] {
        &self.envelope
    }
    pub fn is_newer(&self, trust: &Trust) -> Result<bool, Error> {
        Ok(Build::parse(&self.manifest.build)? > Build::parse(&trust.current_build)?)
    }
}

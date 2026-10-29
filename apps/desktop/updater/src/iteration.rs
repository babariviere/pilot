//! Explicit local signed full-payload staging. No development trust root or executable loader.
use crate::{
    Error,
    installer::{self, Platform, Staged},
    manifest::{self, Trust, VerifiedManifest},
    transport::Cancellation,
};
use serde::Deserialize;
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    schema: u32,
    source: String,
    archive_asset_id: u64,
}

pub(crate) fn read(path: &Path, limit: u64) -> Result<Vec<u8>, Error> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| Error::Filesystem)?;
    let meta = file.metadata().map_err(|_| Error::Filesystem)?;
    if !meta.is_file() || meta.len() > limit {
        return Err(Error::Filesystem);
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Filesystem)?;
    if bytes.len() as u64 > limit {
        return Err(Error::Filesystem);
    }
    Ok(bytes)
}
fn manifest(directory: &Path, trust: &Trust) -> Result<VerifiedManifest, Error> {
    let pin: Pin = serde_json::from_slice(&read(&directory.join("iteration.json"), 4096)?)
        .map_err(|_| Error::Identity)?;
    if pin.schema != 1
        || pin.source.len() != 40
        || !pin
            .source
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::Identity);
    }
    let manifest = VerifiedManifest::parse(
        &read(
            &directory.join(manifest::MANIFEST_ASSET),
            manifest::MAX_MANIFEST as u64,
        )?,
        trust,
        pin.archive_asset_id,
    )?;
    if manifest.manifest().source.as_deref() != Some(&pin.source) {
        return Err(Error::Identity);
    }
    if !manifest.is_newer(trust)? {
        return Err(Error::Version);
    }
    Ok(manifest)
}
pub(crate) fn stage(
    directory: &Path,
    target: &Path,
    trust: &Trust,
    platform: &impl Platform,
    cancel: &Cancellation,
) -> Result<Staged, Error> {
    let verified = manifest(directory, trust)?;
    let (root, lock) = installer::new_stage(target, trust, platform)?;
    let result = (|| {
        let mut input = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(directory.join(manifest::ARCHIVE_ASSET))
            .map_err(|_| Error::Filesystem)?;
        let meta = input.metadata().map_err(|_| Error::Filesystem)?;
        if !meta.is_file() || meta.len() != verified.manifest().archive_size {
            return Err(Error::Archive);
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(installer::download_path(&root)?)
            .map_err(|_| Error::Filesystem)?;
        let mut buffer = [0; 64 * 1024];
        let mut remaining = verified.manifest().archive_size;
        while remaining > 0 {
            cancel.check()?;
            let count = Read::by_ref(&mut input)
                .take(remaining.min(buffer.len() as u64))
                .read(&mut buffer)
                .map_err(|_| Error::Filesystem)?;
            if count == 0 {
                return Err(Error::Archive);
            }
            output
                .write_all(&buffer[..count])
                .map_err(|_| Error::Filesystem)?;
            remaining -= count as u64;
        }
        output.sync_all().map_err(|_| Error::Filesystem)?;
        // Signature, archive digest, extraction bounds and native full-payload policy
        // are identical to a normal download, including helper revalidation at exit.
        let stage = installer::finish_stage(
            root.clone(),
            target.into(),
            lock,
            verified,
            trust,
            platform,
            cancel,
        )?;
        Ok(stage)
    })();
    if result.is_err() && installer::discard_incomplete(&root, target).is_err() {
        return Err(Error::RecoveryRequired);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_local_pin_never_creates_an_install_transaction() {
        let trust = crate::owned_tests::trust();
        assert!(manifest(Path::new("/nonexistent-iteration-input"), &trust).is_err());
    }
}

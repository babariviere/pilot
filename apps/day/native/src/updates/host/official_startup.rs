//! Read-only successor observation. Retained JSON supplies no install, service,
//! rollback or resume capability. The current signed image must match again.
use super::{
    Error,
    updates::{Record, Selection},
    window::SavedWindow,
};
use pilot_desktop_updater::{
    installer::{NativePlatform, Platform},
    manifest::Manifest,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Target {
    source: String,
    build: String,
    version: String,
    sha256: String,
    size: u64,
    config_hash: String,
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn official(record: &Record) -> bool {
    record.root.get("officialNsh").is_some()
}

/// A normal restore cannot rewind a newer close capture. Force has no view.
pub(super) fn capture_matches(record: &Record, capture: Option<&SavedWindow>) -> bool {
    if record.update_version == 2 {
        return record.loss().is_ok_and(|loss| loss.is_some());
    }
    let Some(capture) = capture else {
        return false;
    };
    let payload: Value = match serde_json::from_str(
        record.root["preparation"]["payload"]
            .as_str()
            .unwrap_or_default(),
    ) {
        Ok(value) => value,
        Err(_) => return false,
    };
    capture.validate().is_ok()
        && record.capture_matches(capture)
        && serde_json::to_vec(capture).is_ok_and(|bytes| payload["captureHash"] == digest(&bytes))
}

pub(super) fn verify(selection: &Selection, record: &Record) -> Result<(), Error> {
    verify_with(selection, record, &NativePlatform)
}

// The only substituted dependency in tests is the external code-sign verifier.
// Files, image identity, journal and production state projection stay real.
pub(super) fn verify_with(
    selection: &Selection,
    record: &Record,
    platform: &impl Platform,
) -> Result<(), Error> {
    record.validate()?;
    selection.trust.validate().map_err(|_| Error::Identity)?;
    let target: Target =
        serde_json::from_value(record.root["officialNsh"].clone()).map_err(|_| Error::Identity)?;
    let operation = &record.root["preparation"];
    let raw = operation["payload"].as_str().ok_or(Error::Identity)?;
    let payload: Value = serde_json::from_str(raw).map_err(|_| Error::Identity)?;
    let manifest = record.manifest.as_ref().ok_or(Error::Identity)?;
    let receipt = &manifest["receipt"];
    let service = &manifest["service"];
    let home = json!({"hostId":"daemon","daemonId":record.source.home.daemon_id,"lineageId":record.source.home.lineage_id});
    if record.kind != "app"
        || uuid::Uuid::parse_str(&record.id).is_err()
        || !["entered", "prepared", "unknown", "startup"].contains(&record.state.as_str())
        || selection.restore_transaction.is_some()
        || !selection.matches(&record.source)
        || record.target != target.build
        || target.build != selection.trust.current_build
        || !hex(&target.source, 40)
        || !hex(&target.sha256, 64)
        || !hex(&target.config_hash, 64)
        || target.version.is_empty()
        || target.size == 0
        || target.size > 1024 * 1024 * 1024
        || record.auth != digest(&serde_json::to_vec(&record.root).map_err(|_| Error::Storage)?)
        || operation["schemaVersion"] != 1
        || operation["operationId"] != record.id
        || operation["producerId"] != record.id
        || operation["sequence"] != 1
        || operation["kind"] != "global-update-prepare"
        || operation["targetId"] != "global-update"
        || operation["origin"] != home
        || operation["destination"] != home
        || operation["payloadHash"] != digest(raw.as_bytes())
        || payload.as_object().is_none_or(|p| p.len() != 3)
        || (record.update_version == 1 && payload.get("acceptedLoss").is_some())
        || payload["app"] != json!({"source":target.source,"build":target.build})
        || payload["replacement"]["runtimeRoot"]
            != json!(
                selection
                    .installed
                    .join(pilot_desktop_updater::layout::RUNTIME)
            )
        || payload["replacement"]["build"]["source"] != target.source
        || !["installed", "restart-entered"]
            .contains(&manifest["phase"].as_str().unwrap_or_default())
        || receipt["state"] != "accepted"
        || ["operationId", "payloadHash", "destination", "targetId"]
            .iter()
            .any(|key| receipt[*key] != operation[*key])
        || receipt["result"]["target"] != payload
        || service["role"] != "successor"
        || service["runtime"] != payload["replacement"]
        || service["app"]["app"] != json!(selection.installed)
        || service["app"]["source"] != target.source
        || service["app"]["guiBuild"] != target.build
        || service["app"]["replacement"] != payload["replacement"]
        || record.root["rollback"]["key"] != json!(selection.trust.public_key.to_vec())
        || record.root["rollback"]["requirement"] != selection.trust.code_requirement
    {
        return Err(Error::Identity);
    }
    // Matching a build label is insufficient, including for a same-build
    // differently signed image. Bind the full tree recorded by native handoff.
    platform
        .verify_candidate(
            &selection.installed,
            &selection.trust,
            &Manifest {
                schema: 1,
                source: Some(target.source),
                application_id: selection.trust.application_id.clone(),
                channel: selection.trust.channel.clone(),
                platform: "macos".into(),
                architecture: "aarch64".into(),
                build: target.build,
                short_version: target.version,
                bundle_name: selection.trust.bundle_name.clone(),
                archive_name: "official-app.zip".into(),
                archive_asset_id: 0,
                archive_size: target.size,
                archive_sha256: target.sha256,
            },
        )
        .map_err(|_| Error::Identity)?;
    let identity = pilot_desktop_updater::runtime::identity(&selection.installed)
        .map_err(|_| Error::Identity)?;
    if service["app"]["identity"] != identity {
        return Err(Error::Identity);
    }
    Ok(())
}

/// Record only the fresh display + verified image observation. No external ACK,
/// service start, release, resume, or retained effect is entered here.
pub(super) fn observe(
    journal: &mut super::journal::Journal,
    mut record: Record,
) -> Result<Record, Error> {
    if !official(&record)
        || record.update_version != 1
        || !record.restored
        || journal.updates.get(&record.id) != Some(&record)
        || !capture_matches(
            &record,
            journal.windows.get(&SavedWindow::key(&record.source)?),
        )
    {
        return Err(Error::Stale);
    }
    if record.state == "startup" {
        return Ok(record);
    }
    record.state = "startup".into();
    record.revision += 1;
    record.message = "Signed app startup was observed after restoring this window. Service release and agent resume are not confirmed. Check only; nothing will be replayed.".into();
    journal.save_update(record.clone())?;
    Ok(record)
}

#[cfg(test)]
#[path = "official_startup_tests.rs"]
mod tests;

//! Exact-update loss consent. Neither JSON nor a retained record grants close authority.
use super::{Error, Source, journal::Journal};
use crate::update::{Confirmation, UpdateKind, UpdateMode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;

/// One native prepared choice. Only verified official app inputs construct it.
pub struct Offer {
    confirmation: Confirmation,
    record: Record,
    journal: PathBuf,
}

/// A durable acceptance, not proof that state was discarded or processes exited.
/// This is deliberately not Clone, Deserialize or a VM export.
// The mock-only NSH host has no AppKit close/installer owner.
#[cfg_attr(
    not(all(target_os = "macos", feature = "macos-host")),
    allow(dead_code)
)]
pub struct Accepted {
    record: Record,
    journal: PathBuf,
}

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

#[cfg_attr(
    not(all(target_os = "macos", feature = "macos-host")),
    allow(dead_code)
)]
impl Offer {
    pub(super) fn verified(
        journal: PathBuf,
        source: Source,
        window: String,
        target: Value,
        from: String,
    ) -> Result<Self, Error> {
        let operation = uuid::Uuid::new_v4().to_string();
        let record = Record {
            loss_version: 1,
            confirmation: operation.clone(),
            operation,
            source,
            window,
            target,
            closed: false,
        };
        record.validate()?;
        Ok(Self {
            confirmation: Confirmation {
                id: record.confirmation.clone(),
                mode: Some(UpdateMode::Force),
                kind: UpdateKind::App,
                from,
                to: record.target["build"]
                    .as_str()
                    .ok_or(Error::Identity)?
                    .into(),
                pauses: None,
                keeps: None,
                restarts: true,
            },
            record,
            journal,
        })
    }
    pub fn confirmation(&self) -> &Confirmation {
        &self.confirmation
    }

    fn current(&self, id: &str, target: &Value, journal: &std::path::Path) -> Result<(), Error> {
        if id != self.confirmation.id || self.record.target != *target {
            return Err(Error::Stale);
        }
        if self.journal != journal {
            return Err(Error::Identity);
        }
        Ok(())
    }

    /// Called only by the current verified app owner. Check before writing consent.
    pub(super) async fn accept(
        self,
        id: &str,
        host: &super::NativeHost,
        target: &Value,
        journal: &std::path::Path,
    ) -> Result<Accepted, Error> {
        self.current(id, target, journal)?;
        if !host.loss_binding(&self.record.source, &self.journal) {
            return Err(Error::Identity);
        }
        let outcome = host
            .accept_update_loss(self.record.clone())
            .recv()
            .await
            .map_err(|_| Error::Unknown)??;
        if outcome.status != crate::model::OutcomeStatus::Accepted {
            return Err(Error::Unknown);
        }
        Ok(Accepted {
            record: self.record,
            journal: self.journal,
        })
    }

    #[cfg(test)]
    fn accept_offline(self, id: &str) -> Result<Accepted, Error> {
        self.current(id, &self.record.target, &self.journal)?;
        let mut journal = Journal::open(self.journal.clone())?;
        save(&mut journal, self.record.clone())?;
        Ok(Accepted {
            record: self.record,
            journal: self.journal,
        })
    }
}

pub(super) fn save(journal: &mut Journal, record: Record) -> Result<(), Error> {
    if journal.updates.contains_key(&record.operation)
        || journal.losses.contains_key(&record.operation)
        || journal.losses.values().any(|r| {
            r.source == record.source
                && journal
                    .updates
                    .get(&r.operation)
                    .is_none_or(|u| u.state != "done")
        })
        || journal
            .updates
            .values()
            .any(|r| r.source == record.source && !["done", "stopped"].contains(&r.state.as_str()))
    {
        return Err(Error::Unknown);
    }
    journal.save_loss(record)?;
    journal.finish()
}

#[cfg_attr(
    not(all(target_os = "macos", feature = "macos-host")),
    allow(dead_code)
)]
impl Accepted {
    pub(crate) fn window(&self) -> &str {
        &self.record.window
    }
    pub(crate) fn source(&self) -> &Source {
        &self.record.source
    }
    pub(crate) fn journal(&self) -> &std::path::Path {
        &self.journal
    }
    pub(super) fn record(&self) -> &Record {
        &self.record
    }
    /// Recheck before native loss/close dispatch, not merely after disposal.
    pub(super) fn matches_target(
        &self,
        target: &Value,
        journal: &std::path::Path,
    ) -> Result<(), Error> {
        if self.record.target != *target || self.journal != journal {
            return Err(Error::Identity);
        }
        Ok(())
    }
    /// Native close already joined. This writes history, never reconstructs authority.
    pub(crate) fn closed(&mut self) -> Result<(), Error> {
        let mut journal = Journal::open(self.journal.clone())?;
        self.record.closed = true;
        journal.save_loss(self.record.clone())?;
        journal.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> Result<Temp, std::io::Error> {
        let dir = std::env::temp_dir().join(format!("update-loss-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir)?;
        Ok(Temp(dir))
    }

    fn offer(path: PathBuf, build: &str) -> Offer {
        Offer::verified(
            path,
            Source {
                profile: PathBuf::from("/tmp/unused-loss-fixture"),
                port: 1,
                home: crate::contract::Home {
                    daemon_id: "daemon".into(),
                    lineage_id: "lineage".into(),
                },
                project: Some(crate::host::Project {
                    project_id: "project".into(),
                    project_path: "/project".into(),
                }),
            },
            uuid::Uuid::new_v4().to_string(),
            json!({"source":"a".repeat(40),"build":build}),
            "1.0".into(),
        )
        .unwrap()
    }

    #[test]
    fn cancel_and_stale_confirmation_never_write_loss() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal");
        drop(offer(path.clone(), "2.0"));
        assert!(!path.exists());
        assert!(matches!(
            offer(path.clone(), "2.0").accept_offline("old-confirmation"),
            Err(Error::Stale)
        ));
        assert!(!path.exists());
        let first = offer(path.clone(), "2.0");
        let id = first.confirmation().id.clone();
        assert_eq!(
            first.current(&id, &json!({"source":"a".repeat(40),"build":"3.0"}), &path),
            Err(Error::Stale)
        );
        let mut changed_bytes = first.record.target.clone();
        changed_bytes["sha256"] = "b".repeat(64).into();
        assert_eq!(
            first.current(&id, &changed_bytes, &path),
            Err(Error::Stale),
            "same version is not the same signed artifact"
        );
        assert_eq!(
            first.current(
                &id,
                &first.record.target,
                &dir.path().join("another-journal")
            ),
            Err(Error::Identity)
        );
        assert!(matches!(
            offer(path.clone(), "3.0").accept_offline(&id),
            Err(Error::Stale)
        ));
        assert!(!path.exists());
    }

    #[test]
    fn failed_consent_save_never_grants_close_and_reopen_is_lookup_only() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal");
        let offer = offer(path.clone(), "2.0");
        let record = offer.record.clone();
        {
            let mut journal = Journal::open(path.clone()).unwrap();
            journal.fail_after_sync = true;
            assert!(matches!(
                save(&mut journal, record.clone()),
                Err(Error::Storage)
            ));
            assert!(journal.is_failed());
        }
        let journal = Journal::open(path.clone()).unwrap();
        assert_eq!(journal.losses.get(&record.operation), Some(&record));
        drop(journal);
        let next = super::tests::offer(path, "2.0");
        let id = next.confirmation().id.clone();
        assert!(matches!(next.accept_offline(&id), Err(Error::Unknown)));
    }

    #[test]
    fn official_consent_force_rechecks_exact_target_before_native_loss_dispatch() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal");
        let offer = offer(path.clone(), "2.0");
        let id = offer.confirmation().id.clone();
        let accepted = offer.accept_offline(&id).unwrap();
        let target = accepted.record.target.clone();
        assert_eq!(accepted.matches_target(&target, &path), Ok(()));
        let mut different_bytes = target.clone();
        different_bytes["sha256"] = "b".repeat(64).into();
        assert_eq!(
            accepted.matches_target(&different_bytes, &path),
            Err(Error::Identity)
        );
        assert_eq!(
            accepted.matches_target(&target, &dir.path().join("other")),
            Err(Error::Identity)
        );
        let journal = Journal::open(path).unwrap();
        assert!(!journal.losses[&accepted.record.operation].closed);
        assert!(
            journal.updates.is_empty(),
            "accepted loss is not install entry"
        );
    }

    #[test]
    fn installer_loss_record_never_becomes_a_saved_view_or_changes_target() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal");
        let o = offer(path.clone(), "2.0");
        let id = o.confirmation().id.clone();
        let mut accepted = o.accept_offline(&id).unwrap();
        accepted.closed().unwrap();
        let loss = accepted.record.clone();
        let mut journal = Journal::open(path.clone()).unwrap();
        let record = super::super::updates::Record {
            order: 1,
            update_version: 2,
            id: loss.operation.clone(),
            source: loss.source.clone(),
            root: json!({"loss":loss,"officialNsh":loss.target,"preparation":{"operationId":loss.operation,
                "payload":json!({"acceptedLoss":loss.payload(),"app":{"source":loss.target["source"],"build":loss.target["build"]}}).to_string()}}),
            window: loss.window.clone(),
            kind: "app".into(),
            target: "2.0".into(),
            view: Value::Null,
            auth: "a".repeat(64),
            revision: 1,
            state: "capture".into(),
            flush: None,
            message: "Force accepted loss. No saved-view claim.".into(),
            restored: false,
            manifest: None,
        };
        assert_eq!(record.loss().unwrap(), Some(loss));
        journal.save_update(record.clone()).unwrap();
        for mutation in ["normal", "flush", "retarget", "restore"] {
            let mut changed = record.clone();
            match mutation {
                "normal" => changed.update_version = 1,
                "flush" => changed.flush = Some((1, 1)),
                "retarget" => changed.target = "3.0".into(),
                _ => changed.restored = true,
            }
            assert!(changed.validate().is_err(), "{mutation}");
        }
        drop(journal);
        assert_eq!(
            Journal::open(path).unwrap().updates.get(&record.id),
            Some(&record)
        );
    }

    #[tokio::test]
    async fn accepted_loss_survives_reopen_without_becoming_new_authority() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal");
        let o = offer(path.clone(), "2.0");
        let id = o.confirmation().id.clone();
        let mut accepted = o.accept_offline(&id).unwrap();
        let before = accepted.record.clone();
        {
            let journal = Journal::open(path.clone()).unwrap();
            assert_eq!(journal.losses.get(&before.operation), Some(&before));
            let mut state = super::super::updates::State::new(None);
            state.restore(&journal, &before.source).await;
            assert_eq!(state.snapshot().operation, before.operation);
            assert!(state.snapshot().restore.is_none());
            assert!(
                state
                    .snapshot()
                    .run
                    .unwrap()
                    .message
                    .contains("cannot confirm")
            );
        }
        let next = offer(path.clone(), "3.0");
        let id = next.confirmation().id.clone();
        assert!(matches!(next.accept_offline(&id), Err(Error::Unknown)));
        accepted.closed().unwrap();
        let journal = Journal::open(path).unwrap();
        assert!(journal.losses[&before.operation].closed);
        assert_eq!(
            journal.losses[&before.operation].payload()["unfinishedWork"],
            true
        );
    }
}

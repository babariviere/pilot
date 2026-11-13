//! Native root update status, never an install or state-loss capability.
use super::Error;
use crate::update::UpdateMode;
use pilot_desktop_updater::manifest::Trust;
use serde_json::Value;
use std::path::PathBuf;

/// Only the native bootstrap selects official distribution inputs. Startup only
/// records their location. The expensive signed preflight runs on an explicit
/// Check. Even a verified target cannot enable installation without independent
/// process checks under the dogfood update policy.
#[derive(Clone, Default)]
pub struct OfficialRoot {
    /// Selected input directory and journal path. Path hints, not trust.
    inputs: Option<(PathBuf, PathBuf)>,
    target: Option<Value>,
    failure: Option<Error>,
}

impl OfficialRoot {
    /// Records explicitly selected inputs without reading or verifying them.
    pub fn selected(directory: PathBuf, journal: PathBuf) -> Self {
        Self {
            inputs: Some((directory, journal)),
            ..Self::default()
        }
    }

    /// Verifies the selected inputs again. Blocking: call only from a worker
    /// thread for an explicit Check. The result is a diagnostic pin; the
    /// prepared private copies are dropped, and installation still reverifies.
    pub(super) fn checked(self, trust: Trust) -> Self {
        #[cfg(all(target_os = "macos", feature = "macos-host"))]
        if let Some((directory, journal)) = &self.inputs {
            let result = super::official_update::inspect_inputs(directory, trust, journal.clone());
            return Self {
                inputs: self.inputs.clone(),
                target: result.as_ref().ok().cloned(),
                failure: result.err(),
            };
        }
        let _ = trust;
        self
    }

    pub(super) fn pin(&self) -> Option<&Value> {
        self.target.as_ref()
    }

    pub(super) fn blocked(&self) -> &'static str {
        match (&self.inputs, self.pin(), self.failure) {
            (_, _, Some(_)) => {
                "The official update or rollback inputs could not be verified. Nothing was changed. Supply matching signed distributions before trying again."
            }
            (None, None, None) => {
                "The signed official update and rollback distributions are not selected. Nothing was changed."
            }
            (Some(_), None, None) => {
                "The signed official update and rollback inputs are not checked yet. Check verifies them. Nothing was changed."
            }
            (_, Some(_), None) => {
                "Signed update and rollback inputs verified. Updates stop known owned work; escaped descendants may remain. Nothing was paused or changed."
            }
        }
    }

    pub(super) fn authorize(&self, _mode: UpdateMode) -> Result<(), Error> {
        // This permits fresh consent/capture only. Install still checks signed
        // inputs again, host-owned pause, known process exit and the same lease.
        // Dogfood accepts escaped-descendant risk, not failure to stop known work.
        if self.inputs.is_some() && self.target.is_some() && self.failure.is_none() {
            Ok(())
        } else {
            Err(Error::Unavailable)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trust() -> Trust {
        Trust {
            repository: "synthetic/offline".into(),
            application_id: "com.example.synthetic.day".into(),
            channel: "desktop-stable".into(),
            current_build: "1.0".into(),
            bundle_name: "Pilot Next.app".into(),
            public_key: [42; 32],
            code_requirement: "identifier com.example.synthetic.day".into(),
        }
    }

    #[test]
    fn verified_exact_target_authorizes_dogfood_consent_not_process_success() {
        let target = serde_json::json!({"source":"a".repeat(40),"build":"2.0",
            "sha256":"b".repeat(64),"size":100,"version":"2.0.0","configHash":"c".repeat(64)});
        let root = OfficialRoot {
            inputs: Some((PathBuf::from("/inputs"), PathBuf::from("/journal"))),
            target: Some(target.clone()),
            failure: None,
        };
        assert_eq!(root.pin(), Some(&target));
        assert!(root.blocked().contains("escaped descendants may remain"));
        for mode in [UpdateMode::Normal, UpdateMode::Force] {
            assert_eq!(root.authorize(mode), Ok(()));
        }
    }

    #[test]
    fn missing_and_failed_inputs_are_not_process_or_signature_evidence() {
        let root = OfficialRoot::default();
        assert!(root.blocked().contains("not selected"));
        let failed = OfficialRoot {
            inputs: None,
            target: None,
            failure: Some(Error::Identity),
        };
        assert!(failed.pin().is_none());
        assert!(failed.blocked().contains("could not be verified"));
        assert_eq!(failed.authorize(UpdateMode::Force), Err(Error::Unavailable));
    }

    #[test]
    fn selected_inputs_stay_unchecked_until_an_explicit_check() {
        let missing =
            std::env::temp_dir().join(format!("official-inputs-{}", uuid::Uuid::new_v4()));
        let root = OfficialRoot::selected(missing.clone(), missing.join("journal"));
        assert!(root.pin().is_none());
        assert!(root.blocked().contains("not checked yet"));
        for mode in [UpdateMode::Normal, UpdateMode::Force] {
            assert_eq!(root.authorize(mode), Err(Error::Unavailable));
        }
        assert!(
            OfficialRoot::default()
                .checked(trust())
                .blocked()
                .contains("not selected")
        );
        #[cfg(all(target_os = "macos", feature = "macos-host"))]
        {
            let checked = std::thread::spawn(move || root.checked(trust()))
                .join()
                .unwrap();
            assert!(checked.pin().is_none());
            assert!(checked.blocked().contains("could not be verified"));
            assert_eq!(
                checked.authorize(UpdateMode::Force),
                Err(Error::Unavailable)
            );
        }
        assert!(
            !missing.exists(),
            "Check creates no inputs, journal or copies"
        );
    }
}

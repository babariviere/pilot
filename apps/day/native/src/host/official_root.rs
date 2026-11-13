//! Native root preflight status, never an install or state-loss capability.
use super::Error;
use crate::update::UpdateMode;
use serde_json::Value;

/// Only the native bootstrap selects official distribution inputs. Even a
/// verified target cannot enable installation without independent process proof.
#[derive(Clone, Default)]
pub struct OfficialRoot {
    target: Option<Value>,
    failure: Option<Error>,
}

impl OfficialRoot {
    #[cfg(all(target_os = "macos", feature = "macos-host"))]
    pub(crate) fn inspected(result: Result<Value, Error>) -> Self {
        match result {
            Ok(target) => Self {
                target: Some(target),
                failure: None,
            },
            Err(failure) => Self {
                target: None,
                failure: Some(failure),
            },
        }
    }

    pub(super) fn pin(&self) -> Option<&Value> {
        self.target.as_ref()
    }

    pub(super) fn blocked(&self) -> &'static str {
        match (self.pin(), self.failure) {
            (_, Some(_)) => {
                "The official update or rollback inputs could not be verified. Nothing was changed. Supply matching signed distributions before trying again."
            }
            (None, None) => {
                "The signed official update and rollback distributions are not selected. Nothing was changed."
            }
            (Some(_), None) => {
                "The signed update and rollback inputs were verified, but independent job and descendant shutdown proof is unavailable. Normal and Force update are disabled. Nothing was paused or changed."
            }
        }
    }

    pub(super) fn authorize(&self, _mode: UpdateMode) -> Result<(), Error> {
        // There is no approved native producer of descendant-exit proof yet.
        // Do not replace this with empty blockers, root/lease/group exit, EOF,
        // a cancellation ACK or retained JSON. Force changes preservation only.
        Err(Error::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_exact_target_still_cannot_authorize_normal_or_force() {
        let target = serde_json::json!({"source":"a".repeat(40),"build":"2.0",
            "sha256":"b".repeat(64),"size":100,"version":"2.0.0","configHash":"c".repeat(64)});
        let root = OfficialRoot {
            target: Some(target.clone()),
            failure: None,
        };
        assert_eq!(root.pin(), Some(&target));
        assert!(
            root.blocked()
                .contains("descendant shutdown proof is unavailable")
        );
        for mode in [UpdateMode::Normal, UpdateMode::Force] {
            assert_eq!(root.authorize(mode), Err(Error::Unavailable));
        }
    }

    #[test]
    fn missing_and_failed_inputs_are_not_process_or_signature_evidence() {
        let root = OfficialRoot::default();
        assert!(root.blocked().contains("not selected"));
        let failed = OfficialRoot {
            target: None,
            failure: Some(Error::Identity),
        };
        assert!(failed.pin().is_none());
        assert!(failed.blocked().contains("could not be verified"));
        assert_eq!(failed.authorize(UpdateMode::Force), Err(Error::Unavailable));
    }
}

use pilot_desktop_updater::*;
use std::time::Duration;

#[derive(Default)]
struct Synthetic {
    checks: Vec<(u64, Trigger)>,
    cancels: Vec<u64>,
    installs: Vec<u64>,
    stops: usize,
    check_error: Option<Error>,
    install_error: Option<Error>,
    unsupported: Option<Error>,
}

impl Backend for Synthetic {
    fn check(&mut self, operation: u64, trigger: Trigger) -> Result<(), Error> {
        self.checks.push((operation, trigger));
        self.check_error.map_or(Ok(()), Err)
    }
    fn cancel(&mut self, operation: u64) {
        self.cancels.push(operation);
    }
    fn install_support(&self) -> Result<(), Error> {
        self.unsupported.map_or(Ok(()), Err)
    }
    fn install(&mut self, operation: u64, _: &Candidate, safety: Safety) -> Result<(), Error> {
        safety.validate()?;
        self.installs.push(operation);
        self.install_error.map_or(Ok(()), Err)
    }
    fn teardown(&mut self) {
        self.stops += 1;
    }
}

fn now(seconds: u64) -> Duration {
    Duration::from_secs(seconds)
}
fn done(id: u64, outcome: Outcome) -> Completion {
    Completion {
        operation: id,
        outcome,
    }
}
fn candidate() -> Candidate {
    Candidate {
        version: "200.2".into(),
    }
}
fn safe() -> Safety {
    let receipt = Flush {
        requested: 7,
        acknowledged: Some(7),
        failed: false,
    };
    Safety {
        drafts: receipt,
        deliveries: receipt,
        settings: receipt,
        has_preedit: false,
        active_work: false,
        runtime: Runtime::Independent,
        quit_veto_installed: true,
    }
}
fn available() -> Updater<Synthetic> {
    let mut updater = Updater::new(Synthetic::default(), true, now(0));
    updater.check(Trigger::Manual, now(0)).unwrap();
    assert!(updater.complete(done(1, Outcome::Available(candidate())), now(1)));
    updater
}

#[test]
fn automatic_deadline_is_hourly_and_manual_does_not_wait() {
    let mut updater = Updater::new(Synthetic::default(), true, now(10));
    assert!(!updater.tick(now(9)).unwrap());
    assert!(updater.tick(now(10)).unwrap());
    assert_eq!(updater.next_deadline(), None);
    updater.complete(done(1, Outcome::Current), now(11));
    assert_eq!(updater.next_deadline(), Some(now(3611)));
    assert!(!updater.tick(now(3610)).unwrap());
    updater.check(Trigger::Manual, now(12)).unwrap();
    assert_eq!(
        updater.backend_mut().checks,
        [(1, Trigger::Automatic), (2, Trigger::Manual)]
    );
}

#[test]
fn disabling_automatic_is_not_cancellation_or_loss_of_manual_check() {
    let mut updater = Updater::new(Synthetic::default(), false, now(0));
    assert!(!updater.tick(now(9000)).unwrap());
    updater.check(Trigger::Manual, now(9000)).unwrap();
    updater.set_automatic(false);
    assert!(updater.backend_mut().cancels.is_empty());
    updater.complete(done(1, Outcome::Current), now(9001));
    assert_eq!(updater.next_deadline(), None);
    updater.set_automatic(true);
    assert_eq!(updater.next_deadline(), Some(now(12601)));
}

#[test]
fn offline_and_authentication_backoff_is_bounded_and_recovers() {
    let mut updater = Updater::new(Synthetic::default(), true, now(0));
    for (index, seconds) in [60, 120, 240, 480, 960, 1920, 3600, 3600]
        .into_iter()
        .enumerate()
    {
        updater.check(Trigger::Manual, now(0)).unwrap();
        updater.complete(
            done(
                index as u64 + 1,
                Outcome::Failed(if index % 2 == 0 {
                    Error::Offline
                } else {
                    Error::Authentication
                }),
            ),
            now(1),
        );
        assert_eq!(updater.next_deadline(), Some(now(1 + seconds)));
    }
    updater.check(Trigger::Manual, now(2)).unwrap();
    updater.complete(done(9, Outcome::Current), now(3));
    assert_eq!(updater.state(), &State::Current);
    assert_eq!(updater.next_deadline(), Some(now(3603)));
}

#[test]
fn native_start_failure_uses_same_typed_backoff_path() {
    let mut updater = Updater::new(
        Synthetic {
            check_error: Some(Error::Unconfigured),
            ..Default::default()
        },
        true,
        now(0),
    );
    assert_eq!(
        updater.check(Trigger::Manual, now(0)),
        Err(Error::Unconfigured)
    );
    assert_eq!(updater.state(), &State::Failed(Error::Unconfigured));
    assert_eq!(updater.next_deadline(), Some(now(60)));
}

#[test]
fn duplicate_and_cancelled_checks_do_not_overlap_physical_operation() {
    let mut updater = Updater::new(Synthetic::default(), true, now(0));
    updater.check(Trigger::Manual, now(0)).unwrap();
    assert_eq!(updater.check(Trigger::Manual, now(0)), Err(Error::Busy));
    updater.cancel(now(1)).unwrap();
    updater.cancel(now(1)).unwrap();
    assert_eq!(updater.state(), &State::Cancelling { operation: 1 });
    assert_eq!(updater.check(Trigger::Manual, now(1)), Err(Error::Busy));
    assert_eq!(updater.backend_mut().checks.len(), 1);
    assert_eq!(updater.backend_mut().cancels, [1]);
    updater.complete(done(1, Outcome::Available(candidate())), now(2));
    assert_eq!(updater.state(), &State::Cancelled);
    updater.check(Trigger::Manual, now(3)).unwrap();
    assert!(!updater.complete(done(1, Outcome::Failed(Error::Signature)), now(3)));
    assert_eq!(
        updater.state(),
        &State::Checking {
            operation: 2,
            trigger: Trigger::Manual
        }
    );
}

#[test]
fn each_security_failure_is_retained_and_never_installs() {
    for error in [
        Error::Signature,
        Error::Version,
        Error::Identity,
        Error::RedirectDenied,
        Error::InvalidResponse,
    ] {
        let mut updater = Updater::new(Synthetic::default(), false, now(0));
        updater.check(Trigger::Manual, now(0)).unwrap();
        updater.complete(done(1, Outcome::Failed(error)), now(1));
        assert_eq!(updater.state(), &State::Failed(error));
        assert_eq!(updater.request_install(safe()), Err(Error::Busy));
        assert!(updater.backend_mut().installs.is_empty());
    }
}

#[test]
fn available_is_not_verified_or_automatic_install_authority() {
    let mut updater = available();
    assert_eq!(updater.state(), &State::Available(candidate()));
    assert_eq!(updater.next_deadline(), None);
    assert!(!updater.tick(now(10000)).unwrap());
    assert!(updater.backend_mut().installs.is_empty());
    updater.cancel(now(10000)).unwrap();
    assert_eq!(updater.state(), &State::Cancelled);
    assert!(updater.backend_mut().installs.is_empty());
}

#[test]
fn each_persistence_owner_requires_its_exact_revision_acknowledgement() {
    for field in 0..3 {
        for failed in [false, true] {
            let mut updater = available();
            let mut safety = safe();
            let receipt = match field {
                0 => &mut safety.drafts,
                1 => &mut safety.deliveries,
                _ => &mut safety.settings,
            };
            receipt.acknowledged = Some(6);
            receipt.failed = failed;
            let reason = if failed {
                Error::PersistenceFailed
            } else {
                Error::PersistencePending
            };
            assert_eq!(updater.request_install(safety), Err(reason));
            assert_eq!(
                updater.state(),
                &State::Deferred {
                    candidate: candidate(),
                    reason
                }
            );
            assert!(updater.backend_mut().installs.is_empty());
            // Retry must capture a fresh acknowledged revision, not rely on elapsed time.
            updater.request_install(safe()).unwrap();
            assert_eq!(updater.backend_mut().installs.len(), 1);
        }
    }
}

#[test]
fn input_work_runtime_and_quit_veto_block_independently() {
    for reason in [
        Error::Preedit,
        Error::ActiveWork,
        Error::RuntimeUnverified,
        Error::QuitVetoUnavailable,
    ] {
        let mut updater = available();
        let mut safety = safe();
        match reason {
            Error::Preedit => safety.has_preedit = true,
            Error::ActiveWork => safety.active_work = true,
            Error::RuntimeUnverified => safety.runtime = Runtime::Unknown,
            _ => safety.quit_veto_installed = false,
        }
        assert_eq!(updater.request_install(safety), Err(reason));
        assert!(updater.backend_mut().installs.is_empty());
    }
    let mut safety = safe();
    safety.runtime = Runtime::SharedStopped {
        expected: 7,
        observed: 8,
    };
    assert_eq!(safety.validate(), Err(Error::RuntimeUnverified));
    safety.runtime = Runtime::SharedStopped {
        expected: 8,
        observed: 8,
    };
    assert_eq!(safety.validate(), Ok(()));
}

#[test]
fn native_transport_blocker_cannot_be_overridden_by_safety_booleans() {
    let mut updater = available();
    updater.backend_mut().unsupported = Some(Error::TransportUnavailable);
    assert_eq!(
        updater.request_install(safe()),
        Err(Error::TransportUnavailable)
    );
    assert!(updater.backend_mut().installs.is_empty());
}

#[test]
fn synthetic_verified_install_is_explicit_single_flight_and_recovers_from_failure() {
    // Synthetic backend only. Does not establish native signature/installation coverage.
    let mut updater = available();
    updater.backend_mut().install_error = Some(Error::InstallFailed);
    assert_eq!(updater.request_install(safe()), Err(Error::InstallFailed));
    updater.backend_mut().install_error = None;
    updater.request_install(safe()).unwrap();
    assert_eq!(updater.state(), &State::Installing { operation: 3 });
    assert_eq!(updater.request_install(safe()), Err(Error::Busy));
    assert_eq!(updater.cancel(now(4)), Err(Error::Busy));
    assert!(!updater.complete(done(2, Outcome::Installed), now(4)));
    updater.complete(done(3, Outcome::Installed), now(4));
    assert_eq!(updater.state(), &State::Installed);
    assert_eq!(updater.next_deadline(), None);
    assert_eq!(updater.check(Trigger::Manual, now(5)), Err(Error::Stopped));
}

#[test]
fn teardown_never_installs_and_stale_callbacks_cannot_restore_work() {
    let mut updater = available();
    updater.stop();
    updater.stop();
    assert_eq!(updater.backend_mut().stops, 1);
    assert!(!updater.complete(done(1, Outcome::Available(candidate())), now(9)));
    assert_eq!(updater.state(), &State::Stopped);
    assert!(updater.backend_mut().installs.is_empty());
    assert_eq!(updater.next_deadline(), None);
}

#[test]
fn install_completion_is_not_accepted_as_check_success() {
    let mut updater = Updater::new(Synthetic::default(), false, now(0));
    updater.check(Trigger::Manual, now(0)).unwrap();
    updater.complete(done(1, Outcome::Installed), now(1));
    assert_eq!(updater.state(), &State::Failed(Error::InvalidResponse));
}

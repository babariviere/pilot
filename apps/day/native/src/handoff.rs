//! Native app-only controller. The signed stage and helper control stay owned
//! through joined window close and actual process exit. No daemon reservation.
use crate::host::updates::Selection;
use pilot_desktop_updater::{
    Error, Flush, Runtime, Safety,
    app_update::{self, ExitGuard},
    helper::PreparedExit,
    installer::{self, Staged},
};

/// A retained startup intent is lookup-only. The native ACK is one-use too.
pub(crate) fn startup_ack_needed(phase: installer::Phase, entered: bool) -> Result<bool, Error> {
    match phase {
        installer::Phase::StartupAcknowledged => Ok(false),
        installer::Phase::Swapped | installer::Phase::RelaunchRequested if !entered => Ok(true),
        _ => Err(Error::RecoveryRequired),
    }
}

/// One helper launch and at most one COMMIT, including uncertain writes.
pub(crate) struct Controller {
    commit: Commit<NativeControl>,
}

struct NativeControl {
    _stage: Staged,
    guard: ExitGuard,
    helper: PreparedExit,
}
trait Control {
    fn verify(&self) -> Result<(), Error>;
    fn send(&mut self) -> Result<(), Error>;
}
impl Control for NativeControl {
    fn verify(&self) -> Result<(), Error> {
        self.guard.verify()
    }
    fn send(&mut self) -> Result<(), Error> {
        self.helper.commit()
    }
}
struct Commit<C> {
    control: C,
    commit_entered: bool,
}

pub(crate) fn safety(generation: u32, sequence: u64) -> Safety {
    let flush = Flush {
        requested: sequence,
        acknowledged: Some(sequence),
        failed: false,
    };
    // The native seal pins generation separately; zero is never a native capture.
    Safety {
        drafts: flush,
        deliveries: flush,
        settings: flush,
        has_preedit: generation == 0,
        active_work: false,
        runtime: Runtime::Independent,
        admissions_fenced: true,
    }
}

impl Controller {
    pub(crate) fn commit_entered(&self) -> bool {
        self.commit.commit_entered
    }
    pub(crate) fn prepare(
        selection: &Selection,
        navigation: &serde_json::Value,
        safety: Safety,
        current: impl Fn() -> Result<(), Error>,
    ) -> Result<Self, Error> {
        safety.validate()?;
        current()?;
        let app = selection.app.as_ref().ok_or(Error::Unconfigured)?;
        selection.verify_app().map_err(|_| Error::Identity)?;
        let lock = installer::lock_target(&selection.installed)?;
        let stage = Staged::reopen(&app.transaction, &app.target, &selection.trust, lock)?;
        let guard = ExitGuard::prepare_external(
            selection.connection.clone(),
            &app.target,
            &app.transaction,
            &app.build,
            &selection.trust,
        )?;
        guard.verify()?;
        app_update::save_navigation(&app.transaction, navigation)?;
        current()?; // save/verification I/O cannot preserve earlier authority
        let helper = PreparedExit::launch(&stage, |_| {})?;
        Ok(Self {
            commit: Commit {
                control: NativeControl {
                    _stage: stage,
                    guard,
                    helper,
                },
                commit_entered: false,
            },
        })
    }

    pub(crate) fn commit(
        &mut self,
        safety: Safety,
        current: impl FnOnce() -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.commit.commit(safety, current)
    }
}

impl<C: Control> Commit<C> {
    fn commit(
        &mut self,
        safety: Safety,
        current: impl FnOnce() -> Result<(), Error>,
    ) -> Result<(), Error> {
        if self.commit_entered {
            return Err(Error::CommitUncertain);
        }
        safety.validate()?;
        self.control.verify()?;
        // READY and guard reads may have taken time. Requalify at physical send.
        current()?;
        self.commit_entered = true;
        self.control.send()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        sends: usize,
        result: Result<(), Error>,
        verified: bool,
    }
    impl Control for Fake {
        fn verify(&self) -> Result<(), Error> {
            if self.verified {
                Ok(())
            } else {
                Err(Error::Identity)
            }
        }
        fn send(&mut self) -> Result<(), Error> {
            self.sends += 1;
            self.result
        }
    }
    fn ready(result: Result<(), Error>) -> Commit<Fake> {
        Commit {
            control: Fake {
                sends: 0,
                result,
                verified: true,
            },
            commit_entered: false,
        }
    }
    #[test]
    fn commit_ack_loss_never_resends() {
        for result in [Ok(()), Err(Error::CommitUncertain)] {
            let mut controller = ready(result);
            assert_eq!(controller.commit(safety(7, 12), || Ok(())), result);
            assert_eq!(
                controller.commit(safety(7, 12), || Ok(())),
                Err(Error::CommitUncertain)
            );
            assert_eq!(controller.control.sends, 1);
        }
    }
    #[test]
    fn ready_is_not_fresh_sealed_safety_or_authority() {
        let mut controller = ready(Ok(()));
        assert_eq!(
            controller.commit(safety(0, 12), || Ok(())),
            Err(Error::Preedit)
        );
        assert_eq!(
            controller.commit(safety(7, 12), || Err(Error::Identity)),
            Err(Error::Identity)
        );
        controller.control.verified = false;
        assert_eq!(
            controller.commit(safety(7, 12), || Ok(())),
            Err(Error::Identity)
        );
        assert_eq!(controller.control.sends, 0);
    }

    #[test]
    fn startup_ack_interruption_is_lookup_only() {
        use installer::Phase::*;
        for entered in [false, true] {
            assert_eq!(startup_ack_needed(StartupAcknowledged, entered), Ok(false));
            for phase in [Ready, Committed, Aborted] {
                assert_eq!(
                    startup_ack_needed(phase, entered),
                    Err(Error::RecoveryRequired)
                );
            }
        }
        for phase in [Swapped, RelaunchRequested] {
            assert_eq!(startup_ack_needed(phase, false), Ok(true));
            assert_eq!(
                startup_ack_needed(phase, true),
                Err(Error::RecoveryRequired)
            );
        }
    }
}

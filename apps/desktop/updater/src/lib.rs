//! App-owned updater. Signed metadata, controlled transport, explicit staged restart.
use std::time::Duration;
pub mod archive;
pub mod helper;
pub mod installer;
pub mod manifest;
pub mod transport;
#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub mod worker;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Unconfigured,
    Authentication,
    Offline,
    InvalidResponse,
    RedirectDenied,
    Identity,
    Version,
    Signature,
    Busy,
    Stopped,
    Exhausted,
    Native,
    Filesystem,
    Archive,
    Cancelled,
    PersistencePending,
    PersistenceFailed,
    Preedit,
    ActiveWork,
    RuntimeUnverified,
    AdmissionsNotFenced,
    InstallFailed,
    RecoveryRequired,
    CommitUncertain,
    ParentStillRunning,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    Automatic,
    Manual,
}
/// Signed metadata is authenticated; archive/bundle verification occurs during staging.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub version: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Work {
    Checking(Trigger),
    Downloading,
    PreparingExit,
    CommittingExit,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Current,
    Available(Candidate),
    Staged(Candidate),
    ExitPrepared,
    ExitCommitted,
    HelperStopped(Error),
    Failed(Error),
    Cancelled,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub operation: u64,
    pub outcome: Outcome,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Idle,
    Working { operation: u64, work: Work },
    Cancelling { operation: u64 },
    Current,
    Available(Candidate),
    ReadyToRestart(Candidate),
    Deferred { candidate: Candidate, reason: Error },
    ExitPrepared,
    ExitAuthorized,
    Failed(Error),
    RecoveryRequired(Error),
    Cancelled,
    Stopped,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flush {
    pub requested: u64,
    pub acknowledged: Option<u64>,
    pub failed: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Runtime {
    Independent,
    SharedStopped { expected: u64, observed: u64 },
    Unknown,
}
/// Integration holds these fences through COMMIT and actual process exit. No job is
/// stopped by this library. Unknown runtime/persistence state never grants permission.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Safety {
    pub drafts: Flush,
    pub deliveries: Flush,
    pub settings: Flush,
    pub has_preedit: bool,
    pub active_work: bool,
    pub runtime: Runtime,
    pub admissions_fenced: bool,
}
impl Safety {
    pub fn validate(&self) -> Result<(), Error> {
        for receipt in [self.drafts, self.deliveries, self.settings] {
            if receipt.failed {
                return Err(Error::PersistenceFailed);
            }
            if receipt.acknowledged != Some(receipt.requested) {
                return Err(Error::PersistencePending);
            }
        }
        if self.has_preedit {
            return Err(Error::Preedit);
        }
        if self.active_work {
            return Err(Error::ActiveWork);
        }
        if !self.admissions_fenced {
            return Err(Error::AdmissionsNotFenced);
        }
        if !matches!(self.runtime, Runtime::Independent)
            && !matches!(self.runtime, Runtime::SharedStopped { expected, observed } if expected == observed)
        {
            return Err(Error::RuntimeUnverified);
        }
        Ok(())
    }
}

/// All methods enqueue bounded off-UI work, never wait. Completion means quiescent.
pub trait Backend {
    fn check(&mut self, operation: u64, trigger: Trigger) -> Result<(), Error>;
    fn download(&mut self, operation: u64, candidate: &Candidate) -> Result<(), Error>;
    fn prepare_exit(&mut self, operation: u64, safety: Safety) -> Result<(), Error>;
    fn commit_exit(&mut self, operation: u64, safety: Safety) -> Result<(), Error>;
    fn cancel(&mut self, operation: u64);
    fn teardown(&mut self);
}

pub struct Updater<B: Backend> {
    backend: B,
    state: State,
    automatic: bool,
    next_check: Duration,
    failures: u32,
    sequence: u64,
    staged: Option<Candidate>,
    helper_operation: Option<u64>,
}
impl<B: Backend> Updater<B> {
    pub fn new(backend: B, automatic: bool, now: Duration) -> Self {
        Self {
            backend,
            state: State::Idle,
            automatic,
            next_check: now,
            failures: 0,
            sequence: 0,
            staged: None,
            helper_operation: None,
        }
    }
    pub fn state(&self) -> &State {
        &self.state
    }
    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }
    pub fn next_deadline(&self) -> Option<Duration> {
        (self.automatic
            && matches!(
                self.state,
                State::Idle | State::Current | State::Failed(_) | State::Cancelled
            ))
        .then_some(self.next_check)
    }
    pub fn set_automatic(&mut self, value: bool) {
        self.automatic = value;
    }
    pub fn tick(&mut self, now: Duration) -> Result<bool, Error> {
        if self.next_deadline().is_some_and(|deadline| now >= deadline) {
            self.check(Trigger::Automatic, now)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
    fn start(&mut self, work: Work) -> Result<u64, Error> {
        self.sequence = self.sequence.checked_add(1).ok_or(Error::Exhausted)?;
        self.state = State::Working {
            operation: self.sequence,
            work,
        };
        Ok(self.sequence)
    }
    pub fn check(&mut self, trigger: Trigger, now: Duration) -> Result<(), Error> {
        if !matches!(
            self.state,
            State::Idle
                | State::Current
                | State::Failed(_)
                | State::Cancelled
                | State::Available(_)
        ) {
            return Err(Error::Busy);
        }
        let operation = self.start(Work::Checking(trigger))?;
        if let Err(error) = self.backend.check(operation, trigger) {
            self.complete(
                Completion {
                    operation,
                    outcome: Outcome::Failed(error),
                },
                now,
            );
            return Err(error);
        }
        Ok(())
    }
    /// Explicit download/stage intent. Does not arm a helper or mutate the live app.
    pub fn download(&mut self, now: Duration) -> Result<(), Error> {
        let State::Available(candidate) = &self.state else {
            return Err(Error::Busy);
        };
        let candidate = candidate.clone();
        let operation = self.start(Work::Downloading)?;
        if let Err(error) = self.backend.download(operation, &candidate) {
            self.complete(
                Completion {
                    operation,
                    outcome: Outcome::Failed(error),
                },
                now,
            );
            return Err(error);
        }
        Ok(())
    }
    /// Prepare an explicit restart. Fresh safety is required again before COMMIT.
    pub fn request_install(&mut self, safety: Safety, now: Duration) -> Result<(), Error> {
        let candidate = match &self.state {
            State::ReadyToRestart(candidate) | State::Deferred { candidate, .. } => {
                candidate.clone()
            }
            _ => return Err(Error::Busy),
        };
        if let Err(reason) = safety.validate() {
            self.state = State::Deferred { candidate, reason };
            return Err(reason);
        }
        let operation = self.start(Work::PreparingExit)?;
        if let Err(error) = self.backend.prepare_exit(operation, safety) {
            self.complete(
                Completion {
                    operation,
                    outcome: Outcome::Failed(error),
                },
                now,
            );
            return Err(error);
        }
        Ok(())
    }
    /// After this acknowledges, integration may request a CLEAN quit, retaining all
    /// admission fences. This library never terminates the app or a daemon itself.
    pub fn commit_exit(&mut self, safety: Safety, now: Duration) -> Result<(), Error> {
        if self.state != State::ExitPrepared {
            return Err(Error::Busy);
        }
        safety.validate()?;
        let operation = self.start(Work::CommittingExit)?;
        if let Err(error) = self.backend.commit_exit(operation, safety) {
            self.complete(
                Completion {
                    operation,
                    outcome: Outcome::Failed(error),
                },
                now,
            );
            return Err(error);
        }
        Ok(())
    }
    pub fn cancel(&mut self, now: Duration) -> Result<(), Error> {
        match self.state {
            State::Working {
                operation,
                work: Work::Checking(_) | Work::Downloading,
            } => {
                self.state = State::Cancelling { operation };
                self.backend.cancel(operation);
                Ok(())
            }
            State::Cancelling { .. } => Ok(()),
            State::Working { .. }
            | State::ExitPrepared
            | State::ExitAuthorized
            | State::RecoveryRequired(_) => Err(Error::Busy),
            State::Stopped => Err(Error::Stopped),
            _ => {
                self.next_check = now.saturating_add(Duration::from_secs(3600));
                self.state = State::Cancelled;
                Ok(())
            }
        }
    }
    pub fn complete(&mut self, completion: Completion, now: Duration) -> bool {
        if let Outcome::HelperStopped(reason) = completion.outcome {
            if self.helper_operation != Some(completion.operation) {
                return false;
            }
            self.helper_operation = None;
            self.state = if self.state == State::ExitPrepared {
                match &self.staged {
                    Some(candidate) => State::Deferred {
                        candidate: candidate.clone(),
                        reason,
                    },
                    None => State::Failed(reason),
                }
            } else {
                State::RecoveryRequired(reason)
            };
            return true;
        }
        let (operation, work) = match self.state {
            State::Working { operation, work } => (operation, Some(work)),
            State::Cancelling { operation } => (operation, None),
            _ => return false,
        };
        if operation != completion.operation {
            return false;
        }
        if work.is_none() {
            self.state = State::Cancelled;
            self.next_check = now.saturating_add(Duration::from_secs(3600));
            return true;
        }
        let outcome = match (work, completion.outcome) {
            (_, Outcome::Failed(error)) => Err(error),
            (Some(Work::Checking(_) | Work::Downloading), Outcome::Cancelled) => {
                Ok(State::Cancelled)
            }
            (Some(Work::Checking(_)), Outcome::Current) => Ok(State::Current),
            (Some(Work::Checking(_)), Outcome::Available(candidate)) => {
                Ok(State::Available(candidate))
            }
            (Some(Work::Downloading), Outcome::Staged(candidate)) => {
                self.staged = Some(candidate.clone());
                Ok(State::ReadyToRestart(candidate))
            }
            (Some(Work::PreparingExit), Outcome::ExitPrepared) => {
                self.helper_operation = Some(operation);
                Ok(State::ExitPrepared)
            }
            (Some(Work::CommittingExit), Outcome::ExitCommitted) => Ok(State::ExitAuthorized),
            _ => Err(Error::InvalidResponse),
        };
        self.state = match outcome {
            Ok(state) => {
                self.failures = 0;
                self.next_check = now.saturating_add(Duration::from_secs(3600));
                state
            }
            Err(error) if work == Some(Work::CommittingExit) => State::RecoveryRequired(error),
            Err(error) if work == Some(Work::PreparingExit) => match &self.staged {
                Some(candidate) => State::Deferred {
                    candidate: candidate.clone(),
                    reason: error,
                },
                _ => State::Failed(error),
            },
            Err(error) => {
                self.failures = self.failures.saturating_add(1);
                self.next_check = now.saturating_add(Duration::from_secs(
                    (60_u64 << self.failures.saturating_sub(1).min(6)).min(3600),
                ));
                State::Failed(error)
            }
        };
        true
    }
    pub fn stop(&mut self) {
        if self.state != State::Stopped {
            self.backend.teardown();
            self.state = State::Stopped;
        }
    }
}
impl<B: Backend> Drop for Updater<B> {
    fn drop(&mut self) {
        if self.state != State::Stopped {
            self.backend.teardown();
        }
    }
}

#[cfg(test)]
#[path = "../tests/owned.rs"]
mod owned_tests;

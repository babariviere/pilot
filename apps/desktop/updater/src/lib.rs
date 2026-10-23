//! Update scheduling and safety protocol, independent of GPUI and its UI lifetime.
//! Native installation is deliberately unavailable. See README.md for the blockers.
use std::time::Duration;

#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub mod macos;

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
    PersistencePending,
    PersistenceFailed,
    Preedit,
    ActiveWork,
    RuntimeUnverified,
    QuitVetoUnavailable,
    TransportUnavailable,
    InstallFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    Automatic,
    Manual,
}

/// An appcast offer is NOT proof that the archive has a valid signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Current,
    Available(Candidate),
    Failed(Error),
    Cancelled,
    Installed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub operation: u64,
    pub outcome: Outcome,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Idle,
    Checking { operation: u64, trigger: Trigger },
    Cancelling { operation: u64 },
    Current,
    Available(Candidate),
    Deferred { candidate: Candidate, reason: Error },
    Installing { operation: u64 },
    Failed(Error),
    Cancelled,
    Installed,
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
    /// No running process uses any resource in the bundle being replaced.
    Independent,
    /// Integration must hold admission closed and validate the same stopped generation.
    SharedStopped {
        expected: u64,
        observed: u64,
    },
    Unknown,
}

/// Snapshot from integration, taken while edits and new admissions are fenced.
/// This is a protocol, not permission to stop any user work or daemon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Safety {
    pub drafts: Flush,
    pub deliveries: Flush,
    pub settings: Flush,
    pub has_preedit: bool,
    pub active_work: bool,
    pub runtime: Runtime,
    pub quit_veto_installed: bool,
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
        if !matches!(self.runtime, Runtime::Independent)
            && !matches!(self.runtime, Runtime::SharedStopped { expected, observed } if expected == observed)
        {
            return Err(Error::RuntimeUnverified);
        }
        if !self.quit_veto_installed {
            return Err(Error::QuitVetoUnavailable);
        }
        Ok(())
    }
}

/// Backends must not report completion until their operation is quiescent.
/// No I/O or waiting in these methods. Native callbacks are drained by the host.
pub trait Backend {
    fn check(&mut self, operation: u64, trigger: Trigger) -> Result<(), Error>;
    fn cancel(&mut self, operation: u64);
    fn install_support(&self) -> Result<(), Error>;
    fn install(
        &mut self,
        operation: u64,
        candidate: &Candidate,
        safety: Safety,
    ) -> Result<(), Error>;
    fn teardown(&mut self);
}

pub struct Updater<B: Backend> {
    backend: B,
    state: State,
    automatic: bool,
    next_check: Duration,
    failures: u32,
    sequence: u64,
}

impl<B: Backend> Updater<B> {
    /// The host supplies a monotonic clock and one cancellable deadline wakeup.
    pub fn new(backend: B, automatic: bool, now: Duration) -> Self {
        Self {
            backend,
            state: State::Idle,
            automatic,
            next_check: now,
            failures: 0,
            sequence: 0,
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
            && !self.busy()
            && !matches!(
                self.state,
                State::Stopped | State::Installed | State::Available(_) | State::Deferred { .. }
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

    fn busy(&self) -> bool {
        matches!(
            self.state,
            State::Checking { .. } | State::Cancelling { .. } | State::Installing { .. }
        )
    }

    fn operation(&mut self) -> Result<u64, Error> {
        self.sequence = self.sequence.checked_add(1).ok_or(Error::Exhausted)?;
        Ok(self.sequence)
    }

    pub fn check(&mut self, trigger: Trigger, now: Duration) -> Result<(), Error> {
        if matches!(self.state, State::Stopped | State::Installed) {
            return Err(Error::Stopped);
        }
        if self.busy() {
            return Err(Error::Busy);
        }
        let operation = self.operation()?;
        self.state = State::Checking { operation, trigger };
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

    /// Cancellation retains single-flight until the backend acknowledges quiescence.
    pub fn cancel(&mut self, now: Duration) -> Result<(), Error> {
        match self.state {
            State::Checking { operation, .. } => {
                self.state = State::Cancelling { operation };
                self.backend.cancel(operation);
                Ok(())
            }
            State::Installing { .. } => Err(Error::Busy),
            State::Cancelling { .. } => Ok(()),
            State::Stopped | State::Installed => Err(Error::Stopped),
            _ => {
                self.next_check = now.saturating_add(Duration::from_secs(3600));
                self.state = State::Cancelled;
                Ok(())
            }
        }
    }

    /// Stale/reordered callbacks cannot complete another check or installation.
    pub fn complete(&mut self, completion: Completion, now: Duration) -> bool {
        let (operation, installing, cancelling) = match self.state {
            State::Checking { operation, .. } => (operation, false, false),
            State::Cancelling { operation } => (operation, false, true),
            State::Installing { operation } => (operation, true, false),
            _ => return false,
        };
        if operation != completion.operation {
            return false;
        }
        let outcome = if cancelling {
            Outcome::Cancelled
        } else {
            completion.outcome
        };
        let outcome = match outcome {
            Outcome::Installed if !installing => Outcome::Failed(Error::InvalidResponse),
            Outcome::Available(_) | Outcome::Current | Outcome::Cancelled if installing => {
                Outcome::Failed(Error::InvalidResponse)
            }
            outcome => outcome,
        };
        self.state = match outcome {
            Outcome::Failed(error) => {
                self.failures = self.failures.saturating_add(1);
                let seconds = (60_u64 << self.failures.saturating_sub(1).min(6)).min(3600);
                self.next_check = now.saturating_add(Duration::from_secs(seconds));
                State::Failed(error)
            }
            Outcome::Installed if installing => State::Installed,
            Outcome::Installed => State::Failed(Error::InvalidResponse),
            Outcome::Available(candidate) if !installing => {
                self.failures = 0;
                State::Available(candidate)
            }
            Outcome::Current if !installing => {
                self.failures = 0;
                self.next_check = now.saturating_add(Duration::from_secs(3600));
                State::Current
            }
            Outcome::Cancelled if !installing => {
                self.next_check = now.saturating_add(Duration::from_secs(3600));
                State::Cancelled
            }
            _ => State::Failed(Error::InvalidResponse),
        };
        true
    }

    /// Explicit user intent only. Never invoked by tick or ordinary teardown/quit.
    pub fn request_install(&mut self, safety: Safety) -> Result<(), Error> {
        let candidate = match &self.state {
            State::Available(candidate) | State::Deferred { candidate, .. } => candidate.clone(),
            State::Stopped => return Err(Error::Stopped),
            _ => return Err(Error::Busy),
        };
        let validation = safety
            .validate()
            .and_then(|()| self.backend.install_support());
        if let Err(reason) = validation {
            self.state = State::Deferred { candidate, reason };
            return Err(reason);
        }
        let operation = self.operation()?;
        match self.backend.install(operation, &candidate, safety) {
            Ok(()) => {
                self.state = State::Installing { operation };
                Ok(())
            }
            Err(reason) => {
                self.state = State::Deferred { candidate, reason };
                Err(reason)
            }
        }
    }

    pub fn stop(&mut self) {
        if self.state == State::Stopped {
            return;
        }
        self.backend.teardown();
        self.state = State::Stopped;
    }
}

impl<B: Backend> Drop for Updater<B> {
    fn drop(&mut self) {
        if self.state != State::Stopped {
            self.backend.teardown();
        }
    }
}

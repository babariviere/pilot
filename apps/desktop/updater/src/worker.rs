//! One bounded background worker, one outstanding command/result, no idle polling.
use crate::{
    Backend, Candidate, Completion, Error, Outcome, Safety, Trigger,
    helper::{PreparedExit, compiled_trust},
    installer::{self, NativePlatform, Platform},
    transport::{Access, Cancellation, Transport},
};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
};

enum Job {
    Check(u64, Option<Access>, Cancellation),
    Download(u64, Candidate, Option<Access>, Cancellation),
    Prepare(u64, Safety, Option<crate::coordination::Location>),
    Commit(u64, Safety),
    Abort(u64),
    HelperStopped(u64, Error),
    Shutdown,
}
impl Job {
    fn operation(&self) -> u64 {
        match self {
            Self::Check(id, ..)
            | Self::Download(id, ..)
            | Self::Prepare(id, ..)
            | Self::Commit(id, ..) => *id,
            Self::Abort(id) => *id,
            Self::HelperStopped(id, _) => *id,
            Self::Shutdown => 0,
        }
    }
}

pub type Recovery = Result<Vec<(PathBuf, installer::Phase)>, Error>;
pub struct Worker {
    sender: Option<SyncSender<Job>>,
    receiver: Option<Receiver<Completion>>,
    access: Option<Access>,
    cancellation: Option<(u64, Cancellation)>,
    stopped: Arc<AtomicBool>,
    runtime: Option<crate::coordination::Location>,
    recovery: Option<Receiver<Recovery>>,
}
impl Worker {
    /// No defaults or credential probing. Both GUI and helper need the same compiled
    /// release identity/key contract. Construction does not perform file/network I/O.
    pub fn for_running_app(wakeup: impl Fn() + Send + Sync + 'static) -> Result<Self, Error> {
        let trust = compiled_trust()?;
        let target = crate::layout::running_root()?;
        let (sender, jobs) = mpsc::sync_channel::<Job>(1);
        let (results, receiver) = mpsc::sync_channel(1);
        let (recovery_send, recovery_receive) = mpsc::sync_channel(1);
        let stopped = Arc::new(AtomicBool::new(false));
        let shutdown = stopped.clone();
        let event_sender = sender.clone();
        std::thread::Builder::new()
            .name("desktop-updater".into())
            .spawn(move || {
                let recovery = NativePlatform
                    .verify(&target, &trust, &trust.current_build, None)
                    .and_then(|()| installer::recoveries(&target, &trust));
                if recovery_send.send(recovery).is_err() {
                    return;
                }
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(&wakeup));
                let mut verified = None;
                let mut staged = None;
                let mut prepared = None;
                let mut helper_operation = None;
                let mut runtime_guard: Option<crate::coordination::Guard> = None;
                let mut commit_attempted = false;
                while let Ok(job) = jobs.recv() {
                    if shutdown.load(Ordering::Acquire) || matches!(job, Job::Shutdown) {
                        break;
                    }
                    if matches!(job, Job::HelperStopped(id, _) if helper_operation != Some(id)) {
                        continue;
                    }
                    let operation = job.operation();
                    let result = (|| match job {
                        Job::Check(_, access, cancel) => {
                            prepared = None;
                            helper_operation = None;
                            staged = None;
                            let release =
                                Transport::new()?.discover(&trust, access.as_ref(), &cancel)?;
                            let outcome = match &release {
                                Some(release) => Outcome::Available(Candidate {
                                    version: release.manifest().build.clone(),
                                }),
                                None => Outcome::Current,
                            };
                            verified = release;
                            Ok(outcome)
                        }
                        Job::Download(_, candidate, access, cancel) => {
                            let release = verified.as_ref().ok_or(Error::Identity)?;
                            if release.manifest().build != candidate.version {
                                return Err(Error::Version);
                            }
                            let target: PathBuf =
                                target.canonicalize().map_err(|_| Error::Filesystem)?;
                            let (root, lock) =
                                installer::new_stage(&target, &trust, &NativePlatform)?;
                            let preparation = (|| {
                                Transport::new()?.download(
                                    release,
                                    &trust,
                                    access.as_ref(),
                                    &root.join("archive.zip"),
                                    &cancel,
                                )?;
                                installer::finish_stage(
                                    root.clone(),
                                    target.clone(),
                                    lock,
                                    release.clone(),
                                    &trust,
                                    &NativePlatform,
                                    &cancel,
                                )
                            })();
                            match preparation {
                                Ok(stage) => staged = Some(stage),
                                Err(error) => {
                                    // Never erase a durable/pending journal on failure.
                                    if installer::discard_incomplete(&root, &target).is_err() {
                                        return Err(Error::RecoveryRequired);
                                    }
                                    return Err(error);
                                }
                            }
                            Ok(Outcome::Staged(candidate))
                        }
                        Job::Prepare(id, safety, runtime) => {
                            safety.validate_client()?;
                            if prepared.is_some() {
                                return Err(Error::Busy);
                            }
                            installer::validate_target(&target, &trust)?;
                            NativePlatform.verify(&target, &trust, &trust.current_build, None)?;
                            let stage = staged.as_ref().ok_or(Error::Identity)?;
                            if let Some(old) = runtime_guard.take() {
                                old.cancel();
                            }
                            let guard = crate::coordination::Guard::prepare(
                                runtime.ok_or(Error::RuntimeUnverified)?,
                                &stage.root.join("payload").join(&trust.bundle_name),
                                &stage.root,
                                stage.build(),
                                &trust,
                            )?;
                            guard.save()?;
                            runtime_guard = Some(guard);
                            let sender = event_sender.clone();
                            let stopped = shutdown.clone();
                            prepared = Some(PreparedExit::launch(
                                staged.as_ref().ok_or(Error::Identity)?,
                                move |error| {
                                    if !stopped.load(Ordering::Acquire) {
                                        let _ = sender.send(Job::HelperStopped(id, error));
                                    }
                                },
                            )?);
                            helper_operation = Some(id);
                            Ok(Outcome::ExitPrepared)
                        }
                        Job::Commit(_, safety) => {
                            safety.validate_client()?;
                            runtime_guard
                                .as_ref()
                                .ok_or(Error::RuntimeUnverified)?
                                .verify()?;
                            commit_attempted = true;
                            prepared.as_mut().ok_or(Error::Identity)?.commit()?;
                            Ok(Outcome::ExitCommitted)
                        }
                        Job::Abort(_) => {
                            prepared = None;
                            helper_operation = None;
                            if let Some(guard) = runtime_guard.take() {
                                guard.cancel();
                            }
                            Ok(Outcome::ExitAborted)
                        }
                        Job::HelperStopped(_, error) => {
                            prepared = None;
                            helper_operation = None;
                            Ok(Outcome::HelperStopped(error))
                        }
                        Job::Shutdown => unreachable!(),
                    })();
                    let outcome = match result {
                        Ok(outcome) => outcome,
                        Err(Error::Cancelled) => Outcome::Cancelled,
                        Err(error) => Outcome::Failed(error),
                    };
                    if shutdown.load(Ordering::Acquire) {
                        break;
                    }
                    if results.send(Completion { operation, outcome }).is_err() {
                        break;
                    }
                    // Integration callback only schedules a foreground wakeup. It must not
                    // execute UI work here. Panics cannot unwind across worker ownership.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(&wakeup));
                }
                if !commit_attempted && let Some(guard) = runtime_guard {
                    guard.cancel();
                }
            })
            .map_err(|_| Error::Native)?;
        Ok(Self {
            sender: Some(sender),
            receiver: Some(receiver),
            access: None,
            cancellation: None,
            stopped,
            runtime: None,
            recovery: Some(recovery_receive),
        })
    }
    pub fn supply_access(&mut self, access: Access) {
        self.access = Some(access);
    }
    pub fn clear_access(&mut self) {
        self.access = None;
    }
    pub(crate) fn abort_exit(&mut self, operation: u64) -> Result<(), Error> {
        self.send(Job::Abort(operation))
    }
    pub fn supply_runtime(&mut self, runtime: crate::coordination::Location) {
        self.runtime = Some(runtime);
    }
    pub fn take_completion(&mut self) -> Option<Completion> {
        let completion = self.receiver.as_ref()?.try_recv().ok()?;
        self.cancellation = None;
        Some(completion)
    }
    pub fn take_recovery(&mut self) -> Option<Recovery> {
        self.recovery.as_ref()?.try_recv().ok()
    }
    fn send(&mut self, job: Job) -> Result<(), Error> {
        self.sender
            .as_ref()
            .ok_or(Error::Stopped)?
            .try_send(job)
            .map_err(|_| Error::Busy)
    }
}
impl Backend for Worker {
    fn check(&mut self, operation: u64, _trigger: Trigger) -> Result<(), Error> {
        let access = self.access.take();
        let cancel = Cancellation::default();
        self.cancellation = Some((operation, cancel.clone()));
        self.send(Job::Check(operation, access, cancel))
    }
    fn download(&mut self, operation: u64, candidate: &Candidate) -> Result<(), Error> {
        let access = self.access.take();
        let cancel = Cancellation::default();
        self.cancellation = Some((operation, cancel.clone()));
        self.send(Job::Download(operation, candidate.clone(), access, cancel))
    }
    fn prepare_exit(&mut self, operation: u64, safety: Safety) -> Result<(), Error> {
        self.send(Job::Prepare(operation, safety, self.runtime.clone()))
    }
    fn commit_exit(&mut self, operation: u64, safety: Safety) -> Result<(), Error> {
        self.send(Job::Commit(operation, safety))
    }
    fn cancel(&mut self, operation: u64) {
        if let Some((id, cancel)) = &self.cancellation
            && *id == operation
        {
            cancel.cancel();
        }
    }
    fn teardown(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.access = None;
        if let Some((_, cancel)) = self.cancellation.take() {
            cancel.cancel();
        }
        if let Some(sender) = self.sender.take() {
            let _ = sender.try_send(Job::Shutdown);
        }
        self.receiver = None; // unblock any pending result send; never strand the worker
        self.recovery = None;
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.teardown();
    }
}

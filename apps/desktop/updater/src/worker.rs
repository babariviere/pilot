//! One bounded background worker, one outstanding command/result, no idle polling.
use crate::{
    Backend, Candidate, Completion, Error, Outcome, Progress, Safety, Trigger,
    helper::{PreparedExit, compiled_trust},
    installer::{self, NativePlatform, Platform},
    transport::{Access, Cancellation, Transport},
};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    time::{Duration, Instant},
};

/// Wakes the UI at most this often while bytes arrive.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
type Shared = Arc<Mutex<Option<(u64, Progress)>>>;
fn report(shared: &Shared, operation: u64, progress: Option<Progress>) {
    if let Ok(mut slot) = shared.lock() {
        *slot = progress.map(|progress| (operation, progress));
    }
}

enum Job {
    Inspect,
    Check(u64, Option<Access>, Cancellation),
    Download(u64, Candidate, Option<Access>, Cancellation),
    Local(u64, PathBuf, Cancellation),
    Prepare(
        u64,
        Safety,
        Option<crate::coordination::Location>,
        Option<crate::app_update::Connection>,
        bool,
        serde_json::Value,
    ),
    Commit(u64, Safety),
    Abort(u64),
    HelperStopped(u64, Error),
    Shutdown,
}
impl Job {
    fn operation(&self) -> u64 {
        match self {
            Self::Local(id, ..)
            | Self::Check(id, ..)
            | Self::Download(id, ..)
            | Self::Prepare(id, ..)
            | Self::Commit(id, ..) => *id,
            Self::Abort(id) => *id,
            Self::HelperStopped(id, _) => *id,
            Self::Shutdown | Self::Inspect => 0,
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
    external: Option<crate::app_update::Connection>,
    ui_only: bool,
    navigation: serde_json::Value,
    recovery: Option<Receiver<Recovery>>,
    progress: Shared,
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
        let progress = Shared::default();
        let reporter = progress.clone();
        std::thread::Builder::new()
            .name("desktop-updater".into())
            .spawn(move || {
                let inspect = || {
                    NativePlatform.verify(&target, &trust, &trust.current_build, None)?;
                    // Only Ready with no live target owner is eligible for existing cleanup.
                    let _ = installer::discard_uncommitted(&target, &trust);
                    installer::reconcile_recovery(&target, &trust, &NativePlatform)
                };
                let recovery = inspect();
                if recovery_send.send(recovery).is_err() {
                    return;
                }
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(&wakeup));
                let wake = || {
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(&wakeup));
                };
                let mut verified = None;
                let mut staged = None;
                let mut prepared = None;
                let mut helper_operation = None;
                let mut runtime_guard: Option<crate::app_update::ExitGuard> = None;
                let mut commit_attempted = false;
                while let Ok(job) = jobs.recv() {
                    if shutdown.load(Ordering::Acquire) || matches!(job, Job::Shutdown) {
                        break;
                    }
                    if matches!(job, Job::HelperStopped(id, _) if helper_operation != Some(id)) {
                        continue;
                    }
                    if matches!(job, Job::Inspect) {
                        let _ = recovery_send.send(inspect());
                        wake();
                        continue;
                    }
                    let operation = job.operation();
                    let result = (|| match job {
                        Job::Check(_, access, cancel) => {
                            prepared = None;
                            helper_operation = None;
                            staged = None;
                            let _ = recovery_send.try_send(inspect());
                            wake();
                            let release =
                                Transport::new()?.discover(&trust, access.as_ref(), &cancel)?;
                            let outcome = match &release {
                                Some(release) => Outcome::Available(Candidate {
                                    version: release.manifest().build.clone(),
                                    short_version: release.manifest().short_version.clone(),
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
                            let total = release.manifest().archive_size;
                            report(
                                &reporter,
                                operation,
                                Some(Progress::Transferring { received: 0, total }),
                            );
                            let target: PathBuf =
                                target.canonicalize().map_err(|_| Error::Filesystem)?;
                            let (root, lock) =
                                installer::new_stage(&target, &trust, &NativePlatform)?;
                            let preparation = (|| {
                                let mut woken = Instant::now();
                                Transport::new()?.download(
                                    release,
                                    &trust,
                                    access.as_ref(),
                                    &installer::download_path(&root)?,
                                    &cancel,
                                    &mut |received| {
                                        report(
                                            &reporter,
                                            operation,
                                            Some(Progress::Transferring { received, total }),
                                        );
                                        if woken.elapsed() >= PROGRESS_INTERVAL {
                                            woken = Instant::now();
                                            wake();
                                        }
                                    },
                                )?;
                                report(&reporter, operation, Some(Progress::Verifying));
                                wake();
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
                        Job::Local(_, directory, cancel) => {
                            let stage = crate::iteration::stage(
                                &directory,
                                &target,
                                &trust,
                                &NativePlatform,
                                &cancel,
                            )?;
                            let candidate = Candidate {
                                version: stage.build().into(),
                                short_version: stage.short_version().into(),
                            };
                            staged = Some(stage);
                            Ok(Outcome::Staged(candidate))
                        }
                        Job::Prepare(id, safety, runtime, external, ui_only, navigation) => {
                            safety.validate_client()?;
                            if prepared.is_some() {
                                return Err(Error::Busy);
                            }
                            installer::validate_target(&target, &trust)?;
                            NativePlatform.verify(&target, &trust, &trust.current_build, None)?;
                            let stage = staged.as_ref().ok_or(Error::Identity)?;
                            // Downloading can coexist with old uncertainty; activation cannot.
                            if installer::recoveries(&target, &trust)?
                                .iter()
                                .any(|(root, _)| root != &stage.root)
                            {
                                return Err(Error::RecoveryRequired);
                            }
                            if let Some(old) = runtime_guard.take() {
                                old.cancel();
                            }
                            let guard = if let Some(connection) = external {
                                crate::app_update::ExitGuard::prepare_external(
                                    connection,
                                    &target,
                                    &stage.root,
                                    stage.build(),
                                    &trust,
                                )?
                            } else {
                                let location = runtime.ok_or(Error::RuntimeUnverified)?;
                                let candidate = installer::preview_bundle(&stage.root, &trust)?;
                                let guard = if ui_only {
                                    crate::coordination::Guard::prepare_ui(
                                        location,
                                        &candidate,
                                        &stage.root,
                                        stage.build(),
                                        &trust,
                                    )?
                                } else {
                                    crate::coordination::Guard::prepare(
                                        location,
                                        &candidate,
                                        &stage.root,
                                        stage.build(),
                                        &trust,
                                    )?
                                };
                                guard.save()?;
                                crate::app_update::ExitGuard::Retained(guard)
                            };
                            if let Err(error) =
                                crate::app_update::save_navigation(&stage.root, &navigation)
                            {
                                guard.cancel();
                                return Err(error);
                            }
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
                        Job::Shutdown | Job::Inspect => unreachable!(),
                    })();
                    let outcome = match result {
                        Ok(outcome) => outcome,
                        Err(Error::Cancelled) => Outcome::Cancelled,
                        Err(error) => Outcome::Failed(error),
                    };
                    report(&reporter, operation, None);
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
            external: None,
            ui_only: false,
            navigation: serde_json::Value::Null,
            recovery: Some(recovery_receive),
            progress,
        })
    }
    /// The latest progress of this download operation; `None` before it starts or after it ends.
    pub fn progress(&self, operation: u64) -> Option<Progress> {
        self.progress
            .lock()
            .ok()
            .and_then(|slot| *slot)
            .filter(|(id, _)| *id == operation)
            .map(|(_, progress)| progress)
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
    pub fn supply_external(&mut self, connection: crate::app_update::Connection) {
        self.external = Some(connection);
        self.runtime = None;
    }
    pub fn supply_navigation(&mut self, navigation: serde_json::Value) {
        self.navigation = navigation;
    }
    pub fn ui_only(&mut self, value: bool) {
        self.ui_only = value;
    }
    pub(crate) fn stage_local(&mut self, operation: u64, directory: PathBuf) -> Result<(), Error> {
        let cancel = Cancellation::default();
        self.cancellation = Some((operation, cancel.clone()));
        self.send(Job::Local(operation, directory, cancel))
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
    /// Refresh existing evidence only. Never arms or replays an install.
    pub fn inspect_recovery(&mut self) -> Result<(), Error> {
        self.send(Job::Inspect)
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
        self.send(Job::Prepare(
            operation,
            safety,
            self.runtime.clone(),
            self.external.clone(),
            self.ui_only,
            self.navigation.clone(),
        ))
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

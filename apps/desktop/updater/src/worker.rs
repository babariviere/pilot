//! One bounded background worker, one outstanding command/result, no idle polling.
use crate::{
    Backend, Candidate, Completion, Error, Outcome, Safety, Trigger,
    helper::{PreparedExit, compiled_trust},
    installer::{self, MacPlatform, Platform},
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
    Check(u64, Access, Cancellation),
    Download(u64, Candidate, Access, Cancellation),
    Prepare(u64, Safety),
    Commit(u64, Safety),
}
impl Job {
    fn operation(&self) -> u64 {
        match self {
            Self::Check(id, ..)
            | Self::Download(id, ..)
            | Self::Prepare(id, ..)
            | Self::Commit(id, ..) => *id,
        }
    }
}

pub struct Worker {
    sender: Option<SyncSender<Job>>,
    receiver: Receiver<Completion>,
    access: Option<Access>,
    cancellation: Option<(u64, Cancellation)>,
    stopped: Arc<AtomicBool>,
}
impl Worker {
    /// No defaults or credential probing. Both GUI and helper need the same compiled
    /// release identity/key contract. Construction does not perform file/network I/O.
    pub fn for_running_app(wakeup: impl Fn() + Send + Sync + 'static) -> Result<Self, Error> {
        let trust = compiled_trust()?;
        let executable = std::env::current_exe().map_err(|_| Error::Unconfigured)?;
        let target = executable
            .ancestors()
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name == trust.bundle_name.as_str())
            })
            .ok_or(Error::Unconfigured)?
            .to_owned();
        let (sender, jobs) = mpsc::sync_channel(1);
        let (results, receiver) = mpsc::sync_channel(1);
        let stopped = Arc::new(AtomicBool::new(false));
        let shutdown = stopped.clone();
        std::thread::Builder::new()
            .name("desktop-updater".into())
            .spawn(move || {
                let mut verified = None;
                let mut staged = None;
                let mut prepared = None;
                while let Ok(job) = jobs.recv() {
                    if shutdown.load(Ordering::Acquire) {
                        break;
                    }
                    let operation = job.operation();
                    let result = (|| match job {
                        Job::Check(_, access, cancel) => {
                            prepared = None;
                            staged = None;
                            let release = Transport::new()?.discover(&trust, &access, &cancel)?;
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
                            let (root, lock) = installer::new_stage(&target, &trust, &MacPlatform)?;
                            Transport::new()?.download(
                                release,
                                &trust,
                                &access,
                                &root.join("archive.zip"),
                                &cancel,
                            )?;
                            staged = Some(installer::finish_stage(
                                root,
                                target,
                                lock,
                                release.clone(),
                                &trust,
                                &MacPlatform,
                                &cancel,
                            )?);
                            Ok(Outcome::Staged(candidate))
                        }
                        Job::Prepare(_, safety) => {
                            safety.validate()?;
                            if prepared.is_some() {
                                return Err(Error::Busy);
                            }
                            MacPlatform.verify(&target, &trust, &trust.current_build, None)?;
                            prepared = Some(PreparedExit::launch(
                                staged.as_ref().ok_or(Error::Identity)?,
                            )?);
                            Ok(Outcome::ExitPrepared)
                        }
                        Job::Commit(_, safety) => {
                            safety.validate()?;
                            prepared.as_mut().ok_or(Error::Identity)?.commit()?;
                            Ok(Outcome::ExitCommitted)
                        }
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
            })
            .map_err(|_| Error::Native)?;
        Ok(Self {
            sender: Some(sender),
            receiver,
            access: None,
            cancellation: None,
            stopped,
        })
    }
    pub fn supply_access(&mut self, access: Access) {
        self.access = Some(access);
    }
    pub fn take_completion(&mut self) -> Option<Completion> {
        let completion = self.receiver.try_recv().ok()?;
        self.cancellation = None;
        Some(completion)
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
        let access = self.access.take().ok_or(Error::Authentication)?;
        let cancel = Cancellation::default();
        self.cancellation = Some((operation, cancel.clone()));
        self.send(Job::Check(operation, access, cancel))
    }
    fn download(&mut self, operation: u64, candidate: &Candidate) -> Result<(), Error> {
        let access = self.access.take().ok_or(Error::Authentication)?;
        let cancel = Cancellation::default();
        self.cancellation = Some((operation, cancel.clone()));
        self.send(Job::Download(operation, candidate.clone(), access, cancel))
    }
    fn prepare_exit(&mut self, operation: u64, safety: Safety) -> Result<(), Error> {
        self.send(Job::Prepare(operation, safety))
    }
    fn commit_exit(&mut self, operation: u64, safety: Safety) -> Result<(), Error> {
        self.send(Job::Commit(operation, safety))
    }
    fn cancel(&mut self, operation: u64) {
        if let Some((id, cancel)) = &self.cancellation {
            if *id == operation {
                cancel.cancel();
            }
        }
    }
    fn teardown(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.access = None;
        if let Some((_, cancel)) = self.cancellation.take() {
            cancel.cancel();
        }
        self.sender = None;
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.teardown();
    }
}

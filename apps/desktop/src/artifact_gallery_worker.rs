//! One bounded actor serves all visible image requests. It never evaluates artifact source.
use crate::{LocalOptions, artifact_gallery::Thumbnail, artifact_model::Reference};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

struct Job {
    attempt: u64,
    reference: Reference,
}
pub(crate) enum Outcome {
    Ready(Thumbnail),
    Failed(&'static str),
    Cancelled,
}
pub(crate) struct Update {
    job: Job,
    outcome: Outcome,
}
impl Update {
    pub(crate) fn into_parts(self) -> (u64, Reference, Outcome) {
        (self.job.attempt, self.job.reference, self.outcome)
    }
}
pub(crate) struct Worker {
    commands: async_channel::Sender<Job>,
    cancel: async_channel::Sender<()>,
    _lifetime: async_channel::Sender<()>,
    finished: async_channel::Receiver<()>,
    token: Arc<AtomicU64>,
    owner: String,
    pending: Option<u64>,
}
impl Worker {
    pub(crate) fn start(
        options: LocalOptions,
        owner: String,
    ) -> Result<(Self, async_channel::Receiver<Update>), &'static str> {
        Self::start_with_runtime(options, owner, || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
        })
    }
    fn start_with_runtime(
        options: LocalOptions,
        owner: String,
        make_runtime: impl FnOnce() -> Result<tokio::runtime::Runtime, std::io::Error> + Send + 'static,
    ) -> Result<(Self, async_channel::Receiver<Update>), &'static str> {
        let (commands, jobs) = async_channel::bounded(1);
        let (updates, output) = async_channel::bounded(1);
        let (lifetime, cancelled) = async_channel::bounded(1);
        let (cancel, changed) = async_channel::bounded(1);
        let (done, finished) = async_channel::bounded(1);
        let token = Arc::new(AtomicU64::new(0));
        let actor_token = token.clone();
        let command_lane = jobs.clone();
        std::thread::Builder::new()
            .name("artifact-thumbnails".into())
            .spawn(move || {
                let _done = done;
                if let Ok(runtime) = make_runtime() {
                    runtime.block_on(run(options, jobs, updates, cancelled, changed, actor_token));
                }
                // Includes failed runtime construction. Producer-side liveness cannot outlive this actor.
                command_lane.close();
            })
            .map_err(|_| "Cannot start artifact thumbnails.")?;
        Ok((
            Self {
                commands,
                cancel,
                _lifetime: lifetime,
                finished,
                token,
                owner,
                pending: None,
            },
            output,
        ))
    }
    /// A result acknowledgment is required before the next request, bounding output retention.
    pub(crate) fn load(&mut self, reference: Reference, attempt: u64) -> Result<(), &'static str> {
        if self.pending.is_some() || attempt == 0 {
            return Err("A thumbnail request is already finishing.");
        }
        if reference.kind != "image" || reference.session != self.owner {
            return Err("Thumbnail requires exact current-chat image metadata.");
        }
        self.token.store(attempt, Ordering::Release);
        self.pending = Some(attempt);
        if self.commands.try_send(Job { attempt, reference }).is_err() {
            self.pending = None;
            self.token.store(0, Ordering::Release);
            return Err("The thumbnail reader is unavailable.");
        }
        Ok(())
    }
    pub(crate) fn complete(&mut self, attempt: u64) {
        if self.pending == Some(attempt) {
            self.pending = None;
        }
    }
    pub(crate) fn cancel(&self) {
        self.token.store(0, Ordering::Release);
        let _ = self.cancel.try_send(());
    }
    pub(crate) fn finished(&self) -> async_channel::Receiver<()> {
        self.finished.clone()
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.cancel();
    }
}
async fn run(
    options: LocalOptions,
    jobs: async_channel::Receiver<Job>,
    updates: async_channel::Sender<Update>,
    lifetime: async_channel::Receiver<()>,
    changed: async_channel::Receiver<()>,
    token: Arc<AtomicU64>,
) {
    loop {
        let job = tokio::select! { biased; _ = lifetime.recv() => break, job = jobs.recv() => match job { Ok(job) => job, Err(_) => break } };
        // An old cancellation wake is not authority to cancel this new attempt.
        while changed.try_recv().is_ok() {}
        let stop = || lifetime.is_closed() || token.load(Ordering::Acquire) != job.attempt;
        let outcome = if stop() {
            Outcome::Cancelled
        } else {
            let result = tokio::select! { biased;
                _ = lifetime.recv() => break,
                _ = async { while changed.recv().await.is_ok() { if stop() { break; } } } => Err("Thumbnail cancelled."),
                result = read(&options, &job.reference, &stop) => result,
            };
            if stop() {
                Outcome::Cancelled
            } else {
                match result {
                    Ok(thumbnail) => Outcome::Ready(thumbnail),
                    Err(message) => Outcome::Failed(message),
                }
            }
        };
        if lifetime.is_closed() {
            break;
        }
        // read() has returned: its source/full raster and global permit are already gone.
        let update = Update { job, outcome };
        tokio::select! { biased; _ = lifetime.recv() => break, result = updates.send(update) => if result.is_err() { break; } }
    }
}
async fn read(
    options: &LocalOptions,
    reference: &Reference,
    stop: &impl Fn() -> bool,
) -> Result<Thumbnail, &'static str> {
    if stop() {
        return Err("Thumbnail cancelled.");
    }
    let _permit = crate::artifact_image::Permit::acquire()?;
    let revision = crate::local_client::artifact(options, reference).await?;
    if stop() {
        return Err("Thumbnail cancelled.");
    }
    let raster = crate::artifact_image::decode(&revision.source, stop)?;
    Thumbnail::from_raster(&raster, stop)
}

#[cfg(test)]
#[path = "artifact_gallery_worker_tests.rs"]
mod tests;

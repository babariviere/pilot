//! The selected chat's running background jobs, read from the received session
//! summary (Swift JobsPanel/WorkingLine). Stop uses the existing
//! POST /api/sessions/:id/jobs/:jobId/stop; nothing launches or restarts jobs.
use crate::LocalOptions;
use serde_json::Value;
use std::{sync::Arc, time::Duration};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Job {
    pub(crate) id: String,
    pub(crate) name: String,
    /// Epoch milliseconds.
    pub(crate) started_at: i64,
    /// Runtime-local log path, shown and copied as reported.
    pub(crate) output_path: String,
}

/// runningJobs in server order. Entries without an ID, name or start are
/// skipped rather than guessed; a repeated ID keeps its first entry.
pub(crate) fn read(value: &Value) -> Arc<[Job]> {
    let mut jobs: Vec<Job> = Vec::new();
    for job in value["runningJobs"].as_array().into_iter().flatten() {
        let (Some(id), Some(name), Some(started)) = (
            job["id"].as_str().filter(|id| !id.is_empty()),
            job["name"].as_str(),
            job["startedAt"].as_f64(),
        ) else {
            continue;
        };
        if (!job["state"].is_null() && job["state"] != "running") || jobs.iter().any(|j| j.id == id)
        {
            continue;
        }
        jobs.push(Job {
            id: id.into(),
            name: crate::local_model::bounded(if name.is_empty() { id } else { name }, 240),
            started_at: started as i64,
            output_path: job["outputPath"].as_str().unwrap_or_default().into(),
        });
    }
    jobs.into()
}

/// Swift WorkingLine.compactElapsed: "12s", "4m", "1h 5m" or "2h".
pub(crate) fn elapsed(milliseconds: i64) -> String {
    let seconds = milliseconds.max(0) / 1000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    if seconds < 3600 {
        return format!("{}m", seconds / 60);
    }
    match (seconds / 60) % 60 {
        0 => format!("{}h", seconds / 3600),
        minutes => format!("{}h {minutes}m", seconds / 3600),
    }
}

/// Swift WorkingLine.spokenElapsed, for accessible names.
pub(crate) fn spoken(milliseconds: i64) -> String {
    let seconds = milliseconds.max(0) / 1000;
    let unit = |n: i64, name: &str| format!("{n} {name}{}", if n == 1 { "" } else { "s" });
    if seconds < 60 {
        return unit(seconds, "second");
    }
    if seconds < 3600 {
        return unit(seconds / 60, "minute");
    }
    match (seconds / 60) % 60 {
        0 => unit(seconds / 3600, "hour"),
        minutes => format!(
            "{} {}",
            unit(seconds / 3600, "hour"),
            unit(minutes, "minute")
        ),
    }
}

/// When a compact elapsed time next changes: every second for the first
/// minute, then on each whole minute since the start. Epoch milliseconds.
pub(crate) fn next_change(now: i64, started_at: i64) -> i64 {
    let elapsed = (now - started_at).max(0);
    let step = if elapsed < 60_000 { 1000 } else { 60_000 };
    started_at + (elapsed / step + 1) * step
}

pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The longest-running job, which the collapsed strip names (Swift's working line).
pub(crate) fn oldest(jobs: &[Job]) -> Option<&Job> {
    jobs.iter().min_by_key(|job| job.started_at)
}

pub(crate) fn count(n: usize) -> String {
    format!("{n} {} running", if n == 1 { "job" } else { "jobs" })
}

/// "~/..." for paths under the user's home, as Swift's abbreviatingHome.
pub(crate) fn abbreviate(path: &str, home: Option<&str>) -> String {
    match home.filter(|home| !home.is_empty() && *home != "/") {
        Some(home) => match path.strip_prefix(home) {
            Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
            _ => path.into(),
        },
        None => path.into(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stop {
    Pending,
    /// 202: the worker stops it; the row stays until the summary drops the job.
    Accepted,
    /// 404: it already ended; the summary will drop it.
    Ended,
    /// No acknowledgment. Never retried automatically.
    Failed(&'static str),
}

pub(crate) fn stop_url(options: &LocalOptions, session: &str, job: &str) -> Option<String> {
    if !crate::local_model::valid_id(session) || job.is_empty() {
        return None;
    }
    let mut url = reqwest::Url::parse(&options.loopback()).ok()?;
    url.path_segments_mut()
        .ok()?
        .extend(["api", "sessions", session, "jobs", job, "stop"]);
    Some(url.into())
}

async fn stop(client: &reqwest::Client, options: &LocalOptions, session: &str, job: &str) -> Stop {
    let Some(url) = stop_url(options, session, job) else {
        return Stop::Failed("This job can't be stopped from here.");
    };
    if crate::local_client::hello(client, options).await.is_err() {
        return Stop::Failed("Local is unavailable. Nothing was sent.");
    }
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await;
    match response.map(|r| r.status().as_u16()) {
        Ok(202) => Stop::Accepted,
        Ok(404) => Stop::Ended,
        Ok(503) => Stop::Failed("Local is paused. The job keeps running."),
        _ => Stop::Failed("Stop wasn't confirmed. It wasn't retried."),
    }
}

type Request = (String, String, async_channel::Sender<Stop>);

/// One off-UI thread for the window's stop requests, in order.
pub(crate) struct Worker {
    pub(crate) options: LocalOptions,
    requests: async_channel::Sender<Request>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.requests.close();
    }
}
impl Worker {
    pub(crate) fn start(options: LocalOptions) -> Option<Self> {
        let (requests, rx) = async_channel::bounded::<Request>(8);
        let thread_options = options.clone();
        std::thread::Builder::new()
            .name("local-job-stop".into())
            .spawn(move || {
                let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    return;
                };
                rt.block_on(async move {
                    let Ok(client) = reqwest::Client::builder()
                        .no_proxy()
                        .retry(reqwest::retry::never())
                        .redirect(reqwest::redirect::Policy::none())
                        .connect_timeout(Duration::from_secs(2))
                        .timeout(Duration::from_secs(10))
                        .build()
                    else {
                        return;
                    };
                    while let Ok((session, job, reply)) = rx.recv().await {
                        let _ =
                            reply.try_send(stop(&client, &thread_options, &session, &job).await);
                    }
                });
            })
            .ok()?;
        Some(Self { options, requests })
    }
    pub(crate) fn stop(&self, session: &str, job: &str) -> async_channel::Receiver<Stop> {
        let (tx, rx) = async_channel::bounded(1);
        if let Err(error) = self.requests.try_send((session.into(), job.into(), tx)) {
            let (_, _, tx) = error.into_inner();
            let _ = tx.try_send(Stop::Failed("Too many stop requests. Nothing was sent."));
        }
        rx
    }
}

#[cfg(test)]
#[path = "session_jobs_tests.rs"]
mod tests;

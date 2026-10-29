//! Event loop for the existing pipe protocol. Blocking operations run on a separate worker.
use crate::{guardian::GuardianLease, protocol, support::LEASE};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    io::Write,
    sync::mpsc,
    time::{Duration, Instant},
};

pub(crate) fn run<P: Operations, W: Write>(
    mut runtime: Runtime<P, W>,
    rx: mpsc::Receiver<Event>,
) -> Runtime<P, W> {
    let start = Instant::now();
    while !runtime.stopping {
        match rx.recv_timeout(runtime.until_tick(start.elapsed())) {
            Ok(event) => runtime.event(event, start.elapsed()),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                runtime.event(Event::Stop, start.elapsed())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        runtime.tick(start.elapsed());
    }
    runtime
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sample {
    pub available: bool,
    pub authorized: bool,
    pub connected_to_power: bool,
    pub wifi_connected: bool,
    pub online: bool,
    pub lid_closed: Option<bool>,
    pub sleeping: bool,
    pub full_wake: bool,
    pub wake_token: String,
    pub sleep_generation: u64,
    pub closed_lid_active: bool,
    #[serde(rename = "type")]
    pub kind: &'static str,
}
impl Default for Sample {
    fn default() -> Self {
        Self {
            available: false,
            authorized: false,
            connected_to_power: false,
            wifi_connected: false,
            online: false,
            lid_closed: None,
            sleeping: false,
            full_wake: false,
            wake_token: "0:0".into(),
            sleep_generation: 0,
            closed_lid_active: false,
            kind: "state",
        }
    }
}

pub(crate) enum Event {
    Sample(Sample),
    Frame(Value),
    Stop,
    Ready {
        authorized: bool,
    },
    Activity {
        id: i64,
        awake: bool,
        closed: bool,
        ok: bool,
        permission: Option<bool>,
    },
    Authorized {
        id: i64,
        ok: bool,
    },
}
pub(crate) trait Operations {
    fn set_awake(&mut self, on: bool) -> bool;
    fn allow_sleep(&mut self, generation: u64);
    fn heartbeat(&mut self);
    fn activity(&mut self, id: i64, awake: bool, closed: bool);
    fn authorize(&mut self, id: i64);
    fn sleep_closed_lid(&mut self) -> bool;
    fn shutdown(&mut self);
}

pub(crate) struct Runtime<P, W> {
    pub ops: P,
    pub output: W,
    pub sample: Sample,
    pub authorized: bool,
    pub closed_lid_active: bool,
    pub stopping: bool,
    ready: bool,
    last_report: Option<Sample>,
    lease: GuardianLease,
    unsafe_cutoff: Option<Duration>,
    sleeps: Vec<(i64, u8, Duration)>,
}
impl<P: Operations, W: Write> Runtime<P, W> {
    pub fn new(ops: P, output: W) -> Self {
        Self {
            ops,
            output,
            sample: Sample::default(),
            authorized: false,
            closed_lid_active: false,
            stopping: false,
            ready: false,
            last_report: None,
            lease: GuardianLease::new(Duration::ZERO),
            unsafe_cutoff: None,
            sleeps: Vec::new(),
        }
    }
    pub fn event(&mut self, event: Event, now: Duration) {
        if self.stopping {
            return;
        }
        match event {
            Event::Frame(value) => self.command(value, now),
            Event::Stop => self.shutdown(),
            Event::Sample(sample) => {
                self.sample = sample;
                self.report(now);
            }
            Event::Ready { authorized } => {
                self.ready = true;
                self.authorized = authorized;
                self.report(now);
            }
            Event::Authorized { id, ok } => {
                self.authorized = ok;
                self.report(now);
                protocol::reply(&mut self.output, id, ok);
            }
            Event::Activity {
                id,
                awake,
                closed,
                ok,
                permission,
            } => {
                if ok {
                    self.closed_lid_active = closed;
                } else {
                    self.authorized = permission.unwrap_or(false);
                    self.closed_lid_active |= closed;
                }
                let assertion_ok = self.ops.set_awake(awake && ok);
                self.report(now);
                protocol::reply(&mut self.output, id, ok && assertion_ok);
            }
        }
    }
    pub fn command(&mut self, value: Value, now: Duration) {
        let Some(action) = value["action"].as_str() else {
            self.shutdown();
            return;
        };
        if action == "heartbeat" {
            self.lease.heartbeat(now);
            self.ops.heartbeat();
            return;
        }
        let Some(id) = value["id"].as_i64() else {
            self.shutdown();
            return;
        };
        match action {
            "allowSleep" => {
                let ok = if let Some(generation) = value["generation"].as_u64() {
                    self.ops.allow_sleep(generation);
                    true
                } else {
                    false
                };
                protocol::reply(&mut self.output, id, ok);
            }
            "authorize" => self.ops.authorize(id),
            "activity" => {
                if let (Some(awake), Some(closed)) =
                    (value["awake"].as_bool(), value["closedLid"].as_bool())
                {
                    self.ops.activity(id, awake, closed);
                } else {
                    protocol::reply(&mut self.output, id, false);
                }
            }
            "sleep" => self.request_sleep(id, 6, now),
            _ => protocol::reply(&mut self.output, id, false),
        }
    }
    fn report(&mut self, now: Duration) {
        let unsafe_lid = self.closed_lid_active
            && self.sample.lid_closed == Some(true)
            && (!self.sample.connected_to_power || !self.sample.wifi_connected);
        if unsafe_lid {
            if self.unsafe_cutoff.is_none() {
                self.unsafe_cutoff = Some(now + LEASE);
            }
        } else {
            self.unsafe_cutoff = None;
        }
        let mut sample = self.sample.clone();
        sample.available &= self.ready;
        sample.authorized = self.authorized;
        sample.closed_lid_active = self.closed_lid_active;
        if self.last_report.as_ref() != Some(&sample) {
            let _ = protocol::emit(&mut self.output, &json!(sample));
            self.last_report = Some(sample);
        }
    }
    fn request_sleep(&mut self, id: i64, attempts: u8, now: Duration) {
        if self.closed_lid_active || self.sample.lid_closed != Some(true) {
            protocol::reply(&mut self.output, id, true);
            return;
        }
        let ok = self.ops.sleep_closed_lid();
        if !ok && attempts > 1 {
            self.sleeps
                .push((id, attempts - 1, now + Duration::from_millis(500)));
        } else {
            protocol::reply(&mut self.output, id, ok);
        }
    }
    pub fn tick(&mut self, now: Duration) {
        if self.stopping {
            return;
        }
        if self.lease.tick(now) || self.unsafe_cutoff.is_some_and(|deadline| now >= deadline) {
            self.shutdown();
            return;
        }
        let mut index = 0;
        while index < self.sleeps.len() {
            if self.sleeps[index].2 <= now {
                let (id, attempts, _) = self.sleeps.remove(index);
                self.request_sleep(id, attempts, now);
            } else {
                index += 1;
            }
        }
    }
    pub fn until_tick(&self, now: Duration) -> Duration {
        let mut wait = self.lease.until_check(now);
        for deadline in self.sleeps.iter().map(|v| v.2).chain(self.unsafe_cutoff) {
            wait = wait.min(deadline.saturating_sub(now));
        }
        wait
    }
    fn shutdown(&mut self) {
        if self.stopping {
            return;
        }
        self.stopping = true;
        self.ops.set_awake(false);
        self.ops.allow_sleep(self.sample.sleep_generation);
        self.ops.shutdown();
    }
}

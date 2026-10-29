//! Guardian state is independent of daemon responsiveness and the monitoring process.
use crate::{
    protocol::{self, Frames},
    support::{HEARTBEAT, LEASE, OverrideWriter, SleepOverride},
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    sync::mpsc,
    time::{Duration, Instant},
};

pub(crate) trait LidSleep {
    fn restore_lid_sleep(&mut self);
}

pub(crate) fn restore<W: OverrideWriter + LidSleep>(state: &mut SleepOverride<W>) -> bool {
    let owned = state.owns_override();
    let ok = state.set_enabled(false);
    if ok && owned {
        state.writer.restore_lid_sleep();
    }
    ok
}

pub(crate) fn read_frames(
    input: impl Read + Send + 'static,
    limit: usize,
    send: impl Fn(Option<Value>) + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut frames = Frames::new(input, 8192).line_limit(limit);
        while let Ok(Some(value)) = frames.next() {
            send(Some(value));
        }
        send(None);
    });
}

pub(crate) fn run<W: OverrideWriter + LidSleep>(
    state: &mut SleepOverride<W>,
    input: impl Read + Send + 'static,
    output: &mut impl Write,
) {
    if !restore(state) {
        let _ = protocol::emit(output, &json!({"ok":false}));
        return;
    }
    if protocol::emit(output, &json!({"ok":true})).is_err() {
        return;
    }
    let (tx, rx) = mpsc::channel();
    read_frames(input, 4096, move |value| {
        let _ = tx.send(value);
    });
    let start = Instant::now();
    let mut lease = GuardianLease::new(Duration::ZERO);
    loop {
        let now = start.elapsed();
        if lease.tick(now) {
            break;
        }
        match rx.recv_timeout(lease.until_check(now)) {
            Ok(Some(value)) if value["heartbeat"] == true => lease.heartbeat(start.elapsed()),
            Ok(Some(value)) if value["on"].is_boolean() => {
                let ok = state.set_enabled(value["on"] == true);
                if protocol::emit(output, &json!({"ok":ok})).is_err() {
                    break;
                }
            }
            Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    restore(state);
}

pub(crate) struct GuardianLease {
    heartbeat: Duration,
    next_check: Duration,
}
impl GuardianLease {
    pub fn new(now: Duration) -> Self {
        Self {
            heartbeat: now,
            next_check: now + HEARTBEAT,
        }
    }
    pub fn heartbeat(&mut self, now: Duration) {
        self.heartbeat = now;
    }
    pub fn tick(&mut self, now: Duration) -> bool {
        if self.expired(now) {
            return true;
        }
        if self.until_check(now).is_zero() {
            self.check(now);
        }
        false
    }
    pub fn expired(&self, now: Duration) -> bool {
        now >= self.next_check && now.saturating_sub(self.heartbeat) > LEASE
    }
    pub fn until_check(&self, now: Duration) -> Duration {
        self.next_check.saturating_sub(now)
    }
    pub fn check(&mut self, now: Duration) {
        self.next_check = now + HEARTBEAT;
    }
}

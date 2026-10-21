//! Idle is parked. A native C path that misses the interrupt still terminates the whole helper.
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
pub struct Watchdog {
    start: Instant,
    deadline: Arc<AtomicU64>,
    thread: std::thread::Thread,
}
impl Watchdog {
    pub fn new() -> Result<Self, ()> {
        let start = Instant::now();
        let deadline = Arc::new(AtomicU64::new(0));
        let watched = deadline.clone();
        let thread = std::thread::Builder::new()
            .name("visual-watchdog".into())
            .spawn(move || {
                loop {
                    let value = watched.load(Ordering::Acquire);
                    if value == 0 {
                        std::thread::park();
                        continue;
                    }
                    let now = start.elapsed().as_millis() as u64;
                    if now >= value {
                        if watched.load(Ordering::Acquire) == value {
                            unsafe { libc::_exit(124) }
                        }
                        continue;
                    }
                    std::thread::park_timeout(Duration::from_millis(value - now));
                }
            })
            .map_err(|_| ())?
            .thread()
            .clone();
        Ok(Self {
            start,
            deadline,
            thread,
        })
    }
    pub fn begin(&self) {
        self.deadline.store(
            self.start.elapsed().as_millis() as u64 + 1500,
            Ordering::Release,
        );
        self.thread.unpark();
    }
    pub fn finish(&self) {
        self.deadline.store(0, Ordering::Release);
        self.thread.unpark();
    }
}

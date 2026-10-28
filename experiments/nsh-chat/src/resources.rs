//! Same macOS process counters for both isolated comparison binaries.
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub struct Samples {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Samples {
    pub fn start(path: PathBuf) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let thread = std::thread::spawn(move || {
            let start = Instant::now();
            let mut samples = vec![];
            while !done.load(Ordering::Relaxed) {
                // SAFETY: a V4-sized output buffer for our own PID.
                let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
                let status = unsafe {
                    libc::proc_pid_rusage(
                        libc::getpid(),
                        libc::RUSAGE_INFO_V4,
                        (&mut info as *mut libc::rusage_info_v4).cast(),
                    )
                };
                if status == 0 {
                    let mut cpu = libc::timespec {
                        tv_sec: 0,
                        tv_nsec: 0,
                    };
                    // rusage_info time fields are Mach ticks, not nanoseconds.
                    unsafe {
                        libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut cpu);
                    }
                    samples.push(json!({"at_ms":start.elapsed().as_secs_f64()*1000.,"cpu_ms":cpu.tv_sec as f64*1000.+cpu.tv_nsec as f64/1e6,"footprint_bytes":info.ri_phys_footprint,"resident_bytes":info.ri_resident_size}));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path,serde_json::to_vec_pretty(&json!({"metric":"macOS footprint/RSS: proc_pid_rusage V4; CPU: CLOCK_PROCESS_CPUTIME_ID. Whole process including engine/worker threads; no child helpers","samples":samples})).unwrap()).unwrap();
        });
        Self {
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Samples {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

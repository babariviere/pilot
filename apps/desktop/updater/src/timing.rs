//! Optional numeric lifecycle observations. Never records paths, identities or payloads.
pub(crate) struct Phase {
    #[cfg(feature = "lifecycle-timings")]
    started: std::time::Instant,
}
impl Phase {
    pub(crate) fn start() -> Self {
        Self {
            #[cfg(feature = "lifecycle-timings")]
            started: std::time::Instant::now(),
        }
    }
    pub(crate) fn finish(self, name: &'static str) {
        #[cfg(feature = "lifecycle-timings")]
        eprintln!(
            "lifecycle-phase {name} {:.6}",
            self.started.elapsed().as_secs_f64()
        );
        #[cfg(not(feature = "lifecycle-timings"))]
        let _ = name;
    }
}

//! Explicit daemon handoff. Legacy launchd ownership is retained, never enrolled.
#[cfg(any(test, all(target_os = "macos", feature = "native-macos")))]
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Unsupported,
    Unverified,
    Busy,
    Cancelled,
    /// A lifecycle write may have happened. Inspect before any further action.
    Unknown,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unsupported => "this daemon is not a supported macOS launch agent",
            Self::Unverified => {
                "daemon identity, service definition or runtime could not be verified"
            }
            Self::Busy => "tools are still running; no daemon was stopped",
            Self::Cancelled => "upgrade cancelled before shutdown; agents resume within 30 seconds",
            Self::Unknown => {
                "upgrade outcome is unknown; inspect the retained handoff before retrying"
            }
        })
    }
}
impl std::error::Error for Failure {}

// The seam makes partial native failures testable without launching any real service.
#[cfg(any(test, all(target_os = "macos", feature = "native-macos")))]
trait Handoff {
    fn prepare(&mut self) -> Result<(), Failure>;
    fn drained(&mut self) -> Result<bool, Failure>;
    fn revalidate(&mut self) -> Result<(), Failure>;
    fn journal(&mut self, phase: &str) -> Result<(), Failure>;
    fn stop(&mut self) -> Result<(), Failure>;
    fn exited(&mut self) -> Result<(), Failure>;
    fn replace_definition(&mut self) -> Result<(), Failure>;
    fn start(&mut self) -> Result<(), Failure>;
    fn verify_started(&mut self) -> Result<(), Failure>;
}
#[cfg(any(test, all(target_os = "macos", feature = "native-macos")))]
fn execute(host: &mut impl Handoff, cancel: &AtomicBool) -> Result<(), Failure> {
    host.prepare()?; // Includes full payload verification, native process watch, exclusive lock.
    if cancel.load(Ordering::Acquire) {
        return Err(Failure::Cancelled);
    }
    if !host.drained()? {
        return Err(Failure::Busy);
    }
    host.revalidate()?;
    if cancel.load(Ordering::Acquire) {
        return Err(Failure::Cancelled);
    }
    // This durable record precedes the first lifecycle mutation. Never automatically replay it.
    host.journal("stopping")?;
    let mut committed = || -> Result<(), Failure> {
        host.stop()?;
        host.exited()?; // OS process event AND released permanent profile lease.
        host.journal("stopped")?;
        host.replace_definition()?;
        host.journal("starting")?;
        host.start()?;
        host.verify_started()?;
        host.journal("complete")
    };
    committed().map_err(|_| Failure::Unknown)
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[path = "daemon_upgrade_macos.rs"]
mod macos;
#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub use macos::upgrade;

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Faux {
        calls: Vec<String>,
        fail: Option<&'static str>,
        busy: bool,
    }
    impl Faux {
        fn step(&mut self, name: &str) -> Result<(), Failure> {
            self.calls.push(name.into());
            if self.fail == Some(name) {
                Err(Failure::Unverified)
            } else {
                Ok(())
            }
        }
    }
    impl Handoff for Faux {
        fn prepare(&mut self) -> Result<(), Failure> {
            self.step("prepare")
        }
        fn drained(&mut self) -> Result<bool, Failure> {
            self.step("drain")?;
            Ok(!self.busy)
        }
        fn revalidate(&mut self) -> Result<(), Failure> {
            self.step("identity")
        }
        fn journal(&mut self, p: &str) -> Result<(), Failure> {
            self.step(p)
        }
        fn stop(&mut self) -> Result<(), Failure> {
            self.step("stop")
        }
        fn exited(&mut self) -> Result<(), Failure> {
            self.step("exit+lease")
        }
        fn replace_definition(&mut self) -> Result<(), Failure> {
            self.step("definition")
        }
        fn start(&mut self) -> Result<(), Failure> {
            self.step("start")
        }
        fn verify_started(&mut self) -> Result<(), Failure> {
            self.step("verify")
        }
    }
    #[test]
    fn explicit_handoff_preserves_shutdown_before_single_start() {
        let mut host = Faux::default();
        assert_eq!(execute(&mut host, &AtomicBool::new(false)), Ok(()));
        assert_eq!(
            host.calls,
            [
                "prepare",
                "drain",
                "identity",
                "stopping",
                "stop",
                "exit+lease",
                "stopped",
                "definition",
                "starting",
                "start",
                "verify",
                "complete"
            ]
        );
    }
    #[test]
    fn refusal_busy_cancel_and_changed_identity_never_stop() {
        for (fail, busy, cancel, expected) in [
            (Some("prepare"), false, false, Failure::Unverified),
            (None, true, false, Failure::Busy),
            (None, false, true, Failure::Cancelled),
            (Some("identity"), false, false, Failure::Unverified),
        ] {
            let mut host = Faux {
                fail,
                busy,
                ..Default::default()
            };
            assert_eq!(execute(&mut host, &AtomicBool::new(cancel)), Err(expected));
            assert!(!host.calls.iter().any(|c| c == "stop" || c == "start"));
        }
    }
    #[test]
    fn partial_failures_are_unknown_and_never_replay_or_rollback() {
        for point in [
            "stop",
            "exit+lease",
            "stopped",
            "definition",
            "starting",
            "start",
            "verify",
            "complete",
        ] {
            let mut host = Faux {
                fail: Some(point),
                ..Default::default()
            };
            assert_eq!(
                execute(&mut host, &AtomicBool::new(false)),
                Err(Failure::Unknown),
                "{point}"
            );
            assert_eq!(host.calls.last().unwrap(), point);
            assert!(host.calls.iter().filter(|c| c.as_str() == "start").count() <= 1);
        }
    }
}

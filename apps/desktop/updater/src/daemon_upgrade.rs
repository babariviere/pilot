//! Explicit daemon handoff. Legacy launchd ownership is retained, never enrolled.
#[cfg(any(
    all(target_os = "macos", feature = "native-macos"),
    all(target_os = "linux", feature = "native-linux")
))]
#[path = "daemon_native.rs"]
pub(crate) mod native;
#[cfg(any(
    all(target_os = "macos", feature = "native-macos"),
    all(target_os = "linux", feature = "native-linux")
))]
#[path = "daemon_reservation.rs"]
mod reservation;
#[cfg(any(
    test,
    all(target_os = "macos", feature = "native-macos"),
    all(target_os = "linux", feature = "native-linux")
))]
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Unsupported,
    Unverified,
    Busy,
    Cancelled,
    /// Refused before staging: retained runtimes and staging evidence fill the bounded
    /// runtime store. Nothing was staged or stopped, and no evidence was removed.
    StagingCapacity,
    /// Refused before staging: archiving earlier staging evidence to make room failed.
    /// Nothing was installed or stopped; the evidence stays in place or in the archive.
    StagingArchiveFailed,
    /// A lifecycle write may have happened. Inspect before any further action.
    Unknown,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unsupported => "this daemon is not a supported user service",
            Self::Unverified => {
                "daemon identity, service definition or runtime could not be verified"
            }
            Self::Busy => "work is active or cannot be inspected; no daemon was stopped",
            Self::Cancelled => "upgrade cancelled before shutdown; agents resume within 30 seconds",
            Self::StagingCapacity => {
                "retained runtimes or staging evidence fill ~/Library/Application Support/Pilot Next Runtimes; nothing was staged or stopped. Inspect them before retrying"
            }
            Self::StagingArchiveFailed => {
                "earlier runtime staging evidence could not be archived to make room; nothing was installed or stopped and the evidence was kept. Retry later"
            }
            Self::Unknown => {
                "upgrade outcome is unknown; inspect the retained handoff before retrying"
            }
        })
    }
}
impl std::error::Error for Failure {}

// The seam makes partial native failures testable without launching any real service.
#[cfg(any(
    test,
    all(target_os = "macos", feature = "native-macos"),
    all(target_os = "linux", feature = "native-linux")
))]
trait Handoff {
    fn prepare(&mut self) -> Result<(), Failure>;
    fn drained(&mut self) -> Result<bool, Failure>;
    fn revalidate(&mut self) -> Result<(), Failure>;
    fn reserve(&mut self) -> Result<(), Failure>;
    fn verify_reservation(&mut self) -> Result<(), Failure>;
    fn cancel_reservation(&mut self);
    fn journal(&mut self, phase: &str) -> Result<(), Failure>;
    fn stop(&mut self) -> Result<(), Failure>;
    fn exited(&mut self) -> Result<(), Failure>;
    fn replace_definition(&mut self) -> Result<(), Failure>;
    fn start(&mut self) -> Result<(), Failure>;
    fn verify_started(&mut self) -> Result<(), Failure>;
}
#[cfg(any(
    test,
    all(target_os = "macos", feature = "native-macos"),
    all(target_os = "linux", feature = "native-linux")
))]
fn execute(host: &mut impl Handoff, cancel: &AtomicBool) -> Result<(), Failure> {
    let preflight = (|| {
        host.prepare()?; // Payload, native watch and permanent handoff lock.
        if cancel.load(Ordering::Acquire) {
            return Err(Failure::Cancelled);
        }
        if !host.drained()? {
            return Err(Failure::Busy);
        }
        host.reserve()?;
        host.revalidate()?;
        host.verify_reservation()?;
        if cancel.load(Ordering::Acquire) {
            return Err(Failure::Cancelled);
        }
        Ok(())
    })();
    if let Err(failure) = preflight {
        host.cancel_reservation();
        return Err(failure);
    }
    // This durable record precedes the first lifecycle mutation. Never automatically replay it.
    host.journal("stopping").map_err(|_| Failure::Unknown)?;
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
pub use macos::{migrate_stopped, needed, upgrade, upgrade_startup};
#[cfg(all(target_os = "linux", feature = "native-linux"))]
#[path = "daemon_upgrade_linux.rs"]
mod linux;
#[cfg(all(target_os = "linux", feature = "native-linux"))]
pub use linux::{register, upgrade};

// Runtime package versions, never the GUI's bundle build or hello display version.
#[cfg(any(test, all(target_os = "macos", feature = "native-macos")))]
fn runtime_version(stamp: &serde_json::Value) -> Result<crate::manifest::Build, Failure> {
    let version = stamp["version"].as_str().ok_or(Failure::Unverified)?;
    if stamp["schema"] != 1
        || stamp["protocol"] != 1
        || stamp["platform"] != "darwin"
        || stamp["arch"] != "arm64"
        || version.split('.').count() != 3
    {
        return Err(Failure::Unsupported);
    }
    crate::manifest::Build::parse(version).map_err(|_| Failure::Unverified)
}

#[cfg(any(test, all(target_os = "macos", feature = "native-macos")))]
fn runtime_upgrade_needed(
    running: &serde_json::Value,
    bundled: &serde_json::Value,
) -> Result<bool, Failure> {
    Ok(runtime_version(running)? < runtime_version(bundled)?)
}

/// Read-only startup: attest the live connection, never publish or activate.
/// On macOS `current` may be the installed app, not a retained execution root.
#[cfg(any(
    all(target_os = "macos", feature = "native-macos"),
    all(target_os = "linux", feature = "native-linux")
))]
pub fn connect(
    location: &crate::coordination::Location,
    current: &std::path::Path,
    trust: &crate::manifest::Trust,
) -> Result<(), Failure> {
    #[cfg(target_os = "macos")]
    {
        use crate::installer::Platform;
        crate::installer::validate_target(current, trust).map_err(|_| Failure::Unverified)?;
        crate::installer::MacPlatform
            .verify(current, trust, &trust.current_build, None)
            .map_err(|_| Failure::Unverified)?;
        crate::coordination::inspect_connection(location)
            .map(|_| ())
            .map_err(|_| Failure::Unverified)
    }
    #[cfg(target_os = "linux")]
    {
        let root = crate::coordination::selected(location, current, trust)
            .map_err(|_| Failure::Unverified)?;
        native::running(location, &root).map(|_| ())
    }
}
/// Explicit consent includes login enablement. Never called from GUI startup or update ACK.
#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub fn register(
    location: crate::coordination::Location,
    current: &std::path::Path,
    trust: &crate::manifest::Trust,
    cancel: &AtomicBool,
) -> Result<(), Failure> {
    macos::register(location, current, trust, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stamp(version: &str) -> serde_json::Value {
        serde_json::json!({"schema":1,"protocol":1,"platform":"darwin","arch":"arm64","version":version})
    }
    #[test]
    fn startup_compares_runtime_versions_numerically_and_never_downgrades() {
        for (running, bundled, needed) in [
            ("1.9.0", "1.10.0", true),
            ("1.10.0", "1.9.0", false),
            ("1.10.0", "1.10.0", false),
            ("2.0.0", "1.99.99", false),
            ("0.99.99", "1.0.0", true),
        ] {
            assert_eq!(
                runtime_upgrade_needed(&stamp(running), &stamp(bundled)),
                Ok(needed)
            );
        }
    }
    #[test]
    fn startup_refuses_unknown_and_unsupported_runtime_stamps() {
        let target = stamp("1.10.0");
        assert!(runtime_upgrade_needed(&serde_json::Value::Null, &target).is_err());
        for version in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.2.3-dev",
            "1.2.3+build",
            "9999999999.0.0",
        ] {
            assert!(
                runtime_upgrade_needed(&stamp(version), &target).is_err(),
                "{version}"
            );
            assert!(
                runtime_upgrade_needed(&target, &stamp(version)).is_err(),
                "{version}"
            );
        }
        for (field, value) in [
            ("schema", serde_json::json!(2)),
            ("protocol", serde_json::json!(2)),
            ("platform", serde_json::json!("linux")),
            ("arch", serde_json::json!("x64")),
            ("version", serde_json::Value::Null),
        ] {
            let mut unknown = target.clone();
            unknown[field] = value;
            assert!(
                runtime_upgrade_needed(&unknown, &target).is_err(),
                "{field}"
            );
            assert!(
                runtime_upgrade_needed(&target, &unknown).is_err(),
                "{field}"
            );
        }
    }
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
        fn reserve(&mut self) -> Result<(), Failure> {
            self.step("reserve")
        }
        fn verify_reservation(&mut self) -> Result<(), Failure> {
            self.step("reservation")
        }
        fn cancel_reservation(&mut self) {
            let _ = self.step("cancel-reservation");
        }
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
                "reserve",
                "identity",
                "reservation",
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
    fn reservation_is_verified_and_cancelled_before_any_stop_intent() {
        for point in ["reserve", "identity", "reservation", "stopping"] {
            let mut host = Faux {
                fail: Some(point),
                ..Default::default()
            };
            let _ = execute(&mut host, &AtomicBool::new(false));
            assert!(!host.calls.iter().any(|c| c == "stop"));
            if point != "stopping" {
                assert_eq!(
                    host.calls.last().map(String::as_str),
                    Some("cancel-reservation"),
                    "{point}"
                );
            }
        }
        let mut host = Faux::default();
        execute(&mut host, &AtomicBool::new(false)).unwrap();
        let stop = host.calls.iter().position(|c| c == "stopping").unwrap();
        assert_eq!(host.calls[stop - 1], "reservation");
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

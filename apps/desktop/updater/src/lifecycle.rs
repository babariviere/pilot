//! Renderer-independent daemon lifecycle adapter. Native identity and handoff stay with the existing updater.

use crate::{
    app_update::Connection,
    daemon_upgrade::{self, Failure},
    manifest::Trust,
};
use std::{path::Path, sync::atomic::AtomicBool};

/// Whether a native caller may checkpoint unfinished work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum UpgradeMode {
    /// Explicit user confirmation; uses the signed interrupt reservation.
    Explicit,
    /// Passive startup policy; never interrupts unfinished work.
    Startup,
}

/// An exact configured connection, not service-management authority by itself.
///
/// Call on a worker thread. The native backend revalidates signatures, the service,
/// boot, OS process and profile lease. Do not replay an Unknown result or a lost
/// worker reply. UI state and confirmation consumption belong to the native caller.
#[derive(Debug)]
pub struct DaemonLifecycle {
    connection: Connection,
}

impl DaemonLifecycle {
    /// Pin the configured profile and daemon/storage identities for this attempt.
    pub fn new(connection: Connection) -> Self {
        Self { connection }
    }

    /// Inspect the supported packaged runtime without publishing or activating it.
    ///
    /// # Errors
    /// Refuses unsupported ownership, cancellation or failed native verification.
    pub fn needed(
        &self,
        current: &Path,
        trust: &Trust,
        cancel: &AtomicBool,
    ) -> Result<bool, Failure> {
        #[cfg(target_os = "macos")]
        return daemon_upgrade::needed(
            self.connection.location().clone(),
            current,
            trust,
            self.connection.daemon(),
            self.connection.lineage(),
            cancel,
        );
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (current, trust, cancel);
            Err(Failure::Unsupported)
        }
    }

    /// Replace through the trusted service adapter, using an immutable published capsule.
    ///
    /// Publication remains `runtime::publish_service` on macOS. This method never
    /// moves or deletes an execution root, shells out to a second service manager,
    /// or treats a pause ACK as process exit. App-only updates do not call it.
    ///
    /// # Errors
    /// Definite preflight refusals return their reason. Any entered native mutation
    /// with no exact completion proof returns Unknown and requires inspection.
    pub fn upgrade(
        &self,
        capsule: &Path,
        trust: &Trust,
        mode: UpgradeMode,
        cancel: &AtomicBool,
    ) -> Result<(), Failure> {
        #[cfg(target_os = "macos")]
        let worker = match mode {
            UpgradeMode::Explicit => daemon_upgrade::upgrade,
            UpgradeMode::Startup => daemon_upgrade::upgrade_startup,
        };
        #[cfg(target_os = "linux")]
        let worker = {
            let _ = mode;
            daemon_upgrade::upgrade
        };
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        return worker(
            self.connection.location().clone(),
            capsule,
            trust,
            self.connection.daemon(),
            self.connection.lineage(),
            cancel,
        );
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (capsule, trust, mode, cancel);
            Err(Failure::Unsupported)
        }
    }

    /// Continue an exact durable coordinated proposal through the same native handoff.
    ///
    /// # Errors
    /// Refuses mismatched proposal identity or safety proof; uncertain writes stay Unknown.
    #[cfg(target_os = "macos")]
    pub fn upgrade_coordinated(
        &self,
        capsule: &Path,
        trust: &Trust,
        cancel: &AtomicBool,
        binding: serde_json::Value,
    ) -> Result<(), Failure> {
        daemon_upgrade::upgrade_coordinated(
            self.connection.location().clone(),
            capsule,
            trust,
            self.connection.daemon(),
            self.connection.lineage(),
            cancel,
            binding,
        )
    }

    /// Same one-shot controller, with exact attempted reservation evidence.
    /// The report is not permission to retry or resume any work.
    #[cfg(target_os = "macos")]
    pub fn upgrade_coordinated_report(
        &self,
        capsule: &Path,
        trust: &Trust,
        cancel: &AtomicBool,
        binding: serde_json::Value,
    ) -> daemon_upgrade::UpgradeReport {
        daemon_upgrade::upgrade_coordinated_report(
            self.connection.location().clone(),
            capsule,
            trust,
            self.connection.daemon(),
            self.connection.lineage(),
            cancel,
            binding,
        )
    }
}

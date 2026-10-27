//! Platform-owned distribution paths, never inferred from a remote manifest.
#[cfg(target_os = "linux")]
pub const BUNDLE: &str = "Pilot Next";
#[cfg(not(target_os = "linux"))]
pub const BUNDLE: &str = "Pilot Next.app";
#[cfg(target_os = "linux")]
pub const GUI: &str = "libexec/pilot-desktop";
#[cfg(not(target_os = "linux"))]
pub const GUI: &str = "Contents/MacOS/pilot-desktop";
#[cfg(target_os = "linux")]
pub const HELPER: &str = "libexec/pilot-desktop-update-helper";
#[cfg(not(target_os = "linux"))]
pub const HELPER: &str = "Contents/Helpers/pilot-desktop-update-helper";
#[cfg(target_os = "linux")]
pub const RUNTIME: &str = "runtime";
#[cfg(not(target_os = "linux"))]
pub const RUNTIME: &str = "Contents/Resources/runtime";
#[cfg(target_os = "linux")]
pub const POLICY: &str = "update-runtime-policy.json";
#[cfg(not(target_os = "linux"))]
pub const POLICY: &str = "Contents/Resources/update-runtime-policy.json";

pub fn running_root() -> Result<std::path::PathBuf, crate::Error> {
    let executable = std::env::current_exe().map_err(|_| crate::Error::Identity)?;
    let root = executable
        .ancestors()
        .nth(GUI.split('/').count())
        .ok_or(crate::Error::Identity)?;
    // macOS bundles keep their name. A Linux install is a plain user directory that is
    // often renamed (for example `~/.local/opt/pilot-next`); its signed inventory, not
    // the directory name, identifies the payload.
    let named = cfg!(target_os = "linux") || root.file_name().is_some_and(|name| name == BUNDLE);
    if !named || root.join(GUI) != executable {
        return Err(crate::Error::Identity);
    }
    root.canonicalize().map_err(|_| crate::Error::Filesystem)
}

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

#[cfg(all(test, target_os = "macos", feature = "native-macos"))]
mod tests {
    use super::*;
    use crate::{
        Error,
        installer::{NativePlatform, Platform},
        owned_tests::{Temp, trust},
    };

    const PROBE: &str = "PILOT_UPDATER_OWNED_LAYOUT_PROBE";

    // Invoked in the relocated test executable, not a shell or a path mock.
    #[test]
    fn executable_layout_probe() {
        let Some(mode) = std::env::var_os(PROBE) else {
            return;
        };
        if mode == "accepted" {
            let root = running_root().unwrap();
            assert_eq!(root.join(GUI), std::env::current_exe().unwrap());
            assert!(!root.join(HELPER).exists());
            assert!(
                NativePlatform
                    .verify(&root, &trust(), "100.1", None)
                    .is_err(),
                "an executable at the right path is not a verified package"
            );
        } else {
            assert_eq!(running_root(), Err(Error::Identity));
        }
    }

    #[test]
    fn real_executable_layout_refuses_stock_day_and_does_not_grant_native_trust() {
        let temp = Temp::new();
        let current = std::env::current_exe().unwrap();
        for (bundle, binary, mode) in [
            ("Pilot Next.app", "pilot-desktop", "accepted"),
            ("Pilot Day.app", "PilotDay", "refused"),
            ("Pilot Next.app", "PilotDay", "refused"),
            ("Pilot Day.app", "pilot-desktop", "refused"),
        ] {
            let executable = temp.path().join(bundle).join("Contents/MacOS").join(binary);
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::copy(&current, &executable).unwrap();
            let result = std::process::Command::new(&executable)
                .args([
                    "--exact",
                    "layout::tests::executable_layout_probe",
                    "--nocapture",
                ])
                .env_clear()
                .env(PROBE, mode)
                .output()
                .unwrap();
            assert!(result.status.success(), "{executable:?}: {result:?}");
            assert!(
                String::from_utf8_lossy(&result.stdout).contains("1 passed"),
                "the real relocated probe must run: {result:?}"
            );
        }
    }
}

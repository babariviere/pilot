//! Opening Pilot starts its own service when nothing answers on its port.
//!
//! It acts only on the service definition that belongs to this app: the
//! launch agent, owned by the user and not writable by others, marked as
//! Pilot-managed, claimed for this profile and port, whose program is this
//! app's own runtime (whose signature bootstrap already checked). Anything
//! else is left alone. One try per launch; the connection's own reconnect
//! picks the service up.
use pilot_desktop_updater::coordination::Location;
use serde_json::{Value, json};
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

const LABEL: &str = "com.babariviere.pilot.daemon";

/// Whether `definition` and its owner `claim` describe this app's service
/// for `location`.
fn owns(definition: &Value, claim: &Value, app: &Path, location: &Location) -> bool {
    let runtime = app.join("Contents/Resources/runtime");
    let program = [
        runtime.join("node/bin/node"),
        runtime.join("packages/daemon/src/main.ts"),
    ];
    definition["Label"] == LABEL
        && definition["PilotNextManaged"] == true
        && definition["ProgramArguments"] == json!(program)
        && definition["EnvironmentVariables"]["PILOT_HOME"] == json!(location.home)
        && definition["EnvironmentVariables"]["PILOT_PORT"] == location.port.to_string()
        && *claim == json!({"schema": 1, "profile": location.home, "port": location.port})
}

/// A regular file owned by the user that no one else can write.
fn private(path: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "missing")?;
    if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 {
        return Err("not private".into());
    }
    Ok(())
}

fn launchctl(args: &[&str]) -> Result<Option<i32>, String> {
    Command::new("/bin/launchctl")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.code())
        .map_err(|_| "launchctl".into())
}

/// Starts this app's service if it is stopped. Returns what it found or did.
pub(crate) fn start(location: &Location, app: &Path) -> Result<&'static str, String> {
    let address = (std::net::Ipv4Addr::LOCALHOST, location.port).into();
    if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok() {
        return Ok("running");
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .ok_or("no home")?;
    let plist = home
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"));
    let claim = plist.with_extension("plist.next-owner");
    private(&plist)?;
    private(&claim)?;
    let output = Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(&plist)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "plutil")?;
    let definition: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "unreadable definition")?;
    let claim: Value =
        serde_json::from_slice(&std::fs::read(&claim).map_err(|_| "unreadable claim")?)
            .map_err(|_| "unreadable claim")?;
    if !owns(&definition, &claim, app, location) {
        return Err("not this app's service".into());
    }
    let service = format!("gui/{}/{LABEL}", unsafe { libc::geteuid() });
    let domain = format!("gui/{}", unsafe { libc::geteuid() });
    let plist = plist.to_str().ok_or("path")?;
    // launchctl's documented 113 is "service not found in domain".
    match launchctl(&["print", &service])? {
        Some(0) => match launchctl(&["kickstart", &service])? {
            Some(0) => Ok("kickstarted"),
            code => Err(format!("kickstart {code:?}")),
        },
        Some(113) => match launchctl(&["bootstrap", &domain, plist])? {
            Some(0) => Ok("started"),
            code => Err(format!("bootstrap {code:?}")),
        },
        code => Err(format!("print {code:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn location() -> Location {
        Location {
            home: "/Users/me/.local/share/pilot".into(),
            port: 4319,
            policy: Default::default(),
        }
    }

    fn definition(app: &str) -> Value {
        json!({
            "Label": LABEL,
            "PilotNextManaged": true,
            "ProgramArguments": [
                format!("{app}/Contents/Resources/runtime/node/bin/node"),
                format!("{app}/Contents/Resources/runtime/packages/daemon/src/main.ts"),
            ],
            "EnvironmentVariables": {"PILOT_HOME": "/Users/me/.local/share/pilot", "PILOT_PORT": "4319"},
        })
    }

    #[test]
    fn only_this_apps_managed_service_for_this_profile_is_started() {
        let app = Path::new("/Users/me/Applications/Pilot.app");
        let claim = json!({"schema": 1, "profile": "/Users/me/.local/share/pilot", "port": 4319});
        let ours = definition("/Users/me/Applications/Pilot.app");
        assert!(owns(&ours, &claim, app, &location()));
        // Another app's runtime, a hand-made agent, another profile or port.
        let other = definition("/Users/me/Downloads/Pilot.app");
        assert!(!owns(&other, &claim, app, &location()));
        let mut unmanaged = ours.clone();
        unmanaged["PilotNextManaged"] = json!(false);
        assert!(!owns(&unmanaged, &claim, app, &location()));
        let mut port = ours.clone();
        port["EnvironmentVariables"]["PILOT_PORT"] = json!("5000");
        assert!(!owns(&port, &claim, app, &location()));
        let claimed_elsewhere = json!({"schema": 1, "profile": "/tmp/other", "port": 4319});
        assert!(!owns(&ours, &claimed_elsewhere, app, &location()));
    }
}

//! Production bootstrap. No development resource override, mock root, credential
//! in JS, live registration or updater handshake. Missing identity refuses load.
use crate::{
    bridge::Bridge,
    contract::Home,
    host::{Error, NativeHost, Source},
    macos_app::ApplicationOwner,
    root::DayRoot,
};
use nsh_platform_macos::{AssetBase, objc2::MainThreadMarker};
use pilot_desktop_updater::{
    helper::compiled_trust,
    installer::{NativePlatform, Platform},
};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
};

/// Native launch selection is explicit, never inferred from a development
/// environment or sent to the screen. Full successor restoration is not joined
/// yet, so --updater-receipt is deliberately refused (never acknowledged).
fn selection(args: Vec<OsString>) -> Result<(Source, PathBuf), Error> {
    let mut values = BTreeMap::new();
    let mut args = args.into_iter();
    while let Some(key) = args.next() {
        let key = key.into_string().map_err(|_| Error::Invalid)?;
        if ![
            "--profile",
            "--port",
            "--daemon-id",
            "--lineage-id",
            "--project-id",
            "--project-path",
            "--journal",
        ]
        .contains(&key.as_str())
        {
            return Err(Error::Unavailable);
        }
        let value = args.next().ok_or(Error::Invalid)?;
        if value.is_empty() || values.insert(key, value).is_some() {
            return Err(Error::Invalid);
        }
    }
    let mut take = |name: &str| values.remove(name).ok_or(Error::Invalid);
    let profile = PathBuf::from(take("--profile")?);
    let port = take("--port")?
        .into_string()
        .map_err(|_| Error::Invalid)?
        .parse::<u16>()
        .map_err(|_| Error::Invalid)?;
    let daemon_id = take("--daemon-id")?
        .into_string()
        .map_err(|_| Error::Invalid)?;
    let lineage_id = take("--lineage-id")?
        .into_string()
        .map_err(|_| Error::Invalid)?;
    let project_id = take("--project-id")?
        .into_string()
        .map_err(|_| Error::Invalid)?;
    let project_path = take("--project-path")?
        .into_string()
        .map_err(|_| Error::Invalid)?;
    let journal = PathBuf::from(take("--journal")?);
    if port == 0
        || !profile.is_absolute()
        || !Path::new(&project_path).is_absolute()
        || !journal.is_absolute()
    {
        return Err(Error::Invalid);
    }
    Ok((
        Source {
            profile,
            port,
            home: Home {
                daemon_id,
                lineage_id,
            },
            project_id,
            project_path,
        },
        journal,
    ))
}

/// A path gate only, not signing or payload evidence. Kept separate for tests
/// that must not manufacture a production signature or execute fixture bytecode.
fn resource_directory(executable: &Path) -> Result<PathBuf, Error> {
    let macos = executable.parent().ok_or(Error::Identity)?;
    let contents = macos.parent().ok_or(Error::Identity)?;
    let app = contents.parent().ok_or(Error::Identity)?;
    if executable.file_name().and_then(|s| s.to_str()) != Some("pilot-desktop")
        || macos.file_name().and_then(|s| s.to_str()) != Some("MacOS")
        || contents.file_name().and_then(|s| s.to_str()) != Some("Contents")
        || app.file_name().and_then(|s| s.to_str()) != Some("Pilot Next.app")
    {
        return Err(Error::Identity);
    }
    Ok(contents.join("Resources/nsh"))
}

pub fn run(args: Vec<OsString>) -> Result<(), Error> {
    let (source, journal) = selection(args)?;
    let executable = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|_| Error::Identity)?;
    let resources = resource_directory(&executable)?;
    let root = pilot_desktop_updater::layout::running_root().map_err(|_| Error::Identity)?;
    let trust = compiled_trust().map_err(|_| Error::Unavailable)?;
    trust.validate().map_err(|_| Error::Identity)?;
    // This includes the existing signature, version and payload inventory checks.
    // A stock/ad-hoc runner, path match or helper file cannot replace this gate.
    NativePlatform
        .verify(&root, &trust, &trust.current_build, None)
        .map_err(|_| Error::Identity)?;
    let canonical = resources.canonicalize().map_err(|_| Error::Unavailable)?;
    if canonical != resources {
        return Err(Error::Identity);
    }
    // SAFETY: only the resources of the verified current signed distribution
    // reach QuickJS's trusted-bytecode reader. No NSH_APP_DIR/NSH_CHUNK_DIR.
    let bytecode = resources.join("bundle.nshc");
    if bytecode.canonicalize().map_err(|_| Error::Unavailable)? != bytecode
        || !std::fs::symlink_metadata(&bytecode)
            .map_err(|_| Error::Unavailable)?
            .is_file()
    {
        return Err(Error::Identity);
    }
    let bundle =
        unsafe { nsh_engine::Bundle::read_trusted(&bytecode) }.map_err(|_| Error::Unavailable)?;
    // All initial filesystem/signature reads precede AppKit's event loop.
    let main = MainThreadMarker::new().ok_or(Error::Unavailable)?;
    nsh_platform_macos::set_ui_sets(vec![nsh_base::registry(), crate::__nsh_native_module()]);
    let host = NativeHost::open(source, journal)?;
    let bridge = Bridge::new(DayRoot::new(host));
    let mut configuration = crate::macos_host::options(&bridge);
    configuration.app_id = trust.application_id.clone();
    configuration.asset_base = Some(AssetBase::Directory(resources.join("assets")));
    // No runtime-delivered modules or environment-selected chunk directory.
    configuration.chunks = None;
    ApplicationOwner::configured(main, bundle, bridge, configuration)?.run(main)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packaged_resource_identity_has_no_development_fallback() {
        assert_eq!(
            resource_directory(Path::new(
                "/tmp/Pilot Next.app/Contents/MacOS/pilot-desktop"
            )),
            Ok(PathBuf::from("/tmp/Pilot Next.app/Contents/Resources/nsh"))
        );
        for exe in [
            "/tmp/pilot-desktop",
            "/tmp/Pilot Day.app/Contents/MacOS/PilotDay",
            "/tmp/Pilot Next.app/Contents/MacOS/PilotDay",
        ] {
            assert_eq!(resource_directory(Path::new(exe)), Err(Error::Identity));
        }
    }
    #[test]
    fn successor_and_development_flags_never_fall_back_to_fresh_start() {
        for flag in ["--updater-receipt", "--app-dir", "--chunk-dir"] {
            assert!(matches!(
                selection(vec![flag.into(), "/tmp/untrusted".into()]),
                Err(Error::Unavailable)
            ));
        }
        assert!(selection(vec![]).is_err());
    }
}

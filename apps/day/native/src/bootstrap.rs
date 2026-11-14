//! Production bootstrap. No development resource override, mock root, credential
//! in JS or live registration. Missing signed identity refuses load.
//!
//! A normal launch (Finder, no arguments) reuses the last explicit global
//! selection from `launch.json` while its ids still match the profile files.
//! Otherwise it discovers the profile like GPUI's local client. It never reads
//! or saves a token.
use crate::{
    bridge::Bridge,
    contract::Home,
    host::{
        Error, NativeHost, Options, Source,
        official_root::OfficialRoot,
        updates::{AppTarget, Selection},
    },
    macos_app::ApplicationOwner,
    root::DayRoot,
};
use nsh_platform_macos::{AssetBase, objc2::MainThreadMarker};
use pilot_desktop_updater::{
    helper::compiled_trust,
    installer::{NativePlatform, Platform},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::OpenOptions,
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

/// Explicit native launch selection, never inferred from development state.
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
    let journal = PathBuf::from(take("--journal")?);
    let project = match (
        values.remove("--project-id"),
        values.remove("--project-path"),
    ) {
        (None, None) => None,
        (Some(id), Some(path)) => {
            let project_id = id.into_string().map_err(|_| Error::Invalid)?;
            let project_path = path.into_string().map_err(|_| Error::Invalid)?;
            if !super::host::valid_id(&project_id) || !Path::new(&project_path).is_absolute() {
                return Err(Error::Invalid);
            }
            Some(crate::host::Project {
                project_id,
                project_path,
            })
        }
        _ => return Err(Error::Invalid),
    };
    if port == 0 || !profile.is_absolute() || !journal.is_absolute() {
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
            project,
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
        || app.file_name().and_then(|s| s.to_str()) != Some("Pilot.app")
    {
        return Err(Error::Identity);
    }
    Ok(contents.join("Resources/nsh"))
}

pub fn run(args: Vec<OsString>) -> Result<(), Error> {
    let kind = launch_kind(&args);
    crate::day_log::event(
        "startup",
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "executable": std::env::current_exe().ok(),
            "launch": kind,
        }),
    );
    let launch = if kind == "normal" {
        user_home().and_then(|home| normal_launch(&home, |name| std::env::var_os(name)))
    } else {
        launch(args)
    }
    .map_err(|error| refused("selection", error))?;
    let (resources, root, trust) = (|| {
        let executable = std::env::current_exe()
            .and_then(|p| p.canonicalize())
            .map_err(|_| Error::Identity)?;
        let resources = resource_directory(&executable)?;
        let root = pilot_desktop_updater::layout::running_root().map_err(|_| Error::Identity)?;
        let trust = compiled_trust().map_err(|_| Error::Unavailable)?;
        trust.validate().map_err(|_| Error::Identity)?;
        Ok((resources, root, trust))
    })()
    .map_err(|error| refused("identity", error))?;
    // This includes the existing signature, version and payload inventory checks.
    // A stock/ad-hoc runner, path match or helper file cannot replace this gate.
    // Security.framework's native verifier refuses the AppKit main thread.
    // Wait before creating the engine, without weakening any signature gate.
    let verified_root = root.clone();
    let verified_trust = trust.clone();
    before_appkit(move || {
        NativePlatform
            .verify(
                &verified_root,
                &verified_trust,
                &verified_trust.current_build,
                None,
            )
            .map_err(|_| Error::Identity)
    })
    .map_err(|error| refused("verify", error))?;
    let (bundle, main) = (|| {
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
        let bundle = unsafe { nsh_engine::Bundle::read_trusted(&bytecode) }
            .map_err(|_| Error::Unavailable)?;
        // All initial filesystem/signature reads precede AppKit's event loop.
        let main = MainThreadMarker::new().ok_or(Error::Unavailable)?;
        Ok((bundle, main))
    })()
    .map_err(|error| refused("resources", error))?;
    nsh_platform_macos::set_ui_sets(crate::macos_host::ui_sets());
    let (source, journal, updates, planning_model, origin) = match launch {
        Launch::Successor(receipt) => {
            let successor_trust = trust.clone();
            let (source, journal, updates) = before_appkit(move || {
                crate::host::updates::successor(&receipt, root, successor_trust)
            })
            .map_err(|error| refused("selection", error))?;
            (source, journal, updates, None, None)
        }
        Launch::Selected(selected) => {
            let NativeSelection {
                source,
                journal,
                app,
                planning_model,
                official_inputs,
                origin,
            } = *selected;
            // Distribution inputs are optional update inputs, not startup
            // prerequisites. Startup only records them; an explicit Check
            // verifies them later on the host worker, never here.
            let official = official_inputs.map_or_else(OfficialRoot::default, |directory| {
                OfficialRoot::selected(directory, journal.clone())
            });
            let connection = pilot_desktop_updater::app_update::Connection::new(
                pilot_desktop_updater::coordination::Location {
                    home: source.profile.clone(),
                    port: source.port,
                    policy: Default::default(),
                },
                source.home.daemon_id.clone(),
                source.home.lineage_id.clone(),
            );
            (
                source,
                journal,
                Selection {
                    connection,
                    trust: trust.clone(),
                    installed: root,
                    capsule: None,
                    binding: None,
                    app,
                    restore_transaction: None,
                    official: Some(official),
                },
                planning_model,
                Some(origin),
            )
        }
    };
    crate::day_log::event(
        "launch.selected",
        json!({
            "build": trust.current_build,
            "launch": kind,
            "selection": origin.map_or("receipt", Origin::name),
            "profile": source.profile,
            "port": source.port,
            "journal": journal,
            "project": source.project.is_some(),
        }),
    );
    // Only a global explicit launch becomes the normal launch's selection.
    let saved = (origin == Some(Origin::Args) && source.project.is_none())
        .then(|| (source.clone(), journal.clone()));
    let host = NativeHost::open_with_options(
        source,
        journal,
        Options {
            planning_model,
            url_opener: Some(std::sync::Arc::new(crate::host::navigation::macos)),
            updates: Some(updates),
            day: Some(crate::host::ritual::DaySource::system()),
        },
    )
    .map_err(|error| refused("host", error))?;
    if let Some((source, journal)) = saved {
        // A failed save never blocks this launch; the next normal launch discovers.
        let result = user_home()
            .map_err(|error| format!("{error:?}"))
            .and_then(|home| save_launch(&home, &source, &journal).map_err(|e| e.to_string()));
        crate::day_log::event(
            "launch.saved",
            json!({"ok": result.is_ok(), "error": result.err()}),
        );
    }
    let bridge = Bridge::new(DayRoot::new(host));
    let mut configuration = crate::macos_host::options(&bridge);
    configuration.app_id = trust.application_id.clone();
    configuration.asset_base = Some(AssetBase::Directory(resources.join("assets")));
    // No runtime-delivered modules or environment-selected chunk directory.
    configuration.chunks = None;
    ApplicationOwner::configured(main, bundle, bridge, configuration)
        .map_err(|error| refused("app", error))?
        .run(main)
}

fn refused(stage: &str, error: Error) -> Error {
    crate::day_log::event(
        "launch.refused",
        json!({"stage": stage, "error": format!("{error:?}")}),
    );
    error
}

fn before_appkit<T: Send + 'static>(
    prepare: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    std::thread::Builder::new()
        .name("day-bootstrap".into())
        .spawn(prepare)
        .map_err(|_| Error::Unavailable)?
        .join()
        .map_err(|_| Error::Unknown)?
}

enum Launch {
    Selected(Box<NativeSelection>),
    Successor(PathBuf),
}
struct NativeSelection {
    source: Source,
    journal: PathBuf,
    app: Option<AppTarget>,
    planning_model: Option<String>,
    official_inputs: Option<PathBuf>,
    origin: Origin,
}

/// Where a selected launch's profile and journal came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Origin {
    Args,
    Saved,
    Discovered,
}
impl Origin {
    fn name(self) -> &'static str {
        match self {
            Self::Args => "args",
            Self::Saved => "launch.json",
            Self::Discovered => "discovered",
        }
    }
}

/// The last explicit global selection. It never holds a token.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedLaunch {
    version: u32,
    profile: PathBuf,
    port: u16,
    daemon_id: String,
    lineage_id: String,
    journal: PathBuf,
}
const SAVED_LAUNCH_MAX: u64 = 4096;

fn support_directory(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Pilot Day")
}

fn create_support_directory(home: &Path) -> std::io::Result<PathBuf> {
    let dir = support_directory(home);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    Ok(dir)
}

fn user_home() -> Result<PathBuf, Error> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .ok_or(Error::Unavailable)
}

/// Finder passes no arguments, or only an old "-psn_*" process serial number.
fn is_normal(args: &[OsString]) -> bool {
    match args {
        [] => true,
        [arg] => arg.to_str().is_some_and(|s| s.starts_with("-psn_")),
        _ => false,
    }
}

fn launch_kind(args: &[OsString]) -> &'static str {
    if is_normal(args) {
        "normal"
    } else if args.first().is_some_and(|s| s == "--updater-receipt") {
        "successor"
    } else {
        "explicit"
    }
}

fn global_source(profile: PathBuf, port: u16, daemon_id: String, lineage_id: String) -> Source {
    Source {
        profile,
        port,
        home: Home {
            daemon_id,
            lineage_id,
        },
        project: None,
    }
}

/// Normal launch: the saved selection while it names this profile's daemon,
/// else the same profile discovery as GPUI with Day's own journal.
fn normal_launch(home: &Path, env: impl Fn(&str) -> Option<OsString>) -> Result<Launch, Error> {
    let (source, journal, origin) = match saved_launch(home) {
        Ok((source, journal)) => (source, journal, Origin::Saved),
        Err(reason) => {
            if reason != "missing" {
                crate::day_log::event("launch.saved_ignored", json!({"reason": reason}));
            }
            let (source, journal) = discover(home, env)?;
            (source, journal, Origin::Discovered)
        }
    };
    Ok(Launch::Selected(Box::new(NativeSelection {
        source,
        journal,
        app: None,
        planning_model: None,
        official_inputs: None,
        origin,
    })))
}

fn saved_launch(home: &Path) -> Result<(Source, PathBuf), &'static str> {
    let path = support_directory(home).join("launch.json");
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err("missing"),
        Err(_) => return Err("unreadable"),
    };
    let meta = file.metadata().map_err(|_| "unreadable")?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > SAVED_LAUNCH_MAX
    {
        return Err("not private");
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(SAVED_LAUNCH_MAX + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "unreadable")?;
    let saved: SavedLaunch = serde_json::from_slice(&bytes).map_err(|_| "invalid")?;
    if saved.version != 1
        || saved.port == 0
        || !saved.profile.is_absolute()
        || !saved.journal.is_absolute()
    {
        return Err("invalid");
    }
    if profile_id(&saved.profile, "daemon-id").ok().as_ref() != Some(&saved.daemon_id)
        || profile_id(&saved.profile, "storage-lineage").ok().as_ref() != Some(&saved.lineage_id)
    {
        return Err("identity changed");
    }
    Ok((
        global_source(saved.profile, saved.port, saved.daemon_id, saved.lineage_id),
        saved.journal,
    ))
}

/// Writes launch.json atomically (private temp file, then rename).
fn save_launch(home: &Path, source: &Source, journal: &Path) -> std::io::Result<()> {
    let dir = create_support_directory(home)?;
    let bytes = serde_json::to_vec(&SavedLaunch {
        version: 1,
        profile: source.profile.clone(),
        port: source.port,
        daemon_id: source.home.daemon_id.clone(),
        lineage_id: source.home.lineage_id.clone(),
        journal: journal.to_path_buf(),
    })?;
    let temp = dir.join(format!(".launch.json.{}", uuid::Uuid::new_v4()));
    let result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temp)
        .and_then(|mut file| {
            file.write_all(&bytes)?;
            file.sync_all()
        })
        .and_then(|()| std::fs::rename(&temp, dir.join("launch.json")));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Same profile and port rules as GPUI's `LocalOptions::discover`.
fn discover(
    home: &Path,
    env: impl Fn(&str) -> Option<OsString>,
) -> Result<(Source, PathBuf), Error> {
    let port = match env("PILOT_PORT") {
        None => 4319,
        Some(port) => port
            .to_str()
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p > 0)
            .ok_or(Error::Invalid)?,
    };
    let profile = match env("PILOT_HOME") {
        Some(profile) => PathBuf::from(profile),
        None => env("XDG_DATA_HOME")
            .map_or_else(|| home.join(".local/share"), PathBuf::from)
            .join("pilot"),
    };
    if !profile.is_absolute() {
        return Err(Error::Invalid);
    }
    let daemon_id = profile_id(&profile, "daemon-id")?;
    let lineage_id = profile_id(&profile, "storage-lineage")?;
    let journal = create_support_directory(home)
        .map_err(|_| Error::Storage)?
        .join("window-journal");
    Ok((global_source(profile, port, daemon_id, lineage_id), journal))
}

/// A profile identity file (`daemon-id`, `storage-lineage`), trimmed.
fn profile_id(profile: &Path, name: &str) -> Result<String, Error> {
    let path = profile.join(name);
    let meta = std::fs::symlink_metadata(&path).map_err(|_| Error::Unavailable)?;
    if !meta.is_file() || meta.len() > 128 {
        return Err(Error::Invalid);
    }
    let value = std::fs::read_to_string(path).map_err(|_| Error::Unavailable)?;
    let value = value.trim();
    if !crate::host::valid_id(value) {
        return Err(Error::Invalid);
    }
    Ok(value.to_owned())
}

fn launch(args: Vec<OsString>) -> Result<Launch, Error> {
    if args.first().is_some_and(|s| s == "--updater-receipt") {
        if args.len() != 2 {
            return Err(Error::Invalid);
        }
        let receipt = PathBuf::from(&args[1]);
        if !receipt.is_absolute() {
            return Err(Error::Invalid);
        }
        return Ok(Launch::Successor(receipt));
    }
    // An exact already-staged native target, never screen-supplied paths or a
    // signature bypass. Controller prepare reacquires its lock and verifies it.
    let mut native = BTreeMap::new();
    let mut selected = vec![];
    let mut args = args.into_iter();
    while let Some(key) = args.next() {
        let value = args.next().ok_or(Error::Invalid)?;
        if [
            "--update-transaction",
            "--update-source",
            "--update-build",
            "--planning-model",
            "--official-update-inputs",
        ]
        .iter()
        .any(|s| key == *s)
        {
            if native.insert(key, value).is_some() {
                return Err(Error::Invalid);
            }
        } else {
            selected.extend([key, value]);
        }
    }
    let (source, journal) = selection(selected)?;
    let official_inputs = native
        .remove(&OsString::from("--official-update-inputs"))
        .map(PathBuf::from);
    if official_inputs
        .as_ref()
        .is_some_and(|path| !path.is_absolute())
        || (official_inputs.is_some()
            && ["--update-transaction", "--update-source", "--update-build"]
                .iter()
                .any(|key| native.contains_key(&OsString::from(key))))
    {
        return Err(Error::Invalid);
    }
    // Optional, exact native model selection. No ambient/profile default and no
    // provider call here. The existing enrollment confirmation still gates New.
    let planning_model = native
        .remove(&OsString::from("--planning-model"))
        .map(|value| value.into_string().map_err(|_| Error::Invalid))
        .transpose()?;
    if planning_model
        .as_ref()
        .is_some_and(|model| model.trim().is_empty() || model.len() > 256)
    {
        return Err(Error::Invalid);
    }
    let app = if native.is_empty() {
        None
    } else {
        let transaction = PathBuf::from(
            native
                .remove(&OsString::from("--update-transaction"))
                .ok_or(Error::Invalid)?,
        );
        let source = native
            .remove(&OsString::from("--update-source"))
            .ok_or(Error::Invalid)?
            .into_string()
            .map_err(|_| Error::Invalid)?;
        let build = native
            .remove(&OsString::from("--update-build"))
            .ok_or(Error::Invalid)?
            .into_string()
            .map_err(|_| Error::Invalid)?;
        if !transaction.is_absolute() {
            return Err(Error::Invalid);
        }
        pilot_desktop_updater::iteration::ExpectedTarget::new(source.clone(), build.clone())
            .map_err(|_| Error::Invalid)?;
        Some(AppTarget {
            transaction,
            target: pilot_desktop_updater::layout::running_root().map_err(|_| Error::Identity)?,
            source,
            build,
        })
    };
    Ok(Launch::Selected(Box::new(NativeSelection {
        source,
        journal,
        app,
        planning_model,
        official_inputs,
        origin: Origin::Args,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_preparation_runs_off_appkit_and_keeps_refusals() {
        assert_eq!(
            before_appkit(|| Ok(MainThreadMarker::new().is_none())),
            Ok(true)
        );
        assert_eq!(
            before_appkit(|| Err::<(), _>(Error::Identity)),
            Err(Error::Identity)
        );
    }
    #[test]
    fn packaged_resource_identity_has_no_development_fallback() {
        assert_eq!(
            resource_directory(Path::new("/tmp/Pilot.app/Contents/MacOS/pilot-desktop")),
            Ok(PathBuf::from("/tmp/Pilot.app/Contents/Resources/nsh"))
        );
        for exe in [
            "/tmp/pilot-desktop",
            "/tmp/Pilot Day.app/Contents/MacOS/PilotDay",
            "/tmp/Pilot Next.app/Contents/MacOS/PilotDay",
            "/tmp/Pilot Next.app/Contents/MacOS/pilot-desktop",
        ] {
            assert_eq!(resource_directory(Path::new(exe)), Err(Error::Identity));
        }
    }
    #[test]
    fn successor_and_development_flags_never_fall_back_to_fresh_start() {
        assert!(matches!(
            launch(vec!["--updater-receipt".into(), "/tmp/receipt".into()]),
            Ok(Launch::Successor(_))
        ));
        assert!(launch(vec!["--updater-receipt".into(), "relative".into()]).is_err());
        assert!(
            launch(vec![
                "--updater-receipt".into(),
                "/tmp/receipt".into(),
                "--profile".into(),
                "/tmp/profile".into()
            ])
            .is_err()
        );
        for flag in ["--app-dir", "--chunk-dir"] {
            assert!(matches!(
                selection(vec![flag.into(), "/tmp/untrusted".into()]),
                Err(Error::Unavailable)
            ));
        }
        assert!(selection(vec![]).is_err());
    }

    fn selected_args() -> Vec<OsString> {
        [
            "--profile",
            "/tmp/profile",
            "--port",
            "1234",
            "--daemon-id",
            "daemon",
            "--lineage-id",
            "lineage",
            "--project-id",
            "project",
            "--project-path",
            "/tmp/project",
            "--journal",
            "/tmp/window-journal",
        ]
        .into_iter()
        .map(OsString::from)
        .collect()
    }

    #[test]
    fn raw_daemon_paths_and_bindings_are_not_a_trusted_input_supplier() {
        for (flag, value) in [
            ("--daemon-capsule", "/tmp/Pilot Next.app"),
            ("--daemon-binding", r#"{"id":"invented-proposal"}"#),
            ("--daemon-update-receipt", "/tmp/invented-receipt"),
        ] {
            let mut args = selected_args();
            args.extend([flag.into(), value.into()]);
            assert!(matches!(launch(args), Err(Error::Unavailable)));
        }
    }

    #[test]
    fn global_launch_needs_profile_identity_not_a_project_or_model() {
        let args: Vec<_> = selected_args()
            .chunks(2)
            .filter(|p| p[0] != "--project-id" && p[0] != "--project-path")
            .flatten()
            .cloned()
            .collect();
        let Launch::Selected(selected) = launch(args.clone()).unwrap() else {
            panic!("selected launch")
        };
        assert!(selected.source.project.is_none());
        assert!(selected.planning_model.is_none());
        assert_eq!(selected.origin, Origin::Args);
        assert_eq!(selected.source.profile, PathBuf::from("/tmp/profile"));
        for (key, value) in [
            ("--project-id", "project"),
            ("--project-path", "/tmp/project"),
        ] {
            let mut partial = args.clone();
            partial.extend([key.into(), value.into()]);
            assert!(
                launch(partial).is_err(),
                "legacy selection must be a complete pair"
            );
        }
        let Launch::Selected(legacy) = launch(selected_args()).unwrap() else {
            panic!("selected launch")
        };
        let project = legacy.source.project().unwrap();
        assert_eq!(project.project_id, "project");
        assert_eq!(project.project_path, "/tmp/project");
    }

    #[test]
    fn planning_model_is_explicit_native_selection_not_a_default() {
        let Launch::Selected(selected) = launch(selected_args()).unwrap() else {
            panic!("selected launch")
        };
        assert_eq!(selected.planning_model, None);
        let mut args = selected_args();
        args.extend(["--planning-model".into(), "faux/faux-1".into()]);
        let Launch::Selected(selected) = launch(args.clone()).unwrap() else {
            panic!("selected launch")
        };
        assert_eq!(selected.planning_model.as_deref(), Some("faux/faux-1"));
        args.extend(["--planning-model".into(), "other/model".into()]);
        assert!(launch(args).is_err(), "duplicate authority must refuse");
        for model in ["".to_owned(), " ".to_owned(), "x".repeat(257)] {
            let mut args = selected_args();
            args.extend(["--planning-model".into(), model.into()]);
            assert!(
                launch(args).is_err(),
                "invalid model must refuse before opening"
            );
        }
        let mut args = selected_args();
        args.extend(["--model".into(), "faux/faux-1".into()]);
        assert!(launch(args).is_err(), "no alternate model flag");
    }

    #[test]
    fn official_inputs_are_optional_explicit_and_never_mixed_with_legacy_targets() {
        let Launch::Selected(selected) = launch(selected_args()).unwrap() else {
            panic!("selected launch")
        };
        assert!(selected.official_inputs.is_none());
        let mut args = selected_args();
        args.extend([
            "--official-update-inputs".into(),
            "/tmp/distributions".into(),
        ]);
        let Launch::Selected(selected) = launch(args.clone()).unwrap() else {
            panic!("selected launch")
        };
        assert_eq!(
            selected.official_inputs,
            Some(PathBuf::from("/tmp/distributions"))
        );
        args.extend(["--update-transaction".into(), "/tmp/legacy".into()]);
        assert!(launch(args).is_err());
        for value in ["relative", ""] {
            let mut args = selected_args();
            args.extend(["--official-update-inputs".into(), value.into()]);
            assert!(launch(args).is_err());
        }
        let mut args = selected_args();
        args.extend([
            "--official-update-inputs".into(),
            "/tmp/one".into(),
            "--official-update-inputs".into(),
            "/tmp/two".into(),
        ]);
        assert!(launch(args).is_err());
    }

    fn temp_home() -> PathBuf {
        let home = std::env::temp_dir().join(format!("day-home-{}", uuid::Uuid::new_v4()));
        write_profile(&home.join(".local/share/pilot"), "daemon-1", "lineage-1");
        home
    }

    fn write_profile(profile: &Path, daemon: &str, lineage: &str) {
        std::fs::create_dir_all(profile).unwrap();
        std::fs::write(profile.join("daemon-id"), format!("{daemon}\n")).unwrap();
        std::fs::write(profile.join("storage-lineage"), format!("{lineage}\n")).unwrap();
    }

    fn no_env(_: &str) -> Option<OsString> {
        None
    }

    fn normal(home: &Path) -> NativeSelection {
        match normal_launch(home, no_env).unwrap() {
            Launch::Selected(selected) => *selected,
            Launch::Successor(_) => panic!("selected launch"),
        }
    }

    #[test]
    fn finder_launch_without_arguments_is_a_normal_launch() {
        assert!(is_normal(&[]));
        assert!(is_normal(&["-psn_0_12345".into()]));
        assert!(!is_normal(&["-psn_0_12345".into(), "--profile".into()]));
        assert!(!is_normal(&["--profile".into()]));
        assert_eq!(launch_kind(&["-psn_0_1".into()]), "normal");
        assert_eq!(launch_kind(&selected_args()), "explicit");
        assert_eq!(
            launch_kind(&["--updater-receipt".into(), "/tmp/r".into()]),
            "successor"
        );
    }

    #[test]
    fn normal_launch_discovers_the_profile_like_gpui_with_a_day_journal() {
        let home = temp_home();
        let selected = normal(&home);
        assert_eq!(selected.origin, Origin::Discovered);
        assert_eq!(
            selected.source,
            global_source(
                home.join(".local/share/pilot"),
                4319,
                "daemon-1".into(),
                "lineage-1".into()
            )
        );
        assert_eq!(
            selected.journal,
            home.join("Library/Application Support/Pilot Day/window-journal")
        );
        let meta = std::fs::metadata(support_directory(&home)).unwrap();
        assert_eq!(meta.mode() & 0o777, 0o700);
        assert!(selected.app.is_none() && selected.planning_model.is_none());

        let other = home.join("other-profile");
        write_profile(&other, "daemon-2", "lineage-2");
        let env = |name: &str| match name {
            "PILOT_HOME" => Some(other.clone().into_os_string()),
            "PILOT_PORT" => Some("5000".into()),
            _ => None,
        };
        let (source, _) = discover(&home, env).unwrap();
        assert_eq!((source.profile, source.port), (other.clone(), 5000));
        assert_eq!(source.home.daemon_id, "daemon-2");
        let xdg = home.join("xdg");
        write_profile(&xdg.join("pilot"), "daemon-3", "lineage-3");
        let env = |name: &str| (name == "XDG_DATA_HOME").then(|| xdg.clone().into_os_string());
        assert_eq!(discover(&home, env).unwrap().0.profile, xdg.join("pilot"));
        let bad_port = |name: &str| (name == "PILOT_PORT").then(|| OsString::from("0"));
        assert_eq!(discover(&home, bad_port).err(), Some(Error::Invalid));

        let empty = std::env::temp_dir().join(format!("day-home-{}", uuid::Uuid::new_v4()));
        assert!(
            normal_launch(&empty, no_env).is_err(),
            "no profile ids, no launch"
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn saved_launch_is_used_only_while_private_and_matching_the_profile() {
        let home = temp_home();
        let profile = home.join(".local/share/pilot");
        let journal = home.join("Applications/Pilot/window-journal");
        let source = global_source(
            profile.clone(),
            24680,
            "daemon-1".into(),
            "lineage-1".into(),
        );
        save_launch(&home, &source, &journal).unwrap();
        let path = support_directory(&home).join("launch.json");
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            saved,
            json!({"version": 1, "profile": profile, "port": 24680, "daemonId": "daemon-1",
                "lineageId": "lineage-1", "journal": journal})
        );
        let entries = std::fs::read_dir(support_directory(&home)).unwrap().count();
        assert_eq!(entries, 1, "no temporary file left");

        let selected = normal(&home);
        assert_eq!(selected.origin, Origin::Saved);
        assert_eq!(selected.source, source);
        assert_eq!(selected.journal, journal);

        // Changed profile identity: discover again, with Day's own journal.
        write_profile(&profile, "daemon-2", "lineage-1");
        let selected = normal(&home);
        assert_eq!(selected.origin, Origin::Discovered);
        assert_eq!(selected.source.home.daemon_id, "daemon-2");
        assert_eq!(selected.source.port, 4319);
        write_profile(&profile, "daemon-1", "lineage-1");
        assert_eq!(normal(&home).origin, Origin::Saved);

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(normal(&home).origin, Origin::Discovered, "not private");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let real = support_directory(&home).join("real.json");
        std::fs::rename(&path, &real).unwrap();
        std::os::unix::fs::symlink(&real, &path).unwrap();
        assert_eq!(normal(&home).origin, Origin::Discovered, "symlink");
        std::fs::remove_file(&path).unwrap();

        std::fs::write(&path, "{\"version\":1}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(normal(&home).origin, Origin::Discovered, "incomplete");
        std::fs::remove_dir_all(home).unwrap();
    }
}

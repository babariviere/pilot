//! One bounded, background-only preferences owner. No GPUI, theme or daemon access.
use crate::settings_state::{
    LoadedPreferences, Preferences, SaveRequest, SettingsError, SettingsStore,
};
use async_channel::{Receiver, Sender};
use std::{
    fs::{self, File},
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Component, PathBuf},
    thread::{self, JoinHandle},
};

#[derive(Debug)]
pub(crate) enum Command {
    Load(u64),
    Save(u64, Box<SaveRequest>),
}
#[derive(Debug)]
pub(crate) enum Update {
    Loaded(u64, Result<LoadedPreferences, SettingsError>),
    Saved(u64, SaveRequest, Result<(), SettingsError>),
}
pub(crate) struct SettingsWorker {
    commands: Sender<Command>,
    _thread: Option<JoinHandle<()>>,
}
impl SettingsWorker {
    /// Starting a worker performs no storage I/O until the explicit Load command.
    pub(crate) fn start(root: PathBuf) -> Result<(Self, Receiver<Update>), SettingsError> {
        let (commands, input) = async_channel::bounded(1);
        let (output, updates) = async_channel::bounded(1);
        let worker = thread::Builder::new()
            .name("desktop-settings".into())
            .spawn(move || run(root, input, output))
            .map_err(|_| SettingsError::Io)?;
        Ok((
            Self {
                commands,
                _thread: Some(worker),
            },
            updates,
        ))
    }
    pub(crate) fn command(&self, command: Command) -> Result<(), SettingsError> {
        self.commands.try_send(command).map_err(|error| {
            if error.is_full() {
                SettingsError::Busy
            } else {
                SettingsError::Io
            }
        })
    }
}
impl Drop for SettingsWorker {
    fn drop(&mut self) {
        // Never join a blocking filesystem operation on the UI thread. Closing both
        // channels lets the one owned thread finish its current operation and exit.
        self.commands.close();
    }
}

fn run(root: PathBuf, commands: Receiver<Command>, updates: Sender<Update>) {
    let mut backend = Backend::new(root);
    while let Ok(command) = commands.recv_blocking() {
        let update = match command {
            Command::Load(generation) => Update::Loaded(generation, backend.load()),
            Command::Save(generation, request) => {
                Update::Saved(generation, *request, backend.save(request.preferences()))
            }
        };
        if updates.send_blocking(update).is_err() {
            break;
        }
    }
}

struct Backend {
    root: PathBuf,
    store: SettingsStore,
    missing_parent: bool,
}
impl Backend {
    fn new(root: PathBuf) -> Self {
        Self {
            store: SettingsStore::new(root.clone()),
            root,
            missing_parent: false,
        }
    }
    fn load(&mut self) -> Result<LoadedPreferences, SettingsError> {
        self.missing_parent = false;
        if !self.root.is_absolute()
            || self
                .root
                .components()
                .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        {
            return Err(SettingsError::UnsafePath);
        }
        let parent = self.root.parent().ok_or(SettingsError::UnsafePath)?;
        let mut ancestor = PathBuf::new();
        for component in parent.components() {
            ancestor.push(component);
            match fs::symlink_metadata(&ancestor) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => (),
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound && ancestor == parent => {}
                _ => return Err(SettingsError::UnsafePath),
            }
        }
        match fs::symlink_metadata(parent) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // First Local launch may precede the draft writer creating its Next root.
                // Opening Settings still must not create it or touch Swift defaults.
                self.missing_parent = true;
                Ok(LoadedPreferences {
                    preferences: Preferences::default(),
                    persisted: false,
                })
            }
            _ => self.store.load(),
        }
    }
    fn save(&mut self, preferences: Preferences) -> Result<(), SettingsError> {
        if self.missing_parent {
            let parent = self.root.parent().ok_or(SettingsError::UnsafePath)?;
            match fs::DirBuilder::new().mode(0o700).create(parent) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(_) => return Err(SettingsError::Io),
            }
            let meta = fs::symlink_metadata(parent).map_err(|_| SettingsError::Io)?;
            if !meta.is_dir()
                || meta.file_type().is_symlink()
                || meta.mode() & 0o077 != 0
                || meta.uid() != unsafe { libc::geteuid() }
            {
                return Err(SettingsError::UnsafePath);
            }
            // Only the explicit Save may create this one Next-owned parent. No recursive
            // directory creation, chmod, draft-lock acquisition or snapshot import.
            File::open(parent.parent().ok_or(SettingsError::UnsafePath)?)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| SettingsError::Io)?;
            let loaded = self.store.load()?;
            if loaded.persisted {
                return Err(SettingsError::Conflict);
            }
            self.missing_parent = false;
        }
        self.store.save(preferences)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings_state::{AppearancePreference, SettingsState};
    use std::{
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(1);
    struct Private(PathBuf);
    impl Private {
        fn new() -> Self {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "settings-worker-synthetic-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            Self(root)
        }
    }
    impl Drop for Private {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn background_roundtrip_restart_and_disconnect_are_bounded() {
        let temp = Private::new();
        let root = temp.0.join("settings");
        let (mut worker, updates) = SettingsWorker::start(root.clone()).unwrap();
        assert!(!root.exists());
        worker.command(Command::Load(7)).unwrap();
        let Update::Loaded(7, Ok(loaded)) = updates.recv_blocking().unwrap() else {
            panic!("load")
        };
        assert!(!loaded.persisted);
        assert!(!root.exists());
        let mut state = SettingsState::default();
        state.begin_load();
        state.finish_load(Ok(loaded));
        state.set_appearance(AppearancePreference::Dark);
        let request = state.begin_save().unwrap();
        worker.command(Command::Save(7, Box::new(request))).unwrap();
        let Update::Saved(7, receipt, result) = updates.recv_blocking().unwrap() else {
            panic!("save")
        };
        state.finish_save(receipt, result);
        assert!(state.persisted());
        worker.commands.close();
        drop(updates);
        worker._thread.take().unwrap().join().unwrap();
        drop(worker);
        let mut restarted = SettingsStore::new(root);
        assert_eq!(
            restarted.load().unwrap().preferences.appearance,
            AppearancePreference::Dark
        );
    }
    #[test]
    fn first_load_creates_nothing_and_explicit_save_creates_only_next_parent() {
        let temp = Private::new();
        let parent = temp.0.join("next");
        let root = parent.join("settings");
        let mut backend = Backend::new(root.clone());
        assert!(!backend.load().unwrap().persisted);
        assert!(!parent.exists());
        backend
            .save(Preferences {
                appearance: AppearancePreference::Light,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(fs::metadata(&parent).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::read_dir(parent).unwrap().count(), 1);
        assert_eq!(
            SettingsStore::new(root)
                .load()
                .unwrap()
                .preferences
                .appearance,
            AppearancePreference::Light
        );
    }
    #[test]
    fn a_new_external_snapshot_after_missing_parent_is_not_adopted_or_overwritten() {
        let temp = Private::new();
        let parent = temp.0.join("next");
        let root = parent.join("settings");
        let mut backend = Backend::new(root.clone());
        backend.load().unwrap();
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        let mut external = SettingsStore::new(root.clone());
        external.load().unwrap();
        external.save(Preferences::default()).unwrap();
        assert_eq!(
            backend.save(Preferences {
                appearance: AppearancePreference::Dark,
                ..Default::default()
            }),
            Err(SettingsError::Conflict)
        );
        assert_eq!(
            SettingsStore::new(root).load().unwrap().preferences,
            Preferences::default()
        );
    }
    #[test]
    fn closed_or_full_queue_returns_error_without_waiting() {
        let (commands, input) = async_channel::bounded(1);
        commands.try_send(Command::Load(1)).unwrap();
        assert!(commands.try_send(Command::Load(2)).unwrap_err().is_full());
        input.close();
        assert!(commands.try_send(Command::Load(3)).unwrap_err().is_closed());
    }
}

//! Pure path-import harness: deliberately not registered through lib.rs or Cargo.toml.
#[path = "../src/settings_state.rs"]
mod settings_state;

use settings_state::{
    AppearancePreference::{Dark, Light, System},
    LoadedPreferences, PREFERENCES_FILE, PREFERENCES_LIMIT, Preferences, SettingsError,
    SettingsState, SettingsStore, TestFault,
};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(1);
struct PrivateDirectory(PathBuf);
impl PrivateDirectory {
    fn new() -> Self {
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let path = parent.join(format!(
            "settings-synthetic-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn root(&self) -> PathBuf {
        self.0.join("next-settings")
    }
    fn store(&self) -> SettingsStore {
        SettingsStore::new(self.root())
    }
    fn seed(&self, bytes: &[u8]) {
        if !self.root().exists() {
            fs::create_dir(self.root()).unwrap();
            fs::set_permissions(self.root(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let path = self.root().join(PREFERENCES_FILE);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn preferences(appearance: settings_state::AppearancePreference) -> Preferences {
    Preferences {
        appearance,
        ..Default::default()
    }
}

#[test]
fn automatic_checks_wait_for_exact_settings_durability_and_roundtrip_legacy_defaults() {
    let mut state = SettingsState::default();
    assert!(state.begin_load());
    assert!(state.finish_load(Ok(LoadedPreferences {
        preferences: Preferences::default(),
        persisted: false
    })));
    assert!(!state.current().automatic_update_checks);
    assert_eq!(state.durability_token(), None);
    let initial = state
        .begin_durability_checkpoint()
        .expect("explicit restart may persist previously missing defaults");
    assert!(state.finish_save(initial, Ok(())));
    let first = state.durability_token().unwrap();
    assert!(state.set_automatic_update_checks(true));
    assert_eq!(state.durability_token(), None);
    let requested = state.begin_save().unwrap();
    assert_eq!(state.durability_token(), None);
    assert!(state.finish_save(requested, Err(SettingsError::DurabilityUnknown)));
    assert_eq!(state.durability_token(), None);
    let retry = state.begin_save().unwrap();
    assert!(state.finish_save(retry, Ok(())));
    assert!(state.durability_token().unwrap() > first);
    assert!(state.current().automatic_update_checks);
}

#[test]
fn font_bounds_legacy_load_roundtrip_and_font_only_defaults() {
    use settings_state::{FontFamily, FontPreferences};
    assert!(FontFamily::new(&"x".repeat(97)).is_none());
    assert!(FontFamily::new("bad\nfont").is_none());
    assert!(FontFamily::new("字形 👩‍💻").is_some());
    let temp = PrivateDirectory::new();
    temp.seed(br#"{"version":1,"preferences":{"appearance":"dark"}}"#);
    let mut store = temp.store();
    let original = store.load().unwrap().preferences;
    assert_eq!(original, preferences(Dark));
    let mut state = loaded_state(original, true);
    let fonts = FontPreferences {
        chat_family: FontFamily::new("Georgia").unwrap(),
        code_family: FontFamily::new("Menlo").unwrap(),
        chat_size: Some(44),
        code_size: Some(18),
    };
    assert!(state.set_fonts(fonts));
    assert!(!state.set_fonts(FontPreferences {
        chat_size: Some(45),
        ..fonts
    }));
    assert!(!state.set_fonts(FontPreferences {
        code_size: Some(17),
        ..fonts
    }));
    let request = state.begin_save().unwrap();
    assert!(state.set_fonts(FontPreferences::default()));
    state.finish_save(request, store.save(request.preferences()));
    assert_eq!(
        state.current(),
        original,
        "font-only defaults preserve appearance"
    );
    assert_eq!(temp.store().load().unwrap().preferences.fonts, fonts);
    assert!(
        state.dirty(),
        "late ACK cannot overwrite newer font defaults"
    );
    let defaults = state.begin_save().unwrap();
    state.finish_save(defaults, store.save(defaults.preferences()));
    assert_eq!(temp.store().load().unwrap().preferences, original);
}

#[test]
fn invalid_font_snapshot_is_not_overwritten() {
    let temp = PrivateDirectory::new();
    let bytes = br#"{"version":1,"preferences":{"appearance":"light","fonts":{"chat_family":"Georgia","code_family":"Menlo","chat_size":255,"code_size":26}}}"#;
    temp.seed(bytes);
    let mut store = temp.store();
    assert_eq!(store.load(), Err(SettingsError::InvalidData));
    assert!(store.save(preferences(Dark)).is_err());
    assert_eq!(fs::read(temp.root().join(PREFERENCES_FILE)).unwrap(), bytes);
}

#[test]
fn uncertain_font_save_retries_exact_payload_before_newer_defaults() {
    use settings_state::FontPreferences;
    let temp = PrivateDirectory::new();
    let mut store = temp.store();
    store.load().unwrap();
    store.save(preferences(Dark)).unwrap();
    let mut state = loaded_state(preferences(Dark), true);
    let fonts = FontPreferences {
        chat_size: Some(31),
        code_size: Some(29),
        ..Default::default()
    };
    state.set_fonts(fonts);
    let first = state.begin_save().unwrap();
    store.fail_at = Some(TestFault::AfterRename);
    assert_eq!(
        store.save(first.preferences()),
        Err(SettingsError::DurabilityUnknown)
    );
    state.finish_save(first, Err(SettingsError::DurabilityUnknown));
    state.set_fonts(Default::default());
    let retry = state.begin_save().unwrap();
    assert_eq!(retry.preferences().fonts, fonts);
    store.fail_at = None;
    state.finish_save(retry, store.save(retry.preferences()));
    assert_eq!(state.current(), preferences(Dark));
    assert_eq!(state.committed().unwrap().fonts, fonts);
    assert!(state.dirty());
    let latest = state.begin_save().unwrap();
    state.finish_save(latest, store.save(latest.preferences()));
    assert_eq!(temp.store().load().unwrap().preferences, preferences(Dark));
}
fn loaded_state(value: Preferences, persisted: bool) -> SettingsState {
    let mut state = SettingsState::default();
    assert!(state.begin_load());
    assert!(state.finish_load(Ok(LoadedPreferences {
        preferences: value,
        persisted
    })));
    state
}

#[test]
fn construction_and_missing_load_are_read_only() {
    let temp = PrivateDirectory::new();
    let mut store = temp.store();
    let state = SettingsState::default();
    assert!(!state.loaded());
    assert!(!state.dirty());
    assert!(!state.persisted());
    assert_eq!(state.current(), preferences(System));
    assert!(!temp.root().exists());
    assert_eq!(store.save(preferences(Dark)), Err(SettingsError::NotLoaded));
    assert!(!temp.root().exists());
    assert_eq!(
        store.load(),
        Ok(LoadedPreferences {
            preferences: preferences(System),
            persisted: false
        })
    );
    assert!(!temp.root().exists());
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 0);
}

#[test]
fn explicit_model_load_edit_save_revert_and_retry_contract() {
    let mut state = SettingsState::default();
    assert!(!state.set_appearance(Dark));
    assert!(!state.revert());
    assert!(state.begin_save().is_none());
    assert!(!state.finish_load(Err(SettingsError::Io)));
    assert!(state.begin_load());
    assert!(state.loading());
    assert!(!state.begin_load());
    assert!(state.finish_load(Err(SettingsError::Io)));
    assert!(!state.loaded());
    assert_eq!(state.error(), Some(SettingsError::Io));
    assert!(state.begin_load());
    state.finish_load(Ok(LoadedPreferences {
        preferences: preferences(System),
        persisted: false,
    }));
    assert!(!state.begin_load());
    assert!(!state.persisted());
    assert!(!state.dirty());
    assert!(state.begin_save().is_none());
    assert!(state.set_appearance(Dark));
    assert!(!state.set_appearance(Dark));
    let request = state.begin_save().unwrap();
    assert_eq!(request.preferences(), preferences(Dark));
    assert!(state.saving());
    assert!(state.begin_save().is_none());
    assert!(!state.revert());
    assert!(state.finish_save(request, Err(SettingsError::Io)));
    assert_eq!(state.committed(), None);
    assert!(state.dirty());
    assert!(!state.persisted());
    let retry = state.begin_save().unwrap();
    assert!(state.error().is_none());
    assert!(!state.finish_save(request, Ok(())));
    assert!(state.finish_save(retry, Ok(())));
    assert_eq!(state.committed(), Some(preferences(Dark)));
    assert!(state.persisted());
    assert!(!state.dirty());
    assert!(!state.finish_save(retry, Err(SettingsError::Io)));
    state.set_appearance(Light);
    assert!(state.revert());
    assert_eq!(state.current(), preferences(Dark));
}

#[test]
fn completion_of_old_save_preserves_newer_edits() {
    let mut state = loaded_state(preferences(System), true);
    state.set_appearance(Dark);
    let request = state.begin_save().unwrap();
    state.set_appearance(Light);
    state.finish_save(request, Ok(()));
    assert_eq!(state.current(), preferences(Light));
    assert_eq!(state.committed(), Some(preferences(Dark)));
    assert!(state.dirty());
    assert!(!state.persisted());
    let request = state.begin_save().unwrap();
    state.finish_save(request, Err(SettingsError::Io));
    assert_eq!(state.committed(), Some(preferences(Dark)));
    assert_eq!(state.current(), preferences(Light));
}

#[test]
fn all_appearance_values_roundtrip_and_restart_with_private_modes() {
    let temp = PrivateDirectory::new();
    let mut store = temp.store();
    store.load().unwrap();
    for appearance in [System, Light, Dark, System] {
        store.save(preferences(appearance)).unwrap();
        let mut restarted = temp.store();
        assert_eq!(
            restarted.load(),
            Ok(LoadedPreferences {
                preferences: preferences(appearance),
                persisted: true
            })
        );
    }
    assert_eq!(fs::metadata(temp.root()).unwrap().mode() & 0o777, 0o700);
    for file in [PREFERENCES_FILE, "settings-owner.lock"] {
        assert_eq!(
            fs::metadata(temp.root().join(file)).unwrap().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(fs::read_dir(temp.root()).unwrap().count(), 2);
}

#[test]
fn successful_load_and_identical_save_do_not_rewrite_snapshot() {
    let temp = PrivateDirectory::new();
    let mut store = temp.store();
    store.load().unwrap();
    store.save(preferences(Dark)).unwrap();
    let path = temp.root().join(PREFERENCES_FILE);
    let before = fs::metadata(&path).unwrap();
    let bytes = fs::read(&path).unwrap();
    assert!(store.load().unwrap().persisted);
    store.save(preferences(Dark)).unwrap();
    let after = fs::metadata(path).unwrap();
    assert_eq!(before.ino(), after.ino());
    assert_eq!(before.mtime_nsec(), after.mtime_nsec());
    assert_eq!(bytes, fs::read(temp.root().join(PREFERENCES_FILE)).unwrap());
}

#[test]
fn invalid_future_unknown_duplicate_and_oversized_data_never_enable_writes() {
    let cases: Vec<(Vec<u8>, SettingsError)> = vec![
        (b"".to_vec(), SettingsError::InvalidData),
        (b"{truncated".to_vec(), SettingsError::InvalidData),
        (b"null".to_vec(), SettingsError::InvalidData),
        (
            b"{\"version\":2,\"preferences\":{\"appearance\":\"dark\"}}".to_vec(),
            SettingsError::UnsupportedVersion,
        ),
        (
            b"{\"version\":1,\"preferences\":{\"appearance\":\"sepia\"}}".to_vec(),
            SettingsError::InvalidData,
        ),
        (
            b"{\"version\":1,\"preferences\":{\"appearance\":\"dark\",\"font\":12}}".to_vec(),
            SettingsError::InvalidData,
        ),
        (
            b"{\"version\":1,\"extra\":true,\"preferences\":{\"appearance\":\"dark\"}}".to_vec(),
            SettingsError::InvalidData,
        ),
        (
            b"{\"version\":1,\"version\":1,\"preferences\":{\"appearance\":\"dark\"}}".to_vec(),
            SettingsError::InvalidData,
        ),
        (
            b"{\"version\":1,\"preferences\":{}}".to_vec(),
            SettingsError::InvalidData,
        ),
        (vec![b' '; PREFERENCES_LIMIT + 1], SettingsError::TooLarge),
    ];
    for (bytes, expected) in cases {
        let temp = PrivateDirectory::new();
        temp.seed(&bytes);
        let mut store = temp.store();
        assert_eq!(store.load(), Err(expected));
        assert_eq!(
            store.save(preferences(Light)),
            Err(SettingsError::NotLoaded)
        );
        assert_eq!(fs::read(temp.root().join(PREFERENCES_FILE)).unwrap(), bytes);
        assert_eq!(fs::read_dir(temp.root()).unwrap().count(), 1);
    }
}

#[test]
fn load_failure_revokes_previous_baseline_and_load_retry_is_explicit() {
    let temp = PrivateDirectory::new();
    let mut store = temp.store();
    store.load().unwrap();
    store.save(preferences(Dark)).unwrap();
    temp.seed(b"unsupported");
    assert_eq!(store.load(), Err(SettingsError::InvalidData));
    assert_eq!(
        store.save(preferences(Light)),
        Err(SettingsError::NotLoaded)
    );
    temp.seed(b"{\"version\":1,\"preferences\":{\"appearance\":\"dark\"}}");
    assert_eq!(store.load().unwrap().preferences, preferences(Dark));
    store.save(preferences(Light)).unwrap();
}

#[test]
fn failed_write_keeps_committed_bytes_and_model_then_retries() {
    let temp = PrivateDirectory::new();
    let mut store = temp.store();
    store.load().unwrap();
    store.save(preferences(System)).unwrap();
    let before = fs::read(temp.root().join(PREFERENCES_FILE)).unwrap();
    let mut state = loaded_state(preferences(System), true);
    state.set_appearance(Dark);
    store.fail_at = Some(TestFault::BeforeRename);
    let request = state.begin_save().unwrap();
    assert_eq!(store.save(request.preferences()), Err(SettingsError::Io));
    state.finish_save(request, Err(SettingsError::Io));
    assert_eq!(state.committed(), Some(preferences(System)));
    assert_eq!(
        fs::read(temp.root().join(PREFERENCES_FILE)).unwrap(),
        before
    );
    assert!(!temp.root().join(".preferences-v1.pending").exists());
    store.fail_at = None;
    let retry = state.begin_save().unwrap();
    state.finish_save(retry, store.save(retry.preferences()));
    assert!(state.persisted());
    assert_eq!(temp.store().load().unwrap().preferences, preferences(Dark));
}

#[test]
fn post_rename_failure_is_unconfirmed_then_confirmed_before_newer_save() {
    let temp = PrivateDirectory::new();
    let mut store = temp.store();
    store.load().unwrap();
    store.save(preferences(System)).unwrap();
    let mut state = loaded_state(preferences(System), true);
    state.set_appearance(Dark);
    let request = state.begin_save().unwrap();
    store.fail_at = Some(TestFault::AfterRename);
    state.set_appearance(Light);
    state.finish_save(request, store.save(request.preferences()));
    assert_eq!(state.error(), Some(SettingsError::DurabilityUnknown));
    assert!(state.unconfirmed());
    assert_eq!(state.committed(), Some(preferences(System)));
    assert!(!state.revert());
    state.set_appearance(System);
    assert!(!state.persisted());
    assert!(state.dirty());
    state.set_appearance(Light);
    assert_eq!(store.load(), Err(SettingsError::DurabilityUnknown));
    assert_eq!(
        store.save(preferences(Light)),
        Err(SettingsError::DurabilityUnknown)
    );
    store.fail_at = None;
    let retry = state.begin_save().unwrap();
    assert_eq!(retry.preferences(), preferences(Dark));
    state.finish_save(retry, store.save(retry.preferences()));
    assert!(!state.unconfirmed());
    assert_eq!(state.current(), preferences(Light));
    assert_eq!(state.committed(), Some(preferences(Dark)));
    assert!(state.dirty());
    let latest = state.begin_save().unwrap();
    state.finish_save(latest, store.save(latest.preferences()));
    assert!(state.persisted());
    assert_eq!(temp.store().load().unwrap().preferences, preferences(Light));
}

#[test]
fn changed_or_deleted_or_unsupported_snapshot_is_not_overwritten() {
    for replacement in [
        Some(b"{\"version\":1,\"preferences\":{\"appearance\":\"light\"}}".as_slice()),
        Some(b"future".as_slice()),
        None,
    ] {
        let temp = PrivateDirectory::new();
        let mut store = temp.store();
        store.load().unwrap();
        store.save(preferences(System)).unwrap();
        match replacement {
            Some(bytes) => temp.seed(bytes),
            None => fs::remove_file(temp.root().join(PREFERENCES_FILE)).unwrap(),
        }
        assert!(store.save(preferences(Dark)).is_err());
        assert_eq!(
            fs::read(temp.root().join(PREFERENCES_FILE)).ok().as_deref(),
            replacement
        );
    }
}

#[test]
fn two_stores_compare_baselines_and_lock_contention_is_retryable() {
    let temp = PrivateDirectory::new();
    let mut first = temp.store();
    let mut second = temp.store();
    first.load().unwrap();
    second.load().unwrap();
    first.save(preferences(Dark)).unwrap();
    assert_eq!(
        second.save(preferences(Light)),
        Err(SettingsError::Conflict)
    );
    second.load().unwrap();
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(temp.root().join("settings-owner.lock"))
        .unwrap();
    assert_eq!(
        unsafe {
            libc::flock(
                std::os::fd::AsRawFd::as_raw_fd(&lock),
                libc::LOCK_EX | libc::LOCK_NB,
            )
        },
        0
    );
    assert_eq!(second.save(preferences(Light)), Err(SettingsError::Busy));
    let lock_inode = lock.metadata().unwrap().ino();
    drop(lock);
    second.save(preferences(Light)).unwrap();
    assert_eq!(
        fs::metadata(temp.root().join("settings-owner.lock"))
            .unwrap()
            .ino(),
        lock_inode
    );
}

#[test]
fn replaced_root_is_not_silently_adopted() {
    let temp = PrivateDirectory::new();
    let mut store = temp.store();
    store.load().unwrap();
    store.save(preferences(Dark)).unwrap();
    let bytes = fs::read(temp.root().join(PREFERENCES_FILE)).unwrap();
    fs::rename(temp.root(), temp.0.join("original")).unwrap();
    temp.seed(&bytes);
    assert_eq!(store.save(preferences(Light)), Err(SettingsError::Conflict));
    assert_eq!(fs::read(temp.root().join(PREFERENCES_FILE)).unwrap(), bytes);
}

#[test]
fn removed_loaded_root_is_not_recreated_and_worker_values_are_send() {
    fn assert_send<T: Send>() {}
    assert_send::<SettingsState>();
    assert_send::<SettingsStore>();
    let temp = PrivateDirectory::new();
    let mut store = temp.store();
    store.load().unwrap();
    store.save(preferences(Dark)).unwrap();
    fs::remove_dir_all(temp.root()).unwrap();
    assert_eq!(store.save(preferences(Light)), Err(SettingsError::Conflict));
    assert!(!temp.root().exists());
}

#[test]
fn symlink_hardlink_public_directory_and_nonregular_snapshot_are_refused() {
    let temp = PrivateDirectory::new();
    let outside = temp.0.join("outside");
    fs::write(&outside, b"sentinel").unwrap();
    fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
    temp.seed(b"{}");
    fs::remove_file(temp.root().join(PREFERENCES_FILE)).unwrap();
    symlink(&outside, temp.root().join(PREFERENCES_FILE)).unwrap();
    assert!(temp.store().load().is_err());
    fs::remove_file(temp.root().join(PREFERENCES_FILE)).unwrap();
    fs::hard_link(&outside, temp.root().join(PREFERENCES_FILE)).unwrap();
    assert_eq!(temp.store().load(), Err(SettingsError::UnsafePath));
    fs::remove_file(temp.root().join(PREFERENCES_FILE)).unwrap();
    fs::create_dir(temp.root().join(PREFERENCES_FILE)).unwrap();
    assert_eq!(temp.store().load(), Err(SettingsError::UnsafePath));
    fs::remove_dir_all(temp.root()).unwrap();
    symlink(&temp.0, temp.root()).unwrap();
    assert_eq!(temp.store().load(), Err(SettingsError::UnsafePath));
    fs::remove_file(temp.root()).unwrap();
    fs::create_dir(temp.root()).unwrap();
    fs::set_permissions(temp.root(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(temp.store().load(), Err(SettingsError::UnsafePath));
    assert_eq!(fs::metadata(temp.root()).unwrap().mode() & 0o777, 0o755);
    assert_eq!(fs::read(outside).unwrap(), b"sentinel");
}

#[test]
fn unsafe_lock_and_existing_pending_file_are_preserved() {
    let temp = PrivateDirectory::new();
    let mut store = temp.store();
    store.load().unwrap();
    store.save(preferences(System)).unwrap();
    let before = fs::read(temp.root().join(PREFERENCES_FILE)).unwrap();
    let pending = temp.root().join(".preferences-v1.pending");
    fs::write(&pending, b"prior interrupted operation").unwrap();
    assert_eq!(
        store.save(preferences(Dark)),
        Err(SettingsError::RecoveryRequired)
    );
    assert_eq!(fs::read(&pending).unwrap(), b"prior interrupted operation");
    fs::remove_file(pending).unwrap();
    let lock = temp.root().join("settings-owner.lock");
    fs::set_permissions(lock, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        store.save(preferences(Dark)),
        Err(SettingsError::UnsafePath)
    );
    assert_eq!(
        fs::read(temp.root().join(PREFERENCES_FILE)).unwrap(),
        before
    );
}

#[test]
fn read_limit_is_exact_and_relative_or_symlink_ancestor_paths_are_refused() {
    let temp = PrivateDirectory::new();
    let mut bytes = b"{\"version\":1,\"preferences\":{\"appearance\":\"system\"}}".to_vec();
    bytes.resize(PREFERENCES_LIMIT, b' ');
    temp.seed(&bytes);
    assert!(temp.store().load().is_ok());
    bytes.push(b' ');
    temp.seed(&bytes);
    assert_eq!(temp.store().load(), Err(SettingsError::TooLarge));
    assert_eq!(
        SettingsStore::new(PathBuf::from("relative")).load(),
        Err(SettingsError::UnsafePath)
    );
    let alias = temp.0.join("alias");
    symlink(temp.root(), &alias).unwrap();
    assert_eq!(
        SettingsStore::new(alias.join("child")).load(),
        Err(SettingsError::UnsafePath)
    );
}

#[test]
fn no_swift_draft_or_neighbor_writes_and_errors_are_content_free() {
    let temp = PrivateDirectory::new();
    for name in [
        "swift-defaults.plist",
        "state-v1.json",
        "owner.lock",
        "auth.json",
    ] {
        fs::write(temp.0.join(name), b"synthetic sentinel").unwrap();
    }
    let mut store = temp.store();
    store.load().unwrap();
    store.save(preferences(Dark)).unwrap();
    for name in [
        "swift-defaults.plist",
        "state-v1.json",
        "owner.lock",
        "auth.json",
    ] {
        assert_eq!(fs::read(temp.0.join(name)).unwrap(), b"synthetic sentinel");
    }
    for error in [
        SettingsError::NotLoaded,
        SettingsError::UnsafePath,
        SettingsError::TooLarge,
        SettingsError::InvalidData,
        SettingsError::UnsupportedVersion,
        SettingsError::Busy,
        SettingsError::RecoveryRequired,
        SettingsError::Conflict,
        SettingsError::Io,
        SettingsError::DurabilityUnknown,
    ] {
        assert!(!error.message().contains(temp.0.to_str().unwrap()));
        assert!(!error.message().contains("synthetic sentinel"));
    }
    // A real pre-rename I/O failure, independent of injected write faults.
    fs::create_dir(temp.root().join(".preferences-v1.pending")).unwrap();
    assert!(store.save(preferences(Light)).is_err());
    assert_eq!(temp.store().load().unwrap().preferences, preferences(Dark));
}

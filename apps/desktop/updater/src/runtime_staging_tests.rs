use super::*;
use std::os::unix::fs::PermissionsExt;

struct FixturePlatform(bool);
impl Platform for FixturePlatform {
    fn verify(&self, path: &Path, _: &Trust, _: &str, _: Option<&str>) -> Result<(), Error> {
        if self.0
            && path
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".stage-")
        {
            Err(Error::Signature)
        } else {
            Ok(())
        }
    }
    fn swap(&self, _: &File, _: &Path, _: &Path) -> Result<(), Error> {
        unreachable!("runtime publication never swaps an installed app")
    }
    fn relaunch(&self, _: &Path, _: &Path) -> Result<(), Error> {
        unreachable!("runtime publication never launches a staged app")
    }
}

fn fixture() -> (crate::owned_tests::Temp, PathBuf, PathBuf, Trust) {
    let temp = crate::owned_tests::Temp::new();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let trust = crate::owned_tests::trust();
    let source = temp.path().join(&trust.bundle_name);
    fs::create_dir(&source).unwrap();
    fs::write(source.join("resource"), b"sealed fixture evidence").unwrap();
    let store = temp.path().join(STORE_NAME);
    (temp, source, store, trust)
}

#[test]
fn repeated_failed_runtime_publications_do_not_exhaust_four_root_capacity() {
    let (_temp, source, store, trust) = fixture();
    for attempt in 0..7 {
        assert_eq!(
            publish(&source, &store, &trust, &FixturePlatform(true)),
            Err(Error::Signature),
            "failed publication attempt {attempt} must not consume permanent runtime capacity"
        );
    }
}

#[test]
fn busy_runtime_store_preserves_interrupted_stage_evidence() {
    let (_temp, source, store, trust) = fixture();
    fs::DirBuilder::new().mode(0o700).create(&store).unwrap();
    let stage = store.join(format!(".stage-{}", "a".repeat(32)));
    fs::DirBuilder::new().mode(0o700).create(&stage).unwrap();
    fs::write(stage.join("partial"), b"unfinished copy").unwrap();
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(store.join(".store.lock"))
        .unwrap();
    // SAFETY: owned fixture descriptor, no live user paths.
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    assert_eq!(
        publish(&source, &store, &trust, &FixturePlatform(true)),
        Err(Error::Busy)
    );
    assert_eq!(fs::read(stage.join("partial")).unwrap(), b"unfinished copy");
    assert_eq!(fs::read_dir(&store).unwrap().count(), 2);
}

#[test]
fn published_runtime_capacity_never_moves_retained_roots() {
    let (_temp, source, store, trust) = fixture();
    fs::DirBuilder::new().mode(0o700).create(&store).unwrap();
    let mut roots = Vec::new();
    for value in 1..=4 {
        let root = store.join(format!("{value:064x}"));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("retained"), b"never move").unwrap();
        roots.push((root.clone(), fs::metadata(&root).unwrap().ino()));
    }
    assert_eq!(
        publish(&source, &store, &trust, &FixturePlatform(true)),
        Err(Error::StagingCapacity)
    );
    for (root, inode) in roots {
        assert_eq!(fs::metadata(&root).unwrap().ino(), inode);
        assert_eq!(fs::read(root.join("retained")).unwrap(), b"never move");
    }
}

#[test]
fn archiving_mixed_stages_never_undercounts_four_published_roots() {
    let (_temp, source, store, trust) = fixture();
    let mut stages = Vec::new();
    let mut roots = Vec::new();
    for value in 1..=4 {
        for offset in 0..3 {
            stages.push(interrupted_stage(&store, value * 3 + offset));
        }
        let root = store.join(format!("{value:064x}"));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("retained"), b"never move").unwrap();
        roots.push((root.clone(), fs::metadata(&root).unwrap().ino()));
    }
    assert_eq!(
        publish(&source, &store, &trust, &FixturePlatform(false)),
        Err(Error::StagingCapacity)
    );
    for (root, inode) in roots {
        assert_eq!(fs::metadata(&root).unwrap().ino(), inode);
        assert_eq!(fs::read(root.join("retained")).unwrap(), b"never move");
    }
    for stage in stages {
        let kept = if stage.exists() {
            stage
        } else {
            store.join(HISTORY).join(stage.file_name().unwrap())
        };
        assert_eq!(
            fs::read(kept.join("partial")).unwrap(),
            b"interrupted sealed copy"
        );
    }
    assert!(
        !store.join(identity(&source).unwrap()).exists(),
        "no fifth publication"
    );
}

fn interrupted_stage(store: &Path, value: u8) -> PathBuf {
    fs::DirBuilder::new()
        .mode(0o700)
        .create(store)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Ok(())
            } else {
                Err(error)
            }
        })
        .unwrap();
    let stage = store.join(format!("{STAGE_PREFIX}{value:032x}"));
    fs::DirBuilder::new().mode(0o700).create(&stage).unwrap();
    fs::write(stage.join("partial"), b"interrupted sealed copy").unwrap();
    stage
}

#[test]
fn interrupted_partial_stage_is_archived_opaquely_without_deleting_evidence() {
    let (_temp, source, store, trust) = fixture();
    let stage = interrupted_stage(&store, 1);
    std::os::unix::fs::symlink("not-copied-yet", stage.join("partial-link")).unwrap();
    let inode = fs::metadata(&stage).unwrap().ino();
    assert_eq!(
        publish(&source, &store, &trust, &FixturePlatform(true)),
        Err(Error::Signature)
    );
    let archived = store.join(HISTORY).join(stage.file_name().unwrap());
    assert!(!stage.exists());
    assert_eq!(fs::metadata(&archived).unwrap().ino(), inode);
    assert_eq!(
        fs::read(archived.join("partial")).unwrap(),
        b"interrupted sealed copy"
    );
    assert_eq!(
        fs::read_link(archived.join("partial-link")).unwrap(),
        Path::new("not-copied-yet")
    );
}

#[test]
fn repeated_duplicate_publication_failures_preserve_all_copies_and_published_root() {
    let (_temp, source, store, trust) = fixture();
    fs::DirBuilder::new().mode(0o700).create(&store).unwrap();
    // A partial/unknown content-addressed destination must never be replaced.
    let destination = store.join(identity(&source).unwrap());
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("retained"), b"untouchable destination").unwrap();
    let inode = fs::metadata(&destination).unwrap().ino();
    for attempt in 0..7 {
        assert_eq!(
            publish(&source, &store, &trust, &FixturePlatform(false)),
            Err(Error::RecoveryRequired),
            "attempt {attempt}"
        );
    }
    assert_eq!(fs::metadata(&destination).unwrap().ino(), inode);
    assert_eq!(
        fs::read(destination.join("retained")).unwrap(),
        b"untouchable destination"
    );
    let history = fs::read_dir(store.join(HISTORY))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(history.len(), 6);
    for entry in history {
        assert_eq!(
            fs::read(entry.path().join(&trust.bundle_name).join("resource")).unwrap(),
            b"sealed fixture evidence"
        );
    }
}

#[test]
fn legacy_stages_without_inherited_leases_are_never_assumed_unused() {
    let (_temp, source, store, trust) = fixture();
    fs::DirBuilder::new().mode(0o700).create(&store).unwrap();
    for value in 1..=4 {
        let stage = store.join(format!(".stage-{value:032x}"));
        fs::DirBuilder::new().mode(0o700).create(&stage).unwrap();
        fs::write(stage.join("legacy-evidence"), b"unknown old writer").unwrap();
    }
    assert_eq!(
        publish(&source, &store, &trust, &FixturePlatform(true)),
        Err(Error::StagingCapacity)
    );
    assert!(!store.join(HISTORY).exists());
    for value in 1..=4 {
        assert_eq!(
            fs::read(store.join(format!(".stage-{value:032x}/legacy-evidence"))).unwrap(),
            b"unknown old writer"
        );
    }
}

#[test]
fn archival_collision_preserves_both_evidence_roots_and_refuses_admission() {
    let (_temp, source, store, trust) = fixture();
    let stage = interrupted_stage(&store, 1);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(store.join(HISTORY))
        .unwrap();
    let archived = store.join(HISTORY).join(stage.file_name().unwrap());
    fs::create_dir(&archived).unwrap();
    fs::write(archived.join("older"), b"previous evidence").unwrap();
    let old_inode = fs::metadata(&archived).unwrap().ino();
    let new_inode = fs::metadata(&stage).unwrap().ino();
    assert_eq!(
        publish(&source, &store, &trust, &FixturePlatform(true)),
        Err(Error::StagingArchiveFailed)
    );
    assert_eq!(fs::metadata(&stage).unwrap().ino(), new_inode);
    assert_eq!(fs::metadata(&archived).unwrap().ino(), old_inode);
    assert_eq!(
        fs::read(archived.join("older")).unwrap(),
        b"previous evidence"
    );
    assert_eq!(
        fs::read(stage.join("partial")).unwrap(),
        b"interrupted sealed copy"
    );
    assert_eq!(fs::read_dir(&store).unwrap().count(), 3);
}

#[test]
fn live_inherited_stage_user_blocks_archival_after_publisher_lease_is_dropped() {
    use std::{io::Read, process::Stdio};
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let (_temp, source, store, trust) = fixture();
    let stage = interrupted_stage(&store, 1);
    let lease = stage_lease(&stage).unwrap();
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "printf ready; read release"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    inherit_stage_lease(&mut command, &lease).unwrap();
    let mut child = Child(command.spawn().unwrap());
    drop(command);
    drop(lease); // Simulate publisher death; only the actual child owns the lease.
    let mut ready = [0; 5];
    child
        .0
        .stdout
        .as_mut()
        .unwrap()
        .read_exact(&mut ready)
        .unwrap();
    assert_eq!(&ready, b"ready");
    assert_eq!(
        publish(&source, &store, &trust, &FixturePlatform(true)),
        Err(Error::StagingCapacity)
    );
    assert!(stage.join("partial").exists());
    assert!(!store.join(HISTORY).exists());
    drop(child.0.stdin.take());
    child.0.wait().unwrap();
    assert_eq!(
        publish(&source, &store, &trust, &FixturePlatform(true)),
        Err(Error::Signature)
    );
    assert!(!stage.exists());
    assert_eq!(
        fs::read(
            store
                .join(HISTORY)
                .join(stage.file_name().unwrap())
                .join("partial")
        )
        .unwrap(),
        b"interrupted sealed copy"
    );
}

#[test]
fn staged_capsules_are_categorically_ineligible_execution_roots() {
    let (_temp, _source, store, trust) = fixture();
    let stage = interrupted_stage(&store, 1);
    let app = stage.join(&trust.bundle_name);
    fs::create_dir(&app).unwrap();
    assert_eq!(
        crate::coordination::validate_capsule(&app, &trust, &[], None),
        Err(Error::RuntimeUnverified)
    );
}

#[test]
fn actual_ditto_preserves_stage_lease_after_copying_begins() {
    struct Copier(std::process::Child);
    impl Drop for Copier {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let (temp, source, store, trust) = fixture();
    let input = temp.path().join("copy-input");
    fs::create_dir(&input).unwrap();
    for index in 0..4000 {
        fs::write(input.join(format!("file-{index}")), [7_u8; 2048]).unwrap();
    }
    let stage = interrupted_stage(&store, 1);
    let lease = stage_lease(&stage).unwrap();
    let copied = stage.join("copied");
    let mut command = Command::new("/usr/bin/ditto");
    command
        .args(["--noqtn", "--noacl"])
        .arg(&input)
        .arg(&copied);
    inherit_stage_lease(&mut command, &lease).unwrap();
    let mut child = Copier(command.spawn().unwrap());
    drop(command);
    let pid = child.0.id() as libc::pid_t;
    let watch = crate::helper::ParentWatch::new(pid).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "ditto must still be copying"
        );
        if fs::read_dir(&copied).is_ok_and(|mut entries| entries.next().is_some()) {
            break;
        }
        assert!(Instant::now() < deadline, "ditto never began copying");
        std::thread::sleep(Duration::from_millis(1));
    }
    // SAFETY: exact unreaped Child handle pins this fixture PID against reuse.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
    let mut status = 0;
    // SAFETY: wait only for our owned child, observing stop without reaping it.
    assert_eq!(
        unsafe { libc::waitpid(pid, &mut status, libc::WUNTRACED) },
        pid
    );
    assert!(libc::WIFSTOPPED(status));
    assert!(
        !native_stage_unused(&stage, &lease, Instant::now() + Duration::from_secs(5)),
        "actual surviving ditto must veto legacy-style no-use proof too"
    );
    drop(lease);
    assert_eq!(
        publish(&source, &store, &trust, &FixturePlatform(true)),
        Err(Error::StagingCapacity)
    );
    assert!(stage.exists());
    assert!(!store.join(HISTORY).exists());
    child.0.kill().unwrap();
    watch.wait(Duration::from_secs(5)).unwrap();
    child.0.wait().unwrap();
    assert_eq!(
        publish(&source, &store, &trust, &FixturePlatform(true)),
        Err(Error::Signature)
    );
    assert!(
        store
            .join(HISTORY)
            .join(stage.file_name().unwrap())
            .join("copied")
            .is_dir()
    );
}

fn legacy_duplicate_fixture() -> (crate::owned_tests::Temp, PathBuf, PathBuf, PathBuf, Trust) {
    let (temp, source, store, trust) = fixture();
    fs::create_dir(source.join("Contents")).unwrap();
    fs::write(source.join("Contents/Info.plist"), br#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>100.1</string></dict></plist>"#).unwrap();
    fs::DirBuilder::new().mode(0o700).create(&store).unwrap();
    let stage = store.join(format!(".stage-{}", "a".repeat(32)));
    fs::DirBuilder::new().mode(0o700).create(&stage).unwrap();
    assert!(
        Command::new("/usr/bin/ditto")
            .args(["--noqtn", "--noacl"])
            .arg(&source)
            .arg(stage.join(&trust.bundle_name))
            .status()
            .unwrap()
            .success()
    );
    let published = publish(&source, &store, &trust, &FixturePlatform(false)).unwrap();
    (temp, store, stage, published, trust)
}

#[test]
fn exact_legacy_duplicate_requires_two_positive_absence_proofs() {
    use std::cell::Cell;
    let (_temp, store, stage, published, trust) = legacy_duplicate_fixture();
    let inode = fs::metadata(&published).unwrap().ino();
    let calls = Cell::new(0);
    assert!(
        !archive_legacy_duplicate(
            &stage,
            &store,
            &trust,
            &FixturePlatform(false),
            Instant::now() + Duration::from_secs(10),
            &|| Ok(()),
            &|_, _| false
        )
        .unwrap()
    );
    assert!(stage.exists());
    let rejected_calls = Cell::new(0);
    assert_eq!(
        archive_legacy_duplicate(
            &stage,
            &store,
            &trust,
            &FixturePlatform(false),
            Instant::now() + Duration::from_secs(10),
            &|| Ok(()),
            &|_, _| {
                rejected_calls.set(rejected_calls.get() + 1);
                rejected_calls.get() == 1
            }
        ),
        Err(Error::StagingCapacity)
    );
    assert_eq!(rejected_calls.get(), 2);
    assert!(
        stage.exists(),
        "changing native proof must never authorize relocation"
    );
    assert!(
        archive_legacy_duplicate(
            &stage,
            &store,
            &trust,
            &FixturePlatform(false),
            Instant::now() + Duration::from_secs(10),
            &|| Ok(()),
            &|_, _| {
                calls.set(calls.get() + 1);
                true
            }
        )
        .unwrap()
    );
    assert_eq!(calls.get(), 2);
    assert!(!stage.exists());
    assert!(
        store
            .join(HISTORY)
            .join(stage.file_name().unwrap())
            .join(&trust.bundle_name)
            .exists()
    );
    assert_eq!(fs::metadata(&published).unwrap().ino(), inode);
}

#[test]
fn legacy_changed_or_nonduplicate_evidence_never_archives() {
    let (_temp, store, stage, published, trust) = legacy_duplicate_fixture();
    let deadline = Instant::now() + Duration::from_secs(10);
    assert_eq!(
        archive_legacy_duplicate(
            &stage,
            &store,
            &trust,
            &FixturePlatform(false),
            deadline,
            &|| Ok(()),
            &|_, _| {
                fs::write(
                    stage.join(&trust.bundle_name).join("resource"),
                    b"changed after proof",
                )
                .unwrap();
                true
            }
        ),
        Err(Error::StagingCapacity)
    );
    assert!(stage.exists());
    assert!(
        !archive_legacy_duplicate(
            &stage,
            &store,
            &trust,
            &FixturePlatform(false),
            deadline,
            &|| Ok(()),
            &|_, _| panic!("nonduplicate must never reach native proof")
        )
        .unwrap()
    );
    assert_eq!(
        fs::read(published.join("resource")).unwrap(),
        b"sealed fixture evidence"
    );
}

#[test]
fn native_census_detects_owned_legacy_cwd_fd_executable_and_mapping_users() {
    use std::{ffi::CString, io::Read, os::unix::ffi::OsStrExt, process::Stdio};
    unsafe extern "C" {
        fn pnu_stage_process_unused(
            stage: *const libc::c_char,
            pid: libc::c_int,
            ignored_fd: libc::c_int,
        ) -> bool;
    }
    struct Owner(std::process::Child);
    impl Drop for Owner {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let (temp, store, stage, _published, trust) = legacy_duplicate_fixture();
    let code = temp.path().join("owned-user.c");
    fs::write(
        &code,
        br#"
#include <fcntl.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc != 3) return 1;
    int fd = -1;
    if (!strcmp(argv[1], "cwd") && chdir(argv[2])) return 2;
    if (!strcmp(argv[1], "fd") || !strcmp(argv[1], "map")) {
        fd = open(argv[2], O_RDONLY); if (fd < 0) return 3;
    }
    if (!strcmp(argv[1], "map")) {
        if (mmap(0, 4096, PROT_READ, MAP_PRIVATE, fd, 0) == MAP_FAILED) return 4;
        close(fd); fd = -1;
    }
    if (write(1, "ready", 5) != 5) return 5;
    char release; return read(0, &release, 1) < 0;
}
"#,
    )
    .unwrap();
    let executable = temp.path().join("owned-user");
    assert!(
        Command::new("/usr/bin/clang")
            .arg(&code)
            .arg("-o")
            .arg(&executable)
            .status()
            .unwrap()
            .success()
    );
    let resource = stage.join(&trust.bundle_name).join("resource");
    let stage_text = CString::new(stage.as_os_str().as_bytes()).unwrap();
    for mode in ["clear", "cwd", "fd", "map", "exec", "ditto"] {
        let binary = if mode == "exec" {
            stage.join("owned-user")
        } else if mode == "ditto" {
            temp.path().join("ditto")
        } else {
            executable.clone()
        };
        if binary != executable {
            fs::copy(&executable, &binary).unwrap();
        }
        let path = if mode == "cwd" { &stage } else { &resource };
        let mut child = Owner(
            Command::new(&binary)
                .arg(mode)
                .arg(path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut ready = [0; 5];
        child
            .0
            .stdout
            .as_mut()
            .unwrap()
            .read_exact(&mut ready)
            .unwrap();
        assert_eq!(&ready, b"ready");
        // SAFETY: owned fixture process; stage is a valid owned C string.
        let clear =
            unsafe { pnu_stage_process_unused(stage_text.as_ptr(), child.0.id() as i32, -1) };
        assert_eq!(clear, mode == "clear", "native reference proof for {mode}");
        if mode == "fd" {
            let deadline = Instant::now() + Duration::from_secs(10);
            assert!(
                !archive_legacy_duplicate(
                    &stage,
                    &store,
                    &trust,
                    &FixturePlatform(false),
                    deadline,
                    &|| Ok(()),
                    &|stage, lease| native_stage_unused(stage, lease, deadline)
                )
                .unwrap()
            );
            assert!(
                stage.exists(),
                "live legacy reader must keep its original path"
            );
        }
        drop(child.0.stdin.take());
        child.0.wait().unwrap();
    }
}

#[test]
fn native_global_absence_is_required_not_assumed() {
    let (_temp, store, stage, _published, trust) = legacy_duplicate_fixture();
    let deadline = Instant::now() + Duration::from_secs(10);
    let archived = archive_legacy_duplicate(
        &stage,
        &store,
        &trust,
        &FixturePlatform(false),
        deadline,
        &|| Ok(()),
        &|stage, lease| native_stage_unused(stage, lease, deadline),
    );
    // A restricted or changing host may not provide positive proof. Both paths
    // must preserve the exact evidence, never silently weaken the census.
    println!("native legacy global census result: {archived:?}");
    match archived {
        Ok(true) => assert!(
            store
                .join(HISTORY)
                .join(stage.file_name().unwrap())
                .join(&trust.bundle_name)
                .exists()
        ),
        Ok(false) | Err(Error::StagingCapacity) => assert!(stage.join(&trust.bundle_name).exists()),
        other => panic!("unexpected legacy census result: {other:?}"),
    }
}

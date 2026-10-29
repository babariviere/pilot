use super::*;
use std::{io::Write, os::unix::net::UnixStream, sync::mpsc, time::Duration};

fn temporary() -> std::path::PathBuf {
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "power-test-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir(&path).unwrap();
    path
}

#[derive(Default)]
struct OverrideMock {
    disabled: Option<bool>,
    writes: Vec<bool>,
    fail: bool,
    marker: std::path::PathBuf,
}
impl guardian::LidSleep for OverrideMock {
    fn restore_lid_sleep(&mut self) {
        self.writes.push(false);
    }
}
impl support::OverrideWriter for OverrideMock {
    fn read_disabled(&mut self) -> Option<bool> {
        self.disabled
    }
    fn write_disabled(&mut self, on: bool) -> bool {
        assert!(self.marker.exists(), "marker must precede every write");
        self.writes.push(on);
        !self.fail
    }
}

#[test]
fn ownership_precedes_write_and_restores() {
    let directory = temporary();
    let marker = directory.join("override");
    let mut state = support::SleepOverride::new(
        marker.clone(),
        OverrideMock {
            disabled: Some(false),
            marker,
            ..Default::default()
        },
    );
    assert!(state.set_enabled(true));
    assert!(state.set_enabled(true));
    assert!(state.set_enabled(false));
    assert!(!state.owns_override());
    assert_eq!(state.writer.writes, [true, false]);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn external_or_unknown_override_is_never_taken_over() {
    for disabled in [Some(true), None] {
        let directory = temporary();
        let marker = directory.join("override");
        let mut state = support::SleepOverride::new(
            marker.clone(),
            OverrideMock {
                disabled,
                marker,
                ..Default::default()
            },
        );
        assert!(!state.set_enabled(true));
        assert!(state.set_enabled(false));
        assert!(state.writer.writes.is_empty());
        assert!(!state.owns_override());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn uncertain_enable_and_failed_restore_remain_recoverable() {
    let directory = temporary();
    let marker = directory.join("override");
    let mut state = support::SleepOverride::new(
        marker.clone(),
        OverrideMock {
            disabled: Some(false),
            fail: true,
            marker: marker.clone(),
            ..Default::default()
        },
    );
    assert!(!state.set_enabled(true));
    assert!(state.owns_override());
    assert!(!state.set_enabled(false));
    assert!(state.owns_override());
    let mut recovery = support::SleepOverride::new(
        marker.clone(),
        OverrideMock {
            marker,
            ..Default::default()
        },
    );
    assert!(recovery.set_enabled(false));
    assert_eq!(recovery.writer.writes, [false]);
    assert!(!recovery.owns_override());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn acknowledgement_and_fallback_consume_the_token_only_once() {
    let mut ack = support::SleepAcknowledgement::default();
    let generation = ack.begin(123);
    assert_eq!(ack.take(generation), Some(123));
    assert_eq!(ack.take(generation), None);
    assert_eq!(support::PREPARATION_TIMEOUT, Duration::from_secs(5));
}

#[test]
fn late_daemon_replies_and_timers_cannot_release_the_next_sleep() {
    let mut ack = support::SleepAcknowledgement::default();
    let old = ack.begin(123);
    ack.woke();
    assert_eq!(ack.take(old), None);
    let current = ack.begin(456);
    assert_eq!(ack.take(old), None);
    assert_eq!(ack.take(current), Some(456));
}

#[test]
fn short_reply_does_not_wait_for_full_buffer_or_eof() {
    let (read, mut write) = UnixStream::pair().unwrap();
    let (tx, rx) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let mut reader = protocol::ReplyReader::new(read);
        for _ in 0..2 {
            tx.send(reader.read_reply()).unwrap();
        }
    });
    for _ in 0..2 {
        write.write_all(b"{\"ok\":true}\n").unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap());
    }
    thread.join().unwrap();
}

#[test]
fn retains_coalesced_replies_between_requests() {
    let mut reader =
        protocol::ReplyReader::new(&b"{\"ok\":true}\n{\"ok\":false}\n{\"ok\":true}\n"[..]);
    assert!(reader.read_reply());
    assert!(!reader.read_reply());
    assert!(reader.read_reply());
    assert!(!reader.read_reply());
}

#[test]
fn assembles_reply_across_bounded_reads() {
    let data = format!("{}{{\"ok\":true}}\n", " ".repeat(6000));
    assert!(protocol::ReplyReader::new(data.as_bytes()).read_reply());
}

#[test]
fn rejects_malformed_truncated_and_oversized_replies() {
    for data in [
        "not json\n".to_owned(),
        "{}\n".into(),
        "{\"ok\":false}\n".into(),
        "{\"ok\":true}".into(),
        "".into(),
        "x".repeat(8193),
    ] {
        assert!(
            !protocol::ReplyReader::new(data.as_bytes()).read_reply(),
            "{data:?}"
        );
    }
}

#[test]
fn permission_is_limited_to_two_fixed_commands() {
    assert_eq!(
        support::permission_rule(501),
        "#501 ALL=(root) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0"
    );
    let script = support::install_script(501);
    for text in [
        "/usr/sbin/visudo -c -f",
        "/usr/sbin/chown root:wheel",
        "/bin/chmod 0440",
        "/etc/sudoers.d/pilot-power",
    ] {
        assert!(script.contains(text));
    }
    assert!(!script.contains("NOPASSWD: ALL"));
}

#[derive(Default)]
struct Operations {
    awake: Vec<bool>,
    allowed: Vec<u64>,
    activities: Vec<(i64, bool, bool)>,
    authorized: Vec<i64>,
    heartbeats: usize,
    shutdowns: usize,
    sleep_attempts: usize,
    sleep_ok: bool,
}
impl runtime::Operations for Operations {
    fn set_awake(&mut self, on: bool) -> bool {
        self.awake.push(on);
        true
    }
    fn allow_sleep(&mut self, generation: u64) {
        self.allowed.push(generation);
    }
    fn activity(&mut self, id: i64, awake: bool, closed: bool) {
        self.activities.push((id, awake, closed));
    }
    fn authorize(&mut self, id: i64) {
        self.authorized.push(id);
    }
    fn heartbeat(&mut self) {
        self.heartbeats += 1;
    }
    fn sleep_closed_lid(&mut self) -> bool {
        self.sleep_attempts += 1;
        self.sleep_ok
    }
    fn shutdown(&mut self) {
        self.shutdowns += 1;
    }
}

fn model() -> runtime::Runtime<Operations, Vec<u8>> {
    let mut model = runtime::Runtime::new(Operations::default(), Vec::new());
    model.event(runtime::Event::Ready { authorized: true }, Duration::ZERO);
    model.event(
        runtime::Event::Sample(runtime::Sample {
            available: true,
            connected_to_power: true,
            wifi_connected: true,
            online: true,
            lid_closed: Some(true),
            ..Default::default()
        }),
        Duration::ZERO,
    );
    model
}

#[test]
fn protocol_activity_sleep_generation_and_permission_contract() {
    let mut state = model();
    state.command(
        serde_json::json!({"id":1,"action":"activity","awake":true,"closedLid":true}),
        Duration::ZERO,
    );
    assert_eq!(state.ops.activities, [(1, true, true)]);
    state.event(
        runtime::Event::Activity {
            id: 1,
            awake: true,
            closed: true,
            ok: true,
            permission: None,
        },
        Duration::ZERO,
    );
    assert_eq!(state.ops.awake, [true]);
    assert!(state.closed_lid_active);
    state.command(
        serde_json::json!({"id":2,"action":"allowSleep","generation":2}),
        Duration::ZERO,
    );
    assert_eq!(state.ops.allowed, [2]);
    state.command(
        serde_json::json!({"id":3,"action":"authorize"}),
        Duration::ZERO,
    );
    assert_eq!(state.ops.authorized, [3]);
    state.command(
        serde_json::json!({"action":"heartbeat"}),
        Duration::from_secs(5),
    );
    assert_eq!(state.ops.heartbeats, 1);
    let frames: Vec<serde_json::Value> = String::from_utf8(state.output)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert!(frames.contains(&serde_json::json!({"id":1,"ok":true})));
    assert!(frames.contains(&serde_json::json!({"id":2,"ok":true})));
}

#[test]
fn unsafe_lid_lease_is_not_renewed_by_daemon_heartbeats() {
    let mut state = model();
    state.event(
        runtime::Event::Activity {
            id: 1,
            awake: true,
            closed: true,
            ok: true,
            permission: None,
        },
        Duration::ZERO,
    );
    let mut unsafe_sample = state.sample.clone();
    unsafe_sample.wifi_connected = false;
    state.event(
        runtime::Event::Sample(unsafe_sample),
        Duration::from_secs(1),
    );
    for second in [5, 10, 15, 20] {
        state.command(
            serde_json::json!({"action":"heartbeat"}),
            Duration::from_secs(second),
        );
        state.tick(Duration::from_secs(second));
    }
    assert_eq!(state.ops.shutdowns, 0);
    state.tick(Duration::from_secs(21));
    assert_eq!(state.ops.shutdowns, 1);
    assert_eq!(state.ops.awake.last(), Some(&false));
    state.event(runtime::Event::Stop, Duration::from_secs(22));
    assert_eq!(state.ops.shutdowns, 1);
}

#[test]
fn unsafe_recovery_cancels_cutoff_and_heartbeat_loss_releases() {
    let mut state = model();
    state.event(
        runtime::Event::Activity {
            id: 1,
            awake: true,
            closed: true,
            ok: true,
            permission: None,
        },
        Duration::ZERO,
    );
    let safe = state.sample.clone();
    let mut unsafe_sample = safe.clone();
    unsafe_sample.connected_to_power = false;
    state.event(
        runtime::Event::Sample(unsafe_sample),
        Duration::from_secs(1),
    );
    state.event(runtime::Event::Sample(safe), Duration::from_secs(2));
    for second in [5, 10, 15, 20] {
        state.tick(Duration::from_secs(second));
    }
    assert!(!state.stopping);
    state.tick(Duration::from_secs(25));
    assert!(state.stopping);
    assert_eq!(state.ops.shutdowns, 1);
}

#[test]
fn failed_override_drops_idle_assertion_and_retains_possible_ownership() {
    let mut state = model();
    state.event(
        runtime::Event::Activity {
            id: 1,
            awake: true,
            closed: true,
            ok: false,
            permission: Some(false),
        },
        Duration::ZERO,
    );
    assert!(state.closed_lid_active);
    assert_eq!(state.ops.awake, [false]);
    assert!(!state.authorized);
    assert!(
        String::from_utf8(state.output)
            .unwrap()
            .contains("\"ok\":false")
    );
}

#[test]
fn closed_lid_sleep_has_six_bounded_revalidated_attempts() {
    let mut state = model();
    state.command(serde_json::json!({"id":9,"action":"sleep"}), Duration::ZERO);
    for step in 1..6 {
        state.tick(Duration::from_millis(step * 500));
    }
    assert_eq!(state.ops.sleep_attempts, 6);
    assert!(
        String::from_utf8(state.output)
            .unwrap()
            .contains("\"id\":9,\"ok\":false")
    );
}

#[test]
fn malformed_protocol_and_eof_shutdown_once() {
    for command in [
        serde_json::json!({}),
        serde_json::json!({"id":1}),
        serde_json::json!({"action":"activity"}),
    ] {
        let mut state = model();
        state.command(command, Duration::ZERO);
        assert!(state.stopping);
        state.event(runtime::Event::Stop, Duration::ZERO);
        assert_eq!(state.ops.shutdowns, 1);
    }
}

#[test]
fn fixed_command_parsers_do_not_treat_cached_sudo_as_a_grant() {
    let grant = "User may run: (root) NOPASSWD: /usr/bin/pmset disablesleep 1,\n    /usr/bin/pmset disablesleep 0";
    assert!(support::permission_ready(true, grant));
    assert!(!support::permission_ready(false, grant));
    for foreign in [
        "ALL",
        "(root) /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0",
        "NOPASSWD: ALL",
        "NOPASSWD: /usr/bin/pmset disablesleep 1",
    ] {
        assert!(!support::permission_ready(true, foreign));
    }
    assert_eq!(
        support::sudo_arguments(true),
        ["-n", "-k", "/usr/bin/pmset", "disablesleep", "1"]
    );
    assert_eq!(support::sudo_arguments(false)[4], "0");
    assert_eq!(support::sleep_disabled(false, "SleepDisabled 1"), None);
    assert_eq!(
        support::sleep_disabled(true, "SleepDisabled\t1"),
        Some(true)
    );
    assert_eq!(
        support::sleep_disabled(true, "SleepDisabled 0"),
        Some(false)
    );
    assert_eq!(support::sleep_disabled(true, "SleepDisabled1"), Some(false));
    assert!(
        support::authorization_script(501).contains("with administrator privileges with prompt")
    );
}

#[test]
fn ordinary_idle_assertions_do_not_prevent_lid_sleep() {
    use serde_json::json;
    for kind in [
        "PreventUserIdleSystemSleep",
        "PreventUserIdleDisplaySleep",
        "UserIsActive",
        "DisplayWake",
        "PreventSystemSleep",
    ] {
        assert!(!support::protects_lid(
            &json!({"AssertType":kind,"AssertLevel":255})
        ));
    }
    for key in ["AppliesOnLidClose", "ProcessingHotPlug"] {
        for kind in ["UserIsActive", "DisplayWake", "PreventSystemSleep"] {
            assert!(support::protects_lid(
                &json!({"AssertType":kind,key:true,"AssertLevel":255})
            ));
            assert!(!support::protects_lid(
                &json!({"AssertType":kind,key:true,"AssertLevel":0})
            ));
        }
    }
    // The Swift code treats a missing level as nonzero and a missing type as possibly protective.
    assert!(support::protects_lid(&json!({"AppliesOnLidClose":true})));
}

#[test]
fn guardian_recovery_eof_and_failed_restore_use_injected_writer_only() {
    use std::net::Shutdown;
    for fail in [false, true] {
        let directory = temporary();
        let marker = directory.join("override");
        let (client, server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let marker_thread = marker.clone();
        std::thread::spawn(move || {
            let mut state = support::SleepOverride::new(
                marker_thread.clone(),
                OverrideMock {
                    disabled: Some(false),
                    marker: marker_thread,
                    ..Default::default()
                },
            );
            // Inject a restore failure only after enable, never during real authorization.
            struct Writer {
                inner: OverrideMock,
                fail_restore: bool,
            }
            impl support::OverrideWriter for Writer {
                fn read_disabled(&mut self) -> Option<bool> {
                    self.inner.read_disabled()
                }
                fn write_disabled(&mut self, on: bool) -> bool {
                    if !on && self.fail_restore {
                        self.inner.fail = true;
                    }
                    self.inner.write_disabled(on)
                }
            }
            impl guardian::LidSleep for Writer {
                fn restore_lid_sleep(&mut self) {
                    self.inner.restore_lid_sleep();
                }
            }
            let mut wrapped = support::SleepOverride::new(
                state.writer.marker.clone(),
                Writer {
                    inner: std::mem::take(&mut state.writer),
                    fail_restore: fail,
                },
            );
            let mut output = server.try_clone().unwrap();
            guardian::run(&mut wrapped, server, &mut output);
            done_tx.send(wrapped.writer.inner.writes).unwrap();
        });
        let mut writer = client.try_clone().unwrap();
        let mut reader = protocol::ReplyReader::new(client.try_clone().unwrap());
        assert!(reader.read_reply());
        protocol::emit(&mut writer, &serde_json::json!({"heartbeat":true})).unwrap();
        protocol::emit(&mut writer, &serde_json::json!({"on":true})).unwrap();
        assert!(reader.read_reply());
        assert!(marker.exists());
        client.shutdown(Shutdown::Write).unwrap();
        let writes = done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            writes,
            if fail {
                vec![true, false]
            } else {
                vec![true, false, false]
            }
        );
        assert_eq!(marker.exists(), fail);
        if fail {
            let mut recovery = support::SleepOverride::new(
                marker.clone(),
                OverrideMock {
                    marker: marker.clone(),
                    ..Default::default()
                },
            );
            assert!(guardian::restore(&mut recovery));
            assert!(!marker.exists());
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn guardian_malformed_input_and_foreign_override_never_write() {
    for input in [
        b"bad json\n".as_slice(),
        b"{}\n",
        b"{\"on\":true}\n",
        b"{\"on\":true}",
    ] {
        let directory = temporary();
        let marker = directory.join("override");
        let mut state = support::SleepOverride::new(
            marker.clone(),
            OverrideMock {
                disabled: Some(true),
                marker,
                ..Default::default()
            },
        );
        let mut output = Vec::new();
        guardian::run(
            &mut state,
            std::io::Cursor::new(input.to_vec()),
            &mut output,
        );
        assert!(state.writer.writes.is_empty());
        assert!(!state.owns_override());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn guardian_lease_checks_every_five_seconds_and_expires_after_twenty() {
    let mut lease = guardian::GuardianLease::new(Duration::ZERO);
    for seconds in [5, 10, 15, 20] {
        assert!(!lease.expired(Duration::from_secs(seconds)));
        lease.check(Duration::from_secs(seconds));
    }
    assert!(lease.expired(Duration::from_secs(25)));
    lease.heartbeat(Duration::from_secs(24));
    assert!(!lease.expired(Duration::from_secs(25)));

    let mut production = guardian::GuardianLease::new(Duration::ZERO);
    for seconds in [0, 5, 10, 15, 20] {
        assert!(!production.tick(Duration::from_secs(seconds)));
        assert_eq!(
            production.until_check(Duration::from_secs(seconds)),
            Duration::from_secs(5)
        );
    }
    assert!(
        production.tick(Duration::from_secs(25)),
        "a timeout must check expiry before scheduling another check"
    );
}

#[test]
fn monitor_pipe_lifecycle_uses_mocked_iokit_guardian_and_authorization() {
    use serde_json::json;
    use std::net::Shutdown;
    struct Backend {
        ops: Operations,
        tx: mpsc::Sender<runtime::Event>,
    }
    impl runtime::Operations for Backend {
        fn set_awake(&mut self, on: bool) -> bool {
            self.ops.set_awake(on)
        }
        fn allow_sleep(&mut self, generation: u64) {
            self.ops.allow_sleep(generation);
        }
        fn heartbeat(&mut self) {
            self.ops.heartbeat();
        }
        fn activity(&mut self, id: i64, awake: bool, closed: bool) {
            self.ops.activity(id, awake, closed);
            self.tx
                .send(runtime::Event::Activity {
                    id,
                    awake,
                    closed,
                    ok: true,
                    permission: None,
                })
                .unwrap();
        }
        fn authorize(&mut self, id: i64) {
            self.tx
                .send(runtime::Event::Authorized { id, ok: false })
                .unwrap();
        }
        fn sleep_closed_lid(&mut self) -> bool {
            self.ops.sleep_closed_lid()
        }
        fn shutdown(&mut self) {
            self.ops.shutdown();
        }
    }
    let (client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let sender = tx.clone();
    guardian::read_frames(server.try_clone().unwrap(), 8192, move |value| {
        let _ = sender.send(value.map_or(runtime::Event::Stop, runtime::Event::Frame));
    });
    let mut state = runtime::Runtime::new(
        Backend {
            ops: Operations::default(),
            tx,
        },
        server,
    );
    state.event(runtime::Event::Ready { authorized: true }, Duration::ZERO);
    state.event(
        runtime::Event::Sample(runtime::Sample {
            available: true,
            lid_closed: Some(false),
            ..Default::default()
        }),
        Duration::ZERO,
    );
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let state = runtime::run(state, rx);
        done_tx.send(state.ops.ops).unwrap();
    });
    let mut write = client.try_clone().unwrap();
    let mut read = protocol::Frames::new(client.try_clone().unwrap(), 8192);
    for (id, command, ok) in [
        (
            1,
            json!({"id":1,"action":"activity","awake":true,"closedLid":false}),
            true,
        ),
        (2, json!({"id":2,"action":"authorize"}), false),
        (
            3,
            json!({"id":3,"action":"allowSleep","generation":4}),
            true,
        ),
        (4, json!({"id":4,"action":"sleep"}), true),
    ] {
        protocol::emit(&mut write, &command).unwrap();
        loop {
            let frame = read.next().unwrap().unwrap();
            if frame["id"] == id {
                assert_eq!(frame["ok"], ok);
                break;
            }
        }
    }
    client.shutdown(Shutdown::Write).unwrap();
    let ops = done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(ops.awake, [true, false]);
    assert_eq!(ops.shutdowns, 1);
    assert_eq!(ops.allowed, [4, 0]);
    assert_eq!(ops.sleep_attempts, 0, "open lid sleep is a no-op");
}

#[test]
fn state_reports_coalesce_without_native_work() {
    let mut state = model();
    let bytes = state.output.len();
    for _ in 0..10000 {
        state.event(runtime::Event::Sample(state.sample.clone()), Duration::ZERO);
    }
    assert_eq!(state.output.len(), bytes);
    assert!(state.ops.activities.is_empty());
}

#[test]
fn ownership_lock_is_exclusive_close_releases_and_symlinks_are_refused() {
    use std::os::unix::{
        fs::{PermissionsExt, symlink},
        io::AsRawFd,
    };
    let directory = temporary();
    let lock = support::lock_directory(&directory).unwrap();
    assert!(support::lock_directory(&directory).is_none());
    assert_eq!(
        std::fs::metadata(directory.join("owner.lock"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    // SAFETY: query descriptor flags only, on the live test-owned lock.
    assert_ne!(
        unsafe { libc::fcntl(lock.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
    drop(lock);
    assert!(support::lock_directory(&directory).is_some());
    std::fs::remove_file(directory.join("owner.lock")).unwrap();
    symlink("foreign", directory.join("owner.lock")).unwrap();
    assert!(support::lock_directory(&directory).is_none());
    assert!(!directory.join("foreign").exists());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
#[cfg(target_os = "macos")]
fn legacy_swift_support_has_byte_identical_grant_and_generation_behavior() {
    let directory = temporary();
    let main = directory.join("main.swift");
    std::fs::write(
        &main,
        r#"import Foundation
var ack = SleepAcknowledgement()
let old = ack.begin(argument: 123)
ack.woke()
let current = ack.begin(argument: 456)
precondition(ack.take(generation: old) == nil)
precondition(ack.take(generation: current) == 456)
precondition(ack.take(generation: current) == nil)
print(PowerPermission.installScript(uid: 501), terminator: "")
"#,
    )
    .unwrap();
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../macos/Sources/PilotPowerSupport");
    // Only pure legacy support is compiled. No native helper main or power operations are linked/executed.
    let result = std::process::Command::new("/usr/bin/xcrun")
        .arg("swiftc")
        .arg(root.join("SleepOverride.swift"))
        .arg(root.join("SleepAcknowledgement.swift"))
        .arg(main)
        .arg("-o")
        .arg(directory.join("support"))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let result = std::process::Command::new(directory.join("support"))
        .output()
        .unwrap();
    assert!(result.status.success());
    assert_eq!(
        String::from_utf8(result.stdout).unwrap(),
        support::install_script(501)
    );
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
#[cfg(target_os = "macos")]
fn native_cf_boolean_bridge_preserves_swift_numeric_bool_rules() {
    use core_foundation::{base::TCFType, boolean::CFBoolean, number::CFNumber};
    assert_eq!(
        macos::cf_bool(&CFBoolean::true_value().as_CFType()),
        Some(true)
    );
    for (number, expected) in [(0, Some(false)), (1, Some(true)), (2, None), (255, None)] {
        assert_eq!(
            macos::cf_bool(&CFNumber::from(number).as_CFType()),
            expected
        );
    }
    assert!(support::protects_lid(
        &serde_json::json!({"ProcessingHotPlug":1,"AssertLevel":255})
    ));
    assert!(!support::protects_lid(
        &serde_json::json!({"ProcessingHotPlug":true,"AssertLevel":false})
    ));
}

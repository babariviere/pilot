use super::*;
use serde_json::json;
use std::{
    os::unix::net::UnixStream as StdUnixStream,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

#[test]
fn only_active_local_kde_wayland_is_supported() {
    assert!(supported_session("wayland", "KDE", true, false));
    for (kind, desktop, active, remote) in [
        ("x11", "KDE", true, false),
        ("wayland", "GNOME", true, false),
        ("wayland", "KDE", false, false),
        ("wayland", "KDE", true, true),
    ] {
        assert!(!supported_session(kind, desktop, active, remote));
    }
}

#[derive(Default)]
struct State {
    calls: Vec<String>,
    cookies: u32,
    active: bool,
    deny: bool,
    deny_delay: bool,
    delay_peers: Vec<StdUnixStream>,
}
#[derive(Clone, Default)]
struct Fake(Arc<Mutex<State>>, Arc<Notify>);
#[zbus::interface(name = "org.kde.Solid.PowerManagement.PolicyAgent")]
impl Fake {
    fn add_inhibition(&self, types: u32, who: &str, why: &str) -> zbus::fdo::Result<u32> {
        assert_eq!((types, who, why), (AUTOMATIC_SUSPEND, WHO, WHY));
        let mut s = self.0.lock().unwrap();
        if s.deny {
            return Err(zbus::fdo::Error::AccessDenied("fixture denial".into()));
        }
        s.calls.push(format!("add:{types}"));
        s.cookies += 1;
        self.1.notify_waiters();
        Ok(s.cookies)
    }
    fn release_inhibition(&self, cookie: u32) {
        self.0
            .lock()
            .unwrap()
            .calls
            .push(format!("release:{cookie}"));
        self.1.notify_waiters();
    }
    #[zbus(property)]
    fn active_inhibitions(&self) -> Vec<Inhibition> {
        if self.0.lock().unwrap().active {
            vec![("sleep".into(), WHO.into(), WHY.into(), "block".into(), 3)]
        } else {
            vec![]
        }
    }
}
struct Login(Fake);
#[zbus::interface(name = "org.freedesktop.login1.Manager")]
impl Login {
    fn inhibit(
        &self,
        what: &str,
        who: &str,
        why: &str,
        mode: &str,
    ) -> zbus::fdo::Result<zvariant::OwnedFd> {
        assert_eq!(
            (what, who, why, mode),
            ("sleep", WHO, "Save agent work before sleep", "delay")
        );
        if self.0.0.lock().unwrap().deny_delay {
            return Err(zbus::fdo::Error::AccessDenied("delay denied".into()));
        }
        let (send, receive) = StdUnixStream::pair().unwrap();
        receive.set_nonblocking(true).unwrap();
        self.0.0.lock().unwrap().delay_peers.push(receive);
        self.0.1.notify_waiters();
        Ok(zvariant::OwnedFd::from(OwnedFd::from(send)))
    }
    #[zbus(property)]
    fn preparing_for_sleep(&self) -> bool {
        false
    }
}
struct Network;
#[zbus::interface(name = "org.freedesktop.NetworkManager")]
impl Network {
    #[zbus(property)]
    fn state(&self) -> u32 {
        70
    }
}
struct Fixture {
    client: Connection,
    server: Connection,
    fake: Fake,
}
impl Fixture {
    async fn new() -> Self {
        let fake = Fake::default();
        let (a, b) = tokio::net::UnixStream::pair().unwrap();
        let guid = zbus::Guid::generate();
        let server = zbus::connection::Builder::unix_stream(a)
            .server(guid)
            .unwrap()
            .p2p()
            .serve_at(POLICY_PATH, fake.clone())
            .unwrap()
            .serve_at(LOGIN_PATH, Login(fake.clone()))
            .unwrap()
            .serve_at("/org/freedesktop/NetworkManager", Network)
            .unwrap();
        let (server, client) = tokio::join!(
            server.build(),
            zbus::connection::Builder::unix_stream(b).p2p().build()
        );
        Self {
            client: client.unwrap(),
            server: server.unwrap(),
            fake,
        }
    }
    fn calls(&self) -> Vec<String> {
        self.fake.0.lock().unwrap().calls.clone()
    }
    async fn wait_for_calls(&self, count: usize) {
        loop {
            let notified = self.fake.1.notified();
            if self.calls().len() >= count {
                return;
            }
            notified.await;
        }
    }
    async fn suspend(&self, start: bool) {
        self.server
            .emit_signal(
                None::<&str>,
                LOGIN_PATH,
                LOGIN_INTERFACE,
                "PrepareForSleep",
                &(start,),
            )
            .await
            .unwrap();
    }
    fn delay_open(&self, index: usize) -> bool {
        use std::io::Read;
        let mut peers = self.fake.0.lock().unwrap();
        match peers.delay_peers[index].read(&mut [0]) {
            Ok(0) => false,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => true,
            result => panic!("unexpected delay pipe state: {result:?}"),
        }
    }
    async fn set_active(&self, on: bool) {
        self.fake.0.lock().unwrap().active = on;
        let interface = self
            .server
            .object_server()
            .interface::<_, Fake>(POLICY_PATH)
            .await
            .unwrap();
        interface
            .get()
            .await
            .active_inhibitions_changed(interface.signal_emitter())
            .await
            .unwrap();
    }
}

#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>, Arc<Notify>);
impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.1.notify_waiters();
        Ok(())
    }
}
impl Output {
    async fn wait(&self, matches: impl Fn(&Value) -> bool) -> Value {
        loop {
            let notified = self.1.notified();
            let bytes = self.0.lock().unwrap().clone();
            for line in bytes.split(|byte| *byte == b'\n') {
                if let Ok(value) = serde_json::from_slice::<Value>(line)
                    && matches(&value)
                {
                    return value;
                }
            }
            notified.await;
        }
    }
}
fn start(
    fixture: &Fixture,
) -> (
    mpsc::Sender<Option<Value>>,
    Output,
    tokio::task::JoinHandle<Result<Output>>,
) {
    let (send, receive) = mpsc::channel(16);
    let output = Output::default();
    let helper = tokio::spawn(serve(
        fixture.client.clone(),
        fixture.client.clone(),
        receive,
        output.clone(),
    ));
    (send, output, helper)
}
fn command(send: &mpsc::Sender<Option<Value>>, value: Value) {
    send.try_send(Some(value)).unwrap();
}

#[test]
fn isolated_pipe_child_entry() {
    let Some(path) = std::env::var_os("PILOT_TEST_POWER_PEER") else {
        return;
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let stream = tokio::net::UnixStream::connect(path).await.unwrap();
            let connection = zbus::connection::Builder::unix_stream(stream)
                .p2p()
                .build()
                .await
                .unwrap();
            let (send, receive) = mpsc::channel(16);
            std::thread::spawn(move || {
                let mut frames = protocol::Frames::new(std::io::stdin(), 8192);
                while let Ok(Some(frame)) = frames.next() {
                    if send.blocking_send(Some(frame)).is_err() {
                        return;
                    }
                }
                let _ = send.blocking_send(None);
            });
            serve(connection.clone(), connection, receive, std::io::stdout())
                .await
                .unwrap();
        });
}

#[tokio::test]
async fn real_pipe_eof_and_helper_process_death_close_native_resource_ownership() {
    use std::{
        os::unix::fs::DirBuilderExt,
        process::{Command, Stdio},
    };
    for kill in [false, true] {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let directory = std::env::temp_dir().join(format!("pp-{nonce}"));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let path = directory.join("bus");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "linux::tests::isolated_pipe_child_entry",
                "--nocapture",
            ])
            .env_clear()
            .env("PILOT_TEST_POWER_PEER", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let fake = Fake::default();
        let server = zbus::connection::Builder::unix_stream(stream)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .serve_at(POLICY_PATH, fake.clone())
            .unwrap()
            .serve_at(LOGIN_PATH, Login(fake.clone()))
            .unwrap()
            .serve_at("/org/freedesktop/NetworkManager", Network)
            .unwrap()
            .build()
            .await
            .unwrap();
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"{\"id\":1,\"action\":\"activity\",\"awake\":true,\"closedLid\":false}\n")
            .unwrap();
        loop {
            let notified = fake.1.notified();
            if !fake.0.lock().unwrap().calls.is_empty() {
                break;
            }
            notified.await;
        }
        if kill {
            child.kill().unwrap();
        } else {
            drop(child.stdin.take());
        }
        let status = tokio::task::spawn_blocking(move || child.wait().unwrap())
            .await
            .unwrap();
        assert_eq!(status.success(), !kill);
        server.closed().await;
        use std::io::Read;
        assert_eq!(
            fake.0.lock().unwrap().delay_peers[0]
                .read(&mut [0])
                .unwrap(),
            0
        );
        let calls = fake.0.lock().unwrap().calls.clone();
        if kill {
            assert_eq!(calls, vec!["add:1"]);
        } else {
            assert_eq!(calls, vec!["add:1", "release:1"]);
        }
        // KDE's service-owned cookie is revoked on this same connection-loss event.
        drop(server);
        drop(listener);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tokio::test]
async fn kde_pending_active_and_user_blocked_states_are_not_confused() {
    let f = Fixture::new().await;
    let (send, output, helper) = start(&f);
    let initial = output.wait(|v| v["type"] == "state").await;
    assert_eq!(initial["qualification"], "unqualified");
    assert_eq!(initial["inhibitionActive"], false);
    command(
        &send,
        json!({"id":1,"action":"activity","awake":true,"closedLid":false}),
    );
    output.wait(|v| v["id"] == 1).await;
    f.set_active(true).await;
    output.wait(|v| v["inhibitionActive"] == true).await;
    f.set_active(false).await;
    // A second exact request is coalesced, not another cookie or an override of KDE preferences.
    command(
        &send,
        json!({"id":2,"action":"activity","awake":true,"closedLid":false}),
    );
    output.wait(|v| v["id"] == 2).await;
    assert_eq!(f.calls(), vec!["add:1"]);
    command(
        &send,
        json!({"id":3,"action":"activity","awake":true,"closedLid":true}),
    );
    assert_eq!(output.wait(|v| v["id"] == 3).await["ok"], false);
    command(&send, json!({"id":4,"action":"authorize"}));
    assert_eq!(output.wait(|v| v["id"] == 4).await["ok"], false);
    command(&send, json!({"id":5,"action":"sleep"}));
    assert_eq!(output.wait(|v| v["id"] == 5).await["ok"], true);
    drop(send);
    helper.await.unwrap().unwrap();
    assert!(!f.delay_open(0));
    assert_eq!(f.calls(), vec!["add:1", "release:1"]);
}

#[tokio::test]
async fn suspend_ack_is_generation_bound_and_resume_never_replays_an_action() {
    let f = Fixture::new().await;
    let (send, output, helper) = start(&f);
    output.wait(|v| v["type"] == "state").await;
    assert!(f.delay_open(0));
    f.suspend(true).await;
    output
        .wait(|v| v["sleeping"] == true && v["sleepGeneration"] == 1)
        .await;
    command(&send, json!({"id":1,"action":"allowSleep","generation":0}));
    output.wait(|v| v["id"] == 1).await;
    assert!(f.delay_open(0));
    command(&send, json!({"id":2,"action":"allowSleep","generation":1}));
    output.wait(|v| v["id"] == 2).await;
    assert!(!f.delay_open(0));
    f.suspend(false).await;
    let wake = output.wait(|v| v["fullWake"] == true).await;
    assert_ne!(wake["wakeToken"], "0:0");
    assert!(f.delay_open(1));
    assert!(
        f.calls().is_empty(),
        "resume must not replay AddInhibition or any sleep request"
    );
    f.suspend(true).await;
    output.wait(|v| v["sleepGeneration"] == 2).await;
    command(&send, json!({"id":3,"action":"allowSleep","generation":1}));
    output.wait(|v| v["id"] == 3).await;
    assert!(f.delay_open(1));
    drop(send);
    helper.await.unwrap().unwrap();
    assert!(!f.delay_open(1));
}

#[tokio::test]
async fn bounded_sleep_fallback_and_lost_heartbeat_release_without_daemon_ack() {
    let f = Fixture::new().await;
    let (send, output, helper) = start(&f);
    output.wait(|v| v["type"] == "state").await;
    f.suspend(true).await;
    output.wait(|v| v["sleeping"] == true).await;
    tokio::time::pause();
    tokio::time::advance(PREPARE_LIMIT).await;
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert!(!f.delay_open(0));
    command(&send, json!({"action":"heartbeat"}));
    tokio::task::yield_now().await;
    tokio::time::advance(LEASE).await;
    helper.await.unwrap().unwrap();
}

#[tokio::test]
async fn denied_service_operations_and_disconnect_close_owned_resources() {
    for deny_delay in [false, true] {
        let f = Fixture::new().await;
        f.fake.0.lock().unwrap().deny_delay = deny_delay;
        f.fake.0.lock().unwrap().deny = true;
        let (send, _output, helper) = start(&f);
        command(
            &send,
            json!({"id":1,"action":"activity","awake":true,"closedLid":false}),
        );
        assert!(helper.await.unwrap().is_err());
        assert!(f.calls().is_empty());
        if !deny_delay {
            assert!(!f.delay_open(0));
        }
    }
    let f = Fixture::new().await;
    let (_send, output, helper) = start(&f);
    output.wait(|v| v["type"] == "state").await;
    f.server.clone().close().await.unwrap();
    assert!(helper.await.unwrap().is_err());
}

#[tokio::test]
async fn missing_policy_service_and_unavailable_bus_are_errors_not_capability_claims() {
    let f = Fixture::new().await;
    f.server
        .object_server()
        .remove::<Fake, _>(POLICY_PATH)
        .await
        .unwrap();
    let (_send, _output, helper) = start(&f);
    assert!(helper.await.unwrap().is_err());
    assert!(f.calls().is_empty());
    let f = Fixture::new().await;
    f.client.clone().close().await.unwrap();
    let (_send, _output, helper) = start(&f);
    assert!(helper.await.unwrap().is_err());
}

#[tokio::test]
async fn heartbeat_expiry_and_eof_release_connection_owned_inhibitors() {
    let fixture = Fixture::new().await;
    let (send, receive) = tokio::sync::mpsc::channel(16);
    let helper = tokio::spawn(serve(
        fixture.client.clone(),
        fixture.client.clone(),
        receive,
        Vec::new(),
    ));
    send.try_send(Some(
        json!({"id":1,"action":"activity","awake":true,"closedLid":false}),
    ))
    .unwrap();
    fixture.wait_for_calls(1).await;
    send.try_send(None).unwrap();
    let output = helper.await.unwrap().unwrap();
    assert!(String::from_utf8(output).unwrap().contains("\"ok\":true"));
    assert_eq!(fixture.calls(), vec!["add:1", "release:1"]);
}

// Linux CI exercises bus routing/NameOwnerChanged as well as the portable peer fixtures.
// This daemon is private; no connection is made to the real session or system bus.
#[cfg(target_os = "linux")]
mod bus {
    use super::*;
    use std::{
        io::BufRead,
        process::{Child, Command, Stdio},
    };

    struct Bus {
        child: Child,
        address: String,
    }
    impl Bus {
        fn new() -> Self {
            let mut child = Command::new("/usr/bin/dbus-daemon")
                .args(["--session", "--nofork", "--nopidfile", "--print-address=1"])
                .env_clear()
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("Linux fake-bus tests require dbus-daemon");
            let mut address = String::new();
            std::io::BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap();
            assert!(address.starts_with("unix:"));
            Self {
                child,
                address: address.trim().into(),
            }
        }
        async fn fixture(&self) -> Fixture {
            let fake = Fake::default();
            let server = zbus::connection::Builder::address(self.address.as_str())
                .unwrap()
                .name(POLICY_SERVICE)
                .unwrap()
                .name(LOGIN_SERVICE)
                .unwrap()
                .name("org.freedesktop.NetworkManager")
                .unwrap()
                .serve_at(POLICY_PATH, fake.clone())
                .unwrap()
                .serve_at(LOGIN_PATH, Login(fake.clone()))
                .unwrap()
                .serve_at("/org/freedesktop/NetworkManager", Network)
                .unwrap()
                .build()
                .await
                .unwrap();
            let client = zbus::connection::Builder::address(self.address.as_str())
                .unwrap()
                .method_timeout(Duration::from_secs(2))
                .build()
                .await
                .unwrap();
            Fixture {
                client,
                server,
                fake,
            }
        }
    }
    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[tokio::test]
    async fn service_owner_loss_and_reconnect_never_replay_old_commands() {
        let bus = Bus::new();
        let f = bus.fixture().await;
        let (send, output, helper) = start(&f);
        output.wait(|v| v["type"] == "state").await;
        command(
            &send,
            json!({"id":1,"action":"activity","awake":true,"closedLid":false}),
        );
        output.wait(|v| v["id"] == 1).await;
        f.server.clone().close().await.unwrap();
        assert!(helper.await.unwrap().is_err());
        assert!(!f.delay_open(0));
        let next = bus.fixture().await;
        let (send, output, helper) = start(&next);
        let sample = output.wait(|v| v["type"] == "state").await;
        assert_eq!(sample["fullWake"], false);
        assert_eq!(sample["inhibitionActive"], false);
        assert!(next.calls().is_empty());
        drop(send);
        helper.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn private_bus_death_releases_sleep_delay() {
        let mut bus = Bus::new();
        let f = bus.fixture().await;
        let (_send, output, helper) = start(&f);
        output.wait(|v| v["type"] == "state").await;
        bus.child.kill().unwrap();
        bus.child.wait().unwrap();
        assert!(helper.await.unwrap().is_err());
        assert!(!f.delay_open(0));
    }
}

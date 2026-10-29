//! KDE automatic-suspend inhibition only. Never use logind sleep:block or idle.
use crate::protocol;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{io::Write, os::fd::OwnedFd, time::Duration};
use tokio::sync::mpsc;
use zbus::{Connection, Proxy, wire as zvariant};

const POLICY_SERVICE: &str = "org.kde.Solid.PowerManagement";
const POLICY_PATH: &str = "/org/kde/Solid/PowerManagement/PolicyAgent";
const POLICY_INTERFACE: &str = "org.kde.Solid.PowerManagement.PolicyAgent";
const LOGIN_SERVICE: &str = "org.freedesktop.login1";
const LOGIN_PATH: &str = "/org/freedesktop/login1";
const LOGIN_INTERFACE: &str = "org.freedesktop.login1.Manager";
const WHO: &str = "Pilot";
const WHY: &str = "Agent and tool work";
// PolicyAgent::InterruptSession, NOT ChangeScreenSettings (4). Explicit actions bypass it.
const AUTOMATIC_SUSPEND: u32 = 1;
const LEASE: Duration = Duration::from_secs(20);
// logind also enforces InhibitDelayMaxUSec. Never prevent manual/lid sleep indefinitely.
const PREPARE_LIMIT: Duration = Duration::from_secs(4);

type Inhibition = (String, String, String, String, u32);
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

async fn delay(login: &Proxy<'_>) -> Result<OwnedFd> {
    let fd: zvariant::OwnedFd = login
        .call(
            "Inhibit",
            &("sleep", WHO, "Save agent work before sleep", "delay"),
        )
        .await?;
    Ok(fd.into())
}

fn active(entries: &[Inhibition]) -> bool {
    entries.iter().any(|(what, who, why, mode, flags)| {
        what == "sleep" && who == WHO && why == WHY && mode == "block" && flags & 1 != 0
    })
}

fn supported_session(kind: &str, desktop: &str, active: bool, remote: bool) -> bool {
    kind == "wayland"
        && active
        && !remote
        && desktop
            .split(':')
            .any(|name| name.eq_ignore_ascii_case("KDE"))
}

/// Both connections belong to this helper, not the GUI. Closing them revokes cookies and FDs.
async fn serve<W: Write>(
    system: Connection,
    session: Connection,
    mut input: mpsc::Receiver<Option<Value>>,
    mut output: W,
) -> Result<W> {
    let result = serve_connected(&system, &session, &mut input, &mut output).await;
    // Also covers failed/ambiguous AddInhibition replies, without retrying a mutation.
    let _ = session.close().await;
    let _ = system.close().await;
    result?;
    Ok(output)
}

async fn serve_connected<W: Write>(
    system: &Connection,
    session: &Connection,
    input: &mut mpsc::Receiver<Option<Value>>,
    output: &mut W,
) -> Result<()> {
    let policy = Proxy::new(session, POLICY_SERVICE, POLICY_PATH, POLICY_INTERFACE).await?;
    let login = Proxy::new(system, LOGIN_SERVICE, LOGIN_PATH, LOGIN_INTERFACE).await?;
    let network = Proxy::new(
        system,
        "org.freedesktop.NetworkManager",
        "/org/freedesktop/NetworkManager",
        "org.freedesktop.NetworkManager",
    )
    .await?;
    let mut owners = policy.receive_owner_changed().await?;
    let mut login_owners = login.receive_owner_changed().await?;
    let mut suspends = login.receive_signal("PrepareForSleep").await?;
    let mut changes = policy
        .receive_property_changed::<Vec<Inhibition>>("ActiveInhibitions")
        .await;
    let mut networks = network.receive_property_changed::<u32>("State").await;
    let mut network_owners = network.receive_owner_changed().await?;
    let mut network_open = true;
    // This property is required: a returned cookie alone may be pending or user-blocked.
    let _: Vec<Inhibition> = policy.get_property("ActiveInhibitions").await?;
    let mut delay_fd = Some(delay(&login).await?);
    let mut sleeping: bool = login.get_property("PreparingForSleep").await?;
    let mut network_state = network.get_property::<u32>("State").await.ok();
    let mut generation = u64::from(sleeping);
    let mut full_wake = false;
    // Startup never invents a later wake, even after a helper/daemon restart.
    let mut wake_token = "0:0".to_owned();
    let mut cookie = None;
    let mut inhibition_active = false;
    let lease = tokio::time::sleep(LEASE);
    let preparation = tokio::time::sleep(PREPARE_LIMIT);
    tokio::pin!(lease, preparation);
    let mut last = Value::Null;
    loop {
        let sample = json!({"type":"state", "backend":"kde", "available":true, "authorized":false,
            "connectedToPower":false, "wifiConnected":false, "online": network_state == Some(70),
            "networkKnown":network_state.is_some(), "lidClosed":null, "sleeping":sleeping,
            "fullWake":full_wake, "wakeToken":wake_token, "sleepGeneration":generation,
            "closedLidActive":false, "inhibitionActive":cookie.is_some() && inhibition_active,
            "qualification":"unqualified"});
        if sample != last {
            protocol::emit(output, &sample)?;
            last = sample;
        }
        tokio::select! {
            _ = &mut lease => break,
            _ = &mut preparation, if sleeping && delay_fd.is_some() => { delay_fd.take(); }
            _ = session.closed() => return Err("KDE bus disconnected".into()),
            _ = system.closed() => return Err("system bus disconnected".into()),
            _ = owners.next(), if session.is_bus() => return Err("KDE service changed".into()),
            _ = login_owners.next(), if system.is_bus() => return Err("logind service changed".into()),
            message = suspends.next() => {
                let message = message.ok_or("logind signal stream ended")?;
                let (start,): (bool,) = message.body().deserialize()?;
                if start && !sleeping {
                    sleeping = true;
                    full_wake = false;
                    generation += 1;
                    preparation.as_mut().reset(tokio::time::Instant::now() + PREPARE_LIMIT);
                } else if !start && sleeping {
                    delay_fd.take();
                    delay_fd = Some(delay(&login).await?);
                    sleeping = false;
                    full_wake = true;
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
                    wake_token = format!("{}:{}", now.as_secs(), now.subsec_micros());
                }
            }
            change = changes.next() => {
                let change = change.ok_or("KDE property stream ended")?;
                inhibition_active = active(&change.get().await?);
            }
            _ = network_owners.next(), if system.is_bus() => {
                network_state = network.get_property::<u32>("State").await.ok();
            }
            change = networks.next(), if network_open => {
                network_state = match change { Some(change) => change.get().await.ok(), None => { network_open = false; None } };
            }
            frame = input.recv() => {
                let Some(Some(frame)) = frame else { break };
                if frame["action"] == "heartbeat" {
                    lease.as_mut().reset(tokio::time::Instant::now() + LEASE);
                    continue;
                }
                let Some(id) = frame["id"].as_i64() else { break };
                let ok = match frame["action"].as_str() {
                    Some("activity") => match (frame["awake"].as_bool(), frame["closedLid"].as_bool()) {
                        (Some(awake), Some(false)) => {
                            if awake && !sleeping && cookie.is_none() {
                                cookie = Some(policy.call::<_, _, u32>("AddInhibition", &(AUTOMATIC_SUSPEND, WHO, WHY)).await?);
                            } else if !awake && let Some(value) = cookie.take() {
                                policy.call::<_, _, ()>("ReleaseInhibition", &(value,)).await?;
                                inhibition_active = false;
                            }
                            if cookie.is_some() {
                                inhibition_active = active(&policy.get_property::<Vec<Inhibition>>("ActiveInhibitions").await?);
                            }
                            true
                        }
                        _ => false,
                    },
                    Some("allowSleep") => {
                        if sleeping && frame["generation"].as_u64() == Some(generation) { delay_fd.take(); }
                        frame["generation"].as_u64().is_some()
                    }
                    // No authorization, closed-lid override, or sleep-triggering API on Linux.
                    Some("authorize") => false,
                    Some("sleep") => true,
                    _ => false,
                };
                protocol::emit(output, &json!({"id":id,"ok":ok}))?;
            }
        }
    }
    if let Some(cookie) = cookie {
        policy
            .call::<_, _, ()>("ReleaseInhibition", &(cookie,))
            .await?;
    }
    drop(delay_fd);
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn run() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("power runtime");
    if runtime.block_on(native()).is_err() {
        eprintln!(
            "Linux energy helper unavailable: requires an active KDE Wayland session, current PowerDevil and logind delay permission"
        );
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
async fn native() -> Result<()> {
    let system = zbus::connection::Builder::system()
        .method_timeout(Duration::from_secs(2))
        .build()
        .await?;
    let session = zbus::connection::Builder::session()
        .method_timeout(Duration::from_secs(2))
        .build()
        .await?;
    // A systemd --user daemon is not a login-session process. Resolve the user's display
    // session through logind instead of trusting stale/inapplicable GUI environment variables.
    let login = Proxy::new(&system, LOGIN_SERVICE, LOGIN_PATH, LOGIN_INTERFACE).await?;
    // SAFETY: geteuid has no arguments or memory requirements.
    let uid = unsafe { libc::geteuid() };
    let user: zvariant::OwnedObjectPath = login.call("GetUser", &(uid,)).await?;
    let user = Proxy::new(&system, LOGIN_SERVICE, user, "org.freedesktop.login1.User").await?;
    let (_, path): (String, zvariant::OwnedObjectPath) = user.get_property("Display").await?;
    let display = Proxy::new(
        &system,
        LOGIN_SERVICE,
        path.clone(),
        "org.freedesktop.login1.Session",
    )
    .await?;
    let desktop: String = display.get_property("Desktop").await?;
    if !supported_session(
        &display.get_property::<String>("Type").await?,
        &desktop,
        display.get_property::<bool>("Active").await?,
        display.get_property::<bool>("Remote").await?,
    ) {
        return Err("unsupported login session".into());
    }
    let (send, receive) = mpsc::channel(16);
    std::thread::spawn(move || {
        let mut frames = protocol::Frames::new(std::io::stdin(), 8192).line_limit(4096);
        while let Ok(Some(frame)) = frames.next() {
            if send.blocking_send(Some(frame)).is_err() {
                return;
            }
        }
        let _ = send.blocking_send(None);
    });
    let mut active_changes = display.receive_property_changed::<bool>("Active").await;
    let mut display_changes = user
        .receive_property_changed::<(String, zvariant::OwnedObjectPath)>("Display")
        .await;
    tokio::select! {
        result = serve(system.clone(), session, receive, std::io::stdout()) => { result?; Ok(()) },
        _ = async { while let Some(change) = active_changes.next().await { if !change.get().await.unwrap_or(false) { break; } } } => Err("login session no longer active".into()),
        _ = async { while let Some(change) = display_changes.next().await { if change.get().await.map(|(_, next)| next != path).unwrap_or(true) { break; } } } => Err("display session changed".into()),
    }
}

#[cfg(test)]
mod tests;

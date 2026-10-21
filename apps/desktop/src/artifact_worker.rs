//! One selected artifact, bounded queue, no UI-thread I/O/VM. Closing settles then reaps.
use crate::{
    LocalOptions,
    artifact_model::{Reference, Revision},
    visual_runtime::Fault,
    visual_scene::Scene,
    visual_session::{Program, Session},
};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
#[derive(Clone, Default)]
pub(crate) struct Snapshot {
    pub(crate) revision: Option<Arc<Revision>>,
    pub(crate) scene: Option<Arc<Scene>>,
    pub(crate) state: Option<String>,
    pub(crate) version: u64,
    pub(crate) error: Option<Fault>,
    pub(crate) live: bool,
}
pub(crate) enum Command {
    Event {
        version: u64,
        id: String,
        value: Value,
    },
    Retry,
}
pub(crate) struct Worker {
    commands: async_channel::Sender<Command>,
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0., |d| d.as_secs_f64() * 1000.)
}
impl Worker {
    #[cfg(test)]
    pub(crate) fn synthetic() -> (Self, async_channel::Receiver<Command>) {
        let (commands, events) = async_channel::bounded(2);
        (Self { commands }, events)
    }
    pub(crate) fn start(
        options: LocalOptions,
        reference: Reference,
        state: Option<String>,
    ) -> Result<(Self, async_channel::Receiver<Snapshot>), &'static str> {
        let (commands, events) = async_channel::bounded(2);
        let (updates, output) = async_channel::bounded(1);
        let replace = output.clone();
        std::thread::Builder::new()
            .name("artifact-reader".into())
            .spawn(move || {
                if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    runtime.block_on(run(options, reference, state, events, updates, replace));
                }
            })
            .map_err(|_| "Cannot start the isolated artifact reader")?;
        Ok((Self { commands }, output))
    }
    pub(crate) fn command(&self, command: Command) -> bool {
        self.commands.try_send(command).is_ok()
    }
}

fn publish(
    updates: &async_channel::Sender<Snapshot>,
    replace: &async_channel::Receiver<Snapshot>,
    snapshot: Snapshot,
) {
    if let Err(async_channel::TrySendError::Full(value)) = updates.try_send(snapshot) {
        let _ = replace.try_recv();
        let _ = updates.try_send(value);
    }
}
async fn run(
    options: LocalOptions,
    reference: Reference,
    state: Option<String>,
    events: async_channel::Receiver<Command>,
    updates: async_channel::Sender<Snapshot>,
    replace: async_channel::Receiver<Snapshot>,
) {
    let read = tokio::select! {biased;_=events.recv()=>return,value=crate::local_client::artifact(&options,&reference)=>value};
    let mut snapshot = Snapshot::default();
    let revision = match read {
        Ok(v) => Arc::new(v),
        Err(message) => {
            snapshot.error = Some(Fault {
                kind: "read",
                message: message.into(),
                line: None,
                limit: None,
            });
            publish(&updates, &replace, snapshot);
            return;
        }
    };
    snapshot.revision = Some(revision.clone());
    if !revision.visual_supported {
        publish(&updates, &replace, snapshot);
        return;
    }
    let mut session = match Session::new(
        Program {
            source: (*revision.source).clone(),
            data: revision.data.clone(),
            seed: revision.reference.id.clone(),
            now: now(),
        },
        state,
    ) {
        Ok(s) => s,
        Err(error) => {
            snapshot.error = Some(error);
            publish(&updates, &replace, snapshot);
            return;
        }
    };
    if events.is_closed() || updates.is_closed() {
        return;
    }
    let mut result = match retry(&mut session, &events).await {
        Some(result) => result,
        None => {
            session.stop().await;
            return;
        }
    };
    loop {
        snapshot.scene = session.scene.clone();
        snapshot.state = session.state.clone();
        snapshot.version = session.version;
        snapshot.live = result.is_ok();
        snapshot.error = result.err();
        if events.is_closed() || updates.is_closed() {
            break;
        }
        publish(&updates, &replace, snapshot.clone());
        let Ok(command) = events.recv().await else {
            break;
        };
        session.clock(now());
        let next = match command {
            Command::Retry => retry(&mut session, &events).await,
            Command::Event { version, id, value } => {
                tokio::select! {biased;_=events.recv()=>None,result=session.event(version,&id,value)=>Some(result)}
            }
        };
        let Some(next) = next else {
            break;
        };
        result = next;
    }
    session.stop().await;
}
async fn retry(
    session: &mut Session,
    events: &async_channel::Receiver<Command>,
) -> Option<Result<(), Fault>> {
    // Startup contains no user source and is always joined, never cancelled mid-spawn.
    if let Err(error) = session.prepare().await {
        return Some(Err(error));
    }
    if events.is_closed() {
        return None;
    }
    tokio::select! {biased;_=events.recv()=>None,result=session.load()=>Some(result)}
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn server(changed_after: bool) -> (LocalOptions, Reference, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let reference = Reference {
            id: "art".into(),
            session: "owner".into(),
            revision: 1,
            title: "Synthetic".into(),
            kind: "visual".into(),
        };
        let task = tokio::spawn(async move {
            for (i, path) in [
                "/api/hello",
                "/api/sessions/owner/artifacts/art?revision=1",
                "/api/hello",
            ]
            .iter()
            .enumerate()
            {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buf = [0; 1024];
                    let n = socket.read(&mut buf).await.unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buf[..n]);
                    if request.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                    assert!(request.len() < 4096);
                }
                assert!(
                    String::from_utf8_lossy(&request)
                        .starts_with(&format!("GET {path} HTTP/1.1\r\n"))
                );
                let value = if i == 1 {
                    json!({"id":"art","sessionId":"owner","revision":1,"title":"Synthetic","kind":"visual","source":"({ui,state})=>{const s=state({n:0});return()=>ui.column([ui.text(String(s.n)),ui.button({label:'Increment',onClick:()=>{s.n++}})]);}","html":"never evaluated","data":null,"createdAt":1,"updatedAt":2,"visual":{"api":1,"engine":"quickjs-ng 0.17.0"}})
                } else {
                    json!({"daemonId":if changed_after&&i==2{"changed"}else{"test-daemon"},"lineageId":"test-lineage","minimumClientProtocolVersion":1,"protocolVersion":1,"capabilities":{"independentExecution":true}})
                };
                let body = serde_json::to_vec(&value).unwrap();
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(&body).await.unwrap();
            }
        });
        (options, reference, task)
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn explicit_scoped_read_and_event_use_only_faux_gets_and_close_reaps() {
        let (options, reference, server) = server(false).await;
        let (worker, updates) = Worker::start(options, reference, None).unwrap();
        let initial = tokio::time::timeout(std::time::Duration::from_secs(5), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            initial.live && initial.error.is_none(),
            "synthetic failure: {:?}",
            initial.error
        );
        assert_eq!(initial.state.as_deref(), Some("[{\"n\":0}]"));
        assert!(worker.command(Command::Event {
            version: initial.version,
            id: "0.1".into(),
            value: Value::Null
        }));
        let next = tokio::time::timeout(std::time::Duration::from_secs(3), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(next.live && next.error.is_none());
        assert_eq!(next.state.as_deref(), Some("[{\"n\":1}]"));
        drop(worker);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), updates.recv())
                .await
                .unwrap()
                .is_err()
        );
        server.await.unwrap();
    }
    #[tokio::test]
    async fn identity_change_after_read_never_admits_revision_or_source() {
        let (options, reference, server) = server(true).await;
        let (worker, updates) = Worker::start(options, reference, None).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            result.revision.is_none()
                && result.scene.is_none()
                && !result.live
                && result.error.is_some()
        );
        drop(worker);
        server.await.unwrap();
    }
}

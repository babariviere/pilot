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
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
/// How long an idle reader keeps its warm helper before releasing the slot.
const WARM: Duration = Duration::from_secs(2);
#[derive(Clone, Default)]
pub(crate) struct Snapshot {
    pub(crate) raster: Option<Arc<crate::artifact_image::Raster>>,
    pub(crate) complete: bool,
    pub(crate) drawings: Arc<BTreeMap<String, DrawingFrame>>,
    pub(crate) revision: Option<Arc<Revision>>,
    pub(crate) scene: Option<Arc<Scene>>,
    pub(crate) state: Option<String>,
    pub(crate) version: u64,
    pub(crate) error: Option<Fault>,
    pub(crate) live: bool,
}
#[derive(Clone)]
pub(crate) struct DrawingFrame {
    pub(crate) version: u64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) pointer: Option<[f64; 2]>,
    pub(crate) plan: Result<Arc<crate::visual_canvas_plan::Plan>, &'static str>,
}
pub(crate) enum Command {
    Event {
        version: u64,
        id: String,
        value: Value,
    },
    Retry,
    Draw {
        version: u64,
        id: String,
        width: f64,
        height: f64,
        pointer: Option<[f64; 2]>,
    },
}
pub(crate) struct Worker {
    commands: async_channel::Sender<Command>,
    _lifetime: async_channel::Sender<()>,
    finished: async_channel::Receiver<()>,
    output: async_channel::Receiver<Snapshot>,
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0., |d| d.as_secs_f64() * 1000.)
}
impl Worker {
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn synthetic() -> (Self, async_channel::Receiver<Command>) {
        let (commands, events) = async_channel::bounded(2);
        let (lifetime, _) = async_channel::bounded(1);
        let (_, finished) = async_channel::bounded(1);
        let (_, output) = async_channel::bounded(1);
        (
            Self {
                commands,
                _lifetime: lifetime,
                finished,
                output,
            },
            events,
        )
    }
    pub(crate) fn start(
        options: LocalOptions,
        reference: Reference,
        state: Option<String>,
    ) -> Result<(Self, async_channel::Receiver<Snapshot>), &'static str> {
        Self::start_with_runtime(options, reference, state, || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
        })
    }
    fn start_with_runtime(
        options: LocalOptions,
        reference: Reference,
        state: Option<String>,
        make_runtime: impl FnOnce() -> Result<tokio::runtime::Runtime, std::io::Error> + Send + 'static,
    ) -> Result<(Self, async_channel::Receiver<Snapshot>), &'static str> {
        let (commands, events) = async_channel::bounded(2);
        let (lifetime, cancelled) = async_channel::bounded(1);
        let (updates, output) = async_channel::bounded(1);
        let replace = output.clone();
        let (finished_signal, finished) = async_channel::bounded(1);
        let command_lane = events.clone();
        std::thread::Builder::new()
            .name("artifact-reader".into())
            .spawn(move || {
                let _finished_signal = finished_signal;
                if let Ok(runtime) = make_runtime() {
                    runtime.block_on(run(
                        options, reference, state, events, updates, replace, cancelled,
                    ));
                }
                command_lane.close();
            })
            .map_err(|_| "Cannot start the isolated artifact reader")?;
        Ok((
            Self {
                commands,
                _lifetime: lifetime,
                finished,
                output: output.clone(),
            },
            output,
        ))
    }
    pub(crate) fn command(&self, command: Command) -> bool {
        self.commands.try_send(command).is_ok()
    }
    /// Closes after runtime/read/decode cleanup, including cancelled codecs.
    /// Dropping a UI receiver never implies that its old permit is free.
    pub(crate) fn finished(&self) -> async_channel::Receiver<()> {
        self.finished.clone()
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        // A completed static reader can still have an unconsumed source/raster
        // snapshot. Retire it before its already-closed completion is awaited.
        self.commands.close();
        self.output.close();
        while self.output.try_recv().is_ok() {}
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
    cancelled: async_channel::Receiver<()>,
) {
    let mut snapshot = Snapshot::default();
    let permit = if matches!(reference.kind.as_str(), "image" | "unknown") {
        Some(
            tokio::select! {biased; _=cancelled.recv()=>return, p=crate::artifact_image::Permit::queued()=>p},
        )
    } else {
        None
    };
    let read = tokio::select! {biased;_=cancelled.recv()=>return,value=crate::local_client::artifact(&options,&reference)=>value};
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
    if revision.reference.kind == "image" {
        let _permit = match permit {
            Some(p) => p,
            None => {
                tokio::select! {biased; _=cancelled.recv()=>return, p=crate::artifact_image::Permit::queued()=>p}
            }
        };
        let raster = { crate::artifact_image::decode(&revision.source, || cancelled.is_closed()) };
        if cancelled.is_closed() {
            return;
        }
        snapshot.complete = true;
        snapshot.version = 1;
        match raster {
            Ok(raster) => snapshot.raster = Some(Arc::new(raster)),
            Err(message) => {
                snapshot.error = Some(Fault {
                    kind: "image",
                    message: message.into(),
                    line: None,
                    limit: None,
                })
            }
        }
        publish(&updates, &replace, snapshot);
        return;
    }
    drop(permit);
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
    let mut result = match retry(&mut session, &cancelled).await {
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
        if !snapshot.live {
            session.stop().await;
        }
        publish(&updates, &replace, snapshot.clone());
        // Keep the helper warm between interactions, so a drag or a run of
        // clicks skips process start-up. It yields its slot after WARM idle,
        // or as soon as another reader or a restart needs one.
        let command = if session.alive() {
            tokio::select! {
                biased;
                command = events.recv() => command,
                _ = tokio::time::sleep(WARM) => {
                    session.stop().await;
                    events.recv().await
                }
                _ = crate::visual_runtime::contended() => {
                    session.stop().await;
                    events.recv().await
                }
            }
        } else {
            events.recv().await
        };
        let Ok(command) = command else {
            break;
        };
        if !matches!(command, Command::Retry) && !session.alive() {
            // As with Retry, join startup even if the row retires mid-spawn.
            // Cancelling attestation would drop an unreaped helper.
            if let Err(error) = session.prepare().await {
                result = Err(error);
                continue;
            }
            if cancelled.is_closed() {
                break;
            }
            let resumed = tokio::select! {biased; _=cancelled.recv()=>None, result=session.resume()=>Some(result)};
            match resumed {
                None => break,
                Some(Err(error)) => {
                    result = Err(error);
                    continue;
                }
                Some(Ok(())) => {}
            }
        }
        let next = match command {
            Command::Retry => {
                session.clock(now());
                retry(&mut session, &cancelled).await
            }
            Command::Event { version, id, value } => {
                session.clock(now());
                tokio::select! {biased;_=cancelled.recv()=>None,result=session.event(version,&id,value)=>Some(result)}
            }
            Command::Draw {
                version,
                id,
                width,
                height,
                pointer,
            } => {
                let drawing = tokio::select! {biased;_=cancelled.recv()=>None,drawing=session.draw(version,&id,width,height,pointer)=>Some(drawing)};
                match drawing {
                    None => None,
                    Some(Err(error)) => Some(Err(error)),
                    Some(Ok(drawing)) => {
                        let plan =
                            crate::visual_canvas_plan::Plan::compile(&drawing, width, height)
                                .map(Arc::new);
                        Arc::make_mut(&mut snapshot.drawings).insert(
                            id,
                            DrawingFrame {
                                version,
                                width,
                                height,
                                pointer,
                                plan,
                            },
                        );
                        Some(Ok(()))
                    }
                }
            }
        };
        let Some(next) = next else {
            break;
        };
        if next.is_ok() && session.version != snapshot.version {
            snapshot.drawings = Arc::new(BTreeMap::new());
        }
        result = next;
    }
    session.stop().await;
}
async fn retry(
    session: &mut Session,
    events: &async_channel::Receiver<()>,
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
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[test]
    fn artifact_gallery_completion_receiver_does_not_retain_lifetime_or_queued_raster() {
        let (commands, _events) = async_channel::bounded(1);
        let (lifetime, cancelled) = async_channel::bounded(1);
        let (done, finished) = async_channel::bounded(1);
        let (updates, output) = async_channel::bounded(1);
        let image = Arc::new(gpui_kit::RenderImage::new(vec![image::Frame::new(
            image::RgbaImage::new(4, 4),
        )]));
        let weak = Arc::downgrade(&image);
        let source = Arc::new("synthetic queued source".to_string());
        let source_weak = Arc::downgrade(&source);
        assert!(
            updates
                .try_send(Snapshot {
                    revision: Some(Arc::new(Revision {
                        reference: Reference {
                            id: "queued".into(),
                            session: "owner".into(),
                            revision: 1,
                            title: "Synthetic".into(),
                            kind: "image".into()
                        },
                        source,
                        data: Value::Null,
                        visual_supported: false,
                        created_at: 1.,
                        updated_at: 1.,
                    })),
                    raster: Some(Arc::new(crate::artifact_image::Raster {
                        image,
                        width: 4,
                        height: 4,
                        mime: "image/png",
                        encoded_bytes: 1,
                        source_hash: "synthetic".into(),
                        first_frame: false,
                    })),
                    ..Default::default()
                })
                .is_ok()
        );
        let worker = Worker {
            commands,
            _lifetime: lifetime,
            finished,
            output: output.clone(),
        };
        let waiter = worker.finished();
        drop(worker);
        assert!(
            cancelled.is_closed(),
            "completion receiver must not own a cancellation sender"
        );
        assert!(
            weak.upgrade().is_none(),
            "queued full raster must retire before awaiting completion"
        );
        assert!(
            source_weak.upgrade().is_none(),
            "queued source must retire before awaiting completion"
        );
        assert!(output.is_closed() && output.try_recv().is_err());
        assert!(!waiter.is_closed());
        drop(done);
        assert!(waiter.is_closed());
    }
    #[tokio::test]
    async fn artifact_gallery_detail_init_failure_completes_with_closed_commands() {
        let reference = Reference {
            id: "art".into(),
            session: "owner".into(),
            revision: 1,
            title: "Synthetic".into(),
            kind: "image".into(),
        };
        let (worker, output) =
            Worker::start_with_runtime(LocalOptions::synthetic(1), reference, None, || {
                Err(std::io::Error::other("synthetic runtime failure"))
            })
            .unwrap();
        let done = worker.finished();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), done.recv())
                .await
                .unwrap()
                .is_err()
        );
        assert!(!worker.command(Command::Retry));
        assert!(output.recv().await.is_err());
    }
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
                    json!({"id":"art","sessionId":"owner","revision":1,"title":"Synthetic","kind":"visual","source":"({ui,state})=>{const s=state({n:0});return()=>ui.column([ui.text(String(s.n)),ui.button({label:'Increment',onClick:()=>{s.n++}}),ui.canvas({height:120,draw:(g,{width,height})=>{g.rect(0,0,width,height,{fill:'chart1'});g.text(4,4,String(s.n));}})]);}","html":"never evaluated","data":null,"createdAt":1,"updatedAt":2,"visual":{"api":1,"engine":"quickjs-ng 0.17.0"}})
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
        assert!(worker.command(Command::Draw {
            version: next.version,
            id: "0.2".into(),
            width: 320.,
            height: 120.,
            pointer: Some([25., 30.]),
        }));
        let frame = tokio::time::timeout(std::time::Duration::from_secs(3), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(frame.live && frame.error.is_none());
        let drawing = &frame.drawings["0.2"];
        assert_eq!(drawing.pointer, Some([25., 30.]));
        assert_eq!(drawing.version, next.version);
        assert!(drawing.plan.is_ok());
        assert_eq!(frame.state, next.state);
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

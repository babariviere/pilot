//! Faux loopback only. No real content, credentials, profile or mutation.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use std::{sync::atomic::AtomicUsize, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Notify,
};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn reference() -> Reference {
    Reference {
        id: "image".into(),
        session: "owner".into(),
        revision: 1,
        title: "Synthetic".into(),
        kind: "image".into(),
    }
}
struct Server {
    options: LocalOptions,
    requests: Arc<AtomicUsize>,
    started: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn new(hang: bool, webp: bool) -> Self {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let requests = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let (count, seen) = (requests.clone(), started.clone());
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            4,
            4,
            image::Rgba([197, 29, 11, 255]),
        ))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
        let source = if webp {
            "data:image/webp;base64,AAAA".into()
        } else {
            format!(
                "data:image/png;base64,{}",
                STANDARD.encode(bytes.into_inner())
            )
        };
        let body=Arc::new(json!({"id":"image","sessionId":"owner","revision":1,"title":"Synthetic","kind":"image","source":source,"html":"<script>never execute</script>","createdAt":1,"updatedAt":1}).to_string());
        let task = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    connection=listener.accept()=>{
                        let Ok((socket,_))=connection else {break;};
                        let(body,count,seen)=(body.clone(),count.clone(),seen.clone());
                        handlers.spawn(async move {
                            let operation=async {
                                let mut socket=BufReader::new(socket);let mut headers=String::new();
                                loop { let mut line=String::new(); if socket.read_line(&mut line).await?==0 {return Ok::<(),std::io::Error>(());} headers.push_str(&line);if headers.len()>8192{return Ok(());}
                                    if line=="\r\n"{break;} }
                                assert!(!headers.to_lowercase().contains("authorization:")&&!headers.to_lowercase().contains("cookie:"));
                                let request=headers.lines().next().unwrap();
                                let payload=if request=="GET /api/hello HTTP/1.1" { Arc::new(json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string()) }
                                else {
                                    assert_eq!(request,"GET /api/sessions/owner/artifacts/image?revision=1 HTTP/1.1");
                                    count.fetch_add(1,Ordering::SeqCst);seen.notify_one();
                                    if hang { std::future::pending::<()>().await; }
                                    body
                                };
                                let mut socket=socket.into_inner();
                                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",payload.len()).as_bytes()).await?;
                                socket.write_all(payload.as_bytes()).await?;
                                Ok(())
                            };
                            // Failure/rejection never leaves an unbounded writer or synchronous join.
                            let _=tokio::time::timeout(Duration::from_secs(2),operation).await;
                        });
                    },
                    _=handlers.join_next(),if !handlers.is_empty()=>{}
                }
            }
        });
        Self {
            options,
            requests,
            started,
            task,
        }
    }
}
#[tokio::test]
async fn artifact_gallery_one_request_until_ack_and_only_small_bgra_result() {
    let _serial = SERIAL.lock().await;
    let server = Server::new(false, false).await;
    let (mut worker, updates) = Worker::start(server.options.clone(), "owner".into()).unwrap();
    let mut unsupported = reference();
    unsupported.kind = "visual".into();
    assert!(worker.load(unsupported, 1).is_err());
    let mut foreign = reference();
    foreign.session = "foreign".into();
    assert!(worker.load(foreign, 1).is_err());
    worker.load(reference(), 1).unwrap();
    for n in 2..66 {
        assert!(worker.load(reference(), n).is_err());
    }
    let (attempt, actual, outcome) = tokio::time::timeout(Duration::from_secs(3), updates.recv())
        .await
        .unwrap()
        .unwrap()
        .into_parts();
    assert_eq!(attempt, 1);
    assert_eq!(actual, reference());
    let Outcome::Ready(thumbnail) = outcome else {
        panic!("expected thumbnail");
    };
    assert_eq!(thumbnail.bytes(), 64);
    assert_eq!(
        &thumbnail.image().as_bytes(0).unwrap()[..4],
        &[11, 29, 197, 255]
    );
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
    // The global permit is free before even acknowledging the small result.
    drop(crate::artifact_image::Permit::acquire().unwrap());
    assert!(worker.load(reference(), 2).is_err());
    worker.complete(1);
    let done = worker.finished();
    drop(worker);
    assert!(
        tokio::time::timeout(Duration::from_secs(3), done.recv())
            .await
            .unwrap()
            .is_err()
    );
}
#[tokio::test]
async fn artifact_gallery_cancelled_http_releases_permit_before_completion_without_waiter_cycle() {
    let _serial = SERIAL.lock().await;
    let server = Server::new(true, false).await;
    let (mut worker, _updates) = Worker::start(server.options.clone(), "owner".into()).unwrap();
    worker.load(reference(), 1).unwrap();
    tokio::time::timeout(Duration::from_secs(3), server.started.notified())
        .await
        .unwrap();
    assert!(crate::artifact_image::Permit::acquire().is_err());
    let done = worker.finished();
    drop(worker); // done must not keep the lifetime sender alive.
    assert!(
        tokio::time::timeout(Duration::from_secs(3), done.recv())
            .await
            .unwrap()
            .is_err()
    );
    drop(crate::artifact_image::Permit::acquire().unwrap());
}
#[tokio::test]
async fn artifact_gallery_read_failure_and_init_failure_close_cleanly() {
    let _serial = SERIAL.lock().await;
    let server = Server::new(false, true).await;
    let (mut worker, updates) = Worker::start(server.options.clone(), "owner".into()).unwrap();
    worker.load(reference(), 1).unwrap();
    let (_, _, outcome) = tokio::time::timeout(Duration::from_secs(3), updates.recv())
        .await
        .unwrap()
        .unwrap()
        .into_parts();
    assert!(matches!(outcome,Outcome::Failed(message) if message.contains("WebP")));
    let done = worker.finished();
    drop(worker);
    assert!(
        tokio::time::timeout(Duration::from_secs(3), done.recv())
            .await
            .unwrap()
            .is_err()
    );
    drop(crate::artifact_image::Permit::acquire().unwrap());
    let (mut failed, updates) =
        Worker::start_with_runtime(server.options.clone(), "owner".into(), || {
            Err(std::io::Error::other("synthetic runtime failure"))
        })
        .unwrap();
    let done = failed.finished();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), done.recv())
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        failed.load(reference(), 1).is_err(),
        "dead initialization must not leave a live command lane"
    );
    assert!(updates.recv().await.is_err());
}

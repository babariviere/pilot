//! Temporary faux HTTP only. No real profile, content, service or mutations.
use super::*;
use crate::artifact_model::Reference;
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

struct Server {
    options: LocalOptions,
    requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn start(body: String, status: u16, length: Option<usize>, bad_gate: usize) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let options = LocalOptions {
            externally_managed: false,
            port: listener.local_addr().unwrap().port(),
            daemon_id: "synthetic-daemon".into(),
            lineage_id: "synthetic-lineage".into(),
            native_home: None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            update_policy: Default::default(),
        };
        let requests = Arc::new(Mutex::new(Vec::new()));
        let records = requests.clone();
        let body = Arc::new(body);
        let gates = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    connection=listener.accept()=>{
                        let Ok((stream,_))=connection else{break;};let(records,body,gates)=(records.clone(),body.clone(),gates.clone());
                        handlers.spawn(async move{
                            let operation=async{
                                let mut stream=BufReader::new(stream);let mut headers=String::new();
                                loop{
                                    let mut line=String::new();
                                    if stream.read_line(&mut line).await?==0{break;}
                                    headers.push_str(&line);
                                    if line=="\r\n"{break;}
                                    if headers.len()>8192{return Ok::<(),std::io::Error>(());}
                                }
                                let request=headers.lines().next().unwrap_or("").to_string();records.lock().unwrap().push(request.clone());
                                assert!(!headers.to_lowercase().contains("authorization:"));assert!(!headers.to_lowercase().contains("cookie:"));
                                let path=request.split_whitespace().nth(1).unwrap_or("");assert!(request.starts_with("GET "));
                                let mut stream=stream.into_inner();
                                let (code,payload,len)=if path=="/api/hello"{
                                    let n=gates.fetch_add(1,Ordering::SeqCst)+1;
                                    let payload=json!({"daemonId":if n==bad_gate{"wrong"}else{"synthetic-daemon"},"lineageId":"synthetic-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string();let len=payload.len();(200,Arc::new(payload),len)
                                }else{assert_eq!(path,"/api/sessions/owner/artifacts/synthetic?revision=2");(status,body.clone(),length.unwrap_or(body.len()))};
                                stream.write_all(format!("HTTP/1.1 {code} Synthetic\r\nContent-Type: application/json\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n").as_bytes()).await?;
                                stream.write_all(payload.as_bytes()).await?;Ok::<(),std::io::Error>(())
                            };
                            // A rejected content length may stop the client reading. Teardown
                            // never waits indefinitely on a sender or synchronous thread join.
                            let _=tokio::time::timeout(Duration::from_secs(2),operation).await;
                        });
                    }
                    _=handlers.join_next(),if !handlers.is_empty()=>{}
                }
            }
        });
        Self {
            options,
            requests,
            task,
        }
    }
}
fn reference() -> Reference {
    Reference {
        id: "synthetic".into(),
        session: "owner".into(),
        revision: 2,
        title: "Synthetic".into(),
        kind: "image".into(),
    }
}
fn body(source: &str, html: &str) -> String {
    json!({"id":"synthetic","sessionId":"owner","revision":2,"title":"Synthetic","kind":"image","source":source,"html":html,"createdAt":1,"updatedAt":2}).to_string()
}

#[tokio::test]
async fn image_envelopes_cross_old_cap_including_unknown_pins() {
    let source = format!("data:image/png;base64,{}", "A".repeat(3 * 1024 * 1024));
    let value = body(&source, &source);
    assert!(value.len() > 4 * 1024 * 1024);
    let server = Server::start(value.clone(), 200, None, 0).await;
    let revision = artifact(&server.options, &reference()).await.unwrap();
    assert_eq!(*revision.source, source);
    assert!(!revision.visual_supported);
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    let server = Server::start(value, 200, None, 0).await;
    let mut pin = reference();
    pin.kind = "unknown".into();
    let revision = artifact(&server.options, &pin).await.unwrap();
    assert_eq!(revision.reference.kind, "image");
    assert_eq!(*revision.source, source);
    assert_eq!(server.requests.lock().unwrap().len(), 3);
}
#[tokio::test]
async fn image_read_is_exactly_scoped_and_identity_gated_before_and_after() {
    for bad_gate in [1, 2] {
        let server = Server::start(body("synthetic bytes", "ignored"), 200, None, bad_gate).await;
        assert!(artifact(&server.options, &reference()).await.is_err());
        assert_eq!(
            server.requests.lock().unwrap().len(),
            if bad_gate == 1 { 1 } else { 3 }
        );
    }
    let server = Server::start(body("a", "b"), 200, None, 0).await;
    let mut r = reference();
    r.session = "../owner".into();
    assert!(artifact(&server.options, &r).await.is_err());
    assert!(server.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn large_allowance_does_not_accept_changed_kind_owner_id_or_revision() {
    for (key, value) in [
        ("kind", json!("visual")),
        ("sessionId", json!("other")),
        ("id", json!("other")),
        ("revision", json!(1)),
    ] {
        let mut v: Value = serde_json::from_str(&body("a", "b")).unwrap();
        v[key] = value;
        let server = Server::start(v.to_string(), 200, None, 0).await;
        assert!(artifact(&server.options, &reference()).await.is_err());
    }
}
#[tokio::test]
async fn redirects_and_over_budget_declared_lengths_are_refused() {
    let server = Server::start("{}".into(), 302, None, 0).await;
    assert!(
        artifact(&server.options, &reference())
            .await
            .unwrap_err()
            .contains("HTTP status")
    );
    let server = Server::start(
        "{}".into(),
        200,
        Some(crate::artifact_image::HTTP_CAP + 1),
        0,
    )
    .await;
    assert!(
        artifact(&server.options, &reference())
            .await
            .unwrap_err()
            .contains("44 MiB")
    );
}
#[tokio::test]
async fn exact_image_wire_budget_skips_redundant_html_without_source_clones() {
    let mut value = body("data:image/png;base64,small", "");
    let insertion = value.find("\"html\":\"").unwrap() + 8;
    let padding = crate::artifact_image::HTTP_CAP - value.len();
    value.insert_str(insertion, &"x".repeat(padding));
    assert_eq!(value.len(), crate::artifact_image::HTTP_CAP);
    let server = Server::start(value, 200, None, 0).await;
    let r = artifact(&server.options, &reference()).await.unwrap();
    assert_eq!(r.source.as_str(), "data:image/png;base64,small");
}

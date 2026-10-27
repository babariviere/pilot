//! Faux loopback only. No profile reads, live actions or daemon lifecycle.
use super::*;
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

#[derive(Clone, Copy)]
enum Framing {
    Length,
    Chunked,
    Interrupted,
    Declared(usize),
}
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
    async fn start(body: String, framing: Framing, bad_gate: usize) -> Self {
        Self::with_hello_padding(body, framing, bad_gate, 0).await
    }
    async fn with_hello_padding(
        body: String,
        framing: Framing,
        bad_gate: usize,
        hello_padding: usize,
    ) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let records = requests.clone();
        let body = Arc::new(body);
        let gates = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break; };
                        let (records, body, gates) = (records.clone(), body.clone(), gates.clone());
                        handlers.spawn(async move {
                            let operation = async {
                                let mut reader = BufReader::new(stream);
                                let mut headers = String::new();
                                loop {
                                    let mut line = String::new();
                                    if reader.read_line(&mut line).await? == 0 { return Ok::<(), std::io::Error>(()); }
                                    if line == "\r\n" { break; }
                                    headers.push_str(&line);
                                    if headers.len() > 8192 { return Ok(()); }
                                }
                                let request = headers.lines().next().unwrap().to_string();
                                records.lock().unwrap().push(request.clone());
                                assert!(request.starts_with("GET "));
                                let path = request.split_whitespace().nth(1).unwrap();
                                let (payload, mode) = if path == "/api/hello" {
                                    let n = gates.fetch_add(1, Ordering::SeqCst) + 1;
                                    let mut hello = json!({"daemonId":if n == bad_gate {"changed"} else {"test-daemon"},"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string();
                                    hello.extend(std::iter::repeat_n(' ', hello_padding));
                                    (Arc::new(hello), if hello_padding > 0 { framing } else { Framing::Length })
                                } else {
                                    assert_eq!(path, "/api/sessions/owner/history?before=50&limit=24");
                                    (body, framing)
                                };
                                let mut stream = reader.into_inner();
                                if matches!(mode, Framing::Chunked) {
                                    stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await?;
                                    for chunk in payload.as_bytes().chunks(16384) {
                                        stream.write_all(format!("{:x}\r\n", chunk.len()).as_bytes()).await?;
                                        stream.write_all(chunk).await?;
                                        stream.write_all(b"\r\n").await?;
                                    }
                                    stream.write_all(b"0\r\n\r\n").await?;
                                } else {
                                    let len = match mode { Framing::Declared(n) => n, Framing::Interrupted => payload.len() + 100, _ => payload.len() };
                                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n").as_bytes()).await?;
                                    stream.write_all(payload.as_bytes()).await?;
                                }
                                Ok(())
                            };
                            // Rejected lengths and aborted consumers cannot strand a writer.
                            let _ = tokio::time::timeout(Duration::from_secs(3), operation).await;
                        });
                    }
                    _ = handlers.join_next(), if !handlers.is_empty() => {}
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
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}
fn route() -> ReadRoute {
    ReadRoute::History {
        id: "owner".into(),
        before: 50,
    }
}

#[tokio::test]
async fn large_history_pages_with_inline_images_load_with_both_framings() {
    // Five individually ordinary messages cross the server's soft 4 MiB stop.
    let image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
    let entries: Vec<_> = (40..45).map(|id| json!({"id":id,"kind":"pi.user","model":[{"role":"user","content":[{"type":"text","text":"x".repeat(900*1024)},{"type":"image","mimeType":"image/png","data":image}]}]})).collect();
    let payload = json!({"entries":entries,"more":true}).to_string();
    assert!(payload.len() > 4 * 1024 * 1024);
    for framing in [Framing::Length, Framing::Chunked] {
        let server = Server::start(payload.clone(), framing, 0).await;
        let page = history(&client(), &server.options, "owner".into(), 50)
            .await
            .unwrap();
        assert_eq!(page["entries"][0]["model"][0]["content"][1]["data"], image);
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"snapshot","entries":[{"id":50,"head":50,"kind":"pi.user","model":[{"role":"user","content":[{"type":"text","text":"tail"}]}]}]}));
        model.page(50, &page);
        assert_eq!(model.cursor, Some(40));
        let rows = model.rows();
        assert_eq!(rows.len(), 11);
        let images: Vec<_> = rows.iter().filter_map(|row| row.image_data()).collect();
        assert_eq!(images.len(), 5);
        for source in images {
            assert_eq!(source.data.as_deref().unwrap().as_str(), image);
            let raster = source.decode(|| false).unwrap();
            assert_eq!((raster.width, raster.height), (1, 1));
        }
        assert_eq!(server.requests.lock().unwrap().len(), 3);
    }
}

#[tokio::test]
async fn small_reads_json_errors_and_interrupted_bodies_remain_distinct() {
    let server = Server::start("{\"entries\":[],\"more\":false}".into(), Framing::Length, 0).await;
    assert!(hello(&client(), &server.options).await.is_ok());
    assert_eq!(
        history(&client(), &server.options, "owner".into(), 50)
            .await
            .unwrap()["more"],
        false
    );
    for (body, framing, error) in [
        ("not json", Framing::Length, "Invalid Local JSON response"),
        ("{}", Framing::Interrupted, "Local response interrupted"),
    ] {
        let server = Server::start(body.into(), framing, 0).await;
        assert_eq!(
            history(&client(), &server.options, "owner".into(), 50)
                .await
                .unwrap_err(),
            error
        );
    }
}

#[tokio::test]
async fn history_rechecks_identity_before_exposing_a_page() {
    for gate in [1, 2] {
        let server = Server::start(
            "{\"entries\":[],\"more\":false}".into(),
            Framing::Length,
            gate,
        )
        .await;
        assert!(
            history(&client(), &server.options, "owner".into(), 50)
                .await
                .unwrap_err()
                .contains("identity changed")
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            if gate == 1 { 1 } else { 3 }
        );
    }
}

#[tokio::test]
async fn budgets_are_route_specific_and_enforced_for_length_and_chunks() {
    assert_eq!(ReadRoute::Hello.budget(), None);
    assert_eq!(route().budget(), None);
    let artifact = ReadRoute::Artifact {
        owner: "owner".into(),
        id: "image".into(),
        revision: 1,
    };
    assert_eq!(
        artifact.budget().unwrap().0,
        crate::artifact_image::HTTP_CAP
    );
    let server = Server::start("{}".into(), Framing::Declared(20000), 0).await;
    assert_eq!(
        get_bytes(&client(), &server.options, route(), Some((16384, "budget")))
            .await
            .unwrap_err(),
        "budget"
    );
    // Exercise accumulated-body enforcement without allocating a huge fixture.
    let server = Server::start("x".repeat(20000), Framing::Chunked, 0).await;
    assert_eq!(
        get_bytes(&client(), &server.options, route(), Some((16384, "budget")))
            .await
            .unwrap_err(),
        "budget"
    );
}

#[tokio::test]
async fn hello_and_history_cross_the_removed_caps_with_both_framings() {
    let mut body = String::from("{\"entries\":[],\"more\":false}");
    body.extend(std::iter::repeat_n(' ', 64 * 1024 * 1024));
    for framing in [Framing::Length, Framing::Chunked] {
        let server = Server::with_hello_padding(body.clone(), framing, 0, 4 * 1024 * 1024).await;
        assert!(hello(&client(), &server.options).await.is_ok());
        let page = history(&client(), &server.options, "owner".into(), 50)
            .await
            .unwrap();
        assert_eq!(page["entries"], json!([]));
        assert_eq!(page["more"], false);
    }
}

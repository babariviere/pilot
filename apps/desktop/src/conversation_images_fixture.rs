//! Owned faux loopback reader fixture, never a real profile or filesystem image.
use serde_json::json;
use std::{
    io::{BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_tungstenite::tungstenite::{
    Message, WebSocket, handshake::derive_accept_key, protocol::Role,
};

pub(crate) struct Server {
    pub(crate) options: crate::local_client::LocalOptions,
    pub(crate) requests: Arc<Mutex<Vec<String>>>,
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start(data: String) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let record = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut sockets = Vec::new();
            for stream in listener.incoming() {
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let _ = (|| -> std::io::Result<()> {
                    let mut reader = std::io::BufReader::new((&mut stream).take(8192));
                    let mut headers = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line)? == 0 {
                            return Ok(());
                        }
                        headers.push_str(&line);
                        if line == "\r\n" {
                            break;
                        }
                    }
                    drop(reader);
                    let first = headers.lines().next().unwrap();
                    record.lock().unwrap().push(first.to_owned());
                    assert!(first.starts_with("GET "));
                    let path = first.split_whitespace().nth(1).unwrap();
                    if path == "/api/hello" {
                        let body = json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string();
                        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes())?;
                        return Ok(());
                    }
                    assert!(matches!(
                        path,
                        "/api/ws" | "/api/sessions/owner/ws?history=paged-v1"
                    ));
                    // Header names are case-insensitive, values are not.
                    let key = headers
                        .lines()
                        .find(|line| line.to_ascii_lowercase().starts_with("sec-websocket-key: "))
                        .unwrap()
                        .split_once(':')
                        .unwrap()
                        .1
                        .trim();
                    stream.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {}\r\n\r\n",derive_accept_key(key.as_bytes())).as_bytes())?;
                    Ok(())
                })();
                // ReadRoute has already been recorded above; decide without logging content.
                let path = record.lock().unwrap().last().cloned().unwrap_or_default();
                if path.contains("/api/ws ")
                    || path.contains("/api/sessions/owner/ws?history=paged-v1 ")
                {
                    let mut socket = WebSocket::from_raw_socket(stream, Role::Server, None);
                    let values = if path.contains("/sessions/") {
                        vec![
                            json!({"type":"chat.stream","sessionId":"owner","streamId":"fixture-stream","resumed":false}),
                            // Wrong-chat content must not enter the projection.
                            json!({"type":"events","sessionId":"other","seq":1,"events":[{"type":"snapshot","entries":[]}]}),
                            json!({"type":"events","sessionId":"owner","seq":1,"events":[{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","model":[{"role":"user","content":[{"type":"text","text":"Stored conversation image"},{"type":"image","mimeType":"image/png","data":data}]}]},{"id":2,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Selectable conversation text remains available beside stored images."}]}]}]}]}),
                        ]
                    } else {
                        vec![
                            json!({"type":"sessions","sessions":[{"id":"owner","title":"Synthetic images","state":"idle"}]}),
                        ]
                    };
                    for value in values {
                        let _ = socket.send(Message::Text(value.to_string().into()));
                    }
                    sockets.push(socket);
                    assert!(sockets.len() <= 16, "bounded fixture connections");
                }
            }
        });
        Self {
            options: crate::local_client::LocalOptions::synthetic(port),
            requests,
            port,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, self.port));
        self.thread.take().unwrap().join().unwrap();
    }
}

/// Real, deterministic PNG over the old 1 MiB inline limit, not invalid padding.
pub(crate) fn large_png() -> String {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut state = 42u32;
    let pixels = image::RgbImage::from_fn(640, 640, |_, _| {
        image::Rgb(std::array::from_fn(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        }))
    });
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(pixels)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let data = STANDARD.encode(bytes.into_inner());
    assert!(data.len() > 1024 * 1024);
    data
}

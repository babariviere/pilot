//! Owned loopback fixture only. Bounded I/O and joined teardown.
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};
pub(crate) struct Server {
    pub(crate) port: u16,
    pub(crate) writes: Arc<Mutex<Vec<(String, Value)>>>,
    pub(crate) release: Arc<AtomicBool>,
    pub(crate) mismatch: Arc<AtomicBool>,
    pub(crate) capable: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}
impl Server {
    pub(crate) fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let writes = Arc::new(Mutex::new(vec![]));
        let release = Arc::new(AtomicBool::new(true));
        let mismatch = Arc::new(AtomicBool::new(false));
        let capable = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let (ws, r, m, c, s) = (
            writes.clone(),
            release.clone(),
            mismatch.clone(),
            capable.clone(),
            stop.clone(),
        );
        let join = std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                // Darwin can inherit O_NONBLOCK from the listener. Timeout
                // setters alone do not make this bounded blocking parser safe.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_millis(500)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_millis(500)))
                    .unwrap();
                let Some((method, path, body)) = read(&mut stream) else {
                    continue;
                };
                let value = if method == "GET" && path == "/api/hello" {
                    json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"guardedQueue":c.load(Ordering::SeqCst)}})
                } else {
                    ws.lock().unwrap().push((method.clone(), body.clone()));
                    while !r.load(Ordering::SeqCst) && !s.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    if s.load(Ordering::SeqCst) {
                        break;
                    }
                    let mut v = json!({"ok":true,"guard":body["guard"],"sessionId":"source","submissionId":42,"action":if method=="DELETE"{"remove"}else{"edit"}});
                    if m.load(Ordering::SeqCst) {
                        v["guard"]["operationId"] = json!("wrong");
                    }
                    v
                };
                let body = serde_json::to_string(&value).unwrap();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
            }
        });
        Self {
            port,
            writes,
            release,
            mismatch,
            capable,
            stop,
            join: Some(join),
        }
    }
    pub(crate) fn options(&self) -> crate::LocalOptions {
        crate::LocalOptions::synthetic(self.port)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.release.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            j.join().unwrap();
        }
    }
}
fn read(s: &mut TcpStream) -> Option<(String, String, Value)> {
    let mut bytes = Vec::new();
    let mut b = [0; 2048];
    let end = loop {
        let n = s.read(&mut b).ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&b[..n]);
        if bytes.len() > 80 * 1024 {
            return None;
        }
        if let Some(i) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let header = std::str::from_utf8(&bytes[..end]).ok()?;
    let mut parts = header.lines().next()?.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let len = header
        .lines()
        .find_map(|l| {
            l.to_lowercase()
                .strip_prefix("content-length:")
                .and_then(|s| s.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if len > 70 * 1024 {
        return None;
    }
    while bytes.len() < end + len {
        let n = s.read(&mut b).ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&b[..n]);
    }
    Some((
        method,
        path,
        if len == 0 {
            Value::Null
        } else {
            serde_json::from_slice(&bytes[end..end + len]).ok()?
        },
    ))
}

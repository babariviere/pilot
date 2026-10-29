//! Owned, GET-only synthetic subagent endpoint. No real daemon is contacted.
use crate::LocalOptions;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) response: Arc<Mutex<Value>>,
    pub(crate) requests: Arc<Mutex<Vec<String>>>,
    #[cfg(test)]
    pub(crate) daemon: Arc<Mutex<String>>,
    #[cfg(test)]
    pub(crate) code: Arc<Mutex<u16>>,
    #[cfg(test)]
    pub(crate) summary: Arc<Mutex<Value>>,
    pub(crate) messages: Arc<Mutex<Vec<Value>>>,
    #[cfg(test)]
    pub(crate) drop_ack: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    address: std::net::SocketAddr,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
impl Server {
    pub(crate) fn start() -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let options = LocalOptions::synthetic(address.port());
        let response = Arc::new(Mutex::new(
            json!({"name":"Review/日本 %?#", "full":true, "events":[{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","model":[{"role":"user","content":"Synthetic child task"}]},{"id":2,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Synthetic child answer"}]}]}]}]}),
        ));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let daemon = Arc::new(Mutex::new("test-daemon".to_owned()));
        let code = Arc::new(Mutex::new(200));
        let stop = Arc::new(AtomicBool::new(false));
        let summary = Arc::new(Mutex::new(
            json!({"id":"Parent-A","mode":"build","state":"idle","subagents":[{"name":"Review/日本 %?#","state":"idle","createdAt":1}]}),
        ));
        let messages = Arc::new(Mutex::new(Vec::new()));
        let drop_ack = Arc::new(AtomicBool::new(false));
        let (parent, sent, drop_response) = (summary.clone(), messages.clone(), drop_ack.clone());
        let (reply, seen, identity, status, stopping) = (
            response.clone(),
            requests.clone(),
            daemon.clone(),
            code.clone(),
            stop.clone(),
        );
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else {
                    break;
                };
                if stopping.load(Ordering::Relaxed) {
                    break;
                }
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(&mut stream);
                let mut first = String::new();
                if reader.read_line(&mut first).unwrap_or(0) == 0 {
                    continue;
                }
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(n) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = n.trim().parse().unwrap();
                    }
                }
                let mut content = vec![0; length];
                reader.read_exact(&mut content).unwrap();
                seen.lock().unwrap().push(first.trim().to_owned());
                let path = first.split_whitespace().nth(1).unwrap();
                let (code, body) = if path == "/api/hello" {
                    (
                        200,
                        json!({"daemonId":*identity.lock().unwrap(),"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
                    )
                } else if first.starts_with("POST ") && path.ends_with("/messages") {
                    sent.lock()
                        .unwrap()
                        .push(serde_json::from_slice(&content).unwrap());
                    if drop_response.swap(false, Ordering::Relaxed) {
                        continue;
                    }
                    (202, json!({"ok":true}))
                } else if path == "/api/sessions/Parent-A" {
                    (200, parent.lock().unwrap().clone())
                } else {
                    assert!(first.starts_with("GET "));
                    assert!(path.ends_with("/transcript"));
                    (*status.lock().unwrap(), reply.lock().unwrap().clone())
                };
                let body = body.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {code} Synthetic\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Self {
            options,
            response,
            requests,
            #[cfg(test)]
            daemon,
            #[cfg(test)]
            code,
            #[cfg(test)]
            summary,
            messages,
            #[cfg(test)]
            drop_ack,
            stop,
            thread: Some(thread),
            address,
        }
    }
}

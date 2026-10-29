//! Owned synthetic Local for job stop requests. Never reaches a real daemon or job.
use crate::LocalOptions;
use serde_json::json;
use std::{
    io::{BufRead, Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    time::Duration,
};

pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    /// HTTP status the next stop request answers with.
    pub(crate) code: Arc<Mutex<u16>>,
    /// The daemon identity hello reports.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) daemon: Arc<Mutex<&'static str>>,
    /// (method, path) of every request, hello included.
    pub(crate) requests: Arc<Mutex<Vec<(String, String)>>>,
}
impl Server {
    pub(crate) fn start(code: u16) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let code = Arc::new(Mutex::new(code));
        let daemon = Arc::new(Mutex::new("test-daemon"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (status, seen, identity) = (code.clone(), requests.clone(), daemon.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut reader = std::io::BufReader::new(&mut stream);
                let mut first = String::new();
                if reader.read_line(&mut first).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(n) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = n.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; length];
                let _ = reader.read_exact(&mut body);
                seen.lock().unwrap().push((method.clone(), path.clone()));
                let (code, body) = if path == "/api/hello" {
                    (
                        200,
                        json!({"daemonId":*identity.lock().unwrap(),"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
                    )
                } else if method == "POST" && path.ends_with("/stop") {
                    let code = *status.lock().unwrap();
                    (
                        code,
                        if code == 202 {
                            json!({"ok":true})
                        } else {
                            json!({"error":"synthetic"})
                        },
                    )
                } else {
                    (404, json!({"error":"not found"}))
                };
                let body = body.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {code} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Self {
            options,
            code,
            daemon,
            requests,
        }
    }
    pub(crate) fn stops(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "POST")
            .map(|(_, path)| path.clone())
            .collect()
    }
}

//! Owned faux scope daemon/capability. No real pi settings, sign-ins or native auth.
use crate::{LocalOptions, scoped_models::hash};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
#[derive(Clone, Copy, Debug)]
#[cfg_attr(not(test), allow(dead_code))] // Additional fault modes are exercised by unit transport tests.
pub(crate) enum Mode {
    Accept,
    Unchanged,
    Conflict,
    Lost,
    LostBefore,
    ReadbackFailure,
    Malformed,
    Oversized,
    Chunked,
    Denied,
    Unsupported,
}
pub(crate) struct Seen {
    pub(crate) patterns: Option<Vec<String>>,
    pub(crate) mode: Mode,
    pub(crate) requests: Vec<(String, String, Value)>,
    pub(crate) foreign: bool,
}
pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) home: PathBuf,
    pub(crate) seen: Arc<Mutex<Seen>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
pub(crate) fn snapshot(patterns: &Option<Vec<String>>) -> Value {
    json!({"enabledModels":patterns,"scopeHash":hash(patterns),"allModels":patterns.as_ref().is_none_or(Vec::is_empty),
        "candidates":[{"id":"p/one","provider":"p","name":"One 日本語"},{"id":"p/two","provider":"p","name":"Two"}],
        "resolution":patterns.clone().unwrap_or_default().iter().map(|p|json!({"pattern":p,"matches":[],"unresolved":"unknown"})).collect::<Vec<_>>()})
}
impl Server {
    pub(crate) fn start(mode: Mode) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let home = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("native-model-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        let cap = home.join("github-app-capability");
        std::fs::write(
            &cap,
            json!({"daemonId":"test-daemon","lineageId":"test-lineage","token":"a".repeat(64)})
                .to_string(),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cap, std::fs::Permissions::from_mode(0o600)).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port())
            .with_scope_home(home.clone());
        let seen = Arc::new(Mutex::new(Seen {
            patterns: None,
            mode,
            requests: vec![],
            foreign: false,
        }));
        let record = seen.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let halt = stop.clone();
        let thread = std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                if halt.load(Ordering::SeqCst) {
                    break;
                }
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                // A rejected Content-Length can drop the response without polling
                // the current-thread client's connection driver again. Never let
                // this owned oversized-body sender block fixture join forever.
                stream
                    .set_write_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut r = std::io::BufReader::new(&mut stream);
                let mut first = String::new();
                if r.read_line(&mut first).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap().to_owned();
                let path = parts.next().unwrap().to_owned();
                let mut length = 0;
                let mut authorized = false;
                loop {
                    let mut line = String::new();
                    r.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    assert!(!line.to_ascii_lowercase().starts_with("origin:"));
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                    assert!(length <= 160 * 1024);
                    if let Some(v) = line.strip_prefix("x-pilot-github-capability:") {
                        assert_eq!(v.trim(), "a".repeat(64));
                        authorized = true;
                    }
                }
                let mut bytes = vec![0; length];
                r.read_exact(&mut bytes).unwrap();
                let payload = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                assert_eq!(authorized, method == "PUT");
                let (code, body, chunked) = {
                    let mut s = record.lock().unwrap();
                    s.requests
                        .push((method.clone(), path.clone(), payload.clone()));
                    match(method.as_str(),path.as_str()){
                        ("GET","/api/hello")=>(200,json!({"daemonId":if s.foreign{"foreign"}else{"test-daemon"},"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string(),false),
                        ("GET","/api/model-scope")=>{
                            let puts=s.requests.iter().filter(|(m,_,_)|m=="PUT").count();
                            if matches!(s.mode,Mode::ReadbackFailure)&&puts!=0{(503,"{}".into(),false)}
                            else if matches!(s.mode,Mode::Unsupported){(404,"{}".into(),false)}
                            else if matches!(s.mode,Mode::Malformed){(200,"{bad".into(),false)}
                            else if matches!(s.mode,Mode::Oversized|Mode::Chunked){(200," ".repeat(2*1024*1024+1),matches!(s.mode,Mode::Chunked))}
                            else{(200,snapshot(&s.patterns).to_string(),false)}
                        },
                        ("PUT","/api/model-scope")=>{
                            assert_eq!(payload.as_object().unwrap().len(),2);assert!(payload.get("enabledModels").is_some());assert!(payload["expectedHash"].as_str().is_some());
                            if matches!(s.mode,Mode::LostBefore){continue;}
                            if matches!(s.mode,Mode::Denied){(403,"{}".into(),false)}
                            else if matches!(s.mode,Mode::Conflict){s.patterns=Some(vec!["p/elsewhere".into()]);(409,"{}".into(),false)}
                            else {
                                s.patterns=serde_json::from_value(payload["enabledModels"].clone()).unwrap();
                                if matches!(s.mode,Mode::Lost){continue;}
                                if matches!(s.mode,Mode::Unchanged){(200,json!({"changed":false,"scopeHash":hash(&s.patterns)}).to_string(),false)}
                                else{let mut value=snapshot(&s.patterns);value["changed"]=json!(true);(200,value.to_string(),false)}
                            }
                        },_=>panic!("unallowlisted faux scope route {method} {path}"),
                    }
                };
                if chunked {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {code} result\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
                        body.len()
                    );
                } else {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {code} result\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            }
        });
        Self {
            options,
            home,
            seen,
            stop,
            thread: Some(thread),
        }
    }
    pub(crate) fn puts(&self) -> usize {
        self.seen
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(m, _, _)| m == "PUT")
            .count()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let addr = self
            .options
            .loopback()
            .strip_prefix("http://")
            .unwrap()
            .parse()
            .unwrap();
        let _ = TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2));
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

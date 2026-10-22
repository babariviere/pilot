//! Off-UI process transport. No VM/engine is linked into the desktop process.
use crate::visual_wire;
use serde::Deserialize;
use serde_json::Value;
#[cfg(all(test, target_os = "macos"))]
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
};
const REQUEST_CAP: usize = 4 * 1024 * 1024;
const REPLY_CAP: usize = 2 * 1024 * 1024;
const HARD: Duration = Duration::from_secs(2);
const RUNTIME: &str = include_str!("../../../packages/artifacts/src/visual/runtime.js");
static SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(2)));
static TEARDOWN_FAILED: AtomicBool = AtomicBool::new(false);
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Fault {
    pub(crate) kind: &'static str,
    pub(crate) message: String,
    pub(crate) line: Option<u32>,
    pub(crate) limit: Option<usize>,
}
impl Fault {
    fn new(kind: &'static str, message: &str) -> Self {
        Self {
            kind,
            message: message.into(),
            line: None,
            limit: None,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    protocol: u8,
    pid: u32,
    engine: String,
    #[serde(rename = "runtimeHash")]
    runtime_hash: String,
    sandbox: bool,
}
pub(crate) struct Process {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
}
pub(crate) fn worker_path() -> Result<PathBuf, Fault> {
    let exe = std::env::current_exe()
        .map_err(|_| Fault::new("unavailable", "Cannot locate the visual helper"))?;
    let parent = exe
        .parent()
        .ok_or_else(|| Fault::new("unavailable", "Cannot locate the visual helper"))?;
    let parent = if parent.file_name().is_some_and(|n| n == "deps") {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };
    Ok(parent.join("pilot-visual-worker"))
}
impl Process {
    pub(crate) async fn start() -> Result<Self, Fault> {
        if !cfg!(target_os = "macos") {
            return Err(Fault::new(
                "unavailable",
                "Native source execution is disabled until this platform's confinement is validated. Source remains available.",
            ));
        }
        Self::start_at(&worker_path()?).await
    }
    async fn start_at(path: &Path) -> Result<Self, Fault> {
        if TEARDOWN_FAILED.load(Ordering::Acquire) {
            return Err(Fault::new(
                "sandbox",
                "Visual helper teardown failed; restart the app",
            ));
        }
        let permit = SLOTS.clone().try_acquire_owned().map_err(|_| {
            Fault::new(
                "busy",
                "Native visual worker limit reached; retry when another visual closes",
            )
        })?;
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::symlink_metadata(path).map_err(|_| {
            Fault::new(
                "unavailable",
                "Native visual helper is missing; build the desktop workspace",
            )
        })?;
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o022 != 0
        {
            return Err(Fault::new(
                "sandbox",
                "Visual helper ownership/permissions are unsafe",
            ));
        }
        // A synthetic listener makes an erroneously allowed connect safe and observable.
        let probe = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| Fault::new("sandbox", "Cannot prepare sandbox denial probe"))?;
        probe
            .set_nonblocking(true)
            .map_err(|_| Fault::new("sandbox", "Cannot prepare sandbox denial probe"))?;
        let port = probe
            .local_addr()
            .map_err(|_| Fault::new("sandbox", "Cannot prepare sandbox denial probe"))?
            .port();
        let mut child = Command::new(path)
            .arg("--probe-port")
            .arg(port.to_string())
            .env_clear()
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| Fault::new("unavailable", "Cannot start native visual helper"))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| Fault::new("protocol", "Visual helper has no input"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| Fault::new("protocol", "Visual helper has no output"))?;
        let mut process = Self {
            child,
            input,
            output,
            permit: Some(permit),
        };
        let verified = async {
            let bytes = process.read_frame().await?;
            if bytes.len() > 1024 {
                return Err(Fault::new("protocol", "Invalid visual helper hello"));
            }
            let hello: Hello = serde_json::from_slice(&bytes)
                .map_err(|_| Fault::new("protocol", "Invalid visual helper hello"))?;
            if hello.protocol != 1
                || Some(hello.pid) != process.child.id()
                || hello.engine != "0.17.0"
                || hello.runtime_hash != format!("{:x}", Sha256::digest(RUNTIME))
                || !hello.sandbox
            {
                return Err(Fault::new(
                    "sandbox",
                    "Visual helper identity/runtime mismatch",
                ));
            }
            if !verify_sandbox(hello.pid, path) {
                return Err(Fault::new("sandbox", "Cannot verify native visual sandbox"));
            }
            match probe.accept() {
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                _ => return Err(Fault::new("sandbox", "Visual helper network denial failed")),
            }
            Ok(())
        };
        let result = tokio::time::timeout(HARD, verified)
            .await
            .map_err(|_| {
                Fault::new(
                    "timeout",
                    "Visual helper startup exceeded its hard deadline",
                )
            })
            .and_then(|v| v);
        if let Err(error) = result {
            process.stop().await;
            return Err(error);
        }
        Ok(process)
    }
    async fn read_frame(&mut self) -> Result<Vec<u8>, Fault> {
        let mut size = [0; 4];
        self.output
            .read_exact(&mut size)
            .await
            .map_err(|_| Fault::new("crashed", "Visual helper closed unexpectedly"))?;
        let n = u32::from_le_bytes(size) as usize;
        if n > REPLY_CAP {
            return Err(Fault::new("protocol", "Visual helper reply exceeds 2 MiB"));
        }
        let mut bytes = vec![0; n];
        self.output
            .read_exact(&mut bytes)
            .await
            .map_err(|_| Fault::new("crashed", "Visual helper closed unexpectedly"))?;
        Ok(bytes)
    }
    pub(crate) async fn exchange(&mut self, request: Value) -> Result<Value, Fault> {
        self.transfer(request, |bytes| {
            let value = visual_wire::decode(bytes)
                .map_err(|_| Fault::new("protocol", "Invalid visual reply"))?;
            if value["ok"] != true {
                return Err(script_fault(&value));
            }
            Ok(value)
        })
        .await
    }
    pub(crate) async fn drawing(
        &mut self,
        request: Value,
    ) -> Result<crate::visual_drawing::Drawing, Fault> {
        self.transfer(request, |bytes| {
            if bytes.starts_with(b"PV\x01") {
                let value = visual_wire::decode(bytes)
                    .map_err(|_| Fault::new("protocol", "Invalid drawing error reply"))?;
                return Err(script_fault(&value));
            }
            crate::visual_drawing::Drawing::decode(bytes)
                .map_err(|_| Fault::new("protocol", "Invalid drawing packet"))
        })
        .await
    }
    async fn transfer<T>(
        &mut self,
        request: Value,
        decode: impl FnOnce(&[u8]) -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let result = tokio::time::timeout(HARD, async {
            let bytes = serde_json::to_vec(&request)
                .map_err(|_| Fault::new("request", "Invalid visual request"))?;
            if bytes.len() > REQUEST_CAP {
                return Err(Fault::new("request", "Visual request exceeds 4 MiB"));
            }
            self.input
                .write_all(&(bytes.len() as u32).to_le_bytes())
                .await
                .map_err(|_| Fault::new("crashed", "Visual helper input closed"))?;
            self.input
                .write_all(&bytes)
                .await
                .map_err(|_| Fault::new("crashed", "Visual helper input closed"))?;
            self.input
                .flush()
                .await
                .map_err(|_| Fault::new("crashed", "Visual helper input closed"))?;
            let bytes = self.read_frame().await?;
            decode(&bytes)
        })
        .await
        .map_err(|_| {
            Fault::new(
                "timeout",
                "Visual helper exceeded its 2 second hard deadline",
            )
        })
        .and_then(|v| v);
        // Every failure discards the whole process, including partially-mutated state.
        if result.is_err() {
            self.stop().await;
        }
        result
    }
    pub(crate) async fn stop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.start_kill();
        }
        if matches!(
            tokio::time::timeout(Duration::from_secs(1), self.child.wait()).await,
            Ok(Ok(_))
        ) {
            self.permit.take();
        } else {
            TEARDOWN_FAILED.store(true, Ordering::Release);
            if let Some(permit) = self.permit.take() {
                permit.forget();
            }
        }
    }
}
fn script_fault(value: &Value) -> Fault {
    let e = &value["error"];
    let kind = match e["kind"].as_str() {
        Some("memory") => "memory",
        Some("timeout") => "timeout",
        Some("stack") => "stack",
        Some("script") => "script",
        _ => "result",
    };
    let mut message = e["message"]
        .as_str()
        .unwrap_or("The visual could not render")
        .chars()
        .take(1024)
        .collect::<String>();
    if message.is_empty() {
        message = "The visual could not render".into();
    }
    Fault {
        kind,
        message,
        line: e["line"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n > 0),
        limit: match kind {
            "memory" => Some(32 * 1024 * 1024),
            "stack" => Some(512 * 1024),
            _ => None,
        },
    }
}
#[cfg(target_os = "macos")]
fn verify_sandbox(pid: u32, path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    type Check =
        unsafe extern "C" fn(libc::pid_t, *const libc::c_char, libc::c_int, ...) -> libc::c_int;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe {
        let address = libc::dlsym(libc::RTLD_DEFAULT, c"sandbox_check".as_ptr());
        if address.is_null() {
            return false;
        }
        let check: Check = std::mem::transmute(address);
        check(pid as _, c"file-read-data".as_ptr(), 1, path.as_ptr()) > 0
    }
}
#[cfg(target_os = "linux")]
fn verify_sandbox(pid: u32, _: &Path) -> bool {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(format!("/proc/{pid}/status")) else {
        return false;
    };
    let mut value = String::new();
    if file.take(64 * 1024).read_to_string(&mut value).is_err() {
        return false;
    }
    value
        .lines()
        .any(|l| l.split_whitespace().eq(["Seccomp:", "2"]))
        && value
            .lines()
            .any(|l| l.split_whitespace().eq(["NoNewPrivs:", "1"]))
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn verify_sandbox(_: u32, _: &Path) -> bool {
    false
}
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn shared_draw_errors_match_without_relaxing_the_production_budget() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/fixtures/visual/conformance.json"
        ))
        .unwrap();
        let mut checked = 0;
        let mut overridden = 0;
        for case in corpus["errors"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c.get("draws").is_some())
        {
            let mut p = Process::start().await.unwrap();
            p.exchange(json!({"kind":"load","source":case["source"],"data":case["data"],"state":null,"seed":"","now":0})).await.unwrap();
            let mut error = None;
            for draw in case["draws"].as_array().unwrap() {
                let input = &draw["input"];
                if let Err(e)=p.drawing(json!({"kind":"draw","id":draw["id"],"width":input["width"],"height":input["height"],"t":input["t"],"pointer":input.get("pointer")})).await{error=Some(e);break;}
            }
            if error.is_none() {
                for event in case["events"].as_array().unwrap_or(&Vec::new()) {
                    if let Err(e) = p
                        .exchange(
                            json!({"kind":"event","id":event["id"],"value":event["value"],"now":0}),
                        )
                        .await
                    {
                        error = Some(e);
                        break;
                    }
                }
            }
            let e = error.expect("synthetic draw corpus must fail");
            let text = if let Some(line) = e.line {
                format!("line {line}: {}", e.message)
            } else {
                e.message.clone()
            };
            if case.get("drawMs").is_some() {
                overridden += 1;
                assert!(
                    text == case["error"].as_str().unwrap()
                        || (e.kind == "timeout"
                            && e.message == "the drawing took longer than 8 ms"),
                    "production8ms budget never increases to the fixture5000ms override: {}",
                    case["name"]
                );
            } else {
                assert_eq!(
                    text,
                    case["error"].as_str().unwrap(),
                    "synthetic draw failure: {}",
                    case["name"]
                );
                checked += 1;
            }
            assert!(p.child.try_wait().unwrap().is_some());
            p.stop().await;
        }
        assert_eq!(checked, 12);
        assert_eq!(overridden, 1);
    }
    #[tokio::test]
    async fn native_canvas_packets_match_shared_commands_ops_and_strings() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/fixtures/visual/conformance.json"
        ))
        .unwrap();
        let case = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c.get("drawings").is_some())
            .unwrap();
        let mut p = Process::start().await.unwrap();
        p.exchange(json!({"kind":"load","source":case["source"],"data":case["data"],"state":case.get("state"),"seed":case["id"],"now":case["now"]})).await.unwrap();
        for step in case["steps"].as_array().unwrap().iter().skip(1) {
            p.exchange(json!({"kind":"event","id":step["event"]["id"],"value":step["event"]["value"],"now":case["now"]})).await.unwrap();
        }
        for expected in case["drawings"].as_array().unwrap() {
            let input = &expected["input"];
            let drawing=p.drawing(json!({"kind":"draw","id":expected["id"],"width":input["width"],"height":input["height"],"t":input["t"],"pointer":input.get("pointer")})).await.unwrap();
            assert_eq!(
                drawing.commands,
                expected["commands"].as_u64().unwrap() as usize
            );
            assert_eq!(
                drawing.strings,
                expected["strings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned())
                    .collect::<Vec<_>>()
            );
            let ops = expected["ops"].as_array().unwrap();
            assert_eq!(drawing.ops.len(), ops.len());
            for (a, b) in drawing.ops.iter().zip(ops) {
                let b = b.as_f64().unwrap();
                assert!((a - b).abs() <= 1e-9 * b.abs().max(1.));
            }
        }
        p.stop().await;
    }
    #[tokio::test]
    async fn shared_api_one_view_event_and_state_corpus_matches_the_native_worker() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/fixtures/visual/conformance.json"
        ))
        .unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let mut p = Process::start().await.unwrap();
            let mut value=p.exchange(json!({"kind":"load","source":case["source"],"data":case["data"],"state":case.get("state"),"seed":case["id"],"now":case["now"]})).await.unwrap();
            for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
                if i > 0 {
                    value=p.exchange(json!({"kind":"event","id":step["event"]["id"],"value":step["event"]["value"],"now":case["now"]})).await.unwrap();
                    assert_eq!(
                        value["changed"], step["changed"],
                        "synthetic changed keys: {}",
                        case["name"]
                    );
                }
                assert_eq!(
                    value["tree"], step["tree"],
                    "synthetic tree: {}",
                    case["name"]
                );
                crate::visual_scene::Scene::parse(value["tree"].clone()).unwrap();
            }
            assert_eq!(
                value["state"], case["finalState"],
                "synthetic state: {}",
                case["name"]
            );
            p.stop().await;
        }
        let mut checked = 0;
        for case in corpus["errors"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c.get("draws").is_none())
        {
            let mut p = Process::start().await.unwrap();
            let mut result=p.exchange(json!({"kind":"load","source":case["source"],"data":case["data"],"state":null,"seed":"","now":0})).await;
            if result.is_ok() {
                for event in case["events"].as_array().unwrap_or(&Vec::new()) {
                    result = p
                        .exchange(
                            json!({"kind":"event","id":event["id"],"value":event["value"],"now":0}),
                        )
                        .await;
                    if result.is_err() {
                        break;
                    }
                }
            }
            let e = result.unwrap_err();
            let text = if let Some(line) = e.line {
                format!("line {line}: {}", e.message)
            } else {
                e.message
            };
            assert_eq!(
                text,
                case["error"].as_str().unwrap(),
                "synthetic error: {}",
                case["name"]
            );
            p.stop().await;
            checked += 1;
        }
        assert!(checked > 20);
    }
    fn load(source: &str, state: Option<&str>) -> Value {
        json!({"kind":"load","source":source,"data":null,"state":state,"seed":"synthetic","now":0})
    }
    #[tokio::test]
    async fn real_sandbox_load_event_and_oom_null_discard() {
        let mut p = Process::start().await.unwrap();
        let value=p.exchange(load("({ui,state})=>{const s=state({n:0});return()=>ui.column([ui.text(s.n),ui.toggle({label:'Synthetic',value:false,onChange:()=>s.n++})]);}",None)).await.unwrap();
        assert_eq!(value["state"], "[{\"n\":0}]");
        let changed = p
            .exchange(json!({"kind":"event","id":"0.1","value":false,"now":0}))
            .await
            .unwrap();
        assert_eq!(changed["state"], "[{\"n\":1}]");
        p.stop().await;
        let mut p = Process::start().await.unwrap();
        let error = p
            .exchange(load("()=>{throw null}", None))
            .await
            .unwrap_err();
        assert_eq!(error.kind, "memory");
        assert_eq!(error.limit, Some(32 * 1024 * 1024));
        assert_eq!(error.line, None);
        assert!(p.child.try_wait().unwrap().is_some());
    }
    #[tokio::test]
    async fn stopped_owned_worker_hits_parent_hard_deadline_and_is_killed_reaped() {
        let mut p = Process::start().await.unwrap();
        let pid = p.child.id().unwrap();
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGSTOP) }, 0);
        let error=p.exchange(json!({"kind":"load","source":"({ui})=>ui.text('Synthetic')","data":null,"state":null,"seed":"synthetic","now":0})).await.unwrap_err();
        assert_eq!(error.kind, "timeout");
        assert!(p.child.try_wait().unwrap().is_some());
        let mut fresh = Process::start().await.unwrap();
        assert!(fresh.exchange(json!({"kind":"load","source":"({ui})=>ui.text('Fresh')","data":null,"state":null,"seed":"synthetic","now":0})).await.is_ok());
        fresh.stop().await;
    }
}

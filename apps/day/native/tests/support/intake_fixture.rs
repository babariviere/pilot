// Released JSON bridge, private ledger and isolated real daemon, no visible windows/providers.
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use pilot_day_native::{
    bridge::{Bridge, METHODS, restrict},
    host::{Error, NativeHost, Source},
    root::DayRoot,
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};
const WAIT: Duration = Duration::from_secs(30);
struct Fixture {
    child: Child,
    input: ChildStdin,
    output: mpsc::Receiver<Value>,
    info: Value,
    dir: PathBuf,
}
impl Fixture {
    #[allow(dead_code)] // Shared by integration targets that use different entry points.
    fn new() -> Self {
        Self::with_daemon("day-intake.ts")
    }
    fn with_daemon(fixture: &str) -> Self {
        let mut child = Command::new("node")
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../packages/daemon/src/fixtures")
                    .join(fixture),
            )
            .env_remove("NODE_TEST_CONTEXT")
            .env_remove("PILOT_HOME")
            .env_remove("PILOT_PORT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for l in BufReader::new(stdout).lines() {
                let Ok(l) = l else { break };
                if let Ok(v) = serde_json::from_str(&l)
                    && tx.send(v).is_err()
                {
                    break;
                }
            }
        });
        let info = output.recv_timeout(WAIT).unwrap();
        let dir = std::env::temp_dir().join(format!("intake-bridge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(
            dir.join("nsh.json"),
            json!({"name":"Intake fixture","id":"test.intake","capabilities":{"host":METHODS}})
                .to_string(),
        )
        .unwrap();
        Self {
            child,
            input,
            output,
            info,
            dir,
        }
    }
    fn stats(&mut self, action: &str) -> Value {
        writeln!(self.input, "{}", json!({"action":action})).unwrap();
        self.input.flush().unwrap();
        self.output.recv_timeout(WAIT).unwrap()
    }
    fn host(&self) -> NativeHost {
        let source: Source = serde_json::from_value(self.info["source"].clone()).unwrap();
        self.host_for(source)
    }
    fn host_for(&self, source: Source) -> NativeHost {
        self.host_for_options(source, Default::default())
    }
    fn host_for_options(
        &self,
        source: Source,
        options: pilot_day_native::host::Options,
    ) -> NativeHost {
        let host = NativeHost::open_with_options(
            source,
            self.info["ledger"].as_str().unwrap().into(),
            options,
        )
        .unwrap();
        let events = host.changes();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                tokio::time::timeout(WAIT, async {
                    while host.snapshot().freshness.state != pilot_day_native::FreshnessState::Live
                    {
                        events.recv().await.unwrap();
                    }
                })
                .await
                .unwrap();
            });
        host
    }
    fn bridge(&self) -> Bridge {
        Bridge::new(DayRoot::new(self.host()))
    }
    fn call(&self, bridge: &Bridge, name: &str, args: Value) -> Value {
        let source = format!(
            r#"import {{host, mount, signal, Text}} from 'nsh'; const result=signal('waiting'); mount(()=> <Text>{{result()}}</Text>);
setTimeout(()=>{{ host.call({name},{{version:1,window:host.params.day.window,args:{args}}},{{timeout:0}}).then(r=>result.set('result:'+JSON.stringify(r)),e=>result.set('result:'+JSON.stringify({{error:String(e)}}))); }},0);"#,
            name = json!(name)
        );
        self.eval(bridge, &source)
    }
    fn eval(&self, bridge: &Bridge, source: &str) -> Value {
        let path = self.dir.join("Call.tsx");
        std::fs::write(&path, source).unwrap();
        let bundle = restrict(compile_tsx(&path, &[]).unwrap()).unwrap();
        let mut config = EngineConfig::new(bundle);
        config.host = bridge.channel();
        let mut app = Headless::start(config).unwrap();
        app.wait_until("intake reply", WAIT, |s| {
            s.texts().iter().any(|s| s.starts_with("result:"))
        })
        .unwrap();
        let text = app
            .screen()
            .texts()
            .into_iter()
            .find(|s| s.starts_with("result:"))
            .unwrap();
        serde_json::from_str(text.strip_prefix("result:").unwrap()).unwrap()
    }
    #[allow(dead_code)] // Delivery tests use the same daemon/channel helper without intake reads.
    fn read(&self, bridge: &Bridge) -> Value {
        let result = self.call(bridge, "day.intake.read", json!({}));
        assert!(
            result["value"]["snapshot"]["sources"].is_array(),
            "{result}"
        );
        result["value"]["snapshot"].clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = writeln!(self.input, "{}", json!({"action":"quit"}));
        let _ = self.input.flush();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn close(bridge: Bridge) {
    let rx = bridge.close();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            assert_eq!(
                tokio::time::timeout(WAIT, rx.recv()).await.unwrap(),
                Ok(Ok::<_, Error>(()))
            );
        });
}

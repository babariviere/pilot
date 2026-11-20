//! Calls one root's released JSON bridge from Rust, as TSX does, through one
//! headless engine. No visible window, provider or real account.
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use pilot_day_native::{
    bridge::{Bridge, METHODS, restrict},
    host::{Error, NativeHost},
    root::DayRoot,
};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};

const APP: &str = r#"import { host, mount, signal, Text } from "nsh";
const results = signal({});
mount(() => <Text>{"results:" + JSON.stringify(results())}</Text>);
host.on("test.call", (p) => {
	const done = (r) => results.set({ ...results(), [p.id]: r });
	host
		.call(p.name, { version: 1, window: host.params.day.window, args: p.args }, { timeout: 0 })
		.then(done, (e) => done({ thrown: String(e.code ?? e) }));
});
"#;

pub struct Calls {
    bridge: Option<Bridge>,
    app: Option<Headless>,
    next: u64,
    dir: PathBuf,
}

#[allow(dead_code)] // Each test target uses the part it needs.
impl Calls {
    pub fn new(host: NativeHost) -> Self {
        let bridge = Bridge::new(DayRoot::new(host));
        let dir = std::env::temp_dir().join(format!("day-bridge-calls-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(
            dir.join("nsh.json"),
            json!({"name":"Bridge calls","id":"test.bridge.calls","capabilities":{"host":METHODS}})
                .to_string(),
        )
        .unwrap();
        let path = dir.join("Calls.tsx");
        std::fs::write(&path, APP).unwrap();
        let mut config = EngineConfig::new(restrict(compile_tsx(&path, &[]).unwrap()).unwrap());
        config.host = bridge.channel();
        let app = Headless::start(config).unwrap();
        Self {
            bridge: Some(bridge),
            app: Some(app),
            next: 0,
            dir,
        }
    }

    pub fn bridge(&self) -> &Bridge {
        self.bridge.as_ref().unwrap()
    }

    /// Sends one call and returns its id without waiting for the reply.
    pub fn start(&mut self, name: &str, args: Value) -> u64 {
        self.next += 1;
        self.bridge()
            .channel()
            .send(
                "test.call",
                json!({"id":self.next.to_string(),"name":name,"args":args}),
            )
            .unwrap();
        self.next
    }

    /// The reply of a started call: the bridge's `{version, value}` or `{version, error}`.
    pub fn wait(&mut self, id: u64) -> Value {
        let key = id.to_string();
        let app = self.app.as_mut().unwrap();
        app.wait_until("bridge reply", Duration::from_secs(90), |s| {
            s.texts().iter().any(|t| {
                t.strip_prefix("results:")
                    .and_then(|r| serde_json::from_str::<Value>(r).ok())
                    .is_some_and(|r| r.get(&key).is_some())
            })
        })
        .unwrap();
        app.screen()
            .texts()
            .iter()
            .find_map(|t| t.strip_prefix("results:"))
            .and_then(|r| serde_json::from_str::<Value>(r).ok())
            .unwrap()[&key]
            .clone()
    }

    pub fn call(&mut self, name: &str, args: Value) -> Value {
        let id = self.start(name, args);
        self.wait(id)
    }

    /// The call's outcome, or its refusal code as `{"error": code}`.
    pub fn outcome(&mut self, name: &str, args: Value) -> Value {
        let reply = self.call(name, args);
        if reply["error"].is_string() {
            return json!({"error":reply["error"]});
        }
        reply["value"]["outcome"].clone()
    }

    /// Stops the engine, then joins the root, as the native owner does.
    pub fn close(mut self) -> Result<(), Error> {
        self.app.take();
        let bridge = self.bridge.take().unwrap();
        bridge.close().recv_blocking().map_err(|_| Error::Unknown)?
    }
}

impl Drop for Calls {
    fn drop(&mut self) {
        self.app.take();
        if let Some(bridge) = self.bridge.take() {
            let _ = bridge.close().recv_blocking();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

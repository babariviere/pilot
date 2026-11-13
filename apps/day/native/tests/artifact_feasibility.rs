//! Isolated upstream feasibility probes. No production bridge or artifact reader is installed.
#![cfg(target_os = "macos")]

use std::{
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{Mutex, mpsc},
    time::Duration,
};

use nsh_core::{ApproxTextEngine, MountBatch, access::Capabilities, platform::Os};
use nsh_engine::{AppError, Bundle, Engine, EngineConfig, Limits, MountSink, Policy};
use nsh_testing::{Headless, compile_tsx};

const DEADLINE: Duration = Duration::from_secs(5);

// A regression in the VM's own interrupt/drop must not hang the test host.
// This supervisor is test infrastructure, NOT a production artifact sandbox.
fn supervised() -> bool {
    let name = std::thread::current()
        .name()
        .expect("named test")
        .to_owned();
    if std::env::var("NSH_FEASIBILITY_CHILD").as_deref() == Ok(name.as_str()) {
        return false;
    }
    let temp = Temp::new();
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &name, "--nocapture"])
        .env("NSH_FEASIBILITY_CHILD", &name)
        .env("NSH_FEASIBILITY_TMP", &temp.0)
        .process_group(0)
        .spawn()
        .unwrap();
    struct Owned(Option<Child>);
    impl Drop for Owned {
        fn drop(&mut self) {
            if let Some(child) = &mut self.0 {
                // SAFETY: this is the private process group created above. The
                // unreaped child owns its PID until wait, even if it has exited.
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.wait();
            }
        }
    }
    let mut child = Owned(Some(child));
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.0.as_mut().unwrap().try_wait().unwrap() {
            // try_wait already reaped it: do not signal a reusable PID.
            child.0 = None;
            assert!(status.success(), "isolated probe {name}: {status}");
            return true;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "isolated probe {name} timed out"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn isolated(bundle: Bundle) -> EngineConfig {
    let bundle = bundle.with_policy(Policy {
        harden: true,
        declared: Some(Capabilities::default()),
        granted: Some(Capabilities::default()),
    });
    let mut config = EngineConfig::new(bundle);
    config.environment.os = Os::MacOs;
    config.limits = Limits {
        memory_bytes: 16 << 20,
        stack_bytes: 512 << 10,
        load_budget: Duration::from_millis(250),
        call_budget: Duration::from_millis(100),
        max_op_values: 4096,
        max_canvas_ops: 1024,
        max_nodes: 256,
    };
    // No Day registry, host channel, filesystem, network, assets, storage or credentials.
    config
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/artifact-feasibility")
        .join(name)
}

struct Errors(Mutex<mpsc::Sender<AppError>>);

impl MountSink for Errors {
    fn submit(&self, _batch: MountBatch) {}

    fn report(&self, error: &AppError) {
        let _ = self.0.lock().unwrap().send(error.clone());
    }
}

fn failure(source: &str) -> AppError {
    failure_matching(source, |_| true)
}

fn failure_matching(source: &str, matches: impl Fn(&AppError) -> bool) -> AppError {
    let (tx, rx) = mpsc::channel();
    let engine = Engine::start(
        isolated(Bundle::source(source.to_owned())),
        || ApproxTextEngine,
        Errors(Mutex::new(tx)),
    )
    .unwrap();
    let deadline = std::time::Instant::now() + DEADLINE;
    let mut observed = Vec::new();
    let result = loop {
        let error = rx
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .unwrap_or_else(|error| {
                panic!("VM failure for {source}: {error}; observed: {observed:?}")
            });
        eprintln!("probe failure: {error:?}");
        if matches(&error) {
            break error;
        }
        if observed.len() < 16 {
            observed.push(error);
        }
    };
    drop(engine); // joins the engine, including an interrupted script
    result
}

#[test]
fn tsx_local_controls_comparison_and_reopen_reset() {
    if supervised() {
        return;
    }
    let bundle = compile_tsx(fixture("Example.tsx"), &[nsh_base::registry()]).unwrap();
    let mut retired: Option<(nsh_engine::EngineControl, nsh_core::NodeId)> = None;
    for _ in 0..2 {
        let mut config = isolated(bundle.clone());
        config.ui_sets = vec![nsh_base::registry()];
        let mut app = Headless::start(config).unwrap();
        app.wait_for("Count: 0").unwrap();
        if let Some((control, target)) = &retired {
            control.dispatch_event(
                *target,
                nsh_core::EventKind::Press,
                nsh_core::EventPayload::None,
            );
            app.wait(Duration::from_millis(20)).unwrap();
            assert!(
                app.shows("Count: 0"),
                "old handler must not affect the new VM"
            );
        }
        app.press("role:button[Try]").unwrap();
        app.wait_for("Count: 1").unwrap();
        app.press("role:button[Compare]").unwrap();
        app.wait_for("Map").unwrap();
        retired = Some((
            app.engine().control(),
            app.screen()
                .press_target("role:button[Try]")
                .unwrap()
                .unwrap(),
        ));
        let (engine, _) = app.into_parts();
        drop(engine);
    }
}

#[test]
fn dropping_an_engine_cancels_pending_spinning_work() {
    if supervised() {
        return;
    }
    let (tx, rx) = mpsc::channel();
    let source =
        "setTimeout(() => { throw Error('armed'); }, 0); setTimeout(() => { while(true){} }, 1);";
    let mut config = isolated(Bundle::source(source.to_owned()));
    // The stop flag, not the ordinary 100 ms budget, must end this engine.
    config.limits.call_budget = Duration::from_secs(10);
    let engine = Engine::start(config, || ApproxTextEngine, Errors(Mutex::new(tx))).unwrap();
    assert!(rx.recv_timeout(DEADLINE).unwrap().message.contains("armed"));
    let started = std::time::Instant::now();
    drop(engine);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "drop must join without waiting for the call budget"
    );
}

#[test]
fn deny_policy_checks_calls_not_just_absent_services() {
    if supervised() {
        return;
    }
    let source = r#"
        import {mount, host, Text} from 'nsh';
        import {readFile} from 'fs/promises';
        import process from 'process';
        const results = [];
        async function denied(label, call) {
            try { await call(); results.push(label + ':ALLOWED'); }
            catch(e) { results.push(label + ':' + e.code); }
        }
        Promise.all([
            denied('fs', () => readFile('/not-an-artifact-file')),
            denied('network', () => fetch('https://artifact.invalid/')),
            denied('process', () => process.run('/not-an-artifact-command')),
            denied('exit', () => process.exit()),
            denied('host', () => host.call('day.connection.open', {})),
            denied('global-process', () => globalThis.process.spawn('/not-an-artifact-command')),
        ]).then(() => { mount(() => Text({children: results.sort().join('|')})); });
    "#;
    for (host_available, host_result) in [
        (false, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"),
        (true, "ERR_ACCESS_DENIED"),
    ] {
        let mut config = isolated(Bundle::source(source.to_owned()));
        // Advertise a host only. Never install a Day handler or real channel.
        config.environment.host = host_available;
        let mut app = Headless::start(config).unwrap();
        app.wait_for(&format!("text:exit:ERR_ACCESS_DENIED|fs:ERR_ACCESS_DENIED|global-process:ERR_ACCESS_DENIED|host:{host_result}|network:ERR_ACCESS_DENIED|process:ERR_ACCESS_DENIED")).unwrap();
    }
}

#[test]
fn load_and_timer_loops_are_interrupted_even_inside_catch() {
    if supervised() {
        return;
    }
    for source in [
        "while (true) { try { while (true) {} } catch (_) {} }",
        "setTimeout(() => { while (true) {} }, 0)",
    ] {
        let error = failure(source);
        assert!(error.message.contains("budget"), "{error:?}");
    }
}

#[test]
fn growing_promise_chain_hits_heap_or_time_limit() {
    if supervised() {
        return;
    }
    let source =
        "Promise.resolve().then(function again() { return Promise.resolve().then(again) })";
    // The chain holds promises. Heap exhaustion can precede the time limit;
    // its initial Uncaught diagnostic is not the engine's Stopped report.
    let error = failure_matching(source, |error| {
        error.is_stopped() || error.message.contains("budget")
    });
    assert!(
        error.message.contains("budget") || error.message.contains("out of memory"),
        "{error:?}"
    );
}

#[test]
fn heap_and_op_exhaustion_stop_the_vm() {
    if supervised() {
        return;
    }
    for (source, reason) in [
        (
            "const held = []; for (;;) held.push(new Array(100000).fill(1));",
            "out of memory",
        ),
        (
            "import {text} from 'nsh:rt'; for (let n=0;n<10000;n++) text('x');",
            "4096 changes",
        ),
        (
            "import {text} from 'nsh:rt'; for (let n=0;n<300;n++) text('x');",
            "256 nodes",
        ),
    ] {
        let error = failure_matching(source, AppError::is_stopped);
        assert!(error.message.contains(reason), "{error:?}");
    }
}

#[test]
fn malformed_source_unknown_exports_and_native_reach_through_fail() {
    if supervised() {
        return;
    }
    for source in [
        "export const broken = ;",
        "import {NotAnExport} from 'nsh';",
        "import {Bridge} from 'pilot-day/native';",
        "import 'file:///not-an-artifact-module.js';",
        "import 'https://artifact.invalid/module.js';",
    ] {
        let error = failure(source);
        assert!(error.is_fatal(), "{source}: {error:?}");
    }
}

#[test]
fn production_hardening_blocks_string_code_constructors() {
    if supervised() {
        return;
    }
    for source in [
        "Function('return 1')()",
        "(async function(){}).constructor('return 1')()",
        "(function*(){}).constructor('yield 1')()",
    ] {
        let error = failure(source);
        assert!(error.message.contains("disabled"), "{error:?}");
    }
}

#[test]
fn shader_validation_does_not_impose_a_gpu_execution_budget() {
    if supervised() {
        return;
    }
    use nsh_core::shader::{MAX_SOURCE_BYTES, Shader};
    assert!(Shader::compile(&" ".repeat(MAX_SOURCE_BYTES + 1)).is_err());
    assert!(Shader::compile("fn shade(uv: vec2f) -> vec4f { return 1.0; }").is_err());
    // Validate only. Never submit this expensive program to a GPU.
    let expensive = "fn shade(uv: vec2f) -> vec4f { var i = 0u; loop { i += 1u; if (i == 4000000000u) { break; } } return vec4f(f32(i)); }";
    assert!(
        Shader::compile(expensive).is_ok(),
        "valid WGSL is not a work quota"
    );
}

#[test]
fn deny_capabilities_are_not_a_per_artifact_shader_gate() {
    if supervised() {
        return;
    }
    struct Layers(Mutex<mpsc::Sender<bool>>);
    impl MountSink for Layers {
        fn submit(&self, batch: MountBatch) {
            for item in batch.items {
                if let nsh_core::MountItem::Shader {
                    layer: Some(layer), ..
                } = item
                {
                    let _ = self.0.lock().unwrap().send(
                        layer
                            .shader
                            .inputs()
                            .contains(nsh_core::shader::ShaderInput::Backdrop),
                    );
                }
            }
        }
    }
    let temp = Temp::new();
    let entry = temp.0.join("App.tsx");
    std::fs::write(temp.0.join("nsh.json"), r#"{"capabilities":{}}"#).unwrap();
    std::fs::write(&entry, r#"import {mount, Shader} from 'nsh';
        mount(() => <Shader source="fn shade(uv: vec2f) -> vec4f { return sample_backdrop(uv); }" />);"#).unwrap();
    let bundle = compile_tsx(&entry, &[]).unwrap();
    let (tx, rx) = mpsc::channel();
    let engine = Engine::start(
        isolated(bundle),
        || ApproxTextEngine,
        Layers(Mutex::new(tx)),
    )
    .unwrap();
    assert!(
        rx.recv_timeout(DEADLINE)
            .expect("compiled layer, no GPU renderer installed")
    );
    drop(engine);
}

#[test]
fn frozen_compilation_and_retired_engine_handles_do_not_follow_source_edits() {
    if supervised() {
        return;
    }
    let temp = Temp::new();
    let entry = temp.0.join("App.tsx");
    std::fs::write(temp.0.join("nsh.json"), r#"{"capabilities":{}}"#).unwrap();
    let source =
        |label| format!("import {{mount,Text}} from 'nsh'; mount(() => <Text>{label}</Text>);");
    std::fs::write(&entry, source("first")).unwrap();
    let first = compile_tsx(&entry, &[]).unwrap();
    std::fs::write(&entry, source("second")).unwrap();
    let second = compile_tsx(&entry, &[]).unwrap();
    let mut old = Headless::start(isolated(first.clone())).unwrap();
    old.wait_for("first").unwrap();
    let retired = old.engine().control();
    let (engine, _) = old.into_parts();
    drop(engine);
    let mut new = Headless::start(isolated(second)).unwrap();
    retired.hot_update(nsh_engine::HotUpdate {
        name: "stale.js".into(),
        code: "throw Error('stale callback ran')".into(),
        source_map: None,
    });
    new.wait_for("second").unwrap();
    let mut reopened = Headless::start(isolated(first)).unwrap();
    reopened.wait_for("first").unwrap();
}

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let root =
            std::env::var_os("NSH_FEASIBILITY_TMP").map_or_else(std::env::temp_dir, PathBuf::from);
        let path = root.join(format!("nsh-artifact-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn compiler_is_not_a_captured_bundle_filesystem_boundary() {
    if supervised() {
        return;
    }
    let temp = Temp::new();
    let root = temp.0.join("capture");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("nsh.json"), r#"{"capabilities":{}}"#).unwrap();
    // Harmless owned canary outside the proposed capture root, never a user file.
    std::fs::write(temp.0.join("outside.ts"), "export const value = 'outside';").unwrap();
    let entry = root.join("Entry.tsx");
    std::fs::write(
        &entry,
        "import {value} from '../outside'; globalThis.canary = value;",
    )
    .unwrap();
    assert!(
        compile_tsx(&entry, &[]).is_ok(),
        "upstream follows a parent import"
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(temp.0.join("outside.ts"), root.join("linked.ts")).unwrap();
        std::fs::write(&entry, "export {value} from './linked';").unwrap();
        assert!(
            compile_tsx(&entry, &[]).is_ok(),
            "upstream follows a symlink re-export"
        );
    }
    std::fs::write(&entry, "import './missing';").unwrap();
    assert!(
        compile_tsx(&entry, &[]).is_err(),
        "missing import must fail compilation"
    );
    std::fs::write(&entry, "const broken = <View>;").unwrap();
    let error = compile_tsx(&entry, &[]).unwrap_err();
    assert!(
        error.contains("Entry.tsx"),
        "compile diagnostic must name the source: {error}"
    );
}

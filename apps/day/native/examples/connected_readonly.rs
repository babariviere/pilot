//! Explicit read-only real-host integration check, not signed/native acceptance.
//! No daemon discovery/start, model selection, provider send or domain write.
use nsh_core::prelude::*;
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use pilot_day_native::{
    bridge::{Bridge, METHODS, restrict},
    host::{Error, NativeHost, Options, Source},
    model::FreshnessState,
    root::DayRoot,
};
use serde_json::json;
use std::{
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const WAIT: Duration = Duration::from_secs(45);
// A second, narrower VM grant makes any accidental domain write impossible.
// flush.ack writes only this check's private local window journal.
const READS: &[&str] = &[
    "day.projects.read",
    "day.today.read",
    "day.mission.read",
    "day.plan.read",
    "day.plan.snapshot",
    "day.plan.inventory",
    "day.plan.inventorySnapshot",
    "day.plan.prepare",
    "day.attention.read",
    "day.intake.read",
    "day.linear.read",
    "day.delivery.read",
    "day.delivery.saved",
    "day.window.read",
    "day.update.read",
    "day.ritual.read",
    "day.ritual.snapshot",
    "day.ritual.results",
    "day.flush.ack",
];

fn receive<T>(
    rx: async_channel::Receiver<Result<T, Error>>,
) -> Result<T, Box<dyn std::error::Error>> {
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async { tokio::time::timeout(WAIT, rx.recv()).await })???)
}

fn entry(directory: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for item in std::fs::read_dir(app)? {
        let path = item?.path();
        let name = path
            .file_name()
            .ok_or("missing source name")?
            .to_string_lossy();
        if ((name.ends_with(".ts") || name.ends_with(".tsx")) && !name.ends_with(".test.tsx"))
            || name == "theme.json"
        {
            std::fs::copy(&path, directory.join(name.as_ref()))?;
        }
    }
    std::fs::write(
        directory.join("nsh.json"),
        json!({"name":"Read-only host check",
        "id":"dev.pilot.day.readonly-check", "theme":"theme.json", "capabilities":{"host":METHODS}})
        .to_string(),
    )?;
    Ok(directory.join("Connected.tsx"))
}

fn open(entry: &Path, bridge: &Bridge) -> Result<Headless, Box<dyn std::error::Error>> {
    let sets = vec![nsh_base::registry(), pilot_day_native::registry()];
    let mut bundle = restrict(compile_tsx(entry, &sets)?)?;
    bundle.policy.granted = Some(nsh_engine::parse_capabilities(
        &json!({"host":READS}).to_string(),
    )?);
    assert!(!bundle.policy.access().allows_host("day.plan.create"));
    assert!(!bundle.policy.access().allows_host("day.plan.submit"));
    assert!(!bundle.policy.access().allows_host("day.plan.startWork"));
    assert!(!bundle.policy.access().allows_host("day.intake.start"));
    assert!(!bundle.policy.access().allows_host("day.attention.reply"));
    assert!(!bundle.policy.access().allows_host("day.delivery.done"));
    Ok(Headless::start(EngineConfig {
        ui_sets: sets,
        viewport: Size::new(Points(1100.0), Points(18000.0)),
        host: bridge.channel(),
        ..EngineConfig::new(bundle)
    })?)
}

fn selected(source: &Source, journal: &Path) -> Result<(NativeHost, Bridge), Error> {
    let host = NativeHost::open_with_options(
        source.clone(),
        journal.into(),
        Options {
            day: Some(pilot_day_native::host::ritual::DaySource::system()),
            ..Default::default()
        },
    )?;
    let bridge = Bridge::new(DayRoot::new(host.clone()));
    Ok((host, bridge))
}

fn flush(app: &mut Headless, bridge: &Bridge) -> Result<(), Box<dyn std::error::Error>> {
    let generation = bridge.request_flush()?;
    // Headless has no native editor/preedit. This checks only the actual TSX
    // form ACK and private saved-view journal, not an AppKit capture receipt.
    bridge.native_capture_finished(generation)?;
    let end = Instant::now() + WAIT;
    while !bridge.flush_ready(generation) {
        if Instant::now() >= end {
            return Err("read-only form flush timed out".into());
        }
        app.wait(Duration::from_millis(25))?;
    }
    bridge.seal_flush(generation)?;
    Ok(())
}

fn round(
    source: &Source,
    journal: &Path,
    entry: &Path,
    check: impl FnOnce(&NativeHost, &mut Headless) -> Result<(), Box<dyn std::error::Error>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let (host, bridge) = selected(source, journal)?;
    let mut app = None;
    let result = (|| {
        let changes = host.changes();
        // The control stream's initial hello invalidates a pre-stream read.
        // Wait for the native owner's event-driven refresh, never poll or retry
        // an effect and never pretend that a disconnected read is current.
        match receive(host.refresh()) {
            Err(error) if error.downcast_ref::<Error>() == Some(&Error::Stale) => {}
            result => {
                result?;
            }
        }
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(async {
                tokio::time::timeout(WAIT, async {
                    while host.snapshot().freshness.state != FreshnessState::Live {
                        changes.recv().await?;
                    }
                    Ok::<_, async_channel::RecvError>(())
                })
                .await
            })??;
        app = Some(open(entry, &bridge)?);
        let shown = app.as_mut().ok_or("connected engine missing")?;
        check(&host, shown)?;
        flush(shown, &bridge)
    })();
    // Always join entered native I/O before dropping the engine or removing
    // this check's private journal, including after a failed assertion/read.
    let closed = receive(bridge.close());
    drop(app);
    result?;
    closed?;
    Ok(())
}

fn run(source: Source, mission: &str, directory: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let entry = entry(directory)?;
    let journal = directory.join("window-journal");
    round(&source, &journal, &entry, |host, app| {
        app.wait_for_within("role:button[New]", WAIT)?;
        let row = format!("id:mission-{mission}");
        app.wait_for_within(&row, WAIT)?;
        app.press(&row)?;
        app.wait_for_within("role:button[Back to Today]", WAIT)?;
        if host.mission(mission).is_none() {
            return Err("exact mission detail was not read".into());
        }
        Ok(())
    })?;
    println!("PASS real-host Today and exact mission navigation; private form capture joined");

    let draft = "  Read-only integration check. Do not send. 👩🏽‍💻\nexact draft  ";
    round(&source, &journal, &entry, |host, app| {
        app.wait_for_within("role:button[Back to Today]", WAIT)?;
        if host
            .saved_window()
            .is_none_or(|s| s.source != source || s.view["id"] != mission)
        {
            return Err("ordinary reopen lost exact mission selection".into());
        }
        app.press("role:button[Back to Today]")?;
        app.wait_for_within("role:button[New]", WAIT)?;
        app.press("role:button[New]")?;
        app.wait_for_within("id:goal", WAIT)?;
        app.type_text("id:goal", draft)?;
        Ok(())
    })?;
    println!("PASS cold mission reopen and unsent New draft capture; no domain writes granted");

    round(&source, &journal, &entry, |_, app| {
        app.wait_for_within("id:goal", WAIT)?;
        if app.screen().input_text("id:goal")? != Some(draft) {
            return Err("cold reopen changed unsent draft bytes".into());
        }
        Ok(())
    })?;
    println!(
        "PASS real-host cold reopen preserves exact unsent draft; no provider/work/update effects"
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 || args[0] != "--source" || args[2] != "--mission" {
        return Err("Usage: connected_readonly --source ABSOLUTE_NATIVE_SOURCE_JSON --mission EXACT_MISSION_ID".into());
    }
    let source_path = PathBuf::from(&args[1]);
    if !source_path.is_absolute() || std::fs::metadata(&source_path)?.len() > 4096 {
        return Err("select a small absolute native Source JSON file explicitly".into());
    }
    let source: Source = serde_json::from_slice(&std::fs::read(source_path)?)?;
    let mission = args[3].to_str().ok_or("mission must be UTF-8")?;
    if mission.is_empty()
        || mission.len() > 128
        || !mission
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("invalid exact mission ID".into());
    }
    let directory =
        std::env::temp_dir().join(format!("day-connected-readonly-{}", uuid::Uuid::new_v4()));
    std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let result = run(source, mission, &directory);
    // This removes only this check's own temporary sources/cache/journal.
    if result.is_ok() {
        let _ = std::fs::remove_dir_all(directory);
    } else {
        eprintln!(
            "Failed check's private files preserved until native join is confirmed: {}",
            directory.display()
        );
    }
    result
}

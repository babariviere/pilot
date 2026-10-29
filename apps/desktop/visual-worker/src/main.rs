//! Separate native engine process. No app libraries, host bridge, inherited environment or source before sandbox.
mod engine;
mod isolation;
mod watchdog;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    os::unix::ffi::OsStrExt,
};
const REQUEST_CAP: usize = 4 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pointer {
    x: f64,
    y: f64,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Load {
        source: String,
        data: Value,
        state: Option<String>,
        seed: String,
        now: f64,
    },
    Event {
        id: String,
        value: Value,
        now: f64,
    },
    Draw {
        id: String,
        width: f64,
        height: f64,
        t: f64,
        pointer: Option<Pointer>,
    },
}
fn write_frame(bytes: &[u8]) -> Result<(), ()> {
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(());
    }
    let mut out = std::io::stdout().lock();
    out.write_all(&(bytes.len() as u32).to_le_bytes())
        .map_err(|_| ())?;
    out.write_all(bytes).map_err(|_| ())?;
    out.flush().map_err(|_| ())
}
fn read_request() -> Result<Option<Request>, ()> {
    let mut input = std::io::stdin().lock();
    let mut size = [0; 4];
    match input.read_exact(&mut size) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(_) => return Err(()),
    };
    let size = u32::from_le_bytes(size) as usize;
    if size > REQUEST_CAP {
        return Err(());
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes).map_err(|_| ())?;
    serde_json::from_slice(&bytes).map(Some).map_err(|_| ())
}
fn run() -> Result<(), ()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let port = match args.as_slice() {
        [flag, port] if flag == "--probe-port" => {
            port.parse::<u16>().ok().filter(|p| *p > 0).ok_or(())?
        }
        _ => return Err(()),
    };
    let executable = std::ffi::CString::new(
        std::env::current_exe()
            .map_err(|_| ())?
            .as_os_str()
            .as_bytes(),
    )
    .map_err(|_| ())?;
    let hash = Sha256::digest(engine::RUNTIME)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    isolation::prepare()?;
    // Trusted intrinsics only, no runtime.js or user source has been evaluated yet.
    let mut engine = engine::Engine::new().ok_or(())?;
    let watchdog = watchdog::Watchdog::new()?;
    isolation::install()?;
    if !isolation::probes(&executable, port) {
        return Err(());
    }
    let hello = json!({"protocol":1,"pid":std::process::id(),"engine":engine::Engine::version(),"runtimeHash":hash,"sandbox":true});
    write_frame(&serde_json::to_vec(&hello).map_err(|_| ())?)?;
    while let Some(request) = read_request()? {
        watchdog.begin();
        let result = match request {
            Request::Load {
                source,
                data,
                state,
                seed,
                now,
            } => {
                let data = serde_json::to_string(&data).map_err(|_| ())?;
                if source.len() > 256 * 1024
                    || data.len() > 1024 * 1024
                    || seed.len() > 128
                    || !now.is_finite()
                {
                    return Err(());
                }
                if let Some(state) = &state
                    && (state.encode_utf16().count() > 64 * 1024
                        || !serde_json::from_str::<Value>(state)
                            .map_err(|_| ())?
                            .is_array())
                {
                    return Err(());
                }
                engine.load(&source, &data, state.as_deref(), &seed, now)?
            }
            Request::Event { id, value, now } => {
                if id.len() > 256 || !now.is_finite() {
                    return Err(());
                }
                let value = serde_json::to_string(&value).map_err(|_| ())?;
                if value.len() > 4096 {
                    return Err(());
                }
                engine.event(&id, &value, now)?
            }
            Request::Draw {
                id,
                width,
                height,
                t,
                pointer,
            } => {
                if id.len() > 256
                    || !(1. ..=2000.).contains(&width)
                    || !(24. ..=600.).contains(&height)
                    || !t.is_finite()
                    || t < 0.
                    || pointer.as_ref().is_some_and(|p| {
                        !p.x.is_finite() || !p.y.is_finite() || p.x.abs() > 1e6 || p.y.abs() > 1e6
                    })
                {
                    return Err(());
                }
                engine.draw(&id, width, height, t, pointer.map(|p| (p.x, p.y)))?
            }
        };
        write_frame(&result.1)?;
        watchdog.finish();
        // Never reuse a VM that threw, interrupted, OOMed, overflowed or failed its view.
        if !result.0 {
            return Err(());
        }
    }
    Ok(())
}
fn main() {
    if run().is_err() {
        std::process::exit(1);
    }
}

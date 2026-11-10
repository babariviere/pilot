//! Public release-supported macOS wiring, for isolated qualification only.
//!
//! This is not the production close/update owner: stock `run_app` cannot
//! capture native preedit and every form before its close/Quit stops the VM.
//! No default entry point calls this module. Native/visible acceptance and
//! live activation remain separate gates.
use nsh_engine::Bundle;
use nsh_platform_macos::{AppOptions, AppSource, run_app};

use crate::{
    bridge::{Bridge, restrict},
    host::Error,
};

/// Public AppOptions route. The runner and the app view use this exact channel.
/// Native selection, credentials and paths are not launch parameters.
pub fn options(bridge: &Bridge) -> AppOptions {
    AppOptions {
        title: "Pilot Day qualification".into(),
        size: (1100, 820),
        host: bridge.channel(),
        ..AppOptions::default()
    }
}

/// Run an isolated bundle on the main thread, then join the native host.
/// The caller owns `bridge` across this call and must not reuse it afterwards.
/// A successful return proves only shutdown, NOT successful UI load or capture.
/// Do not use this stock runner for production quit, reload or updates.
pub fn run_qualification(bundle: Bundle, bridge: &Bridge) -> Result<(), Error> {
    let preparation_error = match restrict(bundle) {
        Ok(bundle) => {
            let _exit = run_app(AppSource::Bundle(bundle), options(bridge));
            None
        }
        Err(error) => Some(error),
    };
    // run_app stops its engine before returning. Also close after preparation
    // failed, never fall back to mocks or let a partial load keep a worker.
    let closed = bridge.close().recv_blocking().map_err(|_| Error::Unknown)?;
    if let Some(error) = preparation_error {
        return Err(error);
    }
    closed
}

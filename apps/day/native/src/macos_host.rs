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

/// App-owned public AppView boundary, separate from the stock runner's immediate
/// close/Quit behavior. The embedding window routes EVERY close/reload/selection
/// replacement here and fences its own commands while a generation is pending.
/// This is opt-in qualification code, not a default entry point or live update.
pub struct WindowOwner {
    view: std::rc::Rc<nsh_platform_macos::AppView>,
    bridge: Bridge,
    capture: Option<(u32, crate::macos_capture::Capture)>,
    loaded: bool,
}

impl WindowOwner {
    /// Own exactly the view created with this bridge's AppOptions. A second
    /// engine or stock run_app must never share this channel.
    pub fn new(main: nsh_platform_macos::objc2::MainThreadMarker, bridge: Bridge) -> Self {
        let view = nsh_platform_macos::AppView::new(main, options(&bridge));
        Self {
            view,
            bridge,
            capture: None,
            loaded: false,
        }
    }

    /// The AppKit view to attach, without exposing AppView::load/stop to callers.
    pub fn view(
        &self,
    ) -> nsh_platform_macos::objc2::rc::Retained<nsh_platform_macos::objc2_app_kit::NSView> {
        self.view.view()
    }

    /// Initial load only. Replacement requires closing this owner and opening a
    /// fresh selected root, never loading another engine into its old channel.
    pub fn load(&mut self, bundle: Bundle) -> Result<(), Error> {
        if self.loaded {
            return Err(Error::Busy);
        }
        self.view.load(restrict(bundle)?.into());
        self.loaded = true;
        Ok(())
    }

    /// Capture actual attached text/preedit, freeze editors and THEN queue the
    /// engine's all-form barrier. A failure restores editing in the same engine.
    pub fn begin_close(
        &mut self,
        main: nsh_platform_macos::objc2::MainThreadMarker,
    ) -> Result<u32, Error> {
        if self.capture.is_some() {
            return Err(Error::Busy);
        }
        let generation = self.bridge.begin_capture()?;
        let result = (|| {
            let capture = crate::macos_capture::Capture::begin(self.view.view(), main)?;
            self.bridge.native_capture_finished(generation)?;
            self.bridge.request_form_flush(generation)?;
            self.capture = Some((generation, capture));
            Ok(generation)
        })();
        if result.is_err() {
            let _ = self.bridge.cancel_flush(generation);
        }
        result
    }

    /// The embedding owner schedules a main-thread readiness check on this wake;
    /// it must also handle failed/no form ACK with a cancellable deadline.
    pub fn set_flush_wakeup(&self, wake: std::sync::Arc<dyn Fn() + Send + Sync>) {
        self.bridge.set_flush_wakeup(wake);
    }

    /// Cancel without replacing the root or replaying any native effect.
    pub fn cancel_close(&mut self, generation: u32) -> Result<(), Error> {
        if self
            .capture
            .as_ref()
            .is_none_or(|(current, _)| *current != generation)
        {
            return Err(Error::Stale);
        }
        self.bridge.cancel_flush(generation)?;
        self.capture = None; // restores editability/focus in the still-live view
        Ok(())
    }

    /// Recheck attached native bytes, atomically seal generation/save sequence,
    /// stop the same engine, then return the JOINED root-close receiver. Await it
    /// off the UI thread before replacement/quit. No upgrade is performed here.
    pub fn finish_close(
        &mut self,
        generation: u32,
    ) -> Result<async_channel::Receiver<Result<(), Error>>, Error> {
        let (current, capture) = self.capture.as_mut().ok_or(Error::Stale)?;
        if *current != generation {
            return Err(Error::Stale);
        }
        capture.check()?;
        let receipt = self.bridge.seal_flush(generation)?;
        if !self.bridge.sealed(receipt) {
            return Err(Error::Stale);
        }
        self.view.stop();
        capture.engine_stopped();
        Ok(self.bridge.close())
    }
}

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

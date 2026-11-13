//! Day's AppView lifetime. The application delegate uses this same owner.
//! Capture/save failures never dispose the engine. Host close joins BEFORE
//! engine disposal. No stock runner participates in the production path.
use nsh_engine::Bundle;
use nsh_platform_macos::{AppOptions, AppSource, run_app};

use crate::{
    bridge::{Bridge, restrict},
    host::Error,
};

/// App-owned public AppView boundary, separate from the stock runner's immediate
/// close/Quit behavior. The embedding window routes EVERY close/reload/selection
/// replacement here and fences its own commands while a generation is pending.
/// Used by Day's executable and isolated native fixtures. Not a live update.
pub struct WindowOwner {
    view: std::rc::Rc<nsh_platform_macos::AppView>,
    bridge: Bridge,
    capture: Option<(u32, crate::macos_capture::Capture)>,
    loaded: bool,
    sealed: Option<crate::bridge::FlushReceipt>,
    closing: bool,
    stopped: bool,
}

/// One-use continuation from the exact native/form seal to joined close.
/// Hold it across the existing updater controller's preparation/COMMIT wait.
/// It is not an update permit, READY, COMMIT or successful replacement.
#[must_use]
pub struct SealedClose {
    receipt: crate::bridge::FlushReceipt,
    update_entered: bool,
}

/// The entered host-close receiver, bound to the seal that started it.
#[must_use]
pub struct Closing {
    receipt: crate::bridge::FlushReceipt,
    joined: async_channel::Receiver<Result<(), Error>>,
}

/// Opaque joined result. Only Closing can construct it, never the VM/caller.
#[must_use]
pub struct JoinedClose {
    receipt: crate::bridge::FlushReceipt,
    result: Result<(), Error>,
}
impl Closing {
    /// Wait off the AppKit thread. There is no retry or second close here.
    pub fn recv_blocking(self) -> Result<JoinedClose, Error> {
        let result = self.joined.recv_blocking().map_err(|_| Error::Unknown)?;
        Ok(JoinedClose {
            receipt: self.receipt,
            result,
        })
    }
}
impl JoinedClose {
    pub fn result(&self) -> Result<(), Error> {
        self.result
    }
}

/// Exact native capture after seal, host join and engine disposal. Only the
/// owning WindowOwner can construct this, never a VM reply or stored hint.
pub struct ClosedWindow {
    capture: crate::host::window::SavedWindow,
}
impl ClosedWindow {
    pub(crate) fn capture(&self) -> &crate::host::window::SavedWindow {
        &self.capture
    }
}

/// Force close in flight. Only a durably accepted exact-update loss can enter.
#[must_use]
pub struct ForcedClosing {
    accepted: crate::host::update_loss::Accepted,
    joined: async_channel::Receiver<Result<(), Error>>,
}
/// Joined native host, not yet a disposed UI or installer capability.
#[must_use]
pub struct JoinedForceClose {
    accepted: crate::host::update_loss::Accepted,
    result: Result<(), Error>,
}
impl ForcedClosing {
    /// Join off AppKit. Cancellation/ACK cannot stand in for this result.
    pub fn recv_blocking(self) -> Result<JoinedForceClose, Error> {
        let result = self.joined.recv_blocking().map_err(|_| Error::Unknown)?;
        Ok(JoinedForceClose {
            accepted: self.accepted,
            result,
        })
    }
}
/// Exact accepted-loss window after native host join and engine disposal.
/// It carries no SavedWindow and claims no successful capture.
pub struct ForcedClosedWindow {
    accepted: crate::host::update_loss::Accepted,
}
impl ForcedClosedWindow {
    pub(crate) fn into_accepted(self) -> crate::host::update_loss::Accepted {
        self.accepted
    }
}

impl WindowOwner {
    /// Own exactly the view created with this bridge's AppOptions. A second
    /// engine or stock run_app must never share this channel.
    pub fn new(main: nsh_platform_macos::objc2::MainThreadMarker, bridge: Bridge) -> Self {
        let configuration = options(&bridge);
        Self::configured(main, bridge, configuration)
    }

    pub(crate) fn configured(
        main: nsh_platform_macos::objc2::MainThreadMarker,
        bridge: Bridge,
        mut configuration: AppOptions,
    ) -> Self {
        // A caller may configure resources, never a second host channel.
        bridge.require_saved_view();
        configuration.host = bridge.channel();
        let view = nsh_platform_macos::AppView::new(main, configuration);
        Self {
            view,
            bridge,
            capture: None,
            loaded: false,
            sealed: None,
            closing: false,
            stopped: false,
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

    pub(crate) fn close_unloaded(&mut self) -> Result<(), Error> {
        if self.loaded {
            return Err(Error::Busy);
        }
        // No engine or form was loaded. NativeHost retains itself during join.
        let _joined = self.bridge.close();
        Ok(())
    }

    /// Capture actual attached text/preedit, freeze editors and THEN queue the
    /// engine's all-form barrier. A failure restores editing in the same engine.
    pub fn begin_close(
        &mut self,
        main: nsh_platform_macos::objc2::MainThreadMarker,
    ) -> Result<u32, Error> {
        if self.capture.is_some() || self.closing || self.stopped {
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

    pub fn identity(&self) -> &str {
        self.bridge.window_identity()
    }

    pub(crate) fn take_app_update(&self) -> Option<String> {
        self.bridge.take_app_update()
    }
    pub(crate) fn app_update_requested(&self) -> bool {
        self.bridge.app_update_requested()
    }
    pub(crate) fn startup_ready(&self) -> bool {
        self.bridge.startup_ready()
    }
    pub(crate) fn acknowledge_startup(
        &self,
    ) -> async_channel::Receiver<Result<crate::model::IntentOutcome, Error>> {
        self.bridge.acknowledge_startup()
    }

    pub fn ready(&self, generation: u32) -> bool {
        self.bridge.flush_ready(generation)
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

    /// Recheck native bytes and atomically seal the final admitted save sequence.
    /// This seals exactly once. No close or update has entered yet.
    pub fn seal_close(&mut self, generation: u32) -> Result<SealedClose, Error> {
        let (current, capture) = self.capture.as_mut().ok_or(Error::Stale)?;
        if *current != generation {
            return Err(Error::Stale);
        }
        capture.check()?;
        let receipt = self.bridge.seal_flush(generation)?;
        if !self.bridge.sealed(receipt) {
            return Err(Error::Stale);
        }
        self.sealed = Some(receipt);
        Ok(SealedClose {
            receipt,
            update_entered: false,
        })
    }

    /// One-use entry into the signed controller's READY/COMMIT handoff.
    /// The caller must await this receiver before consuming the continuation
    /// with close_sealed. Only Accepted acknowledges COMMIT, never replacement.
    pub fn prepare_update(
        &self,
        continuation: &mut SealedClose,
        id: String,
    ) -> Result<async_channel::Receiver<Result<crate::model::IntentOutcome, Error>>, Error> {
        if self.sealed != Some(continuation.receipt) || continuation.update_entered {
            return Err(Error::Stale);
        }
        continuation.update_entered = true; // uncertain entry is never replayed
        self.bridge.commit_update(id, continuation.receipt)
    }

    /// Consume the same seal, without attempting a second seal. NativeHost
    /// fences admission and joins entered work while the VM/window stay alive.
    pub fn close_sealed(&mut self, continuation: SealedClose) -> Result<Closing, Error> {
        if self.closing
            || self.sealed != Some(continuation.receipt)
            || !self.bridge.sealed(continuation.receipt)
        {
            return Err(Error::Stale);
        }
        self.closing = true;
        Ok(Closing {
            receipt: continuation.receipt,
            joined: self.bridge.close(),
        })
    }

    /// Called only with the successful joined-close result, on the main thread.
    /// This is deliberately separate from starting the asynchronous drain.
    pub fn dispose_joined(&mut self, joined: JoinedClose) -> Result<(), Error> {
        if !self.closing || self.stopped || self.sealed != Some(joined.receipt) {
            return Err(Error::Stale);
        }
        joined.result?;
        // Entered work may have delivered an older view update while the host
        // joined. Recheck before disposal as well, never lose changed bytes.
        let (_, capture) = self.capture.as_ref().ok_or(Error::Stale)?;
        capture.check()?;
        self.view.stop();
        if let Some((_, capture)) = self.capture.as_mut() {
            capture.engine_stopped();
        }
        self.stopped = true;
        Ok(())
    }

    /// Native official-update continuation. Not an exit hook: all capture and
    /// native host work have finished before this can authorize installer entry.
    pub fn close_for_update(&mut self, joined: JoinedClose) -> Result<ClosedWindow, Error> {
        let capture = self.bridge.saved_capture().ok_or(Error::Storage)?;
        capture.validate()?;
        if capture.window != self.identity()
            || (capture.generation, capture.save_sequence) != joined.receipt.parts()
        {
            return Err(Error::Stale);
        }
        self.dispose_joined(joined)?;
        Ok(ClosedWindow { capture })
    }

    /// Skip preservation only after durable, exact native consent. The host's
    /// entered writes and commands still drain before the engine is disposed.
    pub(crate) fn begin_force_close(
        &mut self,
        accepted: crate::host::update_loss::Accepted,
    ) -> Result<ForcedClosing, Error> {
        if self.closing || self.stopped {
            return Err(Error::Busy);
        }
        self.bridge.seal_loss(&accepted)?;
        self.closing = true;
        Ok(ForcedClosing {
            accepted,
            joined: self.bridge.close(),
        })
    }

    /// Main-thread disposal only after joined close. State loss is explicit;
    /// this never manufactures the normal capture or bypasses a host failure.
    pub fn close_forced(&mut self, joined: JoinedForceClose) -> Result<ForcedClosedWindow, Error> {
        if !self.closing || self.stopped || joined.accepted.window() != self.identity() {
            return Err(Error::Stale);
        }
        joined.result?;
        self.view.stop();
        if let Some((_, capture)) = self.capture.as_mut() {
            capture.engine_stopped();
        }
        self.stopped = true;
        Ok(ForcedClosedWindow {
            accepted: joined.accepted,
        })
    }

    /// Compatibility for qualification callers. Still requires dispose_joined
    /// after receiving the result; this never stops an unjoined root.
    pub fn finish_close(&mut self, generation: u32) -> Result<Closing, Error> {
        let continuation = self.seal_close(generation)?;
        self.close_sealed(continuation)
    }
}

/// Public AppOptions route. The runner and the app view use this exact channel.
/// Native selection, credentials and paths are not launch parameters.
pub fn options(bridge: &Bridge) -> AppOptions {
    AppOptions {
        title: "Pilot".into(),
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

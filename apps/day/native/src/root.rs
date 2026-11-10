//! The trusted native root of a connected Day window.
//!
//! The app's native owner opens one [`NativeHost`] for an explicit selection.
//! [`crate::bridge::Bridge`] binds that same root to one released macOS channel.
//! Native embedding/headless owners can also use [`DayRoot::context`]; the
//! stock released macOS AppView cannot inject EngineConfig::context.
//! Screen code cannot select a profile, port, path or credential.
//!
//! The root owns the host's lifetime. Before disposal, the lifecycle owner
//! must capture native inputs/preedit and await every form's saved ACK. Drop
//! is not that capture. Then the owner stops the engine and awaits
//! [`DayRoot::close`], which fences new intents and joins entered HTTP, the
//! WS task, queued drafts, the journal and the worker. Replacing the
//! selection means doing exactly that, then opening a new root.

use async_channel::Receiver;
use nsh_core::element::{EngineContext, engine_context};

use crate::host::{Error, NativeHost};

/// One connected Day window's native selection, owned by the app's native
/// root and never exported to TSX.
#[derive(Clone)]
pub struct DayRoot {
    host: NativeHost,
}

impl DayRoot {
    /// A root for `host`, an explicit selection the native owner opened.
    pub fn new(host: NativeHost) -> Self {
        Self { host }
    }

    /// The engine context that binds this root to one engine: set it as
    /// `EngineConfig::context` when building that engine.
    pub fn context(&self) -> EngineContext {
        EngineContext::default().with(self.clone())
    }

    /// The selected host, for the root's own Rust code.
    pub fn host(&self) -> &NativeHost {
        &self.host
    }

    /// Fences new intents at once, then joins every entered request, the
    /// queued drafts, the journal and the worker. Await it after the engine
    /// stopped and before quitting or replacing the selection. Closing never
    /// stops, pauses or resumes agents, and never resends anything.
    pub fn close(&self) -> Receiver<Result<(), Error>> {
        self.host.close()
    }
}

/// The host the engine running this code was given, if any. Read in a JS
/// call or task on the engine's thread.
pub fn current_host() -> Option<NativeHost> {
    engine_context::<DayRoot>().map(|root| root.host.clone())
}

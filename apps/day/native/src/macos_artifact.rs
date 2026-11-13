//! The connected app's native preview component. No artifact code enters its
//! parent's VM; props hold only the captured revision already shown by Day.
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::{Rc, Weak},
    sync::atomic::{AtomicUsize, Ordering},
};

use dispatch2::DispatchQueue;
use nsh_engine::{EngineConfig, HostChannel};
use nsh_platform_macos::{
    AppOptions, AppView, ComponentContext, Components, NativeComponent,
    objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained},
    objc2_app_kit::{NSAutoresizingMaskOptions, NSView},
    objc2_foundation::{NSObjectProtocol, NSRect},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{artifact_runtime, artifact_source::CapturedSource};

static COMPILING: AtomicUsize = AtomicUsize::new(0);
thread_local! {
    static PREVIEWS: RefCell<HashMap<String, Weak<RefCell<State>>>> = RefCell::new(HashMap::new());
}

define_class!(
    /// Artifact-local editors are not conversation drafts. Native close capture
    /// skips this subtree; stopping the parent disposes the preview separately.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "PilotDayArtifactContainer"]
    struct Container;
    unsafe impl NSObjectProtocol for Container {}
);

pub(super) fn is_preview(view: &NSView) -> bool {
    view.downcast_ref::<Container>().is_some()
}

struct Slot;
impl Drop for Slot {
    fn drop(&mut self) {
        COMPILING.fetch_sub(1, Ordering::AcqRel);
    }
}

struct State {
    id: String,
    generation: u64,
    container: Retained<Container>,
    view: Option<Rc<AppView>>,
    context: ComponentContext,
}
impl State {
    fn report(&self, state: &str, message: &str) {
        self.context
            .emit("state", json!({"state":state,"message":message}));
    }
    fn stop(&mut self) {
        self.generation += 1;
        if let Some(view) = self.view.take() {
            // Released NSH interrupts running JS, joins it, then removes views.
            view.stop();
            view.view().removeFromSuperview();
        }
    }
}

fn captured(value: &Value) -> Result<CapturedSource, String> {
    let source = value["content"]["source"]
        .as_str()
        .ok_or("No saved source")?;
    let reference = &value["reference"];
    let digest = value["content"]["containerSha256"]
        .as_str()
        .ok_or("No saved revision digest")?;
    if value["version"] != 1
        || value["metadata"]["kind"] != "nsh"
        || value["content"]["state"] != "text"
        || source.len() > 512 * 1024
        || digest.len() != 64
        || !digest.bytes().all(|b| b.is_ascii_hexdigit())
        || !value["content"]["containerBytes"]
            .as_u64()
            .is_some_and(|n| n <= 1024 * 1024)
    {
        return Err("Unsupported saved NSH revision".into());
    }
    Ok(CapturedSource {
        artifact_id: reference["artifactId"]
            .as_str()
            .ok_or("No artifact identity")?
            .into(),
        source_session_id: reference["sourceSessionId"]
            .as_str()
            .ok_or("No source owner")?
            .into(),
        revision: reference["revision"].as_u64().ok_or("No revision")?,
        entry: "Artifact.tsx".into(),
        source: source.into(),
        source_sha256: format!("{:x}", Sha256::digest(source.as_bytes())),
        source_bytes: source.len(),
    })
}

struct Preview {
    state: Rc<RefCell<State>>,
}
impl NativeComponent for Preview {
    fn view(&self) -> Retained<NSView> {
        Retained::into_super(self.state.borrow().container.clone())
    }
    fn set_prop(&mut self, name: &str, value: Option<&Value>) {
        if name != "snapshot" {
            return;
        }
        let mut state = self.state.borrow_mut();
        state.stop();
        let Some(value) = value else {
            return;
        };
        let captured = match captured(value) {
            Ok(captured) => captured,
            Err(error) => {
                state.report("error", &error);
                return;
            }
        };
        if COMPILING
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 2).then_some(n + 1)
            })
            .is_err()
        {
            state.report(
                "error",
                "Another preview is opening. Close this preview and try again.",
            );
            return;
        }
        let slot = Slot;
        let id = state.id.clone();
        let generation = state.generation;
        state.report("loading", "");
        if std::thread::Builder::new()
            .name("artifact-compile".into())
            .spawn(move || {
                let _slot = slot;
                let result = artifact_runtime::config(captured);
                DispatchQueue::main().exec_async(move || ready(&id, generation, result));
            })
            .is_err()
        {
            state.report(
                "error",
                "The preview could not start. Close it and try again.",
            );
        }
    }
}
impl Drop for Preview {
    fn drop(&mut self) {
        let mut state = self.state.borrow_mut();
        PREVIEWS.with(|previews| previews.borrow_mut().remove(&state.id));
        state.stop();
    }
}

fn ready(id: &str, generation: u64, result: Result<EngineConfig, String>) {
    let Some(state) = PREVIEWS.with(|previews| previews.borrow().get(id).and_then(Weak::upgrade))
    else {
        return;
    };
    let mut state = state.borrow_mut();
    if state.generation != generation {
        return;
    }
    let config = match result {
        Ok(config) => config,
        Err(error) => {
            state.report("error", &error);
            return;
        }
    };
    let Some(main) = MainThreadMarker::new() else {
        return;
    };
    let options = AppOptions {
        limits: config.limits,
        ..AppOptions::default()
    };
    let view = AppView::new(main, options);
    let native = view.view();
    native.setFrame(state.container.bounds());
    native.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    state.container.addSubview(&native);
    // AppView snapshots NSH's process-wide UI sets when loading. Only base
    // belongs in an artifact. Restore Day's canonical sets before returning
    // to AppKit, so other connected windows retain their own registry.
    struct RestoreSets;
    impl Drop for RestoreSets {
        fn drop(&mut self) {
            nsh_platform_macos::set_ui_sets(crate::macos_host::ui_sets());
        }
    }
    let restore = RestoreSets;
    nsh_platform_macos::set_ui_sets(config.ui_sets);
    view.load(config.app);
    drop(restore);
    state.view = Some(view);
    // Loaded means the separate engine was started, not a durable outcome or
    // first-frame receipt. Its own runtime/error boundary draws the result.
    state.report("loaded", "");
}

/// Install the app-owned preview component on this connected view only.
pub fn register(main: MainThreadMarker, components: &Components, host: &HostChannel) {
    components.register(
        "pilot/artifact-preview",
        Rc::new(move |context| {
            let container = Container::alloc(main).set_ivars(());
            // SAFETY: the subclass has no ivars; NSView initializes its own state.
            let container: Retained<Container> =
                unsafe { msg_send![super(container), initWithFrame: NSRect::ZERO] };
            container.setClipsToBounds(true);
            let id = uuid::Uuid::new_v4().to_string();
            let state = Rc::new(RefCell::new(State {
                id: id.clone(),
                generation: 0,
                container,
                view: None,
                context,
            }));
            PREVIEWS.with(|previews| previews.borrow_mut().insert(id, Rc::downgrade(&state)));
            Box::new(Preview { state })
        }),
    );
    let mut params = host.params();
    if let Some(day) = params.get_mut("day").and_then(Value::as_object_mut) {
        day.insert("artifactPreview".into(), Value::Bool(true));
    }
    host.set_params(params);
}

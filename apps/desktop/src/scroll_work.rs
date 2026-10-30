//! Opt-in subtree CPU attribution for the hidden sidebar wheel fixture.
use gpui_kit::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Window,
};
use std::{cell::RefCell, collections::BTreeMap};

thread_local! {
    static WORK: RefCell<BTreeMap<&'static str, [f64; 3]>> = RefCell::default();
}

pub(super) fn cpu_ms() -> f64 {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: clock_gettime writes only the supplied timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut t) };
    t.tv_sec as f64 * 1000. + t.tv_nsec as f64 / 1e6
}

pub(super) fn take() -> BTreeMap<&'static str, [f64; 3]> {
    WORK.with(|work| std::mem::take(&mut *work.borrow_mut()))
}

fn record(name: &'static str, phase: usize, start: f64) {
    let elapsed = cpu_ms() - start;
    WORK.with(|work| work.borrow_mut().entry(name).or_default()[phase] += elapsed);
}

pub(super) fn region(child: impl IntoElement, name: &'static str) -> Timed {
    Timed {
        child: child.into_any_element(),
        name,
    }
}

pub(super) struct Timed {
    child: AnyElement,
    name: &'static str,
}

impl IntoElement for Timed {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for Timed {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        w: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let start = cpu_ms();
        let id = self.child.request_layout(w, cx);
        record(self.name, 0, start);
        (id, ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        w: &mut Window,
        cx: &mut App,
    ) {
        let start = cpu_ms();
        self.child.prepaint(w, cx);
        record(self.name, 1, start);
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        w: &mut Window,
        cx: &mut App,
    ) {
        let start = cpu_ms();
        self.child.paint(w, cx);
        record(self.name, 2, start);
    }
}

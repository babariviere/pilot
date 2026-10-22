//! Window-paced native app decoration. Cached viewports/unchanged leaves avoid
//! expensive descendant work; cheap ancestor chrome still renders. No shader,
//! generated code, parent-observing keyed state or image animation invalidation.
use crate::dither::{self, Atlas, Signal, Snapshot, Spec, Timeline};
use gpui_kit::component::ActiveTheme;
use gpui_kit::{
    App, AppContext, Bounds, Context, DispatchPhase, Entity, EntityId, Global, IntoElement,
    MouseMoveEvent, ParentElement, Pixels, Render, Styled, Subscription, Task, WeakEntity, Window,
    canvas, div, fill, point, px, rgb, size,
};
use std::{
    cell::Cell,
    collections::HashMap,
    rc::Rc,
    sync::OnceLock,
    time::{Duration, Instant},
};

static ATLAS: OnceLock<Atlas> = OnceLock::new();
pub(crate) fn prepare(cx: &mut App) {
    if !cx.has_global::<Directory>() {
        cx.set_global(Directory {
            origin: cx.background_executor().now(),
            clocks: HashMap::new(),
            #[cfg(any(test, feature = "native-probes"))]
            visible_override: None,
        });
    }
    if ATLAS.get().is_none() {
        let task = cx.background_executor().spawn(async {
            ATLAS.get_or_init(|| {
                let atlas = Atlas::build();
                debug_assert!(atlas.bytes() < 1_250_000);
                atlas
            });
        });
        cx.spawn(async move |cx| {
            task.await;
            cx.update(|cx| cx.refresh_windows());
        })
        .detach();
    }
}
struct Directory {
    origin: Instant,
    clocks: HashMap<u64, WeakEntity<Clock>>,
    #[cfg(any(test, feature = "native-probes"))]
    visible_override: Option<bool>,
}
impl Global for Directory {}
fn visible(window: &Window, cx: &App) -> bool {
    #[cfg(any(test, feature = "native-probes"))]
    if let Some(value) = cx.global::<Directory>().visible_override {
        return value;
    }
    let _ = cx;
    window.visibility().is_visible()
}
fn clock(window: &mut Window, cx: &mut App) -> Entity<Clock> {
    prepare_if_missing(cx);
    let id = window.window_handle().window_id().as_u64();
    if let Some(clock) = cx
        .global::<Directory>()
        .clocks
        .get(&id)
        .and_then(WeakEntity::upgrade)
    {
        return clock;
    }
    let origin = cx.global::<Directory>().origin;
    let clock = cx.new(|cx| Clock::new(origin, window, cx));
    let directory = cx.global_mut::<Directory>();
    directory.clocks.retain(|_, v| v.upgrade().is_some());
    directory.clocks.insert(id, clock.downgrade());
    clock
}
fn prepare_if_missing(cx: &mut App) {
    if !cx.has_global::<Directory>() {
        prepare(cx);
    }
}
#[derive(Default)]
struct Lease {
    epoch: Cell<u64>,
    painted: Cell<bool>,
    subscribed: Cell<bool>,
    fast: Cell<bool>,
    ticking: Cell<bool>,
}
struct Member {
    owner: WeakEntity<CornerView>,
    lease: Rc<Lease>,
}
struct Clock {
    origin: Instant,
    epoch: Rc<Cell<u64>>,
    members: HashMap<EntityId, Member>,
    task: Option<Task<()>>,
    fast: bool,
    _visibility: Subscription,
    #[cfg(any(test, feature = "native-probes"))]
    ticks: u64,
}
impl Clock {
    fn new(origin: Instant, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let visibility = cx.observe_window_visibility(window, |view, _, window, cx| {
            if visible(window, cx) {
                window.refresh();
            } else {
                view.sleep();
            }
        });
        Self {
            origin,
            epoch: Rc::new(Cell::new(0)),
            members: HashMap::new(),
            task: None,
            fast: false,
            _visibility: visibility,
            #[cfg(any(test, feature = "native-probes"))]
            ticks: 0,
        }
    }
    fn listen(
        &mut self,
        owner: WeakEntity<CornerView>,
        lease: Rc<Lease>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !visible(window, cx)
            || cx.reduce_motion()
            || !lease.painted.get()
            || !lease.ticking.get()
        {
            lease.subscribed.set(false);
            return;
        }
        let fast = lease.fast.get();
        lease.epoch.set(self.epoch.get());
        self.members
            .insert(owner.entity_id(), Member { owner, lease });
        if fast && !self.fast {
            self.task = None;
        }
        self.fast |= fast;
        self.start(window, cx);
    }
    fn start(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self.task.is_some()
            || self.members.is_empty()
            || !visible(window, cx)
            || cx.reduce_motion()
        {
            return;
        }
        let fast = self.fast;
        self.task = Some(cx.spawn_in(window, async move |view, cx| {
            let mut delay = if fast {
                Duration::from_secs_f64(1. / 60.)
            } else {
                Duration::from_secs_f64(1. / 12.)
            };
            loop {
                cx.background_executor().timer(delay).await;
                let next = view
                    .update_in(cx, |view, window, cx| view.tick(window, cx))
                    .ok()
                    .flatten();
                let Some(next) = next else {
                    break;
                };
                delay = next;
            }
        }));
    }
    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Duration> {
        if !visible(window, cx) || cx.reduce_motion() {
            self.sleep();
            return None;
        }
        let epoch = self.epoch.get();
        self.epoch.set(epoch.wrapping_add(1));
        let now = cx
            .background_executor()
            .now()
            .saturating_duration_since(self.origin);
        self.fast = false;
        self.members.retain(|_, member| {
            // A retained but unmounted/clipped leaf does not renew its lease.
            let active = member.lease.painted.get()
                && member.lease.epoch.get() == epoch
                && member.lease.ticking.get();
            let keep = active
                && member
                    .owner
                    .update(cx, |view, cx| view.tick(now, cx))
                    .unwrap_or(false);
            if keep {
                self.fast |= member.lease.fast.get();
            } else {
                member.lease.subscribed.set(false);
                if !active {
                    member.lease.painted.set(false);
                }
            }
            keep
        });
        #[cfg(any(test, feature = "native-probes"))]
        {
            self.ticks += 1;
        }
        if self.members.is_empty() {
            self.task = None;
            None
        } else {
            Some(Duration::from_secs_f64(if self.fast {
                1. / 60.
            } else {
                1. / 12.
            }))
        }
    }
    fn sleep(&mut self) {
        self.task = None;
        self.fast = false;
        for member in self.members.values() {
            member.lease.subscribed.set(false);
            member.lease.painted.set(false);
        }
        self.members.clear();
    }
}

pub(crate) struct CornerView {
    timeline: Timeline,
    spec: Spec,
    clock: Entity<Clock>,
    epoch: Rc<Cell<u64>>,
    origin: Instant,
    lease: Rc<Lease>,
    #[cfg(any(test, feature = "native-probes"))]
    renders: u64,
}
impl CornerView {
    pub(crate) fn new(spec: Spec, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let clock = clock(window, cx);
        let state = clock.read(cx);
        let (epoch, origin) = (state.epoch.clone(), state.origin);
        Self {
            timeline: Timeline::new(spec),
            spec,
            clock,
            epoch,
            origin,
            lease: Rc::new(Lease::default()),
            #[cfg(any(test, feature = "native-probes"))]
            renders: 0,
        }
    }
    pub(crate) fn configure(&mut self, spec: Spec, cx: &mut Context<Self>) {
        if self.spec == spec {
            return;
        }
        let now = self.now(cx);
        if !self.lease.painted.get() {
            self.timeline = Timeline::new(spec);
        } else {
            self.timeline.configure(spec, now);
        }
        self.spec = spec;
        cx.notify();
    }
    fn now(&self, cx: &App) -> Duration {
        cx.background_executor()
            .now()
            .saturating_duration_since(self.origin)
    }
    pub(crate) fn has_corner(&self, cx: &App) -> bool {
        let s = self.timeline.snapshot(self.now(cx), cx.reduce_motion());
        s.spec.signal.is_some() || (s.mix < 1. && s.previous.is_some())
    }
    fn tick(&mut self, now: Duration, cx: &mut Context<Self>) -> bool {
        let snapshot = self.timeline.snapshot(now, cx.reduce_motion());
        self.lease.fast.set(snapshot.fast);
        self.lease.ticking.set(snapshot.ticking);
        cx.notify();
        snapshot.ticking
    }
    fn hover(&mut self, inside: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !self
            .timeline
            .hover(inside, self.now(cx), cx.reduce_motion())
        {
            return;
        }
        let snapshot = self.timeline.snapshot(self.now(cx), cx.reduce_motion());
        self.lease.fast.set(snapshot.fast);
        self.lease.ticking.set(snapshot.ticking);
        if snapshot.ticking {
            self.lease.subscribed.set(true);
            let (owner, lease) = (cx.weak_entity(), self.lease.clone());
            self.clock
                .update(cx, |clock, cx| clock.listen(owner, lease, window, cx));
        }
        cx.notify();
    }
}
impl Render for CornerView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(any(test, feature = "native-probes"))]
        {
            self.renders += 1;
        }
        let snapshot = self.timeline.snapshot(self.now(cx), cx.reduce_motion());
        let (owner, clock, epoch, lease) = (
            cx.weak_entity(),
            self.clock.clone(),
            self.epoch.clone(),
            self.lease.clone(),
        );
        let paint_lease = lease.clone();
        canvas(
            move |bounds: Bounds<Pixels>, window, cx| {
                let (w, h) = snapshot.spec.surface.grid();
                let image = Bounds::new(
                    point(
                        bounds.right() - px(w as f32 * 2.),
                        bounds.bottom() - px(h as f32 * 2.),
                    ),
                    size(px(w as f32 * 2.), px(h as f32 * 2.)),
                );
                let clipped = image
                    .intersect(&bounds)
                    .intersect(&window.content_mask().bounds);
                let shown = visible(window, cx)
                    && ATLAS.get().is_some()
                    && clipped.size.width > px(0.)
                    && clipped.size.height > px(0.);
                lease.painted.set(shown);
                lease.epoch.set(epoch.get());
                lease.fast.set(snapshot.fast);
                lease.ticking.set(snapshot.ticking && shown);
                (image, shown)
            },
            move |bounds, (image, shown), window, cx| {
                if !shown {
                    return;
                }
                if snapshot.ticking
                    && (!paint_lease.subscribed.get() || (snapshot.fast && !clock.read(cx).fast))
                {
                    paint_lease.subscribed.set(true);
                    let (owner, clock, lease) = (owner.clone(), clock.clone(), paint_lease.clone());
                    window.defer(cx, move |window, cx| {
                        clock.update(cx, |clock, cx| clock.listen(owner, lease, window, cx))
                    });
                }
                paint(snapshot, image, bounds, window, cx.theme().is_dark());
                if snapshot.spec.surface == dither::Surface::Row
                    && (snapshot.spec.signal.is_some()
                        || (snapshot.mix < 1. && snapshot.previous.is_some()))
                {
                    let owner = owner.clone();
                    let clip = window.content_mask().bounds;
                    window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                        if phase == DispatchPhase::Capture {
                            let inside =
                                bounds.contains(&event.position) && clip.contains(&event.position);
                            let _ = owner.update(cx, |view, cx| view.hover(inside, window, cx));
                        }
                    });
                }
            },
        )
        .size_full()
    }
}
fn paint(
    snapshot: Snapshot,
    bounds: Bounds<Pixels>,
    host: Bounds<Pixels>,
    window: &mut Window,
    dark: bool,
) {
    if snapshot.spec.signal.is_none() && snapshot.mix >= 1. {
        return;
    }
    let (w, h) = snapshot.spec.surface.grid();
    let colors = [
        Signal::Working,
        Signal::NeedsYou,
        Signal::Failed,
        Signal::Ready,
    ]
    .map(|s| {
        let c: gpui_kit::Hsla = rgb(s.rgb(dark)).into();
        c
    });
    let atlas = ATLAS.get();
    for y in 0..h {
        for x in 0..w {
            if let Some((signal, alpha)) = dither::cell(snapshot, x, y, atlas) {
                let mut color = colors[match signal {
                    Signal::Working => 0,
                    Signal::NeedsYou => 1,
                    Signal::Failed => 2,
                    Signal::Ready => 3,
                }];
                color.a = alpha;
                let dot = Bounds::new(
                    bounds.origin + point(px(x as f32 * 2.), px(y as f32 * 2.)),
                    size(px(2.), px(2.)),
                );
                paint_cell(
                    dot,
                    host,
                    if snapshot.spec.surface == dither::Surface::Row {
                        crate::appearance::Radius::ROW
                    } else {
                        crate::appearance::Radius::TRAY
                    },
                    color,
                    window,
                );
            }
        }
    }
}
// GPUI's child content mask is rectangular. Clip the few boundary cells to
// the host's rounded shape in physical-pixel strips, without offscreen layers,
// texture upsampling or an app-specific shader pipeline.
fn paint_cell(
    dot: Bounds<Pixels>,
    host: Bounds<Pixels>,
    radius: f32,
    color: gpui_kit::Hsla,
    window: &mut Window,
) {
    let r = radius
        .min(f32::from(host.size.width) / 2.)
        .min(f32::from(host.size.height) / 2.);
    let top = f32::from(host.top());
    let bottom = f32::from(host.bottom());
    let left = f32::from(host.left());
    let right = f32::from(host.right());
    let dtop = f32::from(dot.top());
    let dbottom = f32::from(dot.bottom());
    let dleft = f32::from(dot.left());
    let dright = f32::from(dot.right());
    if dtop >= top
        && dbottom <= bottom
        && dleft >= left
        && dright <= right
        && ((dtop >= top + r && dbottom <= bottom - r)
            || (dleft >= left + r && dright <= right - r))
    {
        window.paint_quad(fill(dot, color));
        return;
    }
    let step = 1. / window.scale_factor();
    let mut y = dtop.max(top);
    while y < dbottom.min(bottom) {
        let h = step.min(dbottom.min(bottom) - y);
        let sample = y + h / 2.;
        let dy = if sample < top + r {
            top + r - sample
        } else if sample > bottom - r {
            sample - (bottom - r)
        } else {
            0.
        };
        let inset = if dy > 0. {
            r - (r * r - dy * dy).max(0.).sqrt()
        } else {
            0.
        };
        let x = f32::from(dot.left()).max(left + inset);
        let end = f32::from(dot.right()).min(right - inset);
        if end > x {
            window.paint_quad(fill(
                Bounds::new(point(px(x), px(y)), size(px(end - x), px(h))),
                color,
            ));
        }
        y += h;
    }
}
pub(crate) fn layer(view: Entity<CornerView>) -> impl IntoElement {
    div()
        .absolute()
        .top_0()
        .left_0()
        .right_0()
        .bottom_0()
        .min_w_0()
        .min_h_0()
        .child(view.cached(gpui_kit::StyleRefinement::default().size_full()))
}

#[cfg(feature = "native-probes")]
pub(crate) fn probe_visible(shown: bool, window: &mut Window, cx: &mut App) {
    prepare_if_missing(cx);
    cx.global_mut::<Directory>().visible_override = Some(shown);
    let id = window.window_handle().window_id().as_u64();
    if let Some(clock) = cx
        .global::<Directory>()
        .clocks
        .get(&id)
        .and_then(WeakEntity::upgrade)
    {
        clock.update(cx, |clock, _| {
            if !shown {
                clock.sleep();
            }
        });
    }
    window.refresh();
}
#[cfg(feature = "native-probes")]
pub(crate) fn probe_clock(window: &Window, cx: &App) -> (u64, usize, bool) {
    let id = window.window_handle().window_id().as_u64();
    cx.global::<Directory>()
        .clocks
        .get(&id)
        .and_then(WeakEntity::upgrade)
        .map_or((0, 0, false), |v| {
            let clock = v.read(cx);
            (clock.ticks, clock.members.len(), clock.task.is_some())
        })
}
#[cfg(feature = "native-probes")]
pub(crate) fn probe_atlas_bytes() -> usize {
    ATLAS.get().map_or(0, Atlas::bytes)
}
#[cfg(feature = "native-probes")]
impl CornerView {
    pub(crate) fn probe(&self, cx: &App) -> (Snapshot, u64, bool) {
        (
            self.timeline.snapshot(self.now(cx), cx.reduce_motion()),
            self.renders,
            self.lease.subscribed.get(),
        )
    }
}

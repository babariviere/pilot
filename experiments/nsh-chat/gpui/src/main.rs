//! Matched synthetic replay using the production Kit primitives, not a
//! substitute claim about the complete Pilot application.
#[path = "../../src/model.rs"]
#[allow(dead_code)]
mod model;
#[path = "../../src/resources.rs"]
mod resources;
use gpui_kit::{
    component::{
        Sizable,
        button::Button,
        input::{Textarea, TextareaState},
        message_scroller::{MessageScroller, MessageScrollerState},
        text::{TextView, TextViewState},
    },
    *,
};
use serde_json::json;
use std::{
    borrow::Cow,
    collections::HashMap,
    time::{Duration, Instant},
};

struct Chat {
    fixture: model::Fixture,
    selected: usize,
    scroller: Entity<MessageScrollerState>,
    composer: Entity<TextareaState>,
    texts: HashMap<String, Entity<TextViewState>>,
    task: Option<Task<()>>,
}

impl Chat {
    fn new(w: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            fixture: model::Fixture::default(),
            selected: 0,
            scroller: cx.new(|cx| MessageScrollerState::new(1000, cx)),
            composer: cx.new(|cx| {
                TextareaState::new(w, cx)
                    .placeholder("Write a message…")
                    .auto_grow(2, 6)
            }),
            texts: HashMap::new(),
            task: None,
        }
    }
    fn navigate(&mut self, id: usize, w: &mut Window, cx: &mut Context<Self>) {
        self.fixture.chats[self.selected].draft = self.composer.read(cx).value().to_string();
        self.selected = id;
        let draft = self.fixture.chats[id].draft.clone();
        self.composer.update(cx, |e, cx| e.set_value(draft, w, cx));
        let len = self.fixture.chats[id].visible().len();
        self.scroller.update(cx, |s, cx| s.reset(len, cx));
        cx.notify();
    }
    fn begin(&mut self, cx: &mut Context<Self>) {
        let c = &mut self.fixture.chats[self.selected];
        if c.streaming {
            return;
        }
        c.begin();
        self.scroller.update(cx, |s, cx| {
            s.append(1, cx);
        });
        cx.notify();
    }
    fn tick(&mut self, cx: &mut Context<Self>) {
        let c = &mut self.fixture.chats[self.selected];
        if let Some(row) = c.advance() {
            if let Some(state) = self.texts.get(&row.id) {
                state.update(cx, |s, cx| s.set_text(&row.text, cx));
            }
            let last = c.visible().len() - 1;
            self.scroller.update(cx, |s, cx| {
                s.remeasure_items(last..last + 1, cx);
            });
            cx.notify();
        }
    }
    fn replay(&mut self, cx: &mut Context<Self>) {
        self.begin(cx);
        self.task = Some(cx.spawn(async |view, cx| {
            for _ in 0..100 {
                cx.background_executor()
                    .timer(Duration::from_secs_f64(1. / 30.))
                    .await;
                if view.update(cx, |v, cx| v.tick(cx)).is_err() {
                    break;
                }
            }
        }));
    }
    fn row(&mut self, ix: usize, cx: &mut Context<Self>) -> AnyElement {
        let row = self.fixture.chats[self.selected].visible()[ix].clone();
        let state = self
            .texts
            .entry(row.id.clone())
            .or_insert_with(|| cx.new(|cx| TextViewState::markdown(&row.text, cx)))
            .clone();
        div()
            .w_full()
            .flex()
            .justify_center()
            .px_6()
            .py_3()
            .child(
                div()
                    .w_full()
                    .max_w(px(900.))
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(TextView::new(&state).selectable(true).scrollable(false))
                    .children(row.visual.then(|| {
                        div()
                            .text_sm()
                            .child("Replay cadence       24       30       27       30 updates/s")
                    }))
                    .children(row.image.then(|| {
                        img(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                            .join("../fixture.png"))
                        .w_full()
                        .max_w(px(520.))
                        .h(px(210.))
                    })),
            )
            .into_any_element()
    }
}
impl Render for Chat {
    fn render(&mut self, _w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let weak = cx.weak_entity();
        div()
            .size_full()
            .flex()
            .bg(rgb(0xffffff))
            .text_color(rgb(0x1f2633))
            .font_family("Inter")
            .text_size(px(15.))
            .child(
                div()
                    .w(px(206.))
                    .h_full()
                    .flex()
                    .flex_col()
                    .bg(rgb(0xf6f8fb))
                    .p_4()
                    .gap_3()
                    .child("Conversations")
                    .child(
                        Button::new("chat0")
                            .small()
                            .label("A calmer conversation")
                            .on_click(cx.listener(|v, _, w, cx| v.navigate(0, w, cx))),
                    )
                    .child(
                        Button::new("chat1")
                            .small()
                            .label("Another thought")
                            .on_click(cx.listener(|v, _, w, cx| v.navigate(1, w, cx))),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(64.))
                            .px_6()
                            .flex()
                            .items_center()
                            .child("A calmer conversation · GPUI comparison"),
                    )
                    .child(
                        div().flex_1().min_h_0().child(
                            MessageScroller::new(
                                "history",
                                self.scroller.clone(),
                                move |ix, _, cx| {
                                    weak.update(cx, |v, cx| v.row(ix, cx))
                                        .unwrap_or_else(|_| div().into_any_element())
                                },
                            )
                            .jump_button(false),
                        ),
                    )
                    .child(
                        div()
                            .h(px(34.))
                            .flex()
                            .justify_center()
                            .gap_3()
                            .child(Button::new("earlier").small().label("Earlier").on_click(
                                cx.listener(|v, _, _, cx| {
                                    let c = &mut v.fixture.chats[v.selected];
                                    let before = c.start;
                                    c.prepend();
                                    let added = before - c.start;
                                    v.scroller.update(cx, |s, cx| {
                                        s.prepend(added, cx);
                                    });
                                    cx.notify();
                                }),
                            ))
                            .child(Button::new("latest").small().label("Latest").on_click(
                                cx.listener(|v, _, _, cx| {
                                    v.scroller.update(cx, |s, cx| s.scroll_to_end(cx))
                                }),
                            ))
                            .child(
                                Button::new("replay")
                                    .small()
                                    .label("Replay response")
                                    .on_click(cx.listener(|v, _, _, cx| v.replay(cx))),
                            ),
                    )
                    .child(
                        div().bg(rgb(0xf1f4f8)).p_4().child(
                            div()
                                .bg(rgb(0xffffff))
                                .rounded_lg()
                                .p_3()
                                .child(Textarea::new(&self.composer)),
                        ),
                    ),
            )
    }
}

fn cpu_ms() -> f64 {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe {
        libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut t);
    }
    t.tv_sec as f64 * 1000. + t.tv_nsec as f64 / 1e6
}

fn frame_tick(
    w: &mut Window,
    _cx: &mut App,
    last: Instant,
    cpu: f64,
    frames: std::rc::Rc<std::cell::RefCell<Vec<serde_json::Value>>>,
) {
    let now = Instant::now();
    let used = cpu_ms();
    frames.borrow_mut().push(json!({"interval_ms":(now-last).as_secs_f64()*1000.,"main_thread_cpu_ms":used-cpu,"active":w.is_window_active()}));
    w.on_next_frame(move |w, cx| frame_tick(w, cx, now, used, frames));
}
fn main() {
    let probe = std::env::args().any(|a| a == "--probe");
    let visible = !probe || std::env::args().any(|a| a == "--visible");
    let application = if visible {
        gpui_kit::application()
    } else {
        gpui_kit::Application::with_platform(gpui_kit::platform::current_platform(false))
            .with_windowing(gpui_kit::WindowingRequest::Headless)
    };
    application.run(move|cx| {
        gpui_kit::init(cx);
        cx.text_system().add_fonts(vec![
            Cow::Borrowed(include_bytes!("../../../../apps/desktop/assets/fonts/Inter-Regular.ttf")),
            Cow::Borrowed(include_bytes!("../../../../apps/desktop/assets/fonts/Inter-SemiBold.ttf")),
            Cow::Borrowed(include_bytes!("../../../../apps/desktop/assets/fonts/JetBrainsMono-Regular.ttf")),
        ]).unwrap();
        let (h,view)=gpui_kit::open_window(WindowOptions {show:visible,focus:!probe,window_bounds:Some(WindowBounds::Windowed(Bounds::centered(None,size(px(1180.),px(820.)),cx))),inactive_frame_interval:None,..Default::default()},cx,|w,cx| {
            w.set_window_title("Conversation study · GPUI");
            cx.new(|cx|Chat::new(w,cx))
        }).unwrap();
        if !probe {cx.activate(true);}
        cx.on_window_closed(|cx,_|{if cx.windows().is_empty(){cx.quit();}}).detach();
        if probe {
            let frames=std::rc::Rc::new(std::cell::RefCell::new(vec![]));
            let next=frames.clone();
            if visible {cx.update_window(h,|_,w,_|w.on_next_frame(move|w,cx|frame_tick(w,cx,Instant::now(),cpu_ms(),next))).unwrap();}
            cx.spawn(async move|cx| {
                let _resources=resources::Samples::start(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../output/gpui-resources.json"));
                cx.background_executor().timer(Duration::from_secs(2)).await;
                let mut runs=vec![];
                for run in 0..6 {
                    cx.update_window(h,|_,_,cx|view.update(cx,|v,cx|v.begin(cx))).unwrap();
                    let mut draws=vec![];
                    let replay_start=Instant::now();
                    for tick in 0..100 {
                        let next=replay_start+Duration::from_secs_f64((tick+1) as f64/30.);
                        cx.background_executor().timer(next.saturating_duration_since(Instant::now())).await;
                        let sample=cx.update_window(h,|_,w,cx| {
                            let cpu=cpu_ms();let at=Instant::now();
                            view.update(cx,|v,cx|v.tick(cx));
                            w.draw(cx).clear(cx);
                            json!({"draw_wall_ms":at.elapsed().as_secs_f64()*1000.,"main_cpu_ms":cpu_ms()-cpu})
                        }).unwrap();draws.push(sample);
                    }
                    runs.push(json!({"run":run,"wall_ms":replay_start.elapsed().as_secs_f64()*1000.,"draw_only_samples":draws}));
                    cx.background_executor().timer(Duration::from_millis(500)).await;
                }
                let output=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../output/gpui-probe.json");
                std::fs::create_dir_all(output.parent().unwrap()).unwrap();
                std::fs::write(output,serde_json::to_vec_pretty(&json!({"backend":"GPUI Kit matched primitives","visible":visible,"runs_including_warmup":runs,"real_window_frame_callbacks":*frames.borrow(),"not_measured":"OS-event-to-present / compositor latency; synchronous draw excludes presentation"})).unwrap()).unwrap();
                cx.update(|cx|cx.quit());
            }).detach();
        }
    });
}

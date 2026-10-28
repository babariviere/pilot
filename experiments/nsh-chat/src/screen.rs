//! The complete experiment, written in Rust. No JS VM or TSX compiler.
use crate::model::{Fixture, Message};
use nsh_base::{MarkdownOptions, input, text_view};
use nsh_core::{element::Root, geometry::Percentage, prelude::*};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

struct Bus {
    commands: tokio::sync::mpsc::UnboundedReceiver<String>,
    reports: mpsc::Sender<Value>,
    inputs: mpsc::Sender<Value>,
}
static PROBE: Mutex<Option<Bus>> = Mutex::new(None);
pub struct Probe {
    pub commands: tokio::sync::mpsc::UnboundedSender<String>,
    pub reports: mpsc::Receiver<Value>,
    pub inputs: mpsc::Receiver<Value>,
}
/// A single standalone fixture window, not a general host integration API.
pub fn probe() -> Probe {
    let (commands, rx) = tokio::sync::mpsc::unbounded_channel();
    let (reports, out) = mpsc::channel();
    let (inputs, input) = mpsc::channel();
    *PROBE.lock().unwrap() = Some(Bus {
        commands: rx,
        reports,
        inputs,
    });
    Probe {
        commands,
        reports: out,
        inputs: input,
    }
}

pub fn root() -> Root {
    Root::of::<ConversationStudy>()
        .app_id("dev.pilot.synthetic.nsh-chat")
        .font(Arc::<[u8]>::from(
            include_bytes!("../../../apps/desktop/assets/fonts/Inter-Regular.ttf").as_slice(),
        ))
        .font(Arc::<[u8]>::from(
            include_bytes!("../../../apps/desktop/assets/fonts/Inter-SemiBold.ttf").as_slice(),
        ))
        .font(Arc::<[u8]>::from(
            include_bytes!("../../../apps/desktop/assets/fonts/JetBrainsMono-Regular.ttf")
                .as_slice(),
        ))
}

fn page() -> AdaptiveColor {
    AdaptiveColor::rgb(0xffffff, 0x23262c)
}
fn sidebar() -> AdaptiveColor {
    AdaptiveColor::rgb(0xf6f8fb, 0x1c1f24)
}
fn tray() -> AdaptiveColor {
    AdaptiveColor::rgb(0xf1f4f8, 0x2a2e35)
}
fn card() -> AdaptiveColor {
    AdaptiveColor::rgb(0xffffff, 0x363b44)
}
fn ink() -> AdaptiveColor {
    AdaptiveColor::rgb(0x1f2633, 0xd6dbe3)
}
fn meta() -> AdaptiveColor {
    AdaptiveColor::rgb(0x5f6b7d, 0xa3acba)
}
fn accent() -> AdaptiveColor {
    AdaptiveColor::rgb(0x2f6fc6, 0x7db9e8)
}

fn action(label: &'static str, primary: bool, f: impl Fn(&()) + 'static) -> impl IntoElement {
    view()
        .role(AccessibilityRole::Button)
        .label(label)
        .on_press(f)
        .h(px(30.))
        .px(px(10.))
        .justify_center()
        .rounded(px(6.))
        .bg(move || if primary { accent() } else { page() })
        .child(text(label).text_size(px(12.)).text_color(move || {
            if primary {
                AdaptiveColor::rgb(0xffffff, 0x1c1f24)
            } else {
                meta()
            }
        }))
}

#[derive(Clone, Copy)]
struct Pane {
    id: usize,
    rows: Signal<Vec<Message>>,
    draft: Signal<String>,
    list: ElementRef,
    input: ElementRef,
    offset: Signal<f32>,
    gap: Signal<f32>,
}
#[derive(Clone, Copy)]
struct Ui {
    owner: Owner,
    timers: Stored<[Option<Spawned<()>>; 2]>,
    fixture: Signal<Fixture>,
    selected: Signal<usize>,
    panel: Signal<&'static str>,
    composing: Signal<bool>,
    pane: Signal<Option<Pane>>,
    report: Signal<Option<mpsc::Sender<Value>>>,
    input_report: Signal<Option<mpsc::Sender<Value>>>,
}
impl Ui {
    fn command(self, name: &str) {
        if name == "chat0" || name == "chat1" {
            if !self.composing.get_untracked() {
                self.selected.set(usize::from(name == "chat1"));
            }
            return;
        }
        if name == "source" || name == "mission" {
            self.panel.set(if name == "source" {
                "source"
            } else {
                "mission"
            });
            return;
        }
        if name == "close" {
            self.panel.set("");
        }
        let Some(p) = self.pane.get_untracked() else {
            return;
        };
        match name {
            "focus" | "close" => p.input.focus(),
            "state" => {
                if let Some(tx) = self.report.get_untracked() {
                    let _=tx.send(json!({"chat":p.id,"draft":p.draft.get_untracked(),"composing":self.composing.get_untracked(),"rows":p.rows.with_untracked(Vec::len),"last":p.rows.with_untracked(|r|r.last().cloned()),"offset":p.offset.get_untracked(),"endGap":p.gap.get_untracked(),"streaming":self.fixture.with_untracked(|f|f.chats[p.id].streaming)}));
                }
            }
            "latest" => p.list.scroll_to_end(false),
            "restore" => {
                let value = "Restored 日本語 👩🏽‍💻".to_owned();
                p.draft.set(value.clone());
                self.fixture.update(|f| f.chats[p.id].draft = value);
            }
            "selection-fixture" => {
                self.fixture.update(|f| {
                    let messages = &mut f.chats[p.id].messages;
                    let end = messages.len();
                    for (row, text) in messages[end - 2..].iter_mut().zip([
                        "Selection alpha 日本語 👩🏽‍💻 e\u{301}",
                        "Selection beta العربية 한국어",
                    ]) {
                        row.text = text.into();
                        row.visual = false;
                        row.image = false;
                    }
                });
                p.rows.set(
                    self.fixture
                        .with_untracked(|f| f.chats[p.id].visible().to_vec()),
                );
                p.list.scroll_to_end(false);
            }
            "hold" => p.list.scroll_to_index(
                p.rows.with_untracked(|r| r.len().saturating_sub(10)) as u32,
                Percentage(0.),
                px(0.),
                false,
            ),
            "older" => {
                self.fixture.update(|f| f.chats[p.id].prepend());
                p.rows.set(
                    self.fixture
                        .with_untracked(|f| f.chats[p.id].visible().to_vec()),
                );
            }
            "replay" => self.replay(p),
            "stop" => {
                self.timers.with(|t| {
                    if let Some(task) = t[p.id].take() {
                        task.cancel();
                    }
                });
                self.fixture.update(|f| f.chats[p.id].streaming = false);
            }
            "send" => {
                if self.composing.get_untracked() || p.draft.with_untracked(|d| d.trim().is_empty())
                {
                    return;
                }
                let text = p.draft.get_untracked();
                self.fixture.update(|f| {
                    let c = &mut f.chats[p.id];
                    c.messages.push(Message {
                        id: format!("{}:{}", c.id, c.messages.len()),
                        mine: true,
                        text,
                        image: false,
                        visual: false,
                    });
                    c.draft.clear();
                });
                p.rows.set(
                    self.fixture
                        .with_untracked(|f| f.chats[p.id].visible().to_vec()),
                );
                p.draft.set(String::new());
                p.list.scroll_to_end(false);
                p.input.focus();
            }
            _ => {}
        }
    }
    fn replay(self, p: Pane) {
        if self.fixture.with_untracked(|f| f.chats[p.id].streaming) {
            return;
        }
        self.fixture.update(|f| f.chats[p.id].begin());
        p.rows.set(
            self.fixture
                .with_untracked(|f| f.chats[p.id].visible().to_vec()),
        );
        self.run_ticks(p);
    }
    fn run_ticks(self, p: Pane) {
        self.timers.with(|t| {
            if let Some(task) = t[p.id].take() {
                task.cancel();
            }
            t[p.id] = Some(self.owner.run(|| {
                spawn(async move {
                    loop {
                        timer(Duration::from_secs_f64(1. / 30.)).await;
                        let mut row = None;
                        self.fixture.update(|f| row = f.chats[p.id].advance());
                        let Some(row) = row else {
                            break;
                        };
                        if let Some(current) = self
                            .pane
                            .get_untracked()
                            .filter(|current| current.id == p.id)
                        {
                            current.rows.update(|r| *r.last_mut().unwrap() = row);
                        }
                    }
                })
            }));
        });
    }
}

#[component]
pub fn ConversationStudy() -> impl IntoElement {
    let ui = Ui {
        owner: Owner::current(),
        timers: stored([None, None]),
        fixture: signal_with(Fixture::default(), SignalEquals::Never),
        selected: signal(0),
        panel: signal(""),
        composing: signal(false),
        pane: signal_with(None, SignalEquals::Never),
        report: signal_with(None, SignalEquals::Never),
        input_report: signal_with(None, SignalEquals::Never),
    };
    if let Some(mut bus) = PROBE.lock().unwrap().take() {
        ui.report.set(Some(bus.reports));
        ui.input_report.set(Some(bus.inputs));
        spawn(async move {
            while let Some(cmd) = bus.commands.recv().await {
                ui.command(&cmd);
            }
        });
    }
    view().flex_1().flex_row().bg(page).font_family("Inter").text_color(ink)
        .child(view().w(px(206.)).bg(sidebar).p_4().gap_2()
            .child(text("Conversations").text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).mb(px(24.)))
            .children((0..2).map(move|id|view().role(AccessibilityRole::Button)
                .label(if id==0{"Open reading surface"}else{"Open another thought"})
                .on_press(move|_:&()|ui.command(if id==0{"chat0"}else{"chat1"}))
                .p(px(10.)).gap(px(6.)).rounded(px(7.)).bg(move||if ui.selected.get()==id{tray()}else{sidebar()})
                .child(text(if id==0{"A calmer conversation"}else{"Another thought"}).text_size(px(13.)))
                .child(text(if id==0{"10,000 synthetic messages"}else{"1,000 synthetic messages"}).text_size(px(11.)).text_color(meta))))
            .child(view().flex_1())
            .child(text("Standalone Rust AppKit experiment\nSynthetic data only").text_size(px(11.)).line_height(px(17.)).text_color(meta)))
        .child(view().flex_1().min_w(px(0.))
            .child(view().h(px(64.)).px(px(24.)).flex_row().items_center().gap_2()
                .child(view().flex_1().gap(px(3.))
                    .child(text(move||if ui.selected.get()==0{"A calmer conversation"}else{"Another thought"}).text_size(px(15.)).font_weight(FontWeight::SEMIBOLD))
                    .child(text("Native chat study · Local fixture").text_size(px(11.)).text_color(meta)))
                .child(action("Source",false,move|_|ui.command("source")))
                .child(action("Edit mission",false,move|_|ui.command("mission"))))
            .child(when(move||ui.selected.get()==0,move||conversation(ui,0)).otherwise(move||conversation(ui,1))))
        .child(when(move||!ui.panel.get().is_empty(),move||view().w(px(310.)).bg(sidebar).p(px(20.)).gap(px(20.))
            .child(view().flex_row().items_center().child(text(move||if ui.panel.get()=="source"{"Native visual"}else{"Edit mission"}).flex_1().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD))
                .child(action("Close",false,move|_|ui.command("close"))))
            .child(when(move||ui.panel.get()=="source",move||scroll().flex_1().child(view().selectable(true).gap(px(20.)).child(visual())
                .child(text("{ \"type\": \"bars\", \"title\": \"Replay cadence\", \"values\": [24,30,27,30] }").select_text().font_family("JetBrains Mono").text_size(px(12.)).line_height(px(19.)))
                .child(text("Fixture source, revision 1. Native views, no browser or generated code.").text_size(px(11.)).text_color(meta))))
                .otherwise(move||mission(ui)))))
}

fn visual() -> impl IntoElement {
    view()
        .gap(px(10.))
        .py(px(12.))
        .child(
            text("Replay cadence")
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD),
        )
        .child(
            view()
                .h(px(74.))
                .flex_row()
                .items_end()
                .gap(px(12.))
                .children([24, 30, 27, 30].map(|v| {
                    view()
                        .flex_1()
                        .gap(px(5.))
                        .items_center()
                        .child(
                            view()
                                .w_full()
                                .h(px(v as f32 * 1.5))
                                .rounded(px(3.))
                                .bg(accent),
                        )
                        .child(
                            text(format!("{v} updates/s"))
                                .text_size(px(11.))
                                .text_color(meta),
                        )
                })),
        )
}

fn conversation(ui: Ui, id: usize) -> impl IntoElement {
    let rows = signal(
        ui.fixture
            .with_untracked(|f| f.chats[id].visible().to_vec()),
    );
    let draft = signal(ui.fixture.with_untracked(|f| f.chats[id].draft.clone()));
    let p = Pane {
        id,
        rows,
        draft,
        list: element_ref(),
        input: element_ref(),
        offset: signal(0.),
        gap: signal(0.),
    };
    ui.pane.set(Some(p));
    let document = element_ref();
    view()
        .flex_1()
        .min_h(px(0.))
        .child(
            view()
                .flex_1()
                .min_h(px(0.))
                .selectable(true)
                .focusable(true)
                .test_id("transcript-selection")
                .element_ref(&document)
                .on_press(|_: &()| {})
                .on_press_down(move |_: &()| {
                    if !ui.composing.get_untracked() {
                        p.input.blur();
                        document.focus();
                    }
                })
                .child(
                    virtual_list(
                        move || rows.with(Vec::len),
                        move |at| {
                            let row = computed(move || rows.with(|r| r[at.index()].clone()));
                            view()
                                .label(move || {
                                    SharedString::from(format!(
                                        "message-{}",
                                        row.with(|r| r.id.clone())
                                    ))
                                })
                                .w_full()
                                .max_w(px(900.))
                                .self_center()
                                .gap(px(12.))
                                .style_when(
                                    move || row.with(|r| r.mine),
                                    |v| {
                                        v.self_end()
                                            .max_w(relative(0.82))
                                            .bg(tray)
                                            .rounded(px(12.))
                                            .p(px(12.))
                                    },
                                )
                                .child(
                                    text_view()
                                        .markdown(move || {
                                            Some(SharedString::from(row.with(|r| r.text.clone())))
                                        })
                                        .options(move || MarkdownOptions {
                                            streaming: ui.fixture.with(|f| f.chats[id].streaming)
                                                && row.with(|r| {
                                                    r.id == rows
                                                        .with(|all| all.last().unwrap().id.clone())
                                                }),
                                            ..Default::default()
                                        })
                                        .selectable(true)
                                        .font_family("Inter")
                                        .text_size(px(15.))
                                        .line_height(px(23.))
                                        .text_color(ink)
                                        .gap(px(12.)),
                                )
                                .child(when(move || row.with(|r| r.visual), visual))
                                .child(when(
                                    move || row.with(|r| r.image),
                                    || {
                                        let width = signal(520.);
                                        let ratio = signal(None::<f32>);
                                        image("asset:/experiments/nsh-chat/fixture.png")
                                            .w_full()
                                            .max_w(px(520.))
                                            .h(move || {
                                                px(ratio.get().map_or(48., |r| width.get() * r))
                                            })
                                            .on_layout(move |b: &Bounds<Points>| {
                                                width.set(b.size.width.0)
                                            })
                                            .on_load(
                                                move |size: &Size<
                                                    nsh_core::geometry::DevicePixels,
                                                >| {
                                                    ratio.set(Some(
                                                        size.height.0 as f32 / size.width.0 as f32,
                                                    ))
                                                },
                                            )
                                    },
                                ))
                        },
                    )
                    .keys(move || rows.with(|r| r.iter().map(|r| r.id.clone()).collect::<Vec<_>>()))
                    .initial_scroll_index(rows.with_untracked(|r| r.len() - 3))
                    .estimated_item_size(px(125.))
                    .follow_end(px(24.))
                    .flex_1()
                    .test_id("history")
                    .element_ref(&p.list)
                    .content_padding_x(px(28.))
                    .content_padding_y(px(20.))
                    .row_gap(px(24.))
                    .on_scroll(move |e: &ScrollEvent| {
                        p.offset.set(e.offset.y.0);
                        p.gap
                            .set(e.content_size.height.0 - e.size.height.0 - e.offset.y.0);
                    }),
                ),
        )
        .child(
            view()
                .flex_row()
                .justify_center()
                .h(px(34.))
                .items_center()
                .gap(px(10.))
                .child(action("Earlier", false, move |_| ui.command("older")))
                .child(when(
                    move || p.gap.get() > 30.,
                    move || action("Latest", false, move |_| ui.command("latest")),
                ))
                .child(action("Replay response", false, move |_| {
                    ui.command("replay")
                }))
                .child(when(
                    move || ui.fixture.with(|f| f.chats[id].streaming),
                    move || action("Stop replay", false, move |_| ui.command("stop")),
                )),
        )
        .child(
            view()
                .bg(tray)
                .px(px(16.))
                .py(px(12.))
                .gap(px(4.))
                .child(
                    input()
                        .multiline(true)
                        .submit_behavior(SubmitBehavior::Submit)
                        .test_id("composer")
                        .label("Message")
                        .element_ref(&p.input)
                        .value(move || draft.get())
                        .placeholder("Write a message…")
                        .on_change(move |value: &str| {
                            draft.set(value.to_owned());
                            ui.fixture.update(|f| f.chats[id].draft = value.into());
                            if let Some(tx) = ui.input_report.get_untracked() {
                                let _ = tx.send(json!({"chat":id,"length":value.len()}));
                            }
                        })
                        .on_composition_change(move |e: &Composition| ui.composing.set(e.composing))
                        .on_submit(move |_: &str| ui.command("send"))
                        .min_h(px(54.))
                        .max_h(px(180.))
                        .p(px(12.))
                        .rounded(px(9.))
                        .font_family("Inter")
                        .text_size(px(15.))
                        .line_height(px(22.))
                        .bg(card)
                        .text_color(ink)
                        .caret_color(|| color(accent()))
                        .selection_color(|| color(accent())),
                )
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .child(
                            text("AppKit native editor · Rust")
                                .flex_1()
                                .text_size(px(11.))
                                .text_color(meta),
                        )
                        .child(action("Send", true, move |_| ui.command("send"))),
                ),
        )
}

fn mission(ui: Ui) -> impl IntoElement {
    let title = signal(ui.fixture.with_untracked(|f| f.mission_title.clone()));
    let goal = signal(ui.fixture.with_untracked(|f| f.mission_goal.clone()));
    let saved = signal(false);
    view()
        .gap(px(12.))
        .child(text("Title").text_size(px(12.)).text_color(meta))
        .child(
            input()
                .label("Mission title")
                .value(move || title.get())
                .on_change(move |v: &str| {
                    title.set(v.into());
                    saved.set(false);
                })
                .p(px(10.))
                .rounded(px(6.))
                .bg(card)
                .text_color(ink)
                .text_size(px(13.)),
        )
        .child(text("Goal").text_size(px(12.)).text_color(meta))
        .child(
            input()
                .label("Mission goal")
                .multiline(true)
                .value(move || goal.get())
                .on_change(move |v: &str| {
                    goal.set(v.into());
                    saved.set(false);
                })
                .h(px(120.))
                .p(px(10.))
                .rounded(px(6.))
                .bg(card)
                .text_color(ink)
                .text_size(px(13.)),
        )
        .child(action("Save changes", true, move |_| {
            if !title.with_untracked(|s| s.trim().is_empty()) {
                ui.fixture.update(|f| {
                    f.mission_title = title.get_untracked().trim().into();
                    f.mission_goal = goal.get_untracked();
                });
                saved.set(true);
            }
        }))
        .child(when(
            move || saved.get(),
            || {
                text("Saved in this synthetic process.")
                    .text_size(px(12.))
                    .text_color(meta)
            },
        ))
}

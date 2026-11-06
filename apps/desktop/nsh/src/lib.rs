//! Native chat migration using Pilot's shipping Local reader, courier and Store.
#[cfg(feature = "native-probes")]
pub mod fixture;
#[path = "../../../../experiments/nsh-pilot/src/icons.rs"]
mod icons;
#[path = "../../../../experiments/nsh-pilot/src/theme.rs"]
mod theme;

use icons::icon;
use nsh_base::{
    MarkdownOptions, button, input, text_view,
    text_view::{Block, Document, Inline},
};
use nsh_core::{
    element::{
        AnyValue, Children, Component, NoEvent, PropError, PropSpec, Props, Root, Scope, Slot,
        TsTypes,
    },
    prelude::*,
};
use pilot_desktop::{
    LocalOptions,
    nsh_adapter::{Adapter, Location, SidebarRow, Snapshot},
};
use std::{path::PathBuf, sync::Arc};
use theme::*;

/// Native input captured by the macOS embedding host before it requests close.
#[derive(Clone, Debug)]
pub struct CloseInput {
    pub session: Option<String>,
    pub text: Option<String>,
    pub composing: bool,
}

/// Existing connection and state location. No daemon is started by this app.
#[derive(Clone)]
pub struct Config {
    pub options: LocalOptions,
    pub state: PathBuf,
    pub close: async_channel::Receiver<CloseInput>,
    pub closed: async_channel::Sender<()>,
}

/// Build the native root. NSH owns controls, text editing and rendering.
pub fn root(config: Config) -> Root {
    let config = Arc::new(config);
    Root::new::<Workbench>(move || ConnectionProps(Some(config.clone())))
        .app_id("dev.pilot.next.nsh")
        .font(Arc::<[u8]>::from(
            include_bytes!("../../assets/fonts/Inter-Regular.ttf").as_slice(),
        ))
        .font(Arc::<[u8]>::from(
            include_bytes!("../../assets/fonts/Inter-SemiBold.ttf").as_slice(),
        ))
        .font(Arc::<[u8]>::from(
            include_bytes!("../../assets/fonts/JetBrainsMono-Regular.ttf").as_slice(),
        ))
}

#[derive(Clone, Copy)]
struct Ui {
    adapter: Stored<Adapter>,
    snapshot: Signal<Snapshot>,
    composing: Signal<bool>,
}
impl Ui {
    fn publish(self) {
        self.snapshot.set(self.adapter.with(|a| a.snapshot()));
    }
    fn open(self, id: &str) {
        if self.composing.get_untracked() {
            return;
        }
        self.adapter.with(|adapter| {
            adapter.open(id);
        });
        self.publish();
    }
    fn edit(self, location: &Location, value: &str) {
        self.adapter.with(|adapter| {
            adapter.edit(location, value);
        });
        self.publish();
    }
    fn submit(self, location: &Location, value: Option<&str>, stop: bool) {
        if self.composing.get_untracked() {
            return;
        }
        self.adapter.with(|adapter| {
            if let Some(value) = value {
                adapter.edit(location, value);
            }
            if stop {
                adapter.stop(location);
            } else {
                adapter.send(location);
            }
        });
        self.publish();
    }
}

fn label(value: impl IntoReactive<SharedString>, size: f32) -> nsh_core::element::Text {
    text(value).text_size(px(size))
}
fn plain(value: String) -> Document {
    Document::new(vec![Block::Paragraph {
        content: vec![Inline::Text { text: value }],
    }])
}
fn inactive(title: &'static str, glyph: &'static str) -> impl IntoElement {
    button()
        .disabled(true)
        .accessibility_label(format!("{title}, unavailable in this chat slice"))
        .h(px(32.))
        .px(px(10.))
        .flex_row()
        .items_center()
        .gap(px(10.))
        .child(icon(glyph).text_color(META))
        .child(label(title, 13.).text_color(META))
}
fn sidebar_row(ui: Ui, row: SidebarRow) -> impl IntoElement {
    let id = row.session.clone();
    let action = row.clone();
    button()
        .accessibility_label(
            id.as_ref()
                .map(|id| format!("Open chat {id}"))
                .unwrap_or_else(|| row.title.clone()),
        )
        .selected(move || {
            id.as_ref().is_some_and(|id| {
                ui.snapshot
                    .with(|s| s.location.as_ref().is_some_and(|l| &l.session == id))
            })
        })
        .on_press(move || {
            if let Some(id) = &action.session {
                ui.open(id);
            } else {
                ui.adapter.with(|a| a.toggle(&action.key));
                ui.publish();
            }
        })
        .min_h(px(if row.heading { 32. } else { 50. }))
        .px(px(10. + row.depth as f32 * 16.))
        .py(px(7.))
        .rounded(px(6.))
        .bg(move || {
            if row.session.as_ref().is_some_and(|id| {
                ui.snapshot
                    .with(|s| s.location.as_ref().is_some_and(|l| &l.session == id))
            }) {
                SELECTED
            } else {
                SIDEBAR
            }
        })
        .child(
            view()
                .gap(px(4.))
                .min_w(px(0.))
                .child(
                    label(row.title, if row.heading { 11. } else { 13. })
                        .font_weight(if row.heading {
                            FontWeight::SEMIBOLD
                        } else {
                            FontWeight::NORMAL
                        })
                        .number_of_lines(1),
                )
                .child(when(!row.detail.is_empty(), move || {
                    label(row.detail.clone(), 11.)
                        .text_color(META)
                        .number_of_lines(1)
                })),
        )
}
fn sidebar(ui: Ui) -> impl IntoElement {
    view()
        .w(px(248.))
        .min_w(px(220.))
        .min_h(px(0.))
        .bg(SIDEBAR)
        .border_r_1()
        .border_color(LINE)
        .p(px(8.))
        .child(inactive("Home", "home"))
        .child(inactive("Inbox", "inbox"))
        .child(inactive("Review", "review"))
        .child(inactive("Missions", "missions"))
        .child(inactive("Automations", "automations"))
        .child(
            input()
                .test_id("chat-search")
                .label("Find chats")
                .placeholder("Find chats")
                .on_change(move |value: &str| {
                    ui.adapter.with(|a| a.search(value));
                    ui.publish();
                })
                .h(px(28.))
                .px(px(10.))
                .text_size(px(12.))
                .bg(SIDEBAR)
                .text_color(INK),
        )
        .child(scroll().flex_1().min_h(px(0.)).child(each(
            move || ui.snapshot.with(|s| s.sidebar.clone()),
            |row| row.key.clone(),
            move |row, _| sidebar_row(ui, row.get()),
        )))
        .child(label("NSH · Chat slice", 10.).p(px(10.)).text_color(META))
        .child(inactive("Settings", "settings"))
}

fn conversation(ui: Ui, location: Location) -> impl IntoElement {
    let list = element_ref();
    let editor = element_ref();
    let gap = signal(0_f32);
    let edit_location = location.clone();
    let send_location = location.clone();
    let stop_location = location.clone();
    let earlier_location = location.clone();
    let follow_location = location.clone();
    view()
        .flex_1()
        .min_w(px(0.))
        .min_h(px(0.))
        .child(
            view()
                .h(px(62.))
                .px(px(24.))
                .flex_row()
                .items_center()
                .border_b_1()
                .border_color(LINE)
                .child(
                    view()
                        .flex_1()
                        .min_w(px(0.))
                        .gap(px(4.))
                        .child(
                            label(move || ui.snapshot.with(|s| s.title.clone()), 15.)
                                .font_weight(FontWeight::SEMIBOLD)
                                .number_of_lines(1),
                        )
                        .child(
                            label(move || ui.snapshot.with(|s| s.project.clone()), 11.)
                                .text_color(META),
                        ),
                ),
        )
        .child(when(
            move || ui.snapshot.with(|s| s.earlier),
            move || {
                let location = earlier_location.clone();
                button()
                    .accessibility_label("Earlier messages")
                    .disabled(move || ui.snapshot.with(|s| s.loading_earlier))
                    .on_press(move || {
                        ui.adapter.with(|a| {
                            a.earlier(&location);
                        });
                    })
                    .h(px(28.))
                    .child(label("Earlier messages", 11.).text_color(META))
            },
        ))
        .child(
            view().flex_1().min_h(px(0.)).selectable(true).child(
                virtual_list(
                    move || ui.snapshot.with(|s| s.messages.len()),
                    move |at| {
                        let row = computed(move || {
                            ui.snapshot.with(|s| s.messages.get(at.index()).cloned())
                        });
                        view()
                            .w_full()
                            .max_w(px(912.))
                            .self_center()
                            .gap(px(10.))
                            .style_when(
                                move || row.with(|r| r.as_ref().is_some_and(|m| m.mine)),
                                |v| {
                                    v.self_end()
                                        .w(nsh_core::geometry::auto())
                                        .max_w(relative(0.85))
                                        .rounded(px(12.))
                                        .p(px(14.))
                                        .bg(TRAY)
                                },
                            )
                            .child(
                                text_view()
                                    .markdown(move || {
                                        row.with(|r| {
                                            r.as_ref()
                                                .filter(|m| !m.plain)
                                                .map(|m| SharedString::from(m.source.clone()))
                                        })
                                    })
                                    .document(move || {
                                        row.with(|r| {
                                            r.as_ref()
                                                .filter(|m| m.plain)
                                                .map(|m| plain(m.source.clone()))
                                        })
                                    })
                                    .options(move || MarkdownOptions {
                                        streaming: ui.snapshot.with(|s| {
                                            s.working
                                                && row.with(|r| {
                                                    r.as_ref().is_some_and(|m| {
                                                        Some(m.id)
                                                            == s.messages.last().map(|m| m.id)
                                                    })
                                                })
                                        }),
                                        ..Default::default()
                                    })
                                    .selectable(true)
                                    .font_family("Inter")
                                    .text_size(px(15.))
                                    .line_height(px(23.))
                                    .text_color(INK)
                                    .gap(px(12.)),
                            )
                    },
                )
                .test_id("transcript")
                .element_ref(&list)
                .flex_1()
                .keys(move || {
                    ui.snapshot
                        .with(|s| s.messages.iter().map(|m| m.id).collect::<Vec<_>>())
                })
                .estimated_item_size(px(200.))
                .follow_end(px(24.))
                .content_padding_x(px(24.))
                .content_padding_y(px(26.))
                .row_gap(px(28.))
                .on_scroll(move |event: &ScrollEvent| {
                    let remaining =
                        event.content_size.height.0 - event.size.height.0 - event.offset.y.0;
                    gap.set(remaining);
                    ui.adapter
                        .with(|a| a.follow(&follow_location, remaining < 40.));
                }),
            ),
        )
        .child(when(
            move || gap.get() > 40.,
            move || {
                button()
                    .accessibility_label("Latest message")
                    .h(px(28.))
                    .on_press(move || list.scroll_to_end(false))
                    .child(label("Latest", 12.))
            },
        ))
        .child(when(
            move || ui.snapshot.with(|s| s.problem.is_some()),
            move || {
                label(
                    move || ui.snapshot.with(|s| s.problem.clone().unwrap_or_default()),
                    12.,
                )
                .px(px(24.))
                .py(px(8.))
                .text_color(WARNING)
            },
        ))
        .child(each(
            move || ui.snapshot.with(|s| s.recovered.clone()),
            |text| text.clone(),
            move |text, _| {
                view()
                    .px(px(24.))
                    .py(px(8.))
                    .selectable(true)
                    .child(label("Recovered text", 11.).text_color(META))
                    .child(
                        text_view()
                            .document(Some(plain(text.get())))
                            .selectable(true)
                            .text_size(px(13.))
                            .text_color(INK),
                    )
            },
        ))
        .child(
            view().bg(TRAY).px(px(16.)).py(px(6.)).items_center().child(
                view()
                    .w_full()
                    .max_w(px(928.))
                    .gap(px(4.))
                    .child(
                        input()
                            .test_id("composer")
                            .label(format!("Message in {}", location.session))
                            .element_ref(&editor)
                            .multiline(true)
                            .submit_behavior(SubmitBehavior::Submit)
                            .value(move || ui.snapshot.with(|s| s.text.clone()))
                            .disabled(move || !ui.snapshot.with(|s| s.editable))
                            .placeholder("Message…")
                            .on_change(move |value: &str| ui.edit(&edit_location, value))
                            .on_composition_change(move |event: &Composition| {
                                ui.composing.set(event.composing)
                            })
                            .on_submit(move |value: &str| {
                                ui.submit(&send_location, Some(value), false)
                            })
                            .min_h(px(34.))
                            .max_h(px(150.))
                            .px(px(10.))
                            .py(px(7.))
                            .rounded(px(6.))
                            .bg(CARD)
                            .text_color(INK)
                            .font_family("Inter")
                            .text_size(px(13.))
                            .line_height(px(20.))
                            .caret_color(|| color(ACCENT))
                            .selection_color(|| color(ACCENT)),
                    )
                    .child(
                        view()
                            .h(px(26.))
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                label(
                                    move || {
                                        ui.snapshot.with(|s| {
                                            if s.thinking {
                                                "Thinking…".into()
                                            } else {
                                                s.status.clone()
                                            }
                                        })
                                    },
                                    11.,
                                )
                                .text_color(META)
                                .flex_1(),
                            )
                            .child(when(
                                move || ui.snapshot.with(|s| s.can_stop),
                                move || {
                                    let location = stop_location.clone();
                                    button()
                                        .accessibility_label("Stop reply")
                                        .h(px(26.))
                                        .px(px(8.))
                                        .rounded(px(5.))
                                        .bg(CARD)
                                        .flex_row()
                                        .gap(px(6.))
                                        .items_center()
                                        .on_press(move || ui.submit(&location, None, true))
                                        .child(icon("stop").size(px(12.)))
                                        .child(label("Stop", 11.))
                                },
                            ))
                            .child(
                                button()
                                    .accessibility_label("Send message")
                                    .disabled(move || {
                                        ui.composing.get() || !ui.snapshot.with(|s| s.can_send)
                                    })
                                    .size(px(26.))
                                    .rounded(px(6.))
                                    .items_center()
                                    .justify_center()
                                    .bg(move || {
                                        if ui.snapshot.with(|s| s.can_send) {
                                            ACCENT
                                        } else {
                                            SELECTED
                                        }
                                    })
                                    .on_press(move || {
                                        ui.submit(&location, None, false);
                                        editor.focus();
                                    })
                                    .child(
                                        icon("send")
                                            .size(px(15.))
                                            .text_color(AdaptiveColor::rgb(0xffffff, 0x1c1f24)),
                                    ),
                            ),
                    ),
            ),
        )
}

// Rust-only connection props. No script/JSON conversion or global connection.
#[derive(Clone)]
struct ConnectionProps(Option<Arc<Config>>);
impl PartialEq for ConnectionProps {
    fn eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }
}
impl Props for ConnectionProps {
    fn spec(types: &mut TsTypes) -> Vec<PropSpec> {
        <() as Props>::spec(types)
    }
    fn initial() -> Self {
        Self(None)
    }
    fn set(&mut self, name: &str, value: Option<AnyValue>) -> Result<bool, PropError> {
        ().set(name, value)
    }
    fn set_slot(&mut self, _name: &str, _slot: Option<Slot>) -> bool {
        false
    }
    fn set_children(&mut self, _children: Children) -> bool {
        false
    }
}
struct Workbench;
impl Component for Workbench {
    type Props = ConnectionProps;
    type Event = NoEvent;
    fn view(props: Self::Props, _cx: Scope<Self::Event>) -> impl IntoElement {
        workbench(
            props
                .0
                .expect("Rust root connection props")
                .as_ref()
                .clone(),
        )
    }
}
fn workbench(config: Config) -> impl IntoElement {
    use nsh_core::{
        desktop::MenuRole,
        element::desktop::{MenuItem, set_application_menu},
    };
    set_application_menu(Some(vec![
        MenuItem::submenu(
            "Pilot Next",
            [
                MenuItem::role(MenuRole::Hide),
                MenuItem::separator(),
                MenuItem::role(MenuRole::Quit),
            ],
        ),
        MenuItem::submenu(
            "Edit",
            [
                MenuItem::role(MenuRole::Undo),
                MenuItem::role(MenuRole::Redo),
                MenuItem::separator(),
                MenuItem::role(MenuRole::Cut),
                MenuItem::role(MenuRole::Copy),
                MenuItem::role(MenuRole::Paste),
                MenuItem::role(MenuRole::SelectAll),
            ],
        ),
        MenuItem::submenu(
            "Window",
            [
                MenuItem::role(MenuRole::Minimize),
                MenuItem::role(MenuRole::Close),
            ],
        ),
    ]));
    let adapter = stored(Adapter::start(config.options, config.state));
    let snapshot = signal(adapter.with(|a| a.snapshot()));
    let ui = Ui {
        adapter,
        snapshot,
        composing: signal(false),
    };
    let events = adapter.with(|a| a.events());
    let close = config.close;
    let closed = config.closed;
    let _worker = stored(Some(spawn(async move {
        use futures_util::{FutureExt, select};
        loop {
            let update = events.next().fuse();
            let request = close.recv().fuse();
            futures_util::pin_mut!(update, request);
            select! {
                update = update => match update {
                    Some(update) => { adapter.with(|a| a.accept(update)); ui.publish(); },
                    None => break,
                },
                request = request => {
                    let Ok(request) = request else {break};
                    if !request.composing && !ui.composing.get_untracked() {
                        adapter.with(|a| {
                            let current = a.snapshot().location;
                            if let Some(location) = current {
                                if request.session.as_deref() != Some(location.session.as_str()) {return;}
                                if let Some(text) = request.text && !a.edit(&location,&text) {return;}
                            }
                            a.close();
                        });
                        ui.publish();
                    }
                },
            }
            if snapshot.with_untracked(|s| s.closed) {
                let _ = closed.send(()).await;
                break;
            }
        }
    })));
    view()
        .flex_1()
        .flex_row()
        .bg(PAGE)
        .text_color(INK)
        .font_family("Inter")
        .child(sidebar(ui))
        .child(when(
            move || snapshot.with(|s| s.location.is_none()),
            move || {
                view()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .child(label("Choose a chat", 22.))
            },
        ))
        .child(each(
            move || snapshot.with(|s| s.location.clone().into_iter().collect::<Vec<_>>()),
            |l| l.session.clone(),
            move |location, _| conversation(ui, location.get()),
        ))
}

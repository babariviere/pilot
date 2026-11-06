//! An isolated native reproduction of Pilot's sidebar and conversation.
mod icons;
mod model;
mod theme;

use icons::icon;
use model::Transcript;
use nsh_base::{MarkdownOptions, button, input, text_view};
use nsh_core::{
    element::{Root, View},
    prelude::*,
};
use std::{sync::Arc, time::Duration};
use theme::*;

/// The synthetic workbench root. No live accounts, daemon or persistent state.
pub fn root() -> Root {
    Root::of::<Workbench>()
        .app_id("dev.pilot.synthetic.nsh-workbench")
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

#[derive(Clone, Copy)]
struct Chat {
    id: usize,
    title: &'static str,
    project: &'static str,
    pinned: bool,
    needs_you: bool,
    draft: Signal<String>,
    transcript: Signal<Transcript>,
    task: Stored<Option<Spawned<()>>>,
}

// Chat handles keep their signals and task for the lifetime of this root.
impl PartialEq for Chat {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Chat {
    fn new(id: usize, title: &'static str, project: &'static str, pinned: bool) -> Self {
        Self {
            id,
            title,
            project,
            pinned,
            needs_you: id == 2,
            draft: signal(String::new()),
            transcript: signal(Transcript::fixture(id)),
            task: stored(None),
        }
    }
}

#[derive(Clone, Copy)]
struct Ui {
    owner: Owner,
    chats: Signal<Vec<Chat>>,
    selected: Signal<usize>,
    project: Signal<&'static str>,
    projects_open: Signal<bool>,
    query: Signal<String>,
    composing: Signal<bool>,
}

impl Ui {
    fn open(self, id: usize) {
        // A sidebar press must not discard the native editor's marked text.
        if !self.composing.get_untracked() {
            self.selected.set(id);
        }
    }

    fn active(self) -> Chat {
        self.chats.with(|chats| chats[self.selected.get()])
    }

    fn new_chat(self) {
        if self.composing.get_untracked() || self.chats.with_untracked(Vec::len) >= 32 {
            return;
        }
        let id = self.chats.with_untracked(Vec::len);
        let project = match self.project.get_untracked() {
            "All projects" => "Pilot",
            project => project,
        };
        let chat = self.owner.run(|| {
            let chat = Chat::new(id, "New chat", project, false);
            chat.transcript.set(Transcript::empty());
            chat
        });
        self.chats.update(|chats| chats.push(chat));
        self.query.set(String::new());
        self.selected.set(id);
    }

    fn send(self, chat: Chat) {
        if self.composing.get_untracked() {
            return;
        }
        let mut sent = false;
        chat.transcript
            .update(|t| sent = t.send(&chat.draft.get_untracked()));
        if !sent {
            return;
        }
        chat.draft.set(String::new());
        chat.task.with(|task| {
            if let Some(old) = task.take() {
                old.cancel();
            }
            *task = Some(self.owner.run(|| {
                spawn(async move {
                    while chat.transcript.with_untracked(|t| t.streaming) {
                        timer(Duration::from_millis(33)).await;
                        chat.transcript.update(Transcript::advance);
                    }
                })
            }));
        });
    }

    fn stop(self, chat: Chat) {
        chat.task.with(|task| {
            if let Some(task) = task.take() {
                task.cancel();
            }
        });
        chat.transcript.update(Transcript::stop);
    }

    fn visible(self, chat: Chat) -> bool {
        let project = self.project.get();
        let query = self.query.get().to_lowercase();
        (project == "All projects" || project == chat.project)
            && (query.is_empty() || chat.title.to_lowercase().contains(&query))
    }
}

fn label(value: impl IntoReactive<SharedString>, size: f32) -> nsh_core::element::Text {
    text(value).text_size(px(size))
}

fn section(title: &'static str) -> View {
    view().px(px(10.)).pt(px(16.)).pb(px(6.)).child(
        label(title, 11.)
            .text_color(META)
            .font_weight(FontWeight::SEMIBOLD),
    )
}

fn inactive_row(title: &'static str, glyph: &'static str) -> impl IntoElement {
    button()
        .disabled(true)
        .accessibility_label(format!("{title}, outside this prototype"))
        .h(px(32.))
        .px(px(8.))
        .flex_row()
        .items_center()
        .gap(px(10.))
        .child(icon(glyph).text_color(META))
        .child(label(title, 13.).text_color(META))
}

fn chat_row(ui: Ui, chat: Chat) -> impl IntoElement {
    button()
        .accessibility_label(format!("Open {}", chat.title))
        .selected(move || ui.selected.get() == chat.id)
        .on_press(move || ui.open(chat.id))
        .min_h(px(50.))
        .px(px(10.))
        .py(px(8.))
        .rounded(px(6.))
        .gap(px(4.))
        .bg(move || {
            if ui.selected.get() == chat.id {
                SELECTED
            } else {
                SIDEBAR
            }
        })
        .hover(|s| s.bg(SELECTED))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap(px(6.))
                .child(
                    label(chat.title, 13.)
                        .number_of_lines(1)
                        .flex_1()
                        .min_w(px(0.)),
                )
                .child(when(
                    move || chat.transcript.with(|t| t.streaming),
                    || icon("working").size(px(10.)).text_color(META),
                ))
                .child(when(
                    move || chat.needs_you && !chat.transcript.with(|t| t.streaming),
                    || view().size(px(6.)).rounded(px(3.)).bg(WARNING),
                )),
        )
        .child(
            label(
                move || {
                    let draft = chat.draft.get();
                    if !draft.is_empty() {
                        format!("Draft: {}", draft.lines().next().unwrap_or_default())
                    } else if chat.transcript.with(|t| t.streaming) {
                        format!("{} · Working", chat.project)
                    } else if chat.needs_you {
                        format!("{} · Needs you", chat.project)
                    } else {
                        chat.project.into()
                    }
                },
                11.,
            )
            .number_of_lines(1)
            .text_color(META),
        )
}

fn sidebar(ui: Ui) -> impl IntoElement {
    view()
        .test_id("sidebar")
        .w(px(248.))
        .min_w(px(248.))
        .bg(SIDEBAR)
        .border_r_1()
        .border_color(LINE)
        .px(px(10.))
        .pt(px(10.))
        .child(
            view()
                .flex_row()
                .items_center()
                .child(view().flex_1().child(inactive_row("Home", "home")))
                .child(
                    button()
                        .accessibility_label("New chat")
                        .disabled(move || ui.composing.get() || ui.chats.with(Vec::len) >= 32)
                        .size(px(32.))
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .hover(|s| s.bg(SELECTED))
                        .on_press(move || ui.new_chat())
                        .child(icon("new")),
                ),
        )
        .child(inactive_row("Inbox", "inbox"))
        .child(inactive_row("Review", "review"))
        .child(inactive_row("Missions", "missions"))
        .child(inactive_row("Automations", "automations"))
        .child(
            button()
                .accessibility_label("Choose project")
                .on_press(move || ui.projects_open.update(|open| *open = !*open))
                .h(px(34.))
                .mt(px(14.))
                .px(px(8.))
                .rounded(px(6.))
                .flex_row()
                .items_center()
                .gap(px(10.))
                .hover(|s| s.bg(SELECTED))
                .child(icon("projects").text_color(META))
                .child(label(move || ui.project.get(), 13.).flex_1())
                .child(icon("down").size(px(12.)).text_color(META)),
        )
        .child(when(
            move || ui.projects_open.get(),
            move || {
                view()
                    .pl(px(26.))
                    .children(["All projects", "Pilot", "Website"].map(move |project| {
                        button()
                            .accessibility_label(format!("Show {project}"))
                            .h(px(28.))
                            .px(px(8.))
                            .rounded(px(5.))
                            .selected(move || ui.project.get() == project)
                            .hover(|s| s.bg(SELECTED))
                            .on_press(move || {
                                ui.project.set(project);
                                ui.projects_open.set(false);
                            })
                            .child(label(project, 12.))
                    }))
            },
        ))
        .child(
            button()
                .accessibility_label("All chats")
                .on_press(move || {
                    ui.project.set("All projects");
                    ui.query.set(String::new());
                })
                .h(px(32.))
                .px(px(8.))
                .flex_row()
                .items_center()
                .gap(px(10.))
                .child(icon("chats").text_color(META))
                .child(label("All chats", 13.)),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap(px(6.))
                .px(px(8.))
                .pt(px(8.))
                .pb(px(6.))
                .child(icon("search").size(px(13.)).text_color(META))
                .child(
                    input()
                        .test_id("chat-search")
                        .label("Find chats")
                        .placeholder("Find chats")
                        .value(move || ui.query.get())
                        .on_change(move |value: &str| ui.query.set(value.into()))
                        .flex_1()
                        .h(px(26.))
                        .text_size(px(12.))
                        .text_color(INK)
                        .bg(SIDEBAR),
                ),
        )
        .child(
            scroll().flex_1().min_h(px(0.)).child(
                view()
                    .child(section("Pinned"))
                    .child(each(
                        move || {
                            ui.chats.with(|all| {
                                all.iter()
                                    .copied()
                                    .filter(|c| c.pinned && ui.visible(*c))
                                    .collect::<Vec<_>>()
                            })
                        },
                        |chat| chat.id,
                        move |chat, _| chat_row(ui, chat.get()),
                    ))
                    .child(section("Chats"))
                    .child(each(
                        move || {
                            ui.chats.with(|all| {
                                all.iter()
                                    .copied()
                                    .filter(|c| !c.pinned && ui.visible(*c))
                                    .collect::<Vec<_>>()
                            })
                        },
                        |chat| chat.id,
                        move |chat, _| chat_row(ui, chat.get()),
                    ))
                    .child(when(
                        move || ui.chats.with(|all| !all.iter().any(|c| ui.visible(*c))),
                        || label("No matching chats", 12.).p(px(10.)).text_color(META),
                    )),
            ),
        )
        .child(
            view()
                .py(px(12.))
                .px(px(8.))
                .gap(px(8.))
                .child(label("NSH prototype · Synthetic data", 10.).text_color(META))
                .child(inactive_row("Settings", "settings")),
        )
}

fn conversation(ui: Ui, chat: Chat) -> impl IntoElement {
    let list = element_ref();
    let gap = signal(0.0_f32);
    let editor = element_ref();
    view()
        .test_id("conversation")
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
                            label(chat.title, 15.)
                                .font_weight(FontWeight::SEMIBOLD)
                                .number_of_lines(1),
                        )
                        .child(label(format!("{} · Build", chat.project), 11.).text_color(META)),
                )
                .child(label("Local prototype", 11.).text_color(META)),
        )
        .child(when(
            move || chat.transcript.with(|t| t.messages.is_empty()),
            || {
                view()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap(px(10.))
                    .child(
                        label("What would you like to build?", 22.)
                            .font_weight(FontWeight::SEMIBOLD),
                    )
                    .child(
                        label("Write a message to try the synthetic reply.", 12.).text_color(META),
                    )
            },
        ))
        .child(when(
            move || !chat.transcript.with(|t| t.messages.is_empty()),
            move || {
                view().flex_1().min_h(px(0.)).selectable(true).child(
                    virtual_list(
                        move || chat.transcript.with(|t| t.messages.len()),
                        move |at| {
                            let row = computed(move || {
                                chat.transcript
                                    .with(|t| t.messages.get(at.index()).cloned())
                            });
                            view()
                                .w_full()
                                .max_w(px(912.))
                                .self_center()
                                .gap(px(10.))
                                .style_when(
                                    move || row.with(|row| row.as_ref().is_some_and(|m| m.mine)),
                                    |v| {
                                        v.self_end()
                                            .max_w(relative(0.85))
                                            .rounded(px(12.))
                                            .p(px(14.))
                                            .bg(TRAY)
                                    },
                                )
                                .child(
                                    text_view()
                                        .markdown(move || {
                                            row.with(|row| {
                                                row.as_ref()
                                                    .map(|m| SharedString::from(m.text.clone()))
                                            })
                                        })
                                        .options(move || MarkdownOptions {
                                            streaming: chat.transcript.with(|t| {
                                                t.streaming
                                                    && row.with(|r| {
                                                        r.as_ref().is_some_and(|m| {
                                                            Some(m.id)
                                                                == t.messages.last().map(|m| m.id)
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
                        chat.transcript
                            .with(|t| t.messages.iter().map(|m| m.id).collect::<Vec<_>>())
                    })
                    .initial_scroll_index(
                        chat.transcript
                            .with_untracked(|t| t.messages.len().saturating_sub(1)),
                    )
                    .estimated_item_size(px(200.))
                    .follow_end(px(24.))
                    .content_padding_x(px(24.))
                    .content_padding_y(px(26.))
                    .row_gap(px(28.))
                    .on_scroll(move |event: &ScrollEvent| {
                        gap.set(
                            event.content_size.height.0 - event.size.height.0 - event.offset.y.0,
                        )
                    }),
                )
            },
        ))
        .child(when(
            move || gap.get() > 40.,
            move || {
                view().items_center().py(px(4.)).child(
                    button()
                        .accessibility_label("Latest message")
                        .h(px(28.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .bg(TRAY)
                        .on_press(move || list.scroll_to_end(false))
                        .child(label("Latest", 12.)),
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
                            .label("Message")
                            .element_ref(&editor)
                            .multiline(true)
                            .submit_behavior(SubmitBehavior::Submit)
                            .value(move || chat.draft.get())
                            .placeholder("Message…")
                            .on_change(move |value: &str| chat.draft.set(value.into()))
                            .on_composition_change(move |event: &Composition| {
                                ui.composing.set(event.composing)
                            })
                            .on_submit(move |_: &str| ui.send(chat))
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
                                        if chat.transcript.with(|t| t.streaming) {
                                            "Working · Synthetic reply"
                                        } else {
                                            "Build · Local fixture"
                                        }
                                    },
                                    11.,
                                )
                                .text_color(META)
                                .flex_1(),
                            )
                            .child(when(
                                move || chat.transcript.with(|t| t.streaming),
                                move || {
                                    button()
                                        .accessibility_label("Stop reply")
                                        .h(px(26.))
                                        .px(px(8.))
                                        .rounded(px(5.))
                                        .bg(CARD)
                                        .flex_row()
                                        .gap(px(6.))
                                        .items_center()
                                        .on_press(move || ui.stop(chat))
                                        .child(icon("stop").size(px(12.)))
                                        .child(label("Stop", 11.))
                                },
                            ))
                            .child(
                                button()
                                    .accessibility_label("Send message")
                                    .disabled(move || {
                                        ui.composing.get()
                                            || chat.draft.with(|d| d.trim().is_empty())
                                            || chat.transcript.with(|t| t.streaming)
                                    })
                                    .size(px(26.))
                                    .rounded(px(6.))
                                    .items_center()
                                    .justify_center()
                                    .bg(move || {
                                        if chat.draft.with(|d| d.trim().is_empty())
                                            || chat.transcript.with(|t| t.streaming)
                                        {
                                            SELECTED
                                        } else {
                                            ACCENT
                                        }
                                    })
                                    .on_press(move || {
                                        ui.send(chat);
                                        editor.focus();
                                    })
                                    .child(icon("send").size(px(15.)).text_color(move || {
                                        if chat.draft.with(|d| d.trim().is_empty())
                                            || chat.transcript.with(|t| t.streaming)
                                        {
                                            META
                                        } else {
                                            AdaptiveColor::rgb(0xffffff, 0x1c1f24)
                                        }
                                    })),
                            ),
                    ),
            ),
        )
}

#[component]
fn Workbench() -> impl IntoElement {
    let ui = Ui {
        owner: Owner::current(),
        chats: signal(vec![
            Chat::new(0, "Native Shell chat and sidebar", "Pilot", true),
            Chat::new(1, "Keep drafts across navigation", "Pilot", false),
            Chat::new(2, "Review the update flow", "Pilot", false),
            Chat::new(3, "Quiet settings rows", "Pilot", false),
            Chat::new(4, "A clearer getting started page", "Website", false),
            Chat::new(5, "日本語の入力と下書き", "Website", false),
        ]),
        selected: signal(0),
        project: signal("All projects"),
        projects_open: signal(false),
        query: signal(String::new()),
        composing: signal(false),
    };
    view()
        .flex_1()
        .flex_row()
        .bg(PAGE)
        .text_color(INK)
        .font_family("Inter")
        .child(sidebar(ui))
        .child(each(
            move || vec![ui.active()],
            |chat| chat.id,
            move |chat, _| conversation(ui, chat.get()),
        ))
}

#[cfg(test)]
mod tests;

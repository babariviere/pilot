//! Actual named children in the composer; selecting one keeps the
//! same composer entity and a separate durable draft in the main conversation.
use super::*;
use crate::{
    session_subagents::{Child, State, Target},
    ui::{self, Action, Text},
};
use gpui_kit::{FocusHandle, StatefulInteractiveElement};
use std::collections::BTreeSet;

fn current(v: &LocalViewer) -> bool {
    v.state.list_loaded && v.state.status == "Connected · Local"
}
fn status(child: &Child, fresh: bool) -> State {
    if fresh { child.state } else { State::Unknown }
}
pub(super) fn open(
    viewer: Entity<LocalViewer>,
    parent: String,
    name: Option<String>,
    w: &mut Window,
    cx: &mut App,
) {
    let Some(name) = name else {
        return;
    };
    viewer.update(cx, |v, cx| v.open_subagent(&parent, &name, w, cx));
}
impl LocalViewer {
    fn open_subagent(&mut self, parent: &str, name: &str, w: &mut Window, cx: &mut Context<Self>) {
        if !self.project_choices_ready(w, cx) {
            return;
        }
        let Some(chat) = self
            .state
            .chats
            .iter()
            .find(|c| c.id == parent && !c.local_draft)
            .cloned()
        else {
            return;
        };
        let Some(child) = chat
            .subagents
            .children
            .iter()
            .find(|c| c.name == name)
            .cloned()
        else {
            return;
        };
        let Some(target) = Target::new(parent, &child) else {
            return;
        };
        if !self.open(chat, w, cx) {
            return;
        }
        let fresh = current(self);
        let key = target.key();
        let writable = fresh && !child.retired;
        self.editor.update(cx, |e, cx| {
            e.select(key, writable, child.state == State::Working, w, cx)
        });
        let viewer = cx.entity();
        let conversation = cx.new(|cx| Conversation::new(viewer, target, child, w, cx));
        self.subagent = Some(conversation.clone());
        // The reader consults this owner; start after its update releases.
        let conversation = conversation.downgrade();
        cx.spawn(async move |_, cx| {
            let _ = conversation.update(cx, |v, cx| v.refresh(cx));
        })
        .detach();
        cx.notify();
    }
}

pub(super) struct Entry {
    viewer: gpui_kit::WeakEntity<LocalViewer>,
    expanded: BTreeSet<String>,
    focus: FocusHandle,
    _watch: Subscription,
}
pub(super) fn entry(w: &mut Window, cx: &mut Context<LocalViewer>) -> Entity<Entry> {
    let viewer = cx.entity();
    cx.new(|cx: &mut Context<Entry>| Entry {
        viewer: viewer.downgrade(),
        expanded: BTreeSet::new(),
        focus: cx.focus_handle(),
        _watch: cx.observe_in(&viewer, w, |entry, _, w, cx| {
            if entry.selected(cx).is_none() && entry.focus.contains_focused(w, cx) {
                let _ = entry
                    .viewer
                    .update(cx, |v, cx| v.editor.update(cx, |e, cx| e.focus(w, cx)));
            }
            cx.notify();
        }),
    })
}
impl Entry {
    fn selected(&self, cx: &App) -> Option<(Entity<LocalViewer>, Chat, bool)> {
        let viewer = self.viewer.upgrade()?;
        let v = viewer.read(cx);
        if v.page != Page::Chat {
            return None;
        }
        let chat = v
            .state
            .chats
            .iter()
            .find(|c| {
                Some(&c.id) == v.selected.as_ref()
                    && !c.local_draft
                    && !c.archived
                    && c.subagents.visible()
            })?
            .clone();
        let fresh = current(v);
        Some((viewer, chat, fresh))
    }
}
impl Render for Entry {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some((viewer, chat, fresh)) = self.selected(cx) else {
            return div().hidden().into_any_element();
        };
        let expanded = self.expanded.contains(&chat.id);
        let id = chat.id.clone();
        let owner = viewer.clone();
        let guard = viewer.clone();
        let report = &chat.subagents;
        div()
            .id("session-subagents-strip")
            .test_support()
            .track_focus(&self.focus)
            .v_flex()
            .min_w_0()
            .p_1()
            .bg(appearance::tray(cx))
            .rounded(px(appearance::Radius::TRAY))
            .capture_any_mouse_down(move |_, w, cx| {
                if !guard.update(cx, |v, cx| v.project_choices_ready(w, cx)) {
                    w.prevent_default();
                    cx.stop_propagation();
                }
            })
            .child(
                ui::action("session-subagents-toggle", "", Action::Quiet)
                    .w_full()
                    .min_w_0()
                    .accessibility_label(SharedString::from(format!(
                        "{} {}",
                        if expanded { "Hide" } else { "Show" },
                        report.summary(fresh)
                    )))
                    .child(
                        div()
                            .h_flex()
                            .w_full()
                            .min_w_0()
                            .gap_2()
                            .child(
                                AppIcon::Subagent
                                    .inline()
                                    .text_color(cx.theme().muted_foreground),
                            )
                            .child(
                                ui::text(Text::Label, SharedString::from(report.summary(fresh)))
                                    .flex_1()
                                    .min_w_0()
                                    .truncate(),
                            )
                            .child(
                                if expanded {
                                    AppIcon::Expand
                                } else {
                                    AppIcon::Collapse
                                }
                                .inline(),
                            ),
                    )
                    .on_mouse_down(gpui_kit::MouseButton::Left, move |_, w, cx| {
                        if !owner.update(cx, |v, cx| v.project_choices_ready(w, cx)) {
                            w.prevent_default();
                            cx.stop_propagation();
                        }
                    })
                    .on_click(cx.listener(move |entry, _, w, cx| {
                        if !viewer.update(cx, |v, cx| v.project_choices_ready(w, cx)) {
                            return;
                        }
                        if !entry.expanded.remove(&id) {
                            entry.expanded.insert(id.clone());
                        }
                        cx.notify();
                    })),
            )
            .when(expanded, |d| {
                d.child(
                    div()
                        .id("session-subagents-list")
                        .test_support()
                        .v_flex()
                        .min_w_0()
                        .max_h(px(168.))
                        .overflow_y_scroll()
                        .children(report.children.iter().map(|child| {
                            let viewer = self.viewer.clone();
                            let (id, name) = (chat.id.clone(), child.name.clone());
                            child_button(
                                child,
                                fresh,
                                &format!("composer-subagent:{}", chat.id),
                                cx,
                            )
                            .on_click(move |_, w, cx| {
                                if let Some(viewer) = viewer.upgrade() {
                                    open(viewer, id.clone(), Some(name.clone()), w, cx);
                                }
                            })
                        })),
                )
            })
            .into_any_element()
    }
}

fn child_button(
    child: &Child,
    fresh: bool,
    prefix: &str,
    cx: &App,
) -> gpui_kit::component::button::Button {
    let state = status(child, fresh);
    ui::action(
        SharedString::from(format!("{prefix}:{}", child.name)),
        "",
        Action::Quiet,
    )
    .w_full()
    .min_w_0()
    .accessibility_label(SharedString::from(format!(
        "Inspect {}, {}",
        child.name,
        state.label()
    )))
    .child(
        div()
            .h_flex()
            .w_full()
            .min_w_0()
            .gap_2()
            .child(
                ui::text(Text::Label, SharedString::from(child.name.clone()))
                    .min_w_0()
                    .flex_1()
                    .truncate(),
            )
            .child(
                ui::text(Text::Caption, state.label())
                    .flex_none()
                    .text_color(if state == State::Failed {
                        cx.theme().danger
                    } else {
                        cx.theme().muted_foreground
                    }),
            ),
    )
}

pub(super) struct Conversation {
    viewer: gpui_kit::WeakEntity<LocalViewer>,
    target: Target,
    reported: Child,
    transcript: Entity<TranscriptView>,
    pending: Option<Task<()>>,
    loaded: bool,
    error: Option<&'static str>,
    accepted: Option<String>,
    _watch: Subscription,
}
impl Conversation {
    fn new(
        viewer: Entity<LocalViewer>,
        target: Target,
        child: Child,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            viewer: viewer.downgrade(),
            target,
            reported: child,
            transcript: cx.new(|cx| TranscriptView::readonly(w, cx)),
            pending: None,
            loaded: false,
            error: None,
            accepted: None,
            _watch: cx.observe(&viewer, |v, _, cx| {
                let Some(viewer) = v.viewer.upgrade() else {
                    return;
                };
                let editor = viewer.read(cx).editor.clone();
                if editor.read(cx).navigation_key() != Some(v.target.key().as_str()) {
                    return;
                }
                if let Some((parent, child, fresh, _)) = v.source(cx) {
                    if let Some(viewer) = v.viewer.upgrade() {
                        let editor = viewer.read(cx).editor.clone();
                        editor.update(cx, |e, cx| {
                            if e.navigation_key() == Some(v.target.key().as_str()) {
                                e.permission(
                                    fresh && parent.writable && !child.retired,
                                    fresh && child.state == State::Working,
                                    cx,
                                );
                            }
                        });
                    }
                    let answer_changed = v.reported.last_answer != child.last_answer;
                    v.reported = child;
                    if fresh && answer_changed {
                        v.refresh(cx);
                    }
                } else if let Some(viewer) = v.viewer.upgrade() {
                    let editor = viewer.read(cx).editor.clone();
                    editor.update(cx, |e, cx| e.permission(false, false, cx));
                }
                cx.notify();
            }),
        }
    }
    fn source(&self, cx: &App) -> Option<(Chat, Child, bool, Option<LocalOptions>)> {
        let viewer = self.viewer.upgrade()?;
        let v = viewer.read(cx);
        if v.page != Page::Chat
            || v.editor.read(cx).navigation_key() != Some(self.target.key().as_str())
        {
            return None;
        }
        let parent = v
            .state
            .chats
            .iter()
            .find(|c| c.id == self.target.parent)?
            .clone();
        let child = self.target.child(&parent)?.clone();
        Some((parent, child, current(v), v.usage_options.clone()))
    }
    pub(super) fn accept_write(
        &mut self,
        state: &crate::interaction::WriteState,
        cx: &mut Context<Self>,
    ) {
        if let Some(last) = state
            .book
            .as_ref()
            .and_then(|b| b.drafts.get(&self.target.key()))
            .and_then(|d| d.last.as_ref())
            && last.kind == "subagent-send"
            && last.state == "accepted"
            && self.accepted.as_ref() != Some(&last.id)
        {
            self.accepted = Some(last.id.clone());
            // Write publications arrive inside LocalViewer's update.
            cx.spawn(async move |v, cx| {
                let _ = v.update(cx, |v, cx| v.refresh(cx));
            })
            .detach();
        }
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.pending = None;
        self.error = None;
        let Some((_, _, true, Some(options))) = self.source(cx) else {
            self.error = Some("Current subagent identity is unavailable. Last snapshot retained.");
            cx.notify();
            return;
        };
        let (tx, rx) = async_channel::bounded(1);
        let target = self.target.clone();
        if std::thread::Builder::new().name("subagent-snapshot".into()).spawn(move || {
            match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt)=>rt.block_on(async {
                    tokio::select! {
                        result=crate::local_client::subagent_snapshot(&options,&target.parent,&target.name)=>{let _=tx.send(result).await;}
                        _=tx.closed()=>{}
                    }
                }),
                Err(_)=>{let _=tx.send_blocking(Err("Local inspection is unavailable."));}
            }
        }).is_err(){self.error=Some("Local inspection is unavailable.");cx.notify();return;}
        self.pending = Some(cx.spawn(async move |v, cx| {
            let result = rx
                .recv()
                .await
                .unwrap_or(Err("Subagent transcript is unavailable."));
            let _ = v.update(cx, |v, cx| {
                v.pending = None;
                if !v.source(cx).is_some_and(|(_, _, fresh, _)| fresh) {
                    v.error = Some("Subagent identity changed. Snapshot not applied.");
                } else {
                    match result {
                        Ok(rows) => {
                            v.transcript
                                .update(cx, |t, cx| t.replace_readonly(rows, !v.loaded, cx));
                            v.loaded = true;
                        }
                        Err(error) => v.error = Some(error),
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    pub(super) fn open_find(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.transcript.update(cx, |t, cx| t.open_find(w, cx));
    }
}
impl Render for Conversation {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let source = self.source(cx);
        let child = source.as_ref().map_or(&self.reported, |(_, c, _, _)| c);
        let fresh = source.as_ref().is_some_and(|(_, _, fresh, _)| *fresh);
        let state = status(child, fresh);
        let owner = self.viewer.clone();
        let guard = self.viewer.clone();
        let parent = self.target.parent.clone();
        let editor = self.viewer.upgrade().map(|v| v.read(cx).editor.clone());
        div()
            .id("subagent-conversation")
            .test_support()
            .v_flex()
            .size_full()
            .min_w_0()
            .min_h_0()
            .child(
                div()
                    .id("subagent-header")
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .h(px(48.))
                    .px_3()
                    .flex_none()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .capture_any_mouse_down(move |_, w, cx| {
                        if !guard
                            .update(cx, |v, cx| v.project_choices_ready(w, cx))
                            .unwrap_or(false)
                        {
                            w.prevent_default();
                            cx.stop_propagation();
                        }
                    })
                    .child(
                        ui::icon_action(
                            "subagent-back",
                            "Back to parent chat",
                            AppIcon::Back,
                            Action::Quiet,
                        )
                        .on_click(move |_, w, cx| {
                            let _ = owner.update(cx, |v, cx| {
                                if let Some(chat) =
                                    v.state.chats.iter().find(|c| c.id == parent).cloned()
                                    && v.open(chat, w, cx)
                                {
                                    v.editor.update(cx, |e, cx| e.focus(w, cx));
                                }
                            });
                        }),
                    )
                    .child(AppIcon::Subagent.inline())
                    .child(
                        ui::text(Text::Label, SharedString::from(child.name.clone()))
                            .min_w_0()
                            .flex_1()
                            .truncate(),
                    )
                    .child(ui::text(Text::Caption, state.label()).text_color(
                        if state == State::Failed {
                            cx.theme().danger
                        } else {
                            cx.theme().muted_foreground
                        },
                    ))
                    .child(
                        ui::action("subagent-refresh", "Refresh", Action::Quiet)
                            .disabled(self.pending.is_some() || !fresh)
                            .on_click(cx.listener(|v, _, _, cx| v.refresh(cx))),
                    ),
            )
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap_2()
                    .px_3()
                    .py_1()
                    .text_color(cx.theme().muted_foreground)
                    .children(
                        child
                            .model
                            .as_ref()
                            .map(|m| ui::text(Text::Caption, SharedString::from(m.clone()))),
                    )
                    .child(ui::text(
                        Text::Caption,
                        if self.pending.is_some() {
                            "Reading snapshot…"
                        } else if fresh {
                            "Snapshot · refresh for latest messages"
                        } else {
                            "Last snapshot · current state unknown"
                        },
                    )),
            )
            .children(child.error.as_ref().map(|e| {
                ui::text(Text::Caption, SharedString::from(e.clone()))
                    .px_3()
                    .text_color(cx.theme().danger)
            }))
            .children(self.error.map(|e| {
                ui::text(Text::Caption, e)
                    .id("subagent-read-error")
                    .test_support()
                    .px_3()
                    .text_color(cx.theme().danger)
            }))
            .child(
                div().flex_1().min_w_0().min_h_0().child(
                    self.transcript.clone().cached(
                        gpui_kit::StyleRefinement::default()
                            .size_full()
                            .min_h_0()
                            .min_w_0(),
                    ),
                ),
            )
            .children(editor.map(|e| {
                div()
                    .id("conversation-editor")
                    .test_support()
                    .w_full()
                    .min_w_0()
                    .max_w(px(ui::CONVERSATION_MAX_WIDTH))
                    .mx_auto()
                    .child(e)
            }))
    }
}

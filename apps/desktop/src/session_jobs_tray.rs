//! Running jobs strip above the composer: Swift's JobsPanel/working line, in the
//! todo strip's slot. Jobs come only from the received session summary; Stop is
//! the existing per-job endpoint, one request per click, never retried.
use super::*;
use crate::{
    session_jobs::{self, Job, Stop, Worker},
    ui::{self, Action, Text},
};
use gpui_kit::{Div, FocusHandle, StatefulInteractiveElement};
use std::collections::{BTreeMap, BTreeSet};

const ROW_MIN_HEIGHT: f32 = 28.;
// Rows and notes start under the summary label; its glyph is the gutter.
const ROW_INDENT_REM: f32 = 2.;
// About four two-line rows before the list scrolls.
const LIST_MAX_HEIGHT: f32 = 168.;

pub(super) struct Entry {
    viewer: gpui_kit::WeakEntity<LocalViewer>,
    /// Chats whose job list the user opened. Window-local; survives navigation.
    expanded: BTreeSet<String>,
    /// Stop requests by (chat, job), dropped once the summary drops the job.
    stops: BTreeMap<(String, String), Stop>,
    worker: Option<Worker>,
    focus: FocusHandle,
    /// Wakes when a shown elapsed time next changes.
    tick: Option<Task<()>>,
    _subscription: Subscription,
}

struct Selected {
    chat: String,
    jobs: Arc<[Job]>,
    /// The list subscription is connected and loaded. Otherwise these are the
    /// last reported jobs, not confirmed running or stopped.
    current: bool,
    options: Option<LocalOptions>,
}

pub(super) fn entry(window: &mut Window, cx: &mut Context<LocalViewer>) -> Entity<Entry> {
    let viewer = cx.entity();
    cx.new(|cx: &mut Context<Entry>| Entry {
        viewer: viewer.downgrade(),
        expanded: BTreeSet::new(),
        stops: BTreeMap::new(),
        worker: None,
        focus: cx.focus_handle(),
        tick: None,
        _subscription: cx.observe_in(&viewer, window, |entry, _, w, cx| {
            // The strip went away while it held focus: hand it back to the composer.
            if entry.selected(cx).is_none() && entry.focus.contains_focused(w, cx) {
                let _ = entry.viewer.update(cx, |v, cx| {
                    v.chats.update(cx, |list, cx| list.focus(w, cx));
                    if v.page == Page::Chat && v.selected.is_some() {
                        v.editor.update(cx, |e, cx| e.focus(w, cx));
                    }
                });
            }
            cx.notify();
        }),
    })
}

impl Entry {
    fn allowed(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.viewer
            .update(cx, |v, cx| v.project_choices_ready(w, cx))
            .unwrap_or(false)
    }
    fn selected(&self, cx: &App) -> Option<Selected> {
        let viewer = self.viewer.upgrade()?;
        let v = viewer.read(cx);
        if v.page != Page::Chat {
            return None;
        }
        let id = v.selected.as_ref()?;
        let chat = v
            .state
            .chats
            .iter()
            .find(|c| &c.id == id && !c.archived && !c.local_draft)?;
        if chat.running_jobs.is_empty() {
            return None;
        }
        Some(Selected {
            chat: chat.id.clone(),
            jobs: chat.running_jobs.clone(),
            current: v.state.status == "Connected · Local" && v.state.list_loaded,
            options: v.usage_options.clone(),
        })
    }
    fn schedule(&mut self, jobs: &[Job], now: i64, cx: &mut Context<Self>) {
        if self.tick.is_some() {
            return;
        }
        let Some(next) = jobs
            .iter()
            .map(|job| session_jobs::next_change(now, job.started_at))
            .min()
        else {
            return;
        };
        let delay = Duration::from_millis((next - now).clamp(1, 60_000) as u64);
        self.tick = Some(cx.spawn(async move |entry, cx| {
            cx.background_executor().timer(delay).await;
            let _ = entry.update(cx, |entry, cx| {
                entry.tick = None;
                cx.notify();
            });
        }));
    }
    fn stop(&mut self, chat: &str, job: &str, w: &mut Window, cx: &mut Context<Self>) {
        if !self.allowed(w, cx) {
            return;
        }
        let Some(selected) = self.selected(cx) else {
            return;
        };
        let key = (chat.to_owned(), job.to_owned());
        if selected.chat != chat
            || !selected.current
            || !selected.jobs.iter().any(|j| j.id == job)
            || matches!(
                self.stops.get(&key),
                Some(Stop::Pending | Stop::Accepted | Stop::Ended)
            )
        {
            return;
        }
        let Some(options) = selected.options else {
            return;
        };
        if self.worker.as_ref().is_none_or(|w| {
            w.options.host() != options.host() || w.options.loopback() != options.loopback()
        }) {
            self.worker = Worker::start(options);
        }
        let Some(worker) = &self.worker else {
            self.stops
                .insert(key, Stop::Failed("Stop is unavailable. Nothing was sent."));
            cx.notify();
            return;
        };
        let reply = worker.stop(chat, job);
        self.stops.insert(key.clone(), Stop::Pending);
        cx.notify();
        cx.spawn(async move |entry, cx| {
            let outcome = reply
                .recv()
                .await
                .unwrap_or(Stop::Failed("Stop wasn't confirmed. It wasn't retried."));
            let _ = entry.update(cx, |entry, cx| {
                if let Some(stop) = entry.stops.get_mut(&key)
                    && *stop == Stop::Pending
                {
                    *stop = outcome;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn summary(&self, s: &Selected, expanded: bool, now: i64, cx: &App) -> Div {
        let oldest = session_jobs::oldest(&s.jobs).expect("nonempty jobs");
        let figures = gpui_kit::FontFeatures(Arc::new(vec![("tnum".into(), 1)]));
        div()
            .h_flex()
            .w_full()
            .min_w_0()
            .gap_2()
            .text_left()
            .child(
                AppIcon::Command
                    .inline()
                    .text_color(cx.theme().muted_foreground),
            )
            .child(
                ui::text(
                    Text::Label,
                    SharedString::from(session_jobs::count(s.jobs.len())),
                )
                .id("session-jobs-count")
                .test_support()
                .flex_shrink_0(),
            )
            .child(
                div()
                    .id("session-jobs-name")
                    .test_support()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(cx.theme().muted_foreground)
                    .when(!expanded, |d| {
                        d.child(ui::text(
                            Text::Label,
                            SharedString::from(oldest.name.clone()),
                        ))
                    }),
            )
            .when(!(expanded && s.current), |row| {
                row.child(
                    div()
                        .id(if s.current {
                            "session-jobs-elapsed"
                        } else {
                            "session-jobs-last-reported"
                        })
                        .test_support()
                        .flex_shrink_0()
                        .font_features(figures)
                        .text_color(cx.theme().muted_foreground)
                        .child(ui::text(
                            Text::Caption,
                            if s.current {
                                SharedString::from(session_jobs::elapsed(now - oldest.started_at))
                            } else {
                                "Last reported".into()
                            },
                        )),
                )
            })
            .child(
                // The strip sits on the composer, so the list opens upward:
                // chevron up to open, down to close.
                if expanded {
                    AppIcon::Expand
                } else {
                    AppIcon::Collapse
                }
                .inline()
                .text_color(cx.theme().muted_foreground),
            )
    }

    fn row(
        &self,
        s: &Selected,
        job: &Job,
        now: i64,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let figures = gpui_kit::FontFeatures(Arc::new(vec![("tnum".into(), 1)]));
        let stop = self.stops.get(&(s.chat.clone(), job.id.clone())).copied();
        // Each status has its own test ID; snapshots expose no text.
        // A stale list says "Last reported" once, in its header, not per row.
        let (kind, status): (&str, SharedString) = match stop {
            Some(Stop::Pending | Stop::Accepted) => ("stopping", "Stopping…".into()),
            Some(Stop::Ended) => ("ended", "Ended".into()),
            _ if !s.current => ("unknown", "".into()),
            _ => (
                "elapsed",
                session_jobs::elapsed(now - job.started_at).into(),
            ),
        };
        let home = std::env::var("HOME").ok();
        let mut detail = div().v_flex().flex_1().min_w_0().child(
            ui::text(Text::Label, SharedString::from(job.name.clone()))
                .id(SharedString::from(format!("session-job-name:{}", job.id)))
                .test_support()
                .truncate(),
        );
        if !job.output_path.is_empty() {
            detail = detail.child(
                ui::text(
                    Text::Caption,
                    SharedString::from(session_jobs::abbreviate(&job.output_path, home.as_deref())),
                )
                .id(SharedString::from(format!("session-job-path:{}", job.id)))
                .test_support()
                .font_family(crate::appearance::CODE_FONT)
                .text_color(cx.theme().muted_foreground)
                .truncate(),
            );
        }
        if let Some(Stop::Failed(error)) = stop {
            detail = detail.child(
                ui::text(Text::Caption, error)
                    .id(SharedString::from(format!("session-job-error:{}", job.id)))
                    .test_support()
                    .text_color(cx.theme().danger),
            );
        }
        let busy = matches!(stop, Some(Stop::Pending | Stop::Accepted | Stop::Ended));
        let (chat, id, name) = (s.chat.clone(), job.id.clone(), job.name.clone());
        let log = job.clone();
        div()
            .id(SharedString::from(format!("session-job:{}", job.id)))
            .test_support()
            .h_flex()
            .items_center()
            .min_w_0()
            .min_h(px(ROW_MIN_HEIGHT))
            .py_1()
            .pl(gpui_kit::rems(ROW_INDENT_REM))
            .gap_2()
            .flex_shrink_0()
            .child(detail)
            .child(
                div()
                    .id(SharedString::from(format!("session-job-{kind}:{}", job.id)))
                    .test_support()
                    .flex_shrink_0()
                    .font_features(figures)
                    .text_color(cx.theme().muted_foreground)
                    .child(ui::text(Text::Caption, status)),
            )
            .when(!job.output_path.is_empty(), |row| {
                let chat = s.chat.clone();
                row.child(
                    ui::icon_action(
                        SharedString::from(format!("session-job-log:{}", job.id)),
                        "Show log",
                        AppIcon::Read,
                        Action::Quiet,
                    )
                    .on_click(cx.listener(move |entry, _, w, cx| {
                        if !entry.allowed(w, cx) {
                            return;
                        }
                        if let Some(viewer) = entry.viewer.upgrade() {
                            super::session_jobs_log_view::open(
                                viewer,
                                chat.clone(),
                                log.clone(),
                                w,
                                cx,
                            );
                        }
                    })),
                )
            })
            .child(
                ui::action(
                    SharedString::from(format!("session-job-stop:{}", job.id)),
                    "Stop",
                    Action::Quiet,
                )
                .disabled(busy || !s.current || s.options.is_none())
                .accessibility_label(SharedString::from(format!("Stop {name}")))
                .tooltip("Stop this job. The agent is told you stopped it.")
                .on_click(cx.listener(move |entry, _, w, cx| entry.stop(&chat, &id, w, cx))),
            )
            .into_any_element()
    }
}

impl Render for Entry {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(s) = self.selected(cx) else {
            self.tick = None;
            return div().hidden().into_any_element();
        };
        // A job the summary no longer lists has ended: forget its Stop request.
        self.stops
            .retain(|(chat, job), _| chat != &s.chat || s.jobs.iter().any(|j| &j.id == job));
        let now = session_jobs::now();
        if s.current {
            self.schedule(&s.jobs, now, cx);
        } else {
            self.tick = None;
        }
        let expanded = self.expanded.contains(&s.chat);
        let oldest = session_jobs::oldest(&s.jobs).expect("nonempty jobs");
        let n = s.jobs.len();
        let spoken = format!(
            "{} {}. {}: {}{}",
            if expanded { "Hide" } else { "Show" },
            session_jobs::count(n),
            if n == 1 { "Running" } else { "Longest" },
            oldest.name,
            if s.current {
                format!(", for {}", session_jobs::spoken(now - oldest.started_at))
            } else {
                ". Last reported, Local is reconnecting".into()
            },
        );
        let chat = s.chat.clone();
        let mut content = div()
            .id("session-jobs-strip")
            .test_support()
            .track_focus(&self.focus)
            .v_flex()
            .min_w_0()
            .p_1()
            .bg(crate::appearance::tray(cx))
            .rounded(px(crate::appearance::Radius::TRAY))
            .capture_any_mouse_down(cx.listener(|entry, _, w, cx| {
                if !entry.allowed(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(
                ui::action("session-jobs-toggle", "", Action::Quiet)
                    .w_full()
                    .min_w_0()
                    .accessibility_label(SharedString::from(spoken))
                    .child(self.summary(&s, expanded, now, cx))
                    .on_click(cx.listener(move |entry, _, w, cx| {
                        if !entry.allowed(w, cx) {
                            return;
                        }
                        if !entry.expanded.remove(&chat) {
                            entry.expanded.insert(chat.clone());
                        }
                        cx.notify();
                    })),
            );
        if expanded {
            if !s.current {
                content = content.child(
                    ui::text(
                        Text::Caption,
                        "Local is reconnecting. These jobs were running when last reported.",
                    )
                    .id("session-jobs-stale")
                    .test_support()
                    .pl(gpui_kit::rems(ROW_INDENT_REM))
                    .text_color(cx.theme().muted_foreground),
                );
            }
            let rows: Vec<_> = s
                .jobs
                .iter()
                .map(|job| self.row(&s, job, now, cx))
                .collect();
            content = content.child(
                div()
                    .id("session-jobs-list")
                    .test_support()
                    .v_flex()
                    .min_w_0()
                    .max_h(px(LIST_MAX_HEIGHT))
                    .overflow_y_scroll()
                    .children(rows),
            );
        }
        content.into_any_element()
    }
}

//! Live log popup for one running job: a read-only tail of its local log file,
//! refreshed while open. Closing the popup drops the reader.
use super::*;
use crate::{
    session_jobs::Job,
    session_jobs_log::{self, Tail, WINDOW},
    ui::{self, Action, Text},
};
use gpui_kit::component::WindowExt;
use gpui_kit::{
    ClipboardItem, ListHorizontalSizingBehavior, UniformListScrollHandle, uniform_list,
};

const POLL: Duration = Duration::from_millis(500);
const LINE_HEIGHT: f32 = 18.;

pub(super) struct LogView {
    chat: String,
    job: Job,
    tail: Tail,
    error: Option<&'static str>,
    /// The chat summary still lists the job.
    running: bool,
    scroll: UniformListScrollHandle,
    _poll: Task<()>,
    _watch: Subscription,
}

pub(super) fn open(
    viewer: Entity<LocalViewer>,
    chat: String,
    job: Job,
    w: &mut Window,
    cx: &mut App,
) {
    let title = SharedString::from(job.name.clone());
    let view = cx.new(|cx| LogView::new(viewer, chat, job, cx));
    w.open_dialog(cx, move |dialog, w, cx| {
        let height = (f32::from(w.viewport_size().height) - 220.).clamp(200., 640.);
        ui::dialog(dialog, cx)
            .title(div().min_w_0().truncate().child(title.clone()))
            .w(px((f32::from(w.viewport_size().width) - 48.).min(900.)))
            .child(div().h(px(height)).child(view.clone()))
            .footer({
                let view = view.clone();
                div()
                    .h_flex()
                    .gap_2()
                    .child(
                        ui::action("job-log-copy", "Copy log", Action::Quiet).on_click(
                            move |_, _, cx| {
                                let text = view.read(cx).tail.text();
                                cx.write_to_clipboard(ClipboardItem::new_string(text));
                            },
                        ),
                    )
                    .child(
                        ui::action("job-log-done", "Done", Action::Secondary)
                            .on_click(|_, w, cx| w.close_dialog(cx)),
                    )
            })
    });
}

impl LogView {
    fn new(viewer: Entity<LocalViewer>, chat: String, job: Job, cx: &mut Context<Self>) -> Self {
        let path = std::path::PathBuf::from(&job.output_path);
        let poll = cx.spawn(async move |view, cx| {
            loop {
                let Ok(offset) = view.read_with(cx, |v, _| v.tail.offset) else {
                    break;
                };
                let path = path.clone();
                let result = cx
                    .background_executor()
                    .spawn(async move { session_jobs_log::read(&path, offset, WINDOW) })
                    .await;
                if view.update(cx, |v, cx| v.accept(result, cx)).is_err() {
                    break;
                }
                cx.background_executor().timer(POLL).await;
            }
        });
        let watch = cx.observe(&viewer, |v: &mut Self, viewer, cx| {
            let running = viewer
                .read(cx)
                .state
                .chats
                .iter()
                .any(|c| c.id == v.chat && c.running_jobs.iter().any(|j| j.id == v.job.id));
            if running != v.running {
                v.running = running;
                cx.notify();
            }
        });
        Self {
            chat,
            job,
            tail: Tail::default(),
            error: None,
            running: true,
            scroll: UniformListScrollHandle::new(),
            _poll: poll,
            _watch: watch,
        }
    }
    fn accept(
        &mut self,
        result: Result<session_jobs_log::Chunk, &'static str>,
        cx: &mut Context<Self>,
    ) {
        match result {
            Ok(chunk) => {
                let error = self.error.take().is_some();
                // Keep following only if the reader is at the end (or nothing scrolls yet).
                let follow = self.scroll.is_scrolled_to_end().unwrap_or(true);
                if self.tail.apply(chunk) {
                    if follow {
                        self.scroll.scroll_to_bottom();
                    }
                    cx.notify();
                } else if error {
                    cx.notify();
                }
            }
            Err(error) => {
                if self.error != Some(error) {
                    self.error = Some(error);
                    cx.notify();
                }
            }
        }
    }
    fn status(&self) -> Option<String> {
        let mut parts = Vec::new();
        if !self.running {
            parts.push("No longer running");
        }
        if let Some(error) = self.error {
            parts.push(error);
        }
        if self.tail.clipped {
            parts.push("Newest output only");
        }
        (!parts.is_empty()).then(|| parts.join(" · "))
    }
}

impl Render for LogView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let home = std::env::var("HOME").ok();
        let path = self.job.output_path.clone();
        let lines = self.tail.lines.clone();
        let count = lines.len();
        let muted = cx.theme().muted_foreground;
        let log = if count == 0 {
            div()
                .id("job-log-empty")
                .test_support()
                .p_2()
                .text_color(muted)
                .child(ui::text(Text::Caption, "No output yet."))
                .into_any_element()
        } else {
            uniform_list("job-log-lines", count, move |range, _, _| {
                range
                    .map(|ix| {
                        div()
                            .id(SharedString::from(format!("job-log-line:{ix}")))
                            .test_support()
                            .h(px(LINE_HEIGHT))
                            .px_2()
                            .whitespace_nowrap()
                            .child(SharedString::from(lines[ix].clone()))
                    })
                    .collect()
            })
            .with_width_from_item(Some(self.tail.widest))
            .with_horizontal_sizing_behavior(ListHorizontalSizingBehavior::Unconstrained)
            .track_scroll(&self.scroll)
            .size_full()
            .into_any_element()
        };
        div()
            .id("job-log")
            .test_support()
            .v_flex()
            .size_full()
            .min_h_0()
            .gap_2()
            .child(
                div()
                    .h_flex()
                    .min_w_0()
                    .gap_2()
                    .child(
                        ui::text(
                            Text::Caption,
                            SharedString::from(crate::session_jobs::abbreviate(
                                &path,
                                home.as_deref(),
                            )),
                        )
                        .id("job-log-path")
                        .test_support()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_family(crate::appearance::CODE_FONT)
                        .text_color(muted),
                    )
                    // Status shares this row so the log area never resizes under the reader.
                    .children(self.status().map(|status| {
                        ui::text(Text::Caption, SharedString::from(status))
                            .id("job-log-status")
                            .test_support()
                            .flex_shrink_0()
                            .text_color(if self.error.is_some() {
                                cx.theme().danger
                            } else {
                                muted
                            })
                    }))
                    .child(
                        ui::icon_action(
                            "job-log-copy-path",
                            "Copy log path",
                            AppIcon::Copy,
                            Action::Quiet,
                        )
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(path.clone()))
                        }),
                    ),
            )
            .child(
                div()
                    .id("job-log-output")
                    .test_support()
                    .flex_1()
                    .min_h_0()
                    .py_1()
                    .overflow_hidden()
                    .rounded(px(crate::appearance::Radius::TRAY))
                    .bg(crate::appearance::tray(cx))
                    .font_family(crate::appearance::CODE_FONT)
                    .text_xs()
                    .child(log),
            )
    }
}

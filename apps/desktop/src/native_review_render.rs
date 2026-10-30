//! Calm Review presentation; retained data and guarded reads belong to Pane.
use super::*;
impl Render for Pane {
    fn render(&mut self, _w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut header = div().v_flex().gap_2().min_w_0();
        let mut choices = div().h_flex().gap_2().min_w_0();
        if !self.workers.is_empty() {
            choices = choices.child(
                div()
                    .id("review-worker")
                    .test_support()
                    .flex_1()
                    .min_w_0()
                    .child(
                        Select::new(&self.worker_picker)
                            .placeholder("Choose worker")
                            .accessibility_label("Review worker")
                            .menu_max_h(rems(18.))
                            .w_full(),
                    ),
            );
        }
        if self.worker.is_some() && (!self.comparisons.is_empty() || self.selected.is_some()) {
            choices = choices.child(
                div()
                    .id("review-comparison")
                    .test_support()
                    .flex_1()
                    .min_w_0()
                    .child(
                        Select::new(&self.comparison_picker)
                            .placeholder("Choose saved revision")
                            .disabled(self.error.is_some())
                            .accessibility_label("Exact retained comparison, layer or stack")
                            .menu_max_h(rems(18.))
                            .w_full(),
                    ),
            );
        }
        header = header.child(choices);
        let mut tools = div().h_flex().gap_2().min_w_0();
        if self.source.is_some() {
            tools = tools.child(
                ui::icon_action(
                    "review-back",
                    "Back to diff",
                    crate::app_icon::AppIcon::Back,
                    Action::Quiet,
                )
                .on_click(cx.listener(|p, _, w, cx| p.back(w, cx))),
            );
        }
        if self.snapshot.is_some() || !self.capture_limits.is_empty() {
            tools = tools.child(
                ui::action("review-details", "Details", Action::Quiet)
                    .selected(self.details)
                    .on_click(cx.listener(|p, _, _, cx| {
                        p.details = !p.details;
                        cx.notify();
                    })),
            );
        }
        header = header.child(
            tools.child(
                ui::icon_action(
                    "review-refresh",
                    "Refresh comparisons",
                    crate::app_icon::AppIcon::Retry,
                    Action::Quiet,
                )
                .disabled(self.busy || self.key.is_none())
                .on_click(cx.listener(|p, _, w, cx| p.refresh(w, cx))),
            ),
        );
        if let Some(next) = self.next {
            header = header.child(
                ui::action("review-more", "More comparisons", Action::Quiet)
                    .disabled(self.busy)
                    .on_click(cx.listener(move |p, _, w, cx| {
                        if let (Some(k), Some(worker)) = (p.key.clone(), p.worker.clone()) {
                            p.after = next;
                            p.request(Route::Comparisons(k, worker, next), w, cx);
                        }
                    })),
            );
        }
        if self.after > 0 {
            header = header.child(
                ui::action("review-first", "First comparisons", Action::Quiet)
                    .disabled(self.busy)
                    .on_click(cx.listener(|p, _, w, cx| {
                        if let (Some(k), Some(worker)) = (p.key.clone(), p.worker.clone()) {
                            p.after = 0;
                            p.request(Route::Comparisons(k, worker, 0), w, cx);
                        }
                    })),
            );
        }
        if self.busy {
            header = header.child(Notice::new("Reading retained records…"));
        }
        if let Some(e) = self.error {
            header = header.child(Notice::new(e).tone(Tone::Warning));
        }
        if let Some(notice) = self.capture_notice {
            header = header.child(
                div()
                    .id("review-capture-notice")
                    .test_support()
                    .child(Notice::new(notice).tone(Tone::Warning)),
            );
        }
        if self.details && !self.capture_limits.is_empty() {
            header = header.child(
                div()
                    .id("review-capture-limitations")
                    .test_support()
                    .v_flex()
                    .children(
                        self.capture_limits
                            .iter()
                            .map(|reason| Notice::new(*reason)),
                    ),
            );
        }
        if self.more_workers {
            header=header.child(Notice::new("Only the first 100 current members are shown. This is not a complete mission inventory."));
        }
        if !self.busy && self.workers.is_empty() && self.error.is_none() {
            header = header.child(Notice::new(
                "No current workers are available in this mission. Saved comparisons are separate from live code changes.",
            ));
        }
        if !self.busy
            && self.worker.is_some()
            && self.comparisons.is_empty()
            && self.error.is_none()
        {
            header = header.child(Notice::new(
                "No saved comparison yet. Eligible workers save committed layers at worker checkpoints, not when Review opens. This doesn't mean there are no code changes.",
            ));
        }
        if let Some(s) = &self.snapshot {
            if self.details {
                header = header.child(ui::text(
                    Text::Body,
                    SharedString::from(format!("Proven worker creation · {}", s.notes())),
                ));
            }
            if self.comparisons.iter().any(|c| {
                self.selected.as_ref().is_some_and(|p| {
                    c.request.change_id == p.request.change_id
                        && c.request.scope == p.request.scope
                        && c.sequence > p.sequence
                })
            }) {
                header=header.child(Notice::new("A newer comparison is available. This exact retained revision remains selected."));
            }
            let evidence = ui::action("review-records", "Evidence", Action::Quiet)
                .accessibility_label("Agent dimensions and reported evidence")
                .disabled(self.busy)
                .on_click(cx.listener(|p, _, w, cx| {
                    if p.records_open {
                        p.records_open = false;
                        cx.notify();
                    } else if let (Some(k), Some(worker), Some(s)) =
                        (p.key.clone(), p.worker.clone(), p.snapshot.clone())
                    {
                        p.request(Route::Records(k, worker, s.snapshot_id.clone()), w, cx);
                    }
                }));
            if self.details {
                header = header.child(evidence.self_start());
            }
            if self.details {
                header=header.child(SelectableText::new("review-identities", SharedString::from(format!("Snapshot {}\nRepository {}\nChange {}\n{} vs base {} ({})\nHead {} ({})\nCapture operation {}\nCreation {} at {}\nCaptured at {} · enrollment task scope {} (not task-purpose proof)",s.snapshot_id,s.request.repository_id,s.request.change_id,s.request.scope.kind,s.request.base.commit_id,s.request.base.change_id,s.request.head.commit_id,s.request.head.change_id,s.request.operation_id,s.creation.commit_id,s.creation.operation_id,s.captured_at,s.enrollment_task_ids.join(", ")))));
            }
            if s.status != "complete" {
                header = header.child(
                    Notice::new(if s.status == "partial" {
                        "Some comparison content wasn't retained."
                    } else {
                        "This comparison is unavailable."
                    })
                    .tone(Tone::Warning),
                );
            }
            for omission in s.omissions.iter().filter(|_| self.details) {
                header = header
                    .child(Notice::new(SharedString::from(omission.clone())).tone(Tone::Warning));
            }
            if self.details {
                header = header.child(ui::text(
                    Text::Caption,
                    "Changed paths: Unavailable (retained analysis not supported).",
                ));
            }
            if self.details {
                header=header.child(ui::text(Text::Caption,"Observed checks, live freshness, independence, human authorship, acceptance and integration: Unavailable."));
            }
            if self.details && self.records_open {
                for (ix, r) in self.records.iter().enumerate() {
                    header = header.child(SelectableText::new(
                        ("review-record", ix),
                        SharedString::from(r.clone()),
                    ));
                }
            }
        }
        if let Some(e) = self.patch_error {
            header = header.child(Notice::new(e).tone(Tone::Warning));
        }
        let mut root =
            div()
                .id("native-review")
                .test_support()
                .track_focus(&self.focus)
                .key_context("NativeReview")
                .size_full()
                .min_h_0()
                .min_w_0()
                .v_flex()
                .gap_2()
                .on_action(cx.listener(|p, _: &Back, w, cx| p.back(w, cx)))
                .on_action(cx.listener(|p, _: &NextChange, _, cx| {
                    p.diff.update(cx, |d, cx| d.next_change(cx))
                }))
                .on_action(cx.listener(|p, _: &PreviousChange, _, cx| {
                    p.diff.update(cx, |d, cx| d.previous_change(cx))
                }))
                .child(
                    div()
                        .id("review-summary")
                        .test_support()
                        .max_h(rems(18.))
                        .min_h_0()
                        .child(
                            div()
                                .id("review-summary-scroll")
                                .max_h(rems(18.))
                                .min_h_0()
                                .track_scroll(&self.summary_scroll)
                                .overflow_y_scrollbar()
                                .child(header),
                        ),
                );
        if let Some((title, text)) = &self.source {
            root = root
                .child(ui::text(Text::Caption, SharedString::from(title.clone())))
                .child(
                    div()
                        .id("review-source")
                        .test_support()
                        .flex_1()
                        .min_h_0()
                        .track_scroll(&self.source_scroll)
                        .overflow_y_scrollbar()
                        .child(SelectableText::new("review-source-text", text.clone())),
                );
        } else if self.snapshot.is_some() && self.patch_error.is_none() {
            root = root.child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap_2()
                    .min_w_0()
                    .child(
                        div().flex_1().min_w_0().child(
                            Select::new(&self.file_picker)
                                .placeholder("File")
                                .accessibility_label("Retained diff file")
                                .menu_max_h(rems(18.)),
                        ),
                    )
                    .children(
                        [
                            (DiffMode::Unified, "Unified", "review-unified"),
                            (DiffMode::Split, "Split", "review-split"),
                        ]
                        .map(|(mode, label, id)| {
                            ui::action(id, label, Action::Quiet)
                                .selected(self.diff.read(cx).mode() == mode)
                                .on_click(cx.listener(move |p, _, _, cx| {
                                    p.diff.update(cx, |d, cx| d.set_mode(mode, cx))
                                }))
                        }),
                    )
                    .children(self.details.then(|| {
                        ui::action("review-before", "Before source", Action::Quiet)
                            .disabled(self.busy)
                            .on_click(cx.listener(|p, _, w, cx| p.read_source("before", w, cx)))
                    }))
                    .children(self.details.then(|| {
                        ui::action("review-after", "After source", Action::Quiet)
                            .disabled(self.busy)
                            .on_click(cx.listener(|p, _, w, cx| p.read_source("after", w, cx)))
                    })),
            );
            root = root.child(
                div()
                    .id("review-diff")
                    .test_support()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .child(Diff::new(&self.diff).soft_wrap(true)),
            );
        }
        root
    }
}

//! Files-changed Review: choose a worker and one exact saved revision, then read
//! every file of that retained comparison in one continuous Kit Diff. Identity,
//! provenance and evidence stay in the Revision details dialog, off the page.
use super::*;
use gpui_kit::{
    AnyElement, Div, ElementId, WeakEntity,
    component::{
        ActiveTheme, Sizable, WindowExt,
        button::{ButtonGroup, ButtonVariants},
    },
    px,
};

/// Selector basis: two fit side by side in a wide pane and wrap in a narrow one,
/// so long worker titles truncate inside their own control instead of overflowing.
const CHOICE_BASIS: f32 = 16.;

fn caption(text: impl Into<SharedString>, cx: &App) -> Div {
    ui::text(Text::Caption, text).text_color(cx.theme().muted_foreground)
}
fn section(label: &'static str, cx: &App) -> Div {
    div()
        .v_flex()
        .min_w_0()
        .gap(px(ui::Space::META))
        .child(ui::text(Text::Label, label).text_color(cx.theme().muted_foreground))
}
fn choice(id: &'static str, control: impl IntoElement) -> impl IntoElement {
    div()
        .id(id)
        .test_support()
        .flex_grow(1.)
        .flex_shrink(1.)
        .flex_basis(rems(CHOICE_BASIS))
        .min_w_0()
        .child(control)
}
fn segmented<const N: usize>(
    id: &'static str,
    items: [(&'static str, &'static str, bool, bool); N],
    pick: impl Fn(usize) -> Box<dyn Fn(&gpui_kit::ClickEvent, &mut Window, &mut App)>,
) -> ButtonGroup {
    ButtonGroup::new(id)
        .small()
        .ghost()
        .flex_none()
        .children(
            items
                .into_iter()
                .enumerate()
                .map(|(ix, (id, label, on, enabled))| {
                    let f = pick(ix);
                    ui::action(id, label, Action::Quiet)
                        .selected(on)
                        .disabled(!enabled)
                        .on_click(move |e, w, cx| f(e, w, cx))
                }),
        )
}

/// Technical details for the revision that was shown when the dialog opened.
/// A later selection never silently retargets it.
struct RevisionDetails {
    pane: WeakEntity<Pane>,
    snapshot: Option<String>,
    _subscription: Subscription,
}
impl Render for RevisionDetails {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut panel = div()
            .id("review-details-panel")
            .test_support()
            .v_flex()
            .min_w_0()
            .gap(px(ui::Space::SIDEBAR));
        let Some(pane) = self.pane.upgrade() else {
            return panel.child(caption("Review is closed.", cx));
        };
        let p = pane.read(cx);
        let shown = p
            .snapshot
            .clone()
            .filter(|s| Some(&s.snapshot_id) == self.snapshot.as_ref());
        if self.snapshot.is_some() && shown.is_none() {
            return panel.child(caption(
                "This revision is no longer shown. Close and reopen details for the current one.",
                cx,
            ));
        }
        if let Some(s) = shown.as_ref().filter(|s| !s.omissions.is_empty()) {
            panel = panel.child(
                section("Not retained", cx).children(
                    s.omissions
                        .iter()
                        .map(|o| Notice::new(SharedString::from(o.clone())).tone(Tone::Warning)),
                ),
            );
        }
        if !p.capture_limits.is_empty() {
            panel = panel.child(
                section("Capture limits", cx).child(
                    div()
                        .id("review-capture-limitations")
                        .test_support()
                        .v_flex()
                        .gap(px(ui::Space::META))
                        .children(p.capture_limits.iter().map(|reason| Notice::new(*reason))),
                ),
            );
        }
        let Some(s) = shown else {
            return panel;
        };
        let target = pane.clone();
        let mut evidence = section("Evidence", cx)
            .child(caption(
                "What workers and agents reported for this revision. Reports aren't checks or acceptance.",
                cx,
            ))
            .child(
                div().h_flex().child(
                    ui::action(
                        "review-records",
                        if p.records_open { "Hide evidence" } else { "Show evidence" },
                        Action::Quiet,
                    )
                    .accessibility_label("Agent dimensions and reported evidence")
                    .selected(p.records_open)
                    .disabled(p.busy)
                    .on_click(move |_, w, cx| target.update(cx, |p, cx| p.toggle_records(w, cx))),
                ),
            );
        if p.records_open {
            for (ix, r) in p.records.iter().enumerate() {
                evidence = evidence.child(SelectableText::new(
                    ("review-record", ix),
                    SharedString::from(r.clone()),
                ));
            }
        }
        panel
            .child(section("Provenance", cx).child(ui::text(
                Text::Body,
                SharedString::from(format!("Proven worker creation · {}", s.notes())),
            )))
            .child(evidence)
            .child(section("Not available here", cx).child(caption(
                "Changed paths, observed checks, freshness and acceptance aren't shown for saved revisions yet.",
                cx,
            )))
            .child(section("Keyboard", cx).child(caption(
                "Option-Up and Option-Down move between changes. Escape closes source, then Review.",
                cx,
            )))
            .child(
                section("Exact revision", cx).child(
                    div()
                        .id("review-identities")
                        .test_support()
                        .text_size(px(Text::Caption.size()))
                        .font_family(crate::appearance::CODE_FONT)
                        .child(SelectableText::new(
                            "review-identities-text",
                            SharedString::from(format!(
                                "Snapshot {}\nRepository {}\nChange {}\n{} vs base {} ({})\nHead {} ({})\nCapture operation {}\nCreation {} at {}\nCaptured at {} · enrollment task scope {} (not task-purpose proof)",
                                s.snapshot_id,
                                s.request.repository_id,
                                s.request.change_id,
                                s.request.scope.kind,
                                s.request.base.commit_id,
                                s.request.base.change_id,
                                s.request.head.commit_id,
                                s.request.head.change_id,
                                s.request.operation_id,
                                s.creation.commit_id,
                                s.creation.operation_id,
                                s.captured_at,
                                s.enrollment_task_ids.join(", ")
                            )),
                        )),
                ),
            )
    }
}

impl Pane {
    fn toggle_records(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.records_open {
            self.records_open = false;
            cx.notify();
        } else if let (Some(k), Some(worker), Some(s)) =
            (self.key.clone(), self.worker.clone(), self.snapshot.clone())
        {
            self.request(Route::Records(k, worker, s.snapshot_id.clone()), w, cx);
        }
    }
    fn open_details(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let pane = cx.entity();
        let snapshot = self.snapshot.as_ref().map(|s| s.snapshot_id.clone());
        let details = cx.new(|cx| RevisionDetails {
            pane: pane.downgrade(),
            snapshot,
            _subscription: cx.observe(&pane, |_, _, cx| cx.notify()),
        });
        w.open_dialog(cx, move |dialog, _, cx| {
            ui::dialog(dialog, cx)
                .title("Revision details")
                .w(px(560.))
                .child(
                    div()
                        .id("review-details-scroll")
                        .max_h(rems(28.))
                        .overflow_y_scrollbar()
                        .child(details.clone()),
                )
                .footer(
                    ui::action("review-details-done", "Done", Action::Secondary)
                        .on_click(|_, w, cx| w.close_dialog(cx)),
                )
        });
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let mut row = div()
            .id("review-toolbar")
            .test_support()
            .h_flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .min_w_0();
        if !self.workers.is_empty() {
            row = row.child(choice(
                "review-worker",
                Select::new(&self.worker_picker)
                    .placeholder("Choose worker")
                    .accessibility_label("Worker")
                    .menu_max_h(rems(18.))
                    .w_full(),
            ));
        }
        if self.worker.is_some() && (!self.comparisons.is_empty() || self.selected.is_some()) {
            // Optional evidence failures leave the exact comparison usable; other
            // failures keep choices closed until Refresh rereads the scope.
            let blocked = self.error.is_some_and(|e| e != wire::RECORDS_UNAVAILABLE);
            row = row.child(choice(
                "review-comparison",
                Select::new(&self.comparison_picker)
                    .placeholder("Choose saved revision")
                    .disabled(blocked)
                    .accessibility_label("Saved revision, this change or stack")
                    .menu_max_h(rems(18.))
                    .w_full(),
            ));
        }
        let mut actions = div()
            .id("review-actions")
            .test_support()
            .h_flex()
            .flex_none()
            .items_center()
            .gap_1()
            .ml_auto();
        if self.busy && self.has_content() {
            actions = actions.child(caption(self.loading_label(), cx).mr_1());
        }
        if self.after > 0 {
            actions = actions.child(
                ui::action("review-first", "First page", Action::Quiet)
                    .accessibility_label("First page of saved revisions")
                    .disabled(self.busy)
                    .on_click(cx.listener(|p, _, w, cx| {
                        if let (Some(k), Some(worker)) = (p.key.clone(), p.worker.clone()) {
                            p.after = 0;
                            p.request(Route::Comparisons(k, worker, 0), w, cx);
                        }
                    })),
            );
        }
        if let Some(next) = self.next {
            actions = actions.child(
                ui::action("review-more", "Next page", Action::Quiet)
                    .accessibility_label("Next page of saved revisions")
                    .disabled(self.busy)
                    .on_click(cx.listener(move |p, _, w, cx| {
                        if let (Some(k), Some(worker)) = (p.key.clone(), p.worker.clone()) {
                            p.after = next;
                            p.request(Route::Comparisons(k, worker, next), w, cx);
                        }
                    })),
            );
        }
        if self.snapshot.is_some() || !self.capture_limits.is_empty() {
            actions = actions.child(
                ui::icon_action(
                    "review-details",
                    "Revision details",
                    crate::app_icon::AppIcon::Info,
                    Action::Quiet,
                )
                .on_click(cx.listener(|p, _, w, cx| p.open_details(w, cx))),
            );
        }
        actions = actions.child(
            ui::icon_action(
                "review-refresh",
                "Refresh saved revisions",
                crate::app_icon::AppIcon::Retry,
                Action::Quiet,
            )
            .disabled(self.busy || self.key.is_none())
            .on_click(cx.listener(|p, _, w, cx| p.refresh(w, cx))),
        );
        row.child(actions)
    }

    /// Only real warnings sit above the diff; their explanations live in details.
    fn warnings(&self) -> Vec<AnyElement> {
        let mut out = vec![];
        let mut push = |id: &'static str, notice: Notice| {
            out.push(div().id(id).test_support().child(notice).into_any_element());
        };
        if let Some(e) = self.error {
            push("review-error", Notice::new(e).tone(Tone::Warning));
        }
        if let Some(n) = self.capture_notice {
            push("review-capture-notice", Notice::new(n).tone(Tone::Warning));
        }
        if self.more_workers {
            push(
                "review-more-workers",
                Notice::new("Only the first 100 current members are shown."),
            );
        }
        if let Some(s) = &self.snapshot {
            if s.status != "complete" {
                let mut n = Notice::new(if s.status == "partial" {
                    "Some of this revision wasn't retained."
                } else {
                    "This revision is unavailable."
                })
                .tone(Tone::Warning);
                if !s.omissions.is_empty() {
                    n = n.detail("Revision details lists what is missing.");
                }
                push("review-status", n);
            }
            if self.newer_listed() {
                push(
                    "review-newer",
                    Notice::new("A newer saved revision exists. This one stays selected."),
                );
            }
        }
        if let Some(e) = self.patch_error {
            push("review-patch-error", Notice::new(e).tone(Tone::Warning));
        }
        out
    }

    /// "N files changed +A −D", optional jump, and Unified/Split above the full diff.
    fn files_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let diff = self.diff.read(cx);
        let mode = diff.mode();
        let files = diff.files();
        let (add, del) = files
            .iter()
            .fold((0, 0), |(a, d), f| (a + f.additions(), d + f.deletions()));
        let count = files.len();
        let summary = div()
            .h_flex()
            .items_center()
            .gap_2()
            .min_w_0()
            .flex_1()
            .child(ui::text(
                Text::Label,
                SharedString::from(format!(
                    "{count} {} changed",
                    if count == 1 { "file" } else { "files" }
                )),
            ))
            .child(
                ui::text(Text::Caption, SharedString::from(format!("+{add}")))
                    .text_color(cx.theme().success),
            )
            .child(
                ui::text(Text::Caption, SharedString::from(format!("−{del}")))
                    .text_color(cx.theme().danger),
            );
        let pane = cx.entity().downgrade();
        div()
            .id("review-files-bar")
            .test_support()
            .h_flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .min_w_0()
            .child(summary.id("review-files-summary").test_support())
            .child(
                div()
                    .h_flex()
                    .flex_none()
                    .items_center()
                    .gap_2()
                    .ml_auto()
                    .children((count > 1).then(|| {
                        div().id("review-jump").test_support().w(rems(14.)).child(
                            Select::new(&self.file_picker)
                                .placeholder("Jump to file")
                                .accessibility_label("Jump to file")
                                .menu_max_h(rems(18.))
                                .w_full(),
                        )
                    }))
                    .child(segmented(
                        "review-mode",
                        [
                            ("review-unified", "Unified", mode == DiffMode::Unified, true),
                            ("review-split", "Split", mode == DiffMode::Split, true),
                        ],
                        move |ix| {
                            let pane = pane.clone();
                            let m = if ix == 0 {
                                DiffMode::Unified
                            } else {
                                DiffMode::Split
                            };
                            Box::new(move |_, _, cx| {
                                let _ = pane.update(cx, |p, cx| {
                                    p.diff.update(cx, |d, cx| d.set_mode(m, cx))
                                });
                            })
                        },
                    )),
            )
    }

    fn diff_view(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let pane = cx.entity().downgrade();
        div()
            .id("review-diff")
            .test_support()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .child(
                Diff::new(&self.diff)
                    .soft_wrap(true)
                    .render_header_suffix(move |file, _, _| {
                        let path = file.path().to_string();
                        let pane = pane.clone();
                        ui::action(
                            ElementId::Name(format!("review-view:{path}").into()),
                            "View file",
                            Action::Quiet,
                        )
                        .accessibility_label(SharedString::from(format!(
                            "View retained source of {path}"
                        )))
                        .on_click(move |_, w, cx| {
                            let path = path.clone();
                            let _ = pane.update(cx, |p, cx| p.view_file(path, w, cx));
                        })
                    }),
            )
    }

    fn source_view(
        &self,
        path: &str,
        text: &SharedString,
        cx: &mut Context<Self>,
    ) -> [AnyElement; 2] {
        let pane = cx.entity().downgrade();
        [
            div()
                .h_flex()
                .flex_wrap()
                .items_center()
                .gap_2()
                .min_w_0()
                .child(
                    ui::icon_action(
                        "review-back",
                        "Back to diff",
                        crate::app_icon::AppIcon::Back,
                        Action::Quiet,
                    )
                    .on_click(cx.listener(|p, _, w, cx| p.back(w, cx))),
                )
                .child(
                    ui::text(Text::Label, SharedString::from(path.to_owned()))
                        .id("review-source-title")
                        .test_support()
                        .flex_1()
                        .min_w_0()
                        .truncate(),
                )
                .child(segmented(
                    "review-side",
                    [
                        (
                            "review-before",
                            "Before",
                            self.source_side == "before",
                            self.side_available("before", cx),
                        ),
                        (
                            "review-after",
                            "After",
                            self.source_side == "after",
                            self.side_available("after", cx),
                        ),
                    ],
                    move |ix| {
                        let pane = pane.clone();
                        let side = if ix == 0 { "before" } else { "after" };
                        Box::new(move |_, w, cx| {
                            let _ = pane.update(cx, |p, cx| {
                                if p.source_side != side && !p.busy {
                                    p.read_source(side, w, cx)
                                }
                            });
                        })
                    },
                ))
                .into_any_element(),
            div()
                .id("review-source")
                .test_support()
                .flex_1()
                .min_h_0()
                .min_w_0()
                .p(px(ui::Space::CONTROL))
                .border_1()
                .border_color(cx.theme().border)
                .rounded(cx.theme().radius)
                .font_family(crate::appearance::CODE_FONT)
                .text_size(px(Text::Body.size()))
                .track_scroll(&self.source_scroll)
                .overflow_y_scrollbar()
                .child(SelectableText::new("review-source-text", text.clone()))
                .into_any_element(),
        ]
    }

    /// Fills the diff area when there is no diff: loading is not empty, and no
    /// saved revision is not "no code changes".
    fn state_view(&self) -> Option<AnyElement> {
        let (title, detail) = self.state_message()?;
        let mut notice = Notice::new(title);
        if self.busy {
            notice = notice.tone(Tone::Quiet);
        }
        if let Some(detail) = detail {
            notice = notice.detail(detail);
        }
        Some(
            div()
                .id("review-state")
                .test_support()
                .pt(px(ui::Space::CONTROL))
                .child(notice)
                .into_any_element(),
        )
    }
}

impl Render for Pane {
    fn render(&mut self, _w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let warnings = self.warnings();
        // The toolbar never scrolls, so its controls stay clear of the notes' scrollbar.
        let mut summary = div()
            .id("review-summary")
            .test_support()
            .flex_none()
            .v_flex()
            .gap(px(ui::Space::CONTROL))
            .min_w_0()
            .child(self.toolbar(cx));
        if !warnings.is_empty() {
            summary = summary.child(
                div()
                    .id("review-summary-scroll")
                    .max_h(rems(10.))
                    .min_h_0()
                    .track_scroll(&self.summary_scroll)
                    .overflow_y_scrollbar()
                    .child(
                        div()
                            .v_flex()
                            .gap(px(ui::Space::CONTROL))
                            .min_w_0()
                            .children(warnings),
                    ),
            );
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
                .gap(px(ui::Space::CONTROL))
                .on_action(cx.listener(|p, _: &Back, w, cx| p.back(w, cx)))
                .on_action(cx.listener(|p, _: &NextChange, _, cx| {
                    p.diff.update(cx, |d, cx| d.next_change(cx))
                }))
                .on_action(cx.listener(|p, _: &PreviousChange, _, cx| {
                    p.diff.update(cx, |d, cx| d.previous_change(cx))
                }))
                .child(summary);
        if let Some((path, text)) = self.source.clone() {
            root = root.children(self.source_view(&path, &text, cx));
        } else if self.snapshot.is_some() && self.patch_error.is_none() {
            root = root.child(self.files_bar(cx)).child(self.diff_view(cx));
        } else if let Some(state) = self.state_view() {
            root = root.child(state);
        }
        root
    }
}

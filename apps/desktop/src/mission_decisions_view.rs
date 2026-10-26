//! Decisions share Browser's already-bounded reader, scroll and mounted focus owner.
use super::*;
use crate::mission_decisions::{Section, Text as BoundedText};
use gpui_kit::component::ActiveTheme;
use std::collections::HashSet;

#[derive(Default)]
pub(crate) struct Disclosure {
    pub(super) opened: bool,
    source: bool,
    expanded: HashSet<String>,
    decisions: usize,
    proposals: usize,
}
impl Disclosure {
    pub(super) fn reconcile(&mut self, d: &Detail) {
        if let Ok(s) = &d.decisions {
            let ids: HashSet<String> = s
                .decisions
                .rows
                .iter()
                .flatten()
                .map(|d| format!("current-{}", d.id))
                .chain(
                    s.proposals
                        .rows
                        .iter()
                        .flatten()
                        .map(|p| format!("proposal-{}", p.id)),
                )
                .collect();
            self.expanded.retain(|id| ids.contains(id));
        }
    }
}
impl Browser {
    fn decision_source(&self) -> Option<&Arc<Detail>> {
        let d = self.detail.as_ref()?;
        (self.route == Some(Route::Detail(d.key.clone()))
            && self.local_home().as_ref() == Some(&d.key.home)
            && self.catalog.as_ref().is_some_and(|c| {
                c.rows.iter().any(|r| {
                    r.key == d.key
                        && r.sources
                            .iter()
                            .any(|s| s.canonical && s.home == d.key.home && s.project == d.project)
                })
            }))
        .then_some(d)
    }
    fn decision_matches(&self, d: &Arc<Detail>, generation: u64) -> bool {
        self.generation == generation
            && self
                .decision_source()
                .is_some_and(|current| Arc::ptr_eq(current, d))
    }
    fn decision_text(&self, id: String, text: &BoundedText) -> impl IntoElement {
        let focus = self.focus.clone();
        div().id(SharedString::from(id.clone())).test_support().w_full().min_w_0()
            .text_size(px(Text::Body.size())).line_height(px(Text::Body.size() * 1.6))
            .on_mouse_down(gpui_kit::MouseButton::Left, move |_, w, cx| focus.focus(w, cx))
            .child(SelectableText::new(
                SharedString::from(format!("{id}-{}", self.generation)),
                SharedString::from(if text.value.is_empty() {
                    if text.clipped { "(Text omitted by the viewing limit)".into() } else { "(Empty text)".into() }
                } else { text.value.clone() }),
            ))
            .children(text.clipped.then(|| Notice::new("Text capped. Copy includes only the displayed text, not the full saved content.").tone(Tone::Warning)))
    }
    fn decision_copy(
        &self,
        id: String,
        text: String,
        label: &'static str,
        d: &Arc<Detail>,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let d = d.clone();
        let generation = self.generation;
        ui::action(SharedString::from(id), label, Action::Quiet)
            .self_start()
            .on_click(cx.listener(move |v, _, _, cx| {
                if v.decision_matches(&d, generation) {
                    cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                }
            }))
    }
    fn decision_toggle(
        &self,
        id: String,
        label: String,
        d: &Arc<Detail>,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let d = d.clone();
        let generation = self.generation;
        ui::action(
            SharedString::from(format!("decisions-toggle-{id}")),
            SharedString::from(label),
            Action::Secondary,
        )
        .self_start()
        .on_click(cx.listener(move |v, _, w, cx| {
            if !v.decision_matches(&d, generation) || v.brief_marked(w, cx) {
                return;
            }
            v.focus.focus(w, cx);
            if !v.decisions.expanded.remove(&id) {
                v.decisions.expanded.insert(id.clone());
            }
            cx.notify();
        }))
    }
    pub(super) fn decisions_view(&self, cx: &Context<Self>) -> impl IntoElement {
        let generation = self.generation;
        let mut section = div()
            .id("mission-decisions")
            .test_support()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if v.brief_marked(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .v_flex()
            .w_full()
            .min_w_0()
            .gap(px(Space::CONTROL))
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .justify_between()
                    .children(
                        self.decisions
                            .opened
                            .then(|| ui::heading("decisions-heading", "Decisions", Text::Headline)),
                    )
                    .child(
                        ui::action(
                            "mission-decisions-open",
                            if self.decisions.opened {
                                "Hide"
                            } else {
                                "Read decisions"
                            },
                            if self.decisions.opened {
                                Action::Quiet
                            } else {
                                Action::Secondary
                            },
                        )
                        .on_click(cx.listener(move |v, _, w, cx| {
                            if v.generation != generation || v.brief_marked(w, cx) {
                                return;
                            }
                            v.focus.focus(w, cx);
                            v.decisions.opened = !v.decisions.opened;
                            cx.notify();
                        })),
                    ),
            );
        if !self.decisions.opened {
            return section;
        }
        section = section.child(
            ui::text(Text::Caption, "Binding decisions override the brief.")
                .text_color(cx.theme().muted_foreground),
        );
        let Some(d) = self.decision_source() else {
            return section.child(
                Notice::new(
                    "Decision source differs or is unavailable. No decision details are shown.",
                )
                .tone(Tone::Warning),
            );
        };
        if self.busy || self.error.is_some() || !self.online {
            section = section.child(
                div().id("decisions-stale").test_support().child(
                    Notice::new("Retained snapshot, not current. Refresh the mission to update.")
                        .tone(Tone::Warning),
                ),
            );
        }
        let source = d.clone();
        section = section.child(
            ui::action(
                "decisions-source",
                if self.decisions.source {
                    "Hide source"
                } else {
                    "Show source"
                },
                Action::Quiet,
            )
            .self_start()
            .on_click(cx.listener(move |v, _, w, cx| {
                if !v.decision_matches(&source, generation) || v.brief_marked(w, cx) {
                    return;
                }
                v.focus.focus(w, cx);
                v.decisions.source = !v.decisions.source;
                cx.notify();
            })),
        );
        if self.decisions.source {
            section = section.child(self.decision_text("decisions-source-text".into(), &BoundedText {
                value: format!("Mission {}\nProject {}\nHome {} / {}\nLocal mission detail GET · snapshot {}\nNo decision revision or compare-and-swap token is supplied. Proposal targets refer to the current snapshot, not a captured target revision.", d.key.id, d.project, d.key.home.daemon, d.key.home.lineage, generation),
                clipped: false,
            }));
        }
        let snapshot = match &d.decisions {
            Ok(s) => s,
            Err(e) => {
                return section.child(
                    div()
                        .id("decisions-error")
                        .test_support()
                        .child(Notice::new(*e).tone(Tone::Error)),
                );
            }
        };
        section = section
            .child(
                ui::text(Text::Label, "Current decisions")
                    .font_semibold()
                    .id("decisions-current-heading")
                    .test_support(),
            )
            .child(coverage(&snapshot.decisions, "decisions", cx));
        if let Some(rows) = &snapshot.decisions.rows {
            for item in rows.iter().take(self.decisions.decisions.max(8)) {
                let id = format!("current-{}", item.id);
                let expanded = self.decisions.expanded.contains(&id);
                let mut row = div()
                    .id(SharedString::from(format!("decisions-row-{}", item.id)))
                    .test_support()
                    .v_flex()
                    .min_w_0()
                    .gap(px(Space::CONTROL))
                    .py(px(Space::SIDEBAR))
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .h_flex()
                            .items_center()
                            .gap(px(Space::CONTROL))
                            .child(
                                ui::text(
                                    Text::Body,
                                    SharedString::from(format!("D{}", item.number)),
                                )
                                .font_semibold(),
                            )
                            .child(
                                ui::text(Text::Caption, item.audience)
                                    .text_color(cx.theme().muted_foreground),
                            ),
                    );
                if expanded {
                    row = row.child(
                        self.decision_text(format!("decisions-text-{}", item.id), &item.text),
                    );
                } else {
                    row = row.child(ui::text(
                        Text::Body,
                        SharedString::from(preview(&item.text)),
                    ));
                }
                row = row.child(
                    div()
                        .h_flex()
                        .gap(px(Space::CONTROL))
                        .child(self.decision_toggle(
                            id,
                            if expanded {
                                "Show less".into()
                            } else {
                                "Read full text".into()
                            },
                            d,
                            cx,
                        ))
                        .children(expanded.then(|| {
                            self.decision_copy(
                                format!("decisions-copy-{}", item.id),
                                item.text.value.clone(),
                                "Copy text",
                                d,
                                cx,
                            )
                        })),
                );
                section = section.child(row);
            }
            if rows.len() > self.decisions.decisions.max(8) {
                section = section.child(self.decision_more(false, d, cx));
            }
        }
        section = section
            .child(
                ui::text(Text::Label, "Pending proposals")
                    .font_semibold()
                    .id("decisions-proposals-heading")
                    .test_support(),
            )
            .child(
                ui::text(
                    Text::Caption,
                    "Unadopted, untrusted suggestions. Current decisions remain binding.",
                )
                .text_color(cx.theme().muted_foreground),
            )
            .child(coverage(&snapshot.proposals, "pending proposals", cx));
        if let Some(rows) = &snapshot.proposals.rows {
            for proposal in rows.iter().take(self.decisions.proposals.max(8)) {
                let id = format!("proposal-{}", proposal.id);
                let expanded = self.decisions.expanded.contains(&id);
                let target = snapshot
                    .decisions
                    .rows
                    .as_ref()
                    .and_then(|rows| rows.iter().find(|d| d.id == proposal.target))
                    .map(|d| format!("D{}", d.number))
                    .unwrap_or_else(|| "Unknown (missing, removed or outside this window)".into());
                let mut row = div()
                    .id(SharedString::from(format!(
                        "decisions-proposal-{}",
                        proposal.id
                    )))
                    .test_support()
                    .v_flex()
                    .w_full()
                    .min_w_0()
                    .gap(px(Space::CONTROL))
                    .p(px(Space::SIDEBAR))
                    .bg(ui::Surface::Tray.color(cx))
                    .rounded(px(ui::Radius::ROW))
                    .child(
                        ui::text(
                            Text::Body,
                            if proposal.kind == "Edit" {
                                "Proposed edit"
                            } else {
                                "Proposed removal"
                            },
                        )
                        .font_semibold(),
                    )
                    .child(
                        ui::text(Text::Caption, "Pending · Unadopted")
                            .text_color(cx.theme().muted_foreground),
                    )
                    .child(ui::text(
                        Text::Caption,
                        SharedString::from(format!("Target: {target}")),
                    ));
                if expanded {
                    row = row
                        .child(
                            div()
                                .h_flex()
                                .items_center()
                                .justify_between()
                                .child(ui::text(Text::Label, "Reason").font_semibold())
                                .child(self.decision_copy(
                                    format!("proposal-copy-reason-{}", proposal.id),
                                    proposal.reason.value.clone(),
                                    "Copy reason",
                                    d,
                                    cx,
                                )),
                        )
                        .child(self.decision_text(
                            format!("proposal-reason-{}", proposal.id),
                            &proposal.reason,
                        ));
                    if proposal.kind == "Remove" {
                        row = row.child(ui::text(Text::Body, "Suggests removing this decision."));
                    }
                    if let Some(text) = &proposal.text {
                        row = row
                            .child(
                                div()
                                    .h_flex()
                                    .items_center()
                                    .justify_between()
                                    .child(ui::text(Text::Label, "Proposed text").font_semibold())
                                    .child(self.decision_copy(
                                        format!("proposal-copy-{}", proposal.id),
                                        text.value.clone(),
                                        "Copy proposed text",
                                        d,
                                        cx,
                                    )),
                            )
                            .child(
                                self.decision_text(format!("proposal-text-{}", proposal.id), text),
                            );
                    } else if proposal.kind == "Edit" {
                        row = row.child(Notice::new("No proposed text supplied."));
                    }
                    row = row.child(
                        ui::text(
                            Text::Caption,
                            SharedString::from(format!(
                                "Proposal {} · target {}",
                                proposal.id, proposal.target
                            )),
                        )
                        .text_color(cx.theme().muted_foreground),
                    );
                } else {
                    row = row.child(ui::text(
                        Text::Body,
                        SharedString::from(format!("Reason: {}", preview(&proposal.reason))),
                    ));
                }
                row = row.child(self.decision_toggle(
                    id,
                    if expanded {
                        "Show less".into()
                    } else {
                        "Read proposal".into()
                    },
                    d,
                    cx,
                ));
                section = section.child(row);
            }
            if rows.len() > self.decisions.proposals.max(8) {
                section = section.child(self.decision_more(true, d, cx));
            }
        }
        section
    }
    fn decision_more(
        &self,
        proposals: bool,
        d: &Arc<Detail>,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let d = d.clone();
        let generation = self.generation;
        ui::action(
            if proposals {
                "decisions-more-proposals"
            } else {
                "decisions-more-current"
            },
            "Show 8 more",
            Action::Quiet,
        )
        .self_start()
        .on_click(cx.listener(move |v, _, w, cx| {
            if !v.decision_matches(&d, generation) || v.brief_marked(w, cx) {
                return;
            }
            let count = if proposals {
                &mut v.decisions.proposals
            } else {
                &mut v.decisions.decisions
            };
            *count = (*count)
                .max(8)
                .saturating_add(8)
                .min(crate::mission_decisions::ITEM_CAP);
            v.focus.focus(w, cx);
            cx.notify();
        }))
    }
}
fn preview(text: &BoundedText) -> String {
    if text.value.is_empty() && text.clipped {
        return "Text omitted by the viewing limit.".into();
    }
    let first = text.value.lines().next().unwrap_or("(Empty text)");
    let mut preview: String = first.chars().take(160).collect();
    if text.value.len() > preview.len() || text.clipped {
        preview.push('…');
    }
    preview
}
fn coverage<T>(section: &Section<T>, noun: &str, cx: &App) -> impl IntoElement {
    let text = match &section.rows {
        None => format!("{noun} not supplied. Coverage is unknown, not empty."),
        Some(rows) if section.capped => format!(
            "{} {noun} shown · first 128 of {} records checked. Capped; more may exist.",
            rows.len(),
            section.received
        ),
        Some(rows) if noun == "decisions" => format!("{} decisions", rows.len()),
        Some(rows) => format!(
            "{} pending · {} records checked",
            rows.len(),
            section.received
        ),
    };
    ui::text(Text::Caption, SharedString::from(text)).text_color(cx.theme().muted_foreground)
}

#[cfg(feature = "native-probes")]
#[path = "mission_decisions_probe.rs"]
pub(crate) mod probe;

#[cfg(test)]
mod mission_decisions_source_tests {
    use super::*;
    use crate::mission_browser_fixture as f;
    use gpui_kit::{AppContext, TestAppContext};
    #[test]
    fn disclosure_retention_and_zero_budget_preview_remain_truthful_and_bounded() {
        let d =
            crate::mission_browser::detail(&f::key("mission-A"), &f::detail("mission-A")).unwrap();
        let mut state = Disclosure::default();
        state
            .expanded
            .extend((0..256).map(|n| format!("removed-{n}")));
        state.reconcile(&d);
        assert!(state.expanded.is_empty());
        assert!(
            preview(&BoundedText {
                value: String::new(),
                clipped: true
            })
            .contains("viewing limit")
        );
        assert!(
            preview(&BoundedText {
                value: String::new(),
                clipped: false
            })
            .contains("Empty text")
        );
    }
    #[gpui_kit::test]
    fn exact_source_project_snapshot_and_generation_fence_callbacks(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let browser = cx.new(Browser::new);
        browser.update(cx, |b, _| {
            b.options(LocalOptions::synthetic(1));
            b.catalog = Some(Arc::new(
                crate::mission_browser::catalog(&f::catalog()).unwrap(),
            ));
            let d = Arc::new(
                crate::mission_browser::detail(&f::key("mission-A"), &f::detail("mission-A"))
                    .unwrap(),
            );
            b.detail = Some(d.clone());
            b.route = Some(Route::Detail(d.key.clone()));
            b.generation = 4;
            assert!(b.decision_matches(&d, 4));
            assert!(!b.decision_matches(&d, 3));
            b.detail = Some(Arc::new((*d).clone()));
            assert!(
                !b.decision_matches(&d, 4),
                "same values are not the captured read revision"
            );
            let mut wrong = (*d).clone();
            wrong.project = "project-B".into();
            b.detail = Some(Arc::new(wrong));
            assert!(b.decision_source().is_none());
            b.detail = Some(d.clone());
            b.route = Some(Route::Detail(f::key("mission-B")));
            assert!(b.decision_source().is_none());
            b.route = Some(Route::Detail(d.key.clone()));
            let mut wrong = (*d).clone();
            wrong.key.home.daemon = "other-daemon".into();
            b.route = Some(Route::Detail(wrong.key.clone()));
            b.detail = Some(Arc::new(wrong));
            assert!(b.decision_source().is_none());
        });
    }
}

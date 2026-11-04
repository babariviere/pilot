//! Insights findings on the mission's own task rows. Reads are passive GETs of the
//! linked report chat's findings, mapped by exact task ID. A row's decision only asks
//! the app to open its explicit confirmation; nothing here writes.
use super::*;
use crate::insights::{Finding, Lifecycle, Read, ReadReply};
use std::collections::HashMap;

/// At most this many findings pages (20 each) per read.
const PAGES: usize = 10;

#[derive(Default)]
pub(crate) struct Insights {
    pub(super) session: Option<String>,
    pub(super) findings: Arc<HashMap<String, Finding>>,
    read: Option<Task<()>>,
    lane: u64,
}
/// The explicit decision a row asks the app to confirm.
pub(crate) struct Decide(pub(crate) crate::insights_view::Scope);
impl gpui_kit::EventEmitter<Decide> for Pane {}

impl Pane {
    /// The mission's own report chat, from the cached chat list. None shows plain rows.
    pub(crate) fn set_insights(&mut self, session: Option<String>, cx: &mut Context<Self>) {
        if self.insights.session == session {
            return;
        }
        let lane = self.insights.lane.saturating_add(1);
        self.insights = Insights {
            session,
            lane,
            ..Default::default()
        };
        self.push_insights(cx);
        if self.opened {
            self.read_insights(cx);
        }
    }
    /// Re-read after a decision; passive and coalesced to the latest request.
    pub(crate) fn refresh_insights(&mut self, cx: &mut Context<Self>) {
        if self.opened {
            self.read_insights(cx);
        }
    }
    pub(super) fn read_insights(&mut self, cx: &mut Context<Self>) {
        let (Some(session), Some(options)) = (self.insights.session.clone(), self.options.clone())
        else {
            return;
        };
        self.insights.lane = self.insights.lane.saturating_add(1);
        let lane = self.insights.lane;
        self.insights.read = Some(cx.spawn(async move |view, cx| {
            let mut found = HashMap::new();
            let mut cursor = None;
            let mut ok = false;
            for _ in 0..PAGES {
                let Some(rx) = crate::insights::read(
                    options.clone(),
                    Read::Findings {
                        session: session.clone(),
                        cursor,
                    },
                ) else {
                    ok = false;
                    break;
                };
                match rx.recv().await {
                    Ok(ReadReply::Findings(Ok(page))) => {
                        for f in page.items {
                            found.entry(f.task_id.clone()).or_insert(f);
                        }
                        ok = true;
                        match page.next_cursor {
                            Some(n) => cursor = Some(n),
                            None => break,
                        }
                    }
                    // Access is off: rows stay plain tasks; decisions aren't offered.
                    Ok(ReadReply::Unavailable) => {
                        found.clear();
                        ok = true;
                        break;
                    }
                    _ => {
                        ok = false;
                        break;
                    }
                }
            }
            let _ = view.update(cx, |v, cx| {
                // A failed read keeps what was shown; it never invents a lifecycle.
                if v.insights.lane == lane && ok {
                    v.insights.findings = Arc::new(found);
                    v.push_insights(cx);
                }
            });
        }));
    }
    fn push_insights(&mut self, cx: &mut Context<Self>) {
        let findings = self.insights.findings.clone();
        if let Some(list) = &self.list {
            list.update(cx, |l, cx| {
                l.delegate_mut().insights = findings;
                cx.notify();
            });
        }
        cx.notify();
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_lifecycle(&self, task: &str) -> Option<Lifecycle> {
        self.insights.findings.get(task).map(|f| f.lifecycle)
    }
    pub(super) fn decide(
        &mut self,
        id: &str,
        to: Lifecycle,
        generation: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.state.generation != generation || self.marked(w, cx) {
            return;
        }
        let (Some(session), Some(f), Some(t)) = (
            self.insights.session.clone(),
            self.insights.findings.get(id).cloned(),
            self.state
                .snapshot
                .as_ref()
                .and_then(|s| s.task(id))
                .cloned(),
        ) else {
            return;
        };
        if !crate::insights_view::lifecycle_choices(f.lifecycle).contains(&to) {
            return;
        }
        self.select(id, generation, w, cx);
        cx.emit(Decide(crate::insights_view::Scope::Decide {
            session,
            key: f.key,
            number: t.number,
            title: t.title,
            from: f.lifecycle,
            to,
            expected_revision: f.revision,
        }));
    }
}

/// One terse line: priority, affected projects, then the estimate or measured result.
pub(super) fn meta(f: &Finding) -> String {
    let mut priority = f.priority.clone();
    if let Some(first) = priority.get_mut(..1) {
        first.make_ascii_uppercase();
    }
    let mut parts = vec![priority];
    if !f.targets.is_empty() {
        parts.push(
            f.targets
                .iter()
                .map(|t| t.label.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    if let Some(cost) = &f.cost {
        if cost.later_result.trim().is_empty() {
            parts.push(format!("est. {}", cost.estimate));
        } else {
            parts.push(format!("measured {}", cost.later_result));
        }
    }
    parts.join(" · ")
}
/// The finding's lifecycle; only Proposed (awaiting a decision) is emphasized.
pub(super) fn chip(id: &str, lifecycle: Lifecycle, cx: &App) -> impl IntoElement + use<> {
    let strong = lifecycle == Lifecycle::Proposed;
    div()
        .id(SharedString::from(format!("mission-task-insight-{id}")))
        .test_support()
        .flex_none()
        .px_2()
        .rounded_full()
        .bg(if strong {
            cx.theme().primary.opacity(0.12)
        } else {
            cx.theme().muted
        })
        .text_color(if strong {
            cx.theme().primary
        } else {
            cx.theme().muted_foreground
        })
        .child(ui::text(Text::Caption, lifecycle.label()).when(strong, |t| t.font_semibold()))
}
/// How many of a section's findings still await a decision.
pub(super) fn deciding(
    section: &crate::mission_tasks::Section,
    snapshot: &Snapshot,
    findings: &HashMap<String, Finding>,
) -> usize {
    section
        .tasks
        .iter()
        .filter(|i| {
            snapshot.tasks.get(**i).is_some_and(|t| {
                findings
                    .get(&t.id)
                    .is_some_and(|f| f.lifecycle == Lifecycle::Proposed)
            })
        })
        .count()
}

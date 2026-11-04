//! Insights entry points owned by LocalViewer: the report chat's backlog button and
//! settings, mission setup, and finding decisions chosen from Tasks rows.
//! LocalViewer owns the writer; the panel only emits explicit user actions.
use super::*;
use crate::insights_view::{Event as InsightsEvent, Panel, Scope};
use gpui_kit::component::WindowExt as _;

/// At most this many findings pages (20 each) behind the header count.
const COUNT_PAGES: usize = 10;

/// Findings awaiting a decision, as far as the bounded passive read could tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PendingCount {
    /// Pagination ran out: the complete total.
    Exact(usize),
    /// The page budget ran out, or a later page failed: a lower bound only.
    AtLeast(usize),
    /// The first read failed or was unsupported: nothing is known.
    Unavailable,
}
impl PendingCount {
    /// The header button's accessible name and tooltip.
    pub(super) fn label(self) -> SharedString {
        match self {
            Self::Exact(0) => "Insights backlog".into(),
            Self::Exact(n) => format!("Insights backlog, {n} to decide").into(),
            Self::AtLeast(0) => "Insights backlog, count incomplete".into(),
            Self::AtLeast(n) => format!("Insights backlog, {n}+ to decide").into(),
            Self::Unavailable => "Insights backlog, count unavailable".into(),
        }
    }
    /// The badge, only when findings are known to await a decision.
    pub(super) fn badge(self) -> Option<SharedString> {
        match self {
            Self::Exact(0) | Self::AtLeast(0) | Self::Unavailable => None,
            Self::Exact(n) if n <= 99 => Some(n.to_string().into()),
            Self::Exact(_) => Some("99+".into()),
            Self::AtLeast(n) => Some(format!("{}+", n.min(99)).into()),
        }
    }
}

/// Folds findings pages into a count, stopping at the page budget.
#[derive(Default)]
struct CountPages {
    count: usize,
    read: usize,
}
impl CountPages {
    /// One page's Proposed findings; `Some` once the count is settled.
    fn page(&mut self, proposed: usize, more: bool) -> Option<PendingCount> {
        self.count += proposed;
        self.read += 1;
        if !more {
            Some(PendingCount::Exact(self.count))
        } else if self.read >= COUNT_PAGES {
            Some(PendingCount::AtLeast(self.count))
        } else {
            None
        }
    }
    /// Unavailable, unsupported or failed: keep what was seen, never a guess.
    fn failed(&self) -> PendingCount {
        if self.read == 0 {
            PendingCount::Unavailable
        } else {
            PendingCount::AtLeast(self.count)
        }
    }
}

impl LocalViewer {
    fn selected_insights_chat(&self) -> Option<&Chat> {
        self.selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .filter(|c| c.insights && !c.local_draft)
    }
    /// Header entry for a report chat: its backlog, with findings awaiting a decision.
    pub(super) fn insights_action(&self, cx: &mut Context<Self>) -> Option<gpui_kit::AnyElement> {
        let chat = self.selected_insights_chat()?;
        let id = chat.id.clone();
        let mission = match &chat.mission {
            crate::local_model::MissionAssociation::Linked(m) => Some(m.clone()),
            _ => None,
        };
        // Not read yet: no hint, the same as a complete zero.
        let count = self
            .insights_counts
            .get(&id)
            .copied()
            .unwrap_or(PendingCount::Exact(0));
        let label = count.label();
        let badge = count.badge();
        Some(
            div()
                .relative()
                .flex_none()
                .child(
                    crate::ui::icon_action(
                        "insights-access",
                        label,
                        AppIcon::Tasks,
                        crate::ui::Action::Quiet,
                    )
                    .on_click(cx.listener(move |v, _, w, cx| {
                        if v.editor.update(cx, |e, cx| e.marked(w, cx)) {
                            return;
                        }
                        match &mission {
                            Some(m) => v.open_insights_backlog(m.clone(), w, cx),
                            None => v.open_insights(
                                Scope::Chat {
                                    session: id.clone(),
                                },
                                w,
                                cx,
                            ),
                        }
                    })),
                )
                .when_some(badge, |d, badge| {
                    d.child(
                        div()
                            .id("insights-access-count")
                            .test_support()
                            .absolute()
                            .top(px(-2.))
                            .right(px(-4.))
                            .min_w(px(14.))
                            .h(px(14.))
                            .px(px(3.))
                            .rounded_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .bg(cx.theme().primary)
                            .text_color(cx.theme().primary_foreground)
                            .text_size(px(9.))
                            .font_semibold()
                            .child(badge),
                    )
                })
                .into_any_element(),
        )
    }
    /// The selected report chat's compact settings, from its … menu.
    pub(super) fn can_open_insights_settings(&self) -> bool {
        self.selected_insights_chat().is_some() && self.usage_options.is_some()
    }
    pub(super) fn open_insights_settings(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.selected_insights_chat().map(|c| c.id.clone()) else {
            return;
        };
        if self.editor.update(cx, |e, cx| e.marked(w, cx)) {
            return;
        }
        self.open_insights(Scope::Chat { session }, w, cx);
    }
    /// The linked mission's Tasks, through ordinary mission navigation.
    pub(super) fn open_insights_backlog(
        &mut self,
        mission: String,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = self
            .missions
            .read(cx)
            .local_home()
            .map(|home| crate::mission_browser::Key {
                home,
                id: mission.clone(),
            })
            .filter(|key| key.valid());
        if self.show_chat_mission(&mission, w, cx)
            && let Some(key) = key
        {
            self.missions.update(cx, |b, cx| b.want_tasks(key, w, cx));
        }
    }

    /// Explicit setup for an active mission, from its overview menu.
    pub(super) fn open_insights_setup(
        &mut self,
        mission: String,
        mission_title: String,
        project: String,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(path) = self
            .state
            .projects
            .iter()
            .find(|p| p.id == project)
            .map(|p| p.path.clone())
        else {
            self.nav_error = Some("The mission's project isn't available on this Local.");
            cx.notify();
            return;
        };
        self.open_insights(
            Scope::Setup {
                mission,
                mission_title,
                project,
                path,
            },
            w,
            cx,
        );
    }

    pub(super) fn open_insights(&mut self, scope: Scope, w: &mut Window, cx: &mut Context<Self>) {
        let Some(options) = self.usage_options.clone() else {
            return;
        };
        // The report chat's model ID, and its directory to read the display name.
        let (model, path) = match &scope {
            Scope::Chat { session } => self
                .state
                .chats
                .iter()
                .find(|c| &c.id == session)
                .map(|c| {
                    (
                        c.model_configuration.as_ref().and_then(|m| m.model.clone()),
                        Some(c.cwd.clone()).filter(|p| !p.is_empty()),
                    )
                })
                .unwrap_or_default(),
            _ => (None, None),
        };
        let panel = match &self.insights {
            Some((p, _)) if p.read(cx).matches(&scope, &options) => {
                let p = p.clone();
                p.update(cx, |p, cx| {
                    p.visible = true;
                    p.refresh(cx);
                });
                p
            }
            _ => {
                if self.insights.is_some() {
                    self.close_insights(w, cx);
                }
                let panel = cx.new(|cx| Panel::new(scope, options, model, path, cx));
                let events = cx.subscribe_in(&panel, w, |v, panel, event, w, cx| {
                    v.insights_event(panel, event, w, cx)
                });
                self.insights = Some((panel.clone(), events));
                panel
            }
        };
        let projects = self.state.projects.clone();
        panel.update(cx, |p, cx| p.enable_projects(projects, cx));
        let (book, reply) = (self.insights_book.clone(), self.insights_reply.clone());
        panel.update(cx, |p, cx| p.accept(book.as_ref(), reply.as_ref(), cx));
        self.insights_return = w.focused(cx);
        Panel::open(panel, w, cx);
    }

    fn insights_event(
        &mut self,
        panel: &Entity<Panel>,
        event: &InsightsEvent,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.insights.as_ref().is_none_or(|(p, _)| p != panel) {
            return;
        }
        let decided = match &panel.read(cx).scope {
            // A decision, or settings that may have revoked access, can change the count.
            Scope::Decide { session, .. } | Scope::Chat { session } => Some(session.clone()),
            _ => None,
        };
        match event {
            InsightsEvent::Close => {
                self.close_insights(w, cx);
                // A rejected or unconfirmed decision may have changed the finding.
                if let Some(session) = decided {
                    self.insights_decided(session, cx);
                }
            }
            InsightsEvent::Write { request, action } => {
                let sent = self.writer.as_ref().is_some_and(|writer| {
                    writer.command(crate::interaction::WriteCommand::Insights {
                        request: *request,
                        action: action.clone(),
                    })
                });
                if !sent {
                    panel.update(cx, |p, cx| p.not_sent(cx));
                }
            }
            InsightsEvent::Decided => {
                self.close_insights(w, cx);
                if let Some(session) = decided {
                    self.insights_decided(session, cx);
                }
            }
            InsightsEvent::OpenBacklog(mission) => {
                let mission = mission.clone();
                self.close_insights(w, cx);
                self.open_insights_backlog(mission, w, cx);
            }
            InsightsEvent::OpenChat(id) => {
                let mission = match &panel.read(cx).scope {
                    Scope::Setup { mission, .. } => Some(mission.clone()),
                    Scope::Enable { .. } => panel.read(cx).enable_mission(),
                    _ => None,
                };
                self.close_insights(w, cx);
                if let Some(chat) = self
                    .state
                    .chats
                    .iter()
                    .find(|c| &c.id == id && !c.local_draft)
                    .cloned()
                {
                    self.open(chat, w, cx);
                } else if let Some(mission) = mission {
                    // The new chat appears with the next summary; its mission lists it.
                    self.show_chat_mission(&mission, w, cx);
                }
            }
            InsightsEvent::OpenAutomationSettings => {
                self.close_insights(w, cx);
                self.open_chat_settings(w, cx);
            }
            InsightsEvent::EnableWeekly(session) => {
                let session = session.clone();
                self.close_insights(w, cx);
                self.open_insights_enable(Some(session), w, cx);
            }
        }
    }

    /// The trusted backlog of a report chat: its exact project, linked mission and itself.
    fn insights_binding(chat: &Chat) -> Option<(String, String, String)> {
        match (&chat.mission, &chat.project_id) {
            (crate::local_model::MissionAssociation::Linked(m), Some(p))
                if chat.insights && !chat.local_draft =>
            {
                Some((p.clone(), m.clone(), chat.id.clone()))
            }
            _ => None,
        }
    }
    /// Weekly enable, from Automations (`from` None) or a report chat's settings.
    /// A binding comes only from report chats, never a title; ambiguity means a choice.
    pub(super) fn open_insights_enable(
        &mut self,
        from: Option<String>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.editor.update(cx, |e, cx| e.marked(w, cx)) {
            return;
        }
        let mut reports: Vec<_> = self
            .state
            .chats
            .iter()
            .filter(|c| from.as_ref().is_none_or(|id| &c.id == id))
            .filter_map(Self::insights_binding)
            .collect();
        reports.sort();
        self.open_insights(Scope::Enable { reports }, w, cx);
    }
    /// Settings → Chats, where the existing Automations switch lives. Nothing is switched.
    pub(super) fn open_chat_settings(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.project_choices_ready(w, cx) {
            return;
        }
        let open = self.settings_window.is_some();
        self.settings.update(cx, |owner, cx| {
            if !owner.restart_locked {
                owner.category = crate::settings_view::Category::Chats;
                cx.notify();
            }
        });
        if open && let Some(chats) = self.settings.read(cx).chats.clone() {
            chats.update(cx, |c, cx| c.open(cx));
        }
        self.open_settings(w, cx);
    }
    /// Re-read the Tasks rows and the header count after a decision closes.
    pub(super) fn insights_decided(&mut self, session: String, cx: &mut Context<Self>) {
        let tasks = self.missions.read(cx).tasks_browser.clone();
        tasks.update(cx, |p, cx| p.refresh_insights(cx));
        self.insights_counts.remove(&session);
        self.read_insights_count(session, cx);
    }

    pub(super) fn close_insights(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some((panel, _)) = &self.insights else {
            return;
        };
        let panel = panel.clone();
        if !panel.read(cx).visible {
            return;
        }
        let owned = panel.read(cx).owns_focus(w, cx);
        w.close_dialog(cx);
        panel.update(cx, |p, cx| {
            p.visible = false;
            cx.notify();
        });
        if owned && let Some(focus) = self.insights_return.take() {
            focus.focus(w, cx);
        }
        cx.notify();
    }

    /// The selected report chat's findings awaiting a decision, read once per chat.
    pub(super) fn sync_insights_count(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.selected_insights_chat().map(|c| c.id.clone()) else {
            return;
        };
        if self.insights_counts.contains_key(&id)
            || self
                .insights_count_read
                .as_ref()
                .is_some_and(|(s, _)| s == &id)
        {
            return;
        }
        self.read_insights_count(id, cx);
    }
    fn read_insights_count(&mut self, session: String, cx: &mut Context<Self>) {
        let Some(options) = self.usage_options.clone() else {
            return;
        };
        let reading = session.clone();
        let task = cx.spawn(async move |view, cx| {
            use crate::insights::{Lifecycle, Read, ReadReply};
            let mut pages = CountPages::default();
            let mut cursor = None;
            // Bounded: `page` settles at COUNT_PAGES.
            let count = loop {
                let Some(rx) = crate::insights::read(
                    options.clone(),
                    Read::Findings {
                        session: session.clone(),
                        cursor,
                    },
                ) else {
                    break pages.failed();
                };
                match rx.recv().await {
                    Ok(ReadReply::Findings(Ok(page))) => {
                        let proposed = page
                            .items
                            .iter()
                            .filter(|f| f.lifecycle == Lifecycle::Proposed)
                            .count();
                        if let Some(count) = pages.page(proposed, page.next_cursor.is_some()) {
                            break count;
                        }
                        cursor = page.next_cursor;
                    }
                    _ => break pages.failed(),
                }
            };
            let _ = view.update(cx, |v, cx| {
                if v.insights_count_read
                    .as_ref()
                    .is_some_and(|(s, _)| s == &session)
                {
                    v.insights_count_read = None;
                }
                v.insights_counts.insert(session, count);
                cx.notify();
            });
        });
        self.insights_count_read = Some((reading, task));
    }
}

#[cfg(test)]
mod count_tests {
    use super::{COUNT_PAGES, CountPages, PendingCount};

    fn run(pages: &[(usize, bool)], failure: bool) -> PendingCount {
        let mut tally = CountPages::default();
        for &(proposed, more) in pages {
            if let Some(count) = tally.page(proposed, more) {
                assert!(!failure, "settled before the failing page");
                return count;
            }
        }
        assert!(failure, "an unsettled count needs another page");
        tally.failed()
    }

    #[test]
    fn exhausted_pagination_is_exact() {
        assert_eq!(run(&[(3, true), (1, false)], false), PendingCount::Exact(4));
        assert_eq!(run(&[(0, false)], false), PendingCount::Exact(0));
        let four = PendingCount::Exact(4);
        assert_eq!(four.label(), "Insights backlog, 4 to decide");
        assert_eq!(four.badge().as_deref(), Some("4"));
        assert_eq!(PendingCount::Exact(0).label(), "Insights backlog");
        assert_eq!(PendingCount::Exact(0).badge(), None);
    }

    #[test]
    fn page_budget_with_continuation_is_a_lower_bound() {
        let mut tally = CountPages::default();
        for _ in 1..COUNT_PAGES {
            assert_eq!(tally.page(2, true), None);
        }
        let capped = tally.page(2, true);
        assert_eq!(capped, Some(PendingCount::AtLeast(2 * COUNT_PAGES)));
        // The last budgeted page without a continuation is still complete.
        let mut tally = CountPages::default();
        for _ in 1..COUNT_PAGES {
            tally.page(2, true);
        }
        assert_eq!(
            tally.page(2, false),
            Some(PendingCount::Exact(2 * COUNT_PAGES))
        );
        let at_least = PendingCount::AtLeast(20);
        assert_eq!(at_least.label(), "Insights backlog, 20+ to decide");
        assert_eq!(at_least.badge().as_deref(), Some("20+"));
    }

    #[test]
    fn overflow_is_explicit() {
        let exact = PendingCount::Exact(150);
        assert_eq!(exact.badge().as_deref(), Some("99+"));
        assert_eq!(exact.label(), "Insights backlog, 150 to decide");
        assert_eq!(PendingCount::Exact(99).badge().as_deref(), Some("99"));
        assert_eq!(PendingCount::Exact(100).badge().as_deref(), Some("99+"));
        let capped = PendingCount::AtLeast(200);
        assert_eq!(capped.badge().as_deref(), Some("99+"));
        assert_eq!(capped.label(), "Insights backlog, 200+ to decide");
    }

    #[test]
    fn incomplete_zero_never_claims_none() {
        let pages = vec![(0, true); COUNT_PAGES];
        let zero = run(&pages, false);
        assert_eq!(zero, PendingCount::AtLeast(0));
        assert_ne!(zero, PendingCount::Exact(0));
        assert_eq!(zero.badge(), None);
        assert_eq!(zero.label(), "Insights backlog, count incomplete");
        // A later page failing after nothing was found is incomplete, too.
        assert_eq!(run(&[(0, true)], true), PendingCount::AtLeast(0));
    }

    #[test]
    fn read_failure_is_unavailable_not_zero() {
        let failed = run(&[], true);
        assert_eq!(failed, PendingCount::Unavailable);
        assert_eq!(failed.badge(), None);
        assert_eq!(failed.label(), "Insights backlog, count unavailable");
        // Findings already seen stay a known lower bound.
        assert_eq!(run(&[(5, true)], true), PendingCount::AtLeast(5));
    }
}

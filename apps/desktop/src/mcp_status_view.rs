//! Local Settings page for global MCP servers. Daemon-owned checks and browser sign-in only;
//! no account, credential or configuration owner.
use crate::{
    LocalOptions,
    mcp_status::{RowAction, Server, Snapshot, State, timestamp},
    mcp_status_reader::{Act, Outcome, Reader, Request, perform},
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    Context, InteractiveElement, IntoElement, ParentElement, Render, SharedString, Styled, Task,
    TestSupportExt, Window,
    base::SelectableText,
    component::{ActiveTheme, Disableable, StyledExt},
    div, px,
};
use std::sync::Arc;

/// A control-stream `mcp` report, parsed off the UI thread.
pub(crate) type Pushed = Arc<Result<Snapshot, &'static str>>;

struct Note {
    server: Option<String>,
    text: &'static str,
    tone: Tone,
}

pub(crate) struct Connections {
    pub(crate) state: State,
    options: LocalOptions,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    details: Option<String>,
    /// The category is showing. Pushes and action results only land while open.
    open: bool,
    /// Bumped on close: obsolete action results are ignored, never cancelled.
    session: u64,
    pub(crate) pending: Option<Act>,
    action: Option<Task<()>>,
    note: Option<Note>,
    seen: Option<Pushed>,
}
impl Connections {
    pub(crate) fn new(options: LocalOptions) -> Self {
        Self {
            state: State::default(),
            options,
            reader: None,
            updates: None,
            details: None,
            open: false,
            session: 0,
            pending: None,
            action: None,
            note: None,
            seen: None,
        }
    }
    /// Leaving drops reads and ignores action results. Daemon sign-ins keep running.
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        self.reader = None;
        self.updates = None;
        self.state.generation += 1;
        self.state.busy = false;
        self.open = false;
        self.session += 1;
        self.pending = None;
        self.action = None;
        self.note = None;
        cx.notify();
    }
    /// Existing control-stream updates. Only a new report while open replaces the page.
    pub(crate) fn pushed(&mut self, report: Pushed, cx: &mut Context<Self>) {
        if self
            .seen
            .as_ref()
            .is_some_and(|seen| Arc::ptr_eq(seen, &report))
        {
            return;
        }
        self.seen = Some(report.clone());
        if self.open {
            self.state
                .adopt((*report).clone(), crate::usage_overview::now());
            self.forget_details();
            cx.notify();
        }
    }
    fn forget_details(&mut self) {
        if self.details.as_ref().is_some_and(|name| {
            !self
                .state
                .snapshot
                .as_ref()
                .is_some_and(|s| s.servers.iter().any(|s| &s.name == name))
        }) {
            self.details = None;
        }
    }
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        self.open = true;
        let generation = self.state.begin();
        if self.reader.is_none() {
            match Reader::start(self.options.clone()) {
                Err(error) => {
                    self.state.accept(generation, Err(error), 0);
                    cx.notify();
                    return;
                }
                Ok((reader, output)) => {
                    self.reader = Some(reader);
                    self.updates = Some(cx.spawn(async move |view, cx| {
                        while let Ok(response) = output.recv().await {
                            if view
                                .update(cx, |v, cx| {
                                    if v.state.accept(
                                        response.generation,
                                        response.result,
                                        crate::usage_overview::now(),
                                    ) {
                                        v.forget_details();
                                        cx.notify();
                                    }
                                })
                                .is_err()
                            {
                                return;
                            }
                        }
                        let _ = view.update(cx, |v, cx| {
                            v.reader = None;
                            v.state.busy = false;
                            v.state.error =
                                Some("Local MCP status reader stopped. Refresh to retry.");
                            cx.notify();
                        });
                    }));
                }
            }
        }
        if !self
            .reader
            .as_ref()
            .is_some_and(|r| r.request(Request { generation }))
        {
            self.state.accept(
                generation,
                Err("Local MCP status read could not be queued. Refresh to retry."),
                0,
            );
        }
        cx.notify();
    }
    /// Only from a deliberate click/keypress. One action at a time; no retry.
    pub(crate) fn run(&mut self, act: Act, cx: &mut Context<Self>) {
        if !self.open || self.pending.is_some() || !self.applies(&act) {
            return;
        }
        self.note = None;
        self.pending = Some(act.clone());
        let session = self.session;
        let outcome = perform(self.options.clone(), act.clone());
        self.action = Some(cx.spawn(async move |view, cx| {
            let outcome = outcome.recv().await.unwrap_or(Outcome::Refused(
                "Pilot couldn’t start the request. Nothing was sent.",
            ));
            let _ = view.update(cx, |v, cx| v.finish(session, act, outcome, cx));
        }));
        cx.notify();
    }
    /// The visible row still offers this action, including the exact sign-in start to cancel.
    fn applies(&self, act: &Act) -> bool {
        let row = |name: &str| -> Option<&Server> {
            self.state
                .snapshot
                .as_ref()?
                .servers
                .iter()
                .find(|s| s.name == name)
        };
        match act {
            Act::Check { server: None } => self.state.snapshot.is_some(),
            Act::Check { server: Some(name) } => {
                row(name).is_some_and(|s| s.action() == Some(RowAction::CheckAgain))
            }
            Act::SignIn {
                server,
                again: false,
            } => row(server).is_some_and(|s| s.action() == Some(RowAction::SignIn)),
            Act::SignIn {
                server,
                again: true,
            } => row(server).is_some_and(Server::can_sign_in_again),
            Act::Cancel { server, started_at } => {
                row(server).is_some_and(|s| s.action() == Some(RowAction::Cancel(*started_at)))
            }
        }
    }
    fn finish(&mut self, session: u64, act: Act, outcome: Outcome, cx: &mut Context<Self>) {
        if session != self.session {
            return;
        }
        self.pending = None;
        self.action = None;
        let server = act.server().map(str::to_owned);
        match outcome {
            Outcome::SignIn(Some(ack)) => {
                if let Some(name) = &server {
                    self.state.record_sign_in(name, ack);
                }
            }
            Outcome::SignIn(None) => {}
            Outcome::Status(snapshot) => {
                self.state.adopt(Ok(snapshot), crate::usage_overview::now());
                self.forget_details();
            }
            Outcome::Refused(text) => {
                self.note = Some(Note {
                    server,
                    text,
                    tone: Tone::Error,
                });
                if matches!(act, Act::Cancel { .. }) {
                    self.load(cx);
                }
            }
            Outcome::Unconfirmed(text) => {
                self.note = Some(Note {
                    server,
                    text,
                    tone: Tone::Warning,
                });
                // A passive re-read shows what happened. The request is never repeated.
                self.load(cx);
            }
        }
        cx.notify();
    }
    fn note_for(&self, server: Option<&str>) -> Option<&Note> {
        self.note.as_ref().filter(|n| n.server.as_deref() == server)
    }
    fn row(&self, server: &Server, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let name = server.name.clone();
        let expanded = self.details.as_ref() == Some(&name);
        let busy = self.pending.is_some();
        let mine = self.pending.as_ref().and_then(Act::server) == Some(name.as_str());
        let id = |part: &str| SharedString::from(format!("mcp-{part}-{name}"));
        let mut text = div()
            .v_flex()
            .flex_1()
            .min_w_0()
            .gap_1()
            .child(
                div()
                    .id(id("text"))
                    .test_support()
                    .w_full()
                    .min_w_0()
                    .child(SelectableText::new(
                        id("name"),
                        SharedString::from(name.clone()),
                    )),
            )
            .child(
                ui::text(Text::Caption, server.label())
                    .id(id("state"))
                    .test_support()
                    .text_color(server.tone().color(cx)),
            );
        if let Some((line, tone)) = server.sign_in_line() {
            text = text.child(
                ui::text(Text::Caption, SharedString::from(line))
                    .id(id("sign-in"))
                    .test_support()
                    .text_color(tone.color(cx)),
            );
        }
        if let Some(problem) = &server.problem {
            text = text.child(div().text_size(px(Text::Caption.size())).child(
                SelectableText::new(id("problem"), SharedString::from(problem.clone())),
            ));
        }
        if let Some(note) = self.note_for(Some(&name)) {
            text = text.child(
                div()
                    .id(id("note"))
                    .test_support()
                    .child(Notice::new(note.text).tone(note.tone)),
            );
        }
        let details_name = name.clone();
        text = text.child(
            ui::action(
                id("details"),
                if expanded { "Hide details" } else { "Details" },
                Action::Quiet,
            )
            .self_start()
            .accessibility_label(SharedString::from(format!("Details for {name}")))
            .on_click(cx.listener(move |v, _, _, cx| {
                v.details = if expanded {
                    None
                } else {
                    Some(details_name.clone())
                };
                cx.notify();
            })),
        );
        if expanded {
            text = text.child(div().id("mcp-detail-text").test_support().child(
                SelectableText::new("mcp-detail-content", SharedString::from(server.details())),
            ));
            if server.can_sign_in_again() {
                let act = Act::SignIn {
                    server: name.clone(),
                    again: true,
                };
                text = text.child(
                    ui::action(id("sign-in-again"), "Sign in again", Action::Quiet)
                        .self_start()
                        .tooltip("Opens your browser to sign in with another account or scope")
                        .accessibility_label(SharedString::from(format!("Sign in again to {name}")))
                        .disabled(busy)
                        .loading(
                            mine && matches!(self.pending, Some(Act::SignIn { again: true, .. })),
                        )
                        .on_click(cx.listener(move |v, _, _, cx| v.run(act.clone(), cx))),
                );
            }
        }
        let mut row = div()
            .id(id("row"))
            .test_support()
            .h_flex()
            .items_start()
            .w_full()
            .min_w_0()
            .gap_3()
            .py_3()
            .child(text);
        if let Some(action) = server.action() {
            let (label, role, act, help) = match action {
                RowAction::SignIn => (
                    "Sign in",
                    Action::Secondary,
                    Act::SignIn {
                        server: name.clone(),
                        again: false,
                    },
                    "Opens your browser to sign in",
                ),
                RowAction::Cancel(started_at) => (
                    "Cancel sign-in",
                    Action::Quiet,
                    Act::Cancel {
                        server: name.clone(),
                        started_at,
                    },
                    "Stops waiting for this browser sign-in",
                ),
                RowAction::CheckAgain => (
                    "Check again",
                    Action::Quiet,
                    Act::Check {
                        server: Some(name.clone()),
                    },
                    "Asks Local to connect to this server again",
                ),
            };
            row = row.child(
                ui::action(id("action"), label, role)
                    .flex_none()
                    .tooltip(help)
                    .accessibility_label(SharedString::from(format!("{label}: {name}")))
                    .disabled(busy)
                    .loading(mine && !matches!(self.pending, Some(Act::SignIn { again: true, .. })))
                    .on_click(cx.listener(move |v, _, _, cx| v.run(act.clone(), cx))),
            );
        }
        div()
            .v_flex()
            .w_full()
            .child(ui::rule(window, cx))
            .child(row)
    }
}
impl Render for Connections {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let checking = self.state.snapshot.as_ref().is_some_and(|s| s.checking);
        let check_pending = matches!(self.pending, Some(Act::Check { server: None }));
        let mut controls = div()
            .h_flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .child(
                ui::action("mcp-check", "Check now", Action::Quiet)
                    .tooltip("Asks Local to connect to every server again. Local process servers may start.")
                    .disabled(self.pending.is_some() || checking || self.state.snapshot.is_none())
                    .loading(check_pending)
                    .on_click(cx.listener(|v, _, _, cx| v.run(Act::Check { server: None }, cx))),
            )
            .child(
                ui::action("mcp-refresh", "Refresh", Action::Quiet)
                    .tooltip("Re-reads Local’s last report. Nothing is checked.")
                    .disabled(self.state.busy)
                    .on_click(cx.listener(|v, _, _, cx| v.load(cx))),
            );
        if let Some(at) = self.state.read_at {
            controls = controls.child(
                ui::text(
                    Text::Caption,
                    SharedString::from(format!("Last read {}", timestamp(at))),
                )
                .text_color(cx.theme().muted_foreground),
            );
        }
        let mut page = div().id("mcp-page").test_support().v_flex().w_full().min_w_0().gap_4()
            .child(ui::header("mcp-title", "MCP connections", Text::Title)
                .child(ui::text(Text::Body, "Local · global Pi servers")))
            .child(ui::text(Text::Caption, "Last reported checks, not live chat connections. Refresh only reads the daemon’s report; Check now asks it to connect again.").text_color(cx.theme().muted_foreground))
            .child(controls);
        if self.state.busy {
            page = page.child(notice("mcp-loading", "Reading status…", Tone::Quiet));
        }
        if let Some(error) = self.state.error {
            page = page.child(notice("mcp-error", error, Tone::Error));
        }
        if let Some(note) = self.note_for(None) {
            page = page.child(notice("mcp-note", note.text, note.tone));
        }
        let Some(snapshot) = &self.state.snapshot else {
            if !self.state.busy && self.state.error.is_none() {
                page = page.child(notice(
                    "mcp-unread",
                    "MCP status has not been read.",
                    Tone::Quiet,
                ));
            }
            return page;
        };
        if self.state.error.is_some() || self.state.busy {
            page = page.child(notice(
                "mcp-stale",
                "Stale · showing the previous Local report, not current connection state.",
                Tone::Quiet,
            ));
        }
        if snapshot.checking {
            page = page.child(notice(
                "mcp-checking",
                "The daemon reported a check in progress. Rows keep the previous results.",
                Tone::Quiet,
            ));
        }
        if let Some(n) = snapshot.config_problems.filter(|n| *n > 0) {
            let problem = if n == 1 {
                "1 MCP configuration entry needs attention.".into()
            } else {
                format!("{n} MCP configuration entries need attention.")
            };
            page = page.child(notice(
                "mcp-config-problem",
                SharedString::from(problem),
                Tone::Warning,
            ));
        }
        if snapshot.servers.is_empty() {
            return page.child(notice(
                "mcp-empty",
                "No MCP servers reported. This does not prove that no servers are configured.",
                Tone::Quiet,
            ));
        }
        let rows: Vec<_> = snapshot
            .servers
            .iter()
            .map(|server| self.row(server, window, cx).into_any_element())
            .collect();
        page.child(
            div()
                .id("mcp-list")
                .test_support()
                .v_flex()
                .w_full()
                .min_w_0()
                .children(rows),
        )
    }
}
fn notice(id: &'static str, text: impl Into<SharedString>, tone: Tone) -> impl IntoElement {
    div()
        .id(id)
        .test_support()
        .child(Notice::new(text).tone(tone))
}

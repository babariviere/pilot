//! Local Settings page for global MCP servers. Daemon-owned checks and browser sign-in only;
//! no account, credential or configuration owner.
use crate::{
    LocalOptions,
    mcp_status::{RowAction, Server, Snapshot, State, Status, timestamp},
    mcp_status_reader::{Act, Outcome, Reader, Request, perform},
    state_mark::{self, Glyph, Mark},
    ui::{self, Action, IconRole, Notice, Space, Text, Tone},
};
use gpui_kit::{
    Context, InteractiveElement, IntoElement, ParentElement, Render, SharedString, Styled, Task,
    TestSupportExt, Window,
    base::SelectableText,
    component::{ActiveTheme, Disableable, StyledExt},
    div,
    prelude::FluentBuilder,
    px,
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
    fn row(&self, server: &Server, cx: &mut Context<Self>) -> impl IntoElement {
        let name = server.name.clone();
        let expanded = self.details.as_ref() == Some(&name);
        let busy = self.pending.is_some();
        let mine = self.pending.as_ref().and_then(Act::server) == Some(name.as_str());
        let id = |part: &str| SharedString::from(format!("mcp-{part}-{name}"));
        let muted = cx.theme().muted_foreground;
        let (status, tone) = server.status();
        let glyph = if server.sign_in.as_ref().is_some_and(|s| s.waiting()) {
            Some(Glyph::Circle {
                faint: false,
                filled: false,
            })
        } else if server.checked_at.is_none() {
            None
        } else {
            match server.state {
                Status::NeedsSignIn => Some(Glyph::Mark(Mark::NeedsYou)),
                Status::Failed => Some(Glyph::Mark(Mark::Failed)),
                _ => None,
            }
        };
        let mut line = div()
            .h_flex()
            .items_center()
            .w_full()
            .min_w_0()
            .gap_2()
            .min_h(px(36.))
            .child(
                div()
                    .flex_none()
                    .w(px(state_mark::SLOT))
                    .flex()
                    .justify_center()
                    .children(glyph.map(|g| state_mark::glyph(g, cx))),
            )
            .child(
                div()
                    .id(id("text"))
                    .test_support()
                    .flex_1()
                    .min_w_0()
                    .child(SelectableText::new(
                        id("name"),
                        SharedString::from(name.clone()),
                    )),
            )
            .child(
                ui::text(Text::Caption, SharedString::from(status))
                    .id(id("state"))
                    .test_support()
                    .flex_none()
                    .text_color(tone.color(cx)),
            );
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
                    "Cancel",
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
            line = line.child(
                ui::action(id("action"), label, role)
                    .flex_none()
                    .tooltip(help)
                    .accessibility_label(SharedString::from(format!("{label}: {name}")))
                    .disabled(busy)
                    .loading(mine && !matches!(self.pending, Some(Act::SignIn { again: true, .. })))
                    .on_click(cx.listener(move |v, _, _, cx| v.run(act.clone(), cx))),
            );
        }
        let details_name = name.clone();
        line = line.child(
            ui::icon_action(
                id("details"),
                SharedString::from(if expanded {
                    format!("Hide details for {name}")
                } else {
                    format!("Details for {name}")
                }),
                if expanded {
                    IconRole::Collapse
                } else {
                    IconRole::Expand
                },
                Action::Quiet,
            )
            .flex_none()
            .on_click(cx.listener(move |v, _, _, cx| {
                v.details = if expanded {
                    None
                } else {
                    Some(details_name.clone())
                };
                cx.notify();
            })),
        );
        // Everything below the line aligns with the name.
        let mut more = div()
            .v_flex()
            .min_w_0()
            .gap_1()
            .pl(px(state_mark::SLOT + Space::CONTROL))
            .text_size(px(Text::Caption.size()));
        let mut extra = false;
        if let Some((text, tone)) = server.sign_in_line() {
            extra = true;
            more = more.child(
                ui::text(Text::Caption, SharedString::from(text))
                    .id(id("sign-in"))
                    .test_support()
                    .text_color(tone.color(cx)),
            );
        }
        if let Some(hint) = server.hint() {
            extra = true;
            more = more.child(ui::text(Text::Caption, hint).text_color(muted));
        }
        if let Some(problem) = &server.problem {
            extra = true;
            more = more.child(div().text_color(muted).child(SelectableText::new(
                id("problem"),
                SharedString::from(problem.clone()),
            )));
        }
        if let Some(note) = self.note_for(Some(&name)) {
            extra = true;
            more = more.child(
                ui::text(Text::Caption, note.text)
                    .id(id("note"))
                    .test_support()
                    .text_color(note.tone.color(cx)),
            );
        }
        if expanded {
            extra = true;
            more = more.child(
                div()
                    .id("mcp-detail-text")
                    .test_support()
                    .pt_1()
                    .text_color(muted)
                    .child(SelectableText::new(
                        "mcp-detail-content",
                        SharedString::from(server.details()),
                    )),
            );
            if server.can_sign_in_again() {
                let act = Act::SignIn {
                    server: name.clone(),
                    again: true,
                };
                more = more.child(
                    ui::action(id("sign-in-again"), "Sign in again…", Action::Quiet)
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
        div()
            .id(id("row"))
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .pb(px(if extra { 8. } else { 0. }))
            .child(line)
            .when(extra, |d| d.child(more))
    }
    fn group(
        &self,
        id: &'static str,
        label: String,
        servers: &[&Server],
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut group = div()
            .id(id)
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .child(
                ui::text(Text::Caption, SharedString::from(label))
                    .font_semibold()
                    .text_color(cx.theme().muted_foreground)
                    .pb_1(),
            );
        for (i, server) in servers.iter().enumerate() {
            if i > 0 {
                group = group.child(ui::rule(window, cx));
            }
            group = group.child(self.row(server, cx));
        }
        group
    }
}
impl Render for Connections {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = cx.theme().muted_foreground;
        let checking = self.state.snapshot.as_ref().is_some_and(|s| s.checking);
        let check_pending = matches!(self.pending, Some(Act::Check { server: None }));
        let last_check = self
            .state
            .snapshot
            .as_ref()
            .and_then(|s| s.servers.iter().filter_map(|s| s.checked_at).max());
        let meta = if checking {
            "Local · checking…".to_owned()
        } else if let Some(at) = last_check {
            format!("Local · last checked {}", timestamp(at))
        } else {
            "Local · global Pi servers".to_owned()
        };
        let refresh_help = match self.state.read_at {
            Some(at) => format!(
                "Re-read the last report (read {}). Doesn't check servers.",
                timestamp(at)
            ),
            None => "Re-read the last report. Doesn't check servers.".to_owned(),
        };
        let header = div()
            .h_flex()
            .items_start()
            .justify_between()
            .w_full()
            .min_w_0()
            .gap_3()
            .child(
                ui::header("mcp-title", "MCP connections", Text::Title).min_w_0().child(
                    ui::text(Text::Caption, SharedString::from(meta))
                        .id(if checking { "mcp-checking" } else { "mcp-meta" })
                        .test_support()
                        .text_color(muted),
                ),
            )
            .child(
                div()
                    .h_flex()
                    .flex_none()
                    .items_center()
                    .gap_1()
                    .child(
                        ui::icon_action("mcp-refresh", "Refresh", IconRole::Retry, Action::Quiet)
                            .tooltip(SharedString::from(refresh_help))
                            .loading(self.state.busy)
                            .disabled(self.state.busy)
                            .on_click(cx.listener(|v, _, _, cx| v.load(cx))),
                    )
                    .child(
                        ui::action("mcp-check", "Check now", Action::Secondary)
                            .tooltip("Reconnect to every server. Rows show the last check, not live chat connections.")
                            .disabled(self.pending.is_some() || checking || self.state.snapshot.is_none())
                            .loading(check_pending)
                            .on_click(cx.listener(|v, _, _, cx| v.run(Act::Check { server: None }, cx))),
                    ),
            );
        let mut page = div()
            .id("mcp-page")
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_5()
            .child(header);
        if self.state.busy && self.state.snapshot.is_none() {
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
        if self.state.error.is_some() {
            page = page.child(notice(
                "mcp-stale",
                "Stale · showing the previous report.",
                Tone::Quiet,
            ));
        }
        if snapshot.servers.is_empty() {
            page = page.child(notice(
                "mcp-empty",
                "No MCP servers reported. Some may still be configured.",
                Tone::Quiet,
            ));
        }
        let (needs, rest): (Vec<&Server>, Vec<&Server>) =
            snapshot.servers.iter().partition(|s| s.needs_you());
        if !needs.is_empty() {
            page = page.child(self.group("mcp-needs", "Needs you".into(), &needs, window, cx));
        }
        if !rest.is_empty() {
            let label = if !needs.is_empty() {
                "Other"
            } else if rest
                .iter()
                .all(|s| s.state == Status::Connected && s.checked_at.is_some())
            {
                "Connected"
            } else {
                "Servers"
            };
            let label = format!("{label} · {}", rest.len());
            page = page.child(self.group("mcp-list", label, &rest, window, cx));
        }
        if let Some(n) = snapshot.config_problems.filter(|n| *n > 0) {
            let text = if n == 1 {
                "1 entry in mcp.json isn’t valid · run pi mcp list".to_owned()
            } else {
                format!("{n} entries in mcp.json aren’t valid · run pi mcp list")
            };
            page = page.child(
                div()
                    .id("mcp-config-problem")
                    .test_support()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_none()
                            .w(px(state_mark::SLOT))
                            .flex()
                            .justify_center()
                            .child(state_mark::glyph(Glyph::Mark(Mark::NeedsYou), cx)),
                    )
                    .child(ui::text(Text::Caption, SharedString::from(text)).text_color(muted)),
            );
        }
        page
    }
}
fn notice(id: &'static str, text: impl Into<SharedString>, tone: Tone) -> impl IntoElement {
    div()
        .id(id)
        .test_support()
        .child(Notice::new(text).tone(tone))
}

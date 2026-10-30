//! Read-only Local Settings page. Immutable daemon scope, no account or credential owner.
use crate::{
    LocalOptions,
    mcp_status::{State, timestamp},
    mcp_status_reader::{Reader, Request},
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    Context, InteractiveElement, IntoElement, ParentElement, Render, SharedString, Styled, Task,
    TestSupportExt, Window,
    base::SelectableText,
    component::{ActiveTheme, Disableable, StyledExt},
    div,
};

pub(crate) struct Connections {
    pub(crate) state: State,
    options: LocalOptions,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    details: Option<String>,
}
impl Connections {
    pub(crate) fn new(options: LocalOptions) -> Self {
        Self {
            state: State::default(),
            options,
            reader: None,
            updates: None,
            details: None,
        }
    }
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        self.reader = None;
        self.updates = None;
        self.state.generation += 1;
        self.state.busy = false;
        cx.notify();
    }
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
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
                                        if v.details.as_ref().is_some_and(|name| {
                                            !v.state.snapshot.as_ref().is_some_and(|s| {
                                                s.servers.iter().any(|s| &s.name == name)
                                            })
                                        }) {
                                            v.details = None;
                                        }
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
}
impl Render for Connections {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut page = div().id("mcp-page").test_support().v_flex().w_full().min_w_0().gap_4()
            .child(ui::header("mcp-title", "MCP connections", Text::Title)
                .child(ui::text(Text::Body, "Local · global Pi servers")))
            .child(ui::text(Text::Caption, "Last reported checks, not live chat connections. Refresh only reads the daemon’s report.").text_color(cx.theme().muted_foreground))
            .child(ui::action("mcp-refresh", "Refresh", Action::Quiet).disabled(self.state.busy).self_start()
                .on_click(cx.listener(|v, _, _, cx| v.load(cx))));
        if self.state.busy {
            page = page.child(notice("mcp-loading", "Reading status…", Tone::Quiet));
        }
        if let Some(error) = self.state.error {
            page = page.child(notice("mcp-error", error, Tone::Error));
        }
        if let Some(at) = self.state.read_at {
            page = page.child(
                ui::text(
                    Text::Caption,
                    SharedString::from(format!("Last read {}", timestamp(at))),
                )
                .text_color(cx.theme().muted_foreground),
            );
        }
        if let Some(snapshot) = &self.state.snapshot {
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
                page = page.child(notice(
                    "mcp-empty",
                    "No MCP servers reported. This does not prove that no servers are configured.",
                    Tone::Quiet,
                ));
            }
            for server in &snapshot.servers {
                let name = server.name.clone();
                let expanded = self.details.as_ref() == Some(&name);
                let generation = self.state.generation;
                let mut row = div()
                    .id(SharedString::from(format!("mcp-row-{name}")))
                    .test_support()
                    .v_flex()
                    .min_w_0()
                    .w_full()
                    .gap_2()
                    .py_2()
                    .child(
                        div()
                            .id(SharedString::from(format!("mcp-text-{name}")))
                            .test_support()
                            .w_full()
                            .min_w_0()
                            .child(SelectableText::new(
                                SharedString::from(format!("mcp-name-{name}")),
                                SharedString::from(name.clone()),
                            )),
                    )
                    .child(
                        ui::text(Text::Caption, server.label())
                            .text_color(cx.theme().muted_foreground),
                    );
                if let Some(problem) = &server.problem {
                    row = row.child(SelectableText::new(
                        SharedString::from(format!("mcp-problem-{name}")),
                        SharedString::from(problem.clone()),
                    ));
                }
                row = row.child(
                    ui::action(
                        SharedString::from(format!("mcp-details-{name}")),
                        if expanded { "Hide details" } else { "Details" },
                        Action::Quiet,
                    )
                    .self_start()
                    .accessibility_label(SharedString::from(format!("Details for {name}")))
                    .on_click(cx.listener(move |v, _, _, cx| {
                        if v.state.generation == generation {
                            v.details = if expanded { None } else { Some(name.clone()) };
                            cx.notify();
                        }
                    })),
                );
                if expanded {
                    row = row.child(div().id("mcp-detail-text").test_support().child(
                        SelectableText::new(
                            "mcp-detail-content",
                            SharedString::from(server.details()),
                        ),
                    ));
                }
                page = page.child(row);
            }
        } else if !self.state.busy && self.state.error.is_none() {
            page = page.child(notice(
                "mcp-unread",
                "MCP status has not been read.",
                Tone::Quiet,
            ));
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

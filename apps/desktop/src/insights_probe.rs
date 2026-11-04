//! Hidden pixels of the Insights access and setup panels over owned synthetic HTTP.
//! Writes PNGs only when PILOT_NEXT_INSIGHTS_DIR is set. No real Local or writes.
use crate::{
    insights_view::{Panel, Scope},
    task_status_fixture::{Reply, Server},
    ui::{self, Text},
};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Context, Entity, HeadlessAppContext, IntoElement,
    ParentElement, Render, Styled, Window, WindowBounds, WindowOptions,
    component::{ActiveTheme, StyledExt},
    div, px, size,
    test::TestWindowExt as _,
};
use serde_json::json;
use std::time::{Duration, Instant};

const SESSION: &str = "insights-chat";
struct Frame {
    title: &'static str,
    panel: Entity<Panel>,
}
impl Render for Frame {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().bg(cx.theme().background).p_6().child(
            div()
                .w(px(560.))
                .v_flex()
                .gap_3()
                .p_4()
                .rounded(px(12.))
                .border_1()
                .border_color(cx.theme().border)
                .bg(cx.theme().popover)
                .text_color(cx.theme().popover_foreground)
                .child(ui::text(Text::Headline, self.title).font_semibold())
                .child(self.panel.clone()),
        )
    }
}
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, f: impl Fn(&gpui_kit::App) -> bool) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| f(cx)) {
        assert!(Instant::now() < end, "insights probe timeout");
        settle(cx, h);
        std::thread::sleep(Duration::from_millis(5));
    }
    settle(cx, h);
}
fn server() -> Server {
    let s = Server::start();
    s.reply("GET", "/api/hello", Reply::json(200, json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"insights":1}})));
    s.reply("GET", &format!("/api/insights/sessions/{SESSION}"), Reply::json(200, json!({
        "sessionId":SESSION,"enabled":true,"revision":1,"projectId":"project-a","missionId":"mission-a",
        "setupPending":false,"archived":false,"available":true,"disclosure":"insights-history-v1"})));
    s.reply("GET", &format!("/api/insights/sessions/{SESSION}/findings"), Reply::json(200, json!({
        "items":[
            {"key":"0b5c2f7e-1d2a-4c3b-9e8f-0a1b2c3d4e5f","revision":3,"taskId":"task-1","lifecycle":"proposed",
             "title":"Retry flaky desktop probes once before failing CI","priority":"high",
             "targets":[{"projectId":"project-a","label":"pilot"}],"cost":null},
            {"key":"1c6d3a8f-2e3b-4d4c-8f9a-1b2c3d4e5f60","revision":2,"taskId":"task-2","lifecycle":"shipped",
             "title":"Trim repeated AGENTS.md context in long sessions","priority":"medium",
             "targets":[{"projectId":"project-a","label":"pilot"},{"projectId":"project-b","label":"dotfiles"}],
             "cost":{"baseline":"~41k tokens per turn","assumptions":"Same model and task mix","estimate":"~12% fewer input tokens per week",
                     "qualityRisks":"Missing rules on rare tasks","laterResult":""}}
        ],"nextCursor":null})));
    s.reply("GET", "/api/models?cwd=%2Ftmp%2Fpilot", Reply::json(200, json!({
        "models":[
            {"id":"anthropic/claude-opus-5-5","provider":"anthropic","name":"Claude Opus 5.5","thinkingLevels":["low","high"],"thinking":"high"},
            {"id":"openai-codex/gpt-6.1-sol","provider":"openai-codex","name":"GPT-6.1 Sol","thinkingLevels":["high"],"thinking":"high"}
        ],"defaultModel":"anthropic/claude-opus-5-5"})));
    s
}
fn open(
    cx: &mut HeadlessAppContext,
    scope: Scope,
    title: &'static str,
    server: &Server,
    dark: bool,
) -> (AnyWindowHandle, Entity<Panel>) {
    cx.update(|cx| {
        crate::appearance::commit_appearance(
            if dark {
                crate::settings_state::AppearancePreference::Dark
            } else {
                crate::settings_state::AppearancePreference::Light
            },
            cx,
        )
    });
    let options = server.options.clone();
    let mut panel = None;
    let h = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(620.), px(920.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |_, cx| {
                let path = matches!(scope, Scope::Chat { .. }).then(|| "/tmp/pilot".to_owned());
                let p = cx.new(|cx| {
                    Panel::new(
                        scope,
                        options,
                        Some("anthropic/claude-opus-5-5".into()),
                        path,
                        cx,
                    )
                });
                panel = Some(p.clone());
                cx.new(|_| Frame { title, panel: p })
            },
        )
        .unwrap()
        .0
    });
    (h, panel.unwrap())
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: &str) {
    settle(cx, h);
    if let Some(dir) = std::env::var_os("PILOT_NEXT_INSIGHTS_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(format!("{name}.png")))
            .unwrap();
    }
}
pub fn run_insights_probe(cx: &mut HeadlessAppContext) {
    let server = server();
    for dark in [false, true] {
        let mode = if dark { "dark" } else { "light" };
        let (h, panel) = open(
            cx,
            Scope::Chat {
                session: SESSION.into(),
            },
            "Insights",
            &server,
            dark,
        );
        until(cx, h, |cx| panel.read(cx).probe_ready());
        capture(cx, h, &format!("access-{mode}"));
        cx.update(|cx| panel.update(cx, |p, cx| p.probe_scope(cx)));
        capture(cx, h, &format!("scope-{mode}"));
        cx.update(|cx| panel.update(cx, |p, cx| p.probe_revoke(cx)));
        capture(cx, h, &format!("revoke-{mode}"));
        let (h, panel) = open(
            cx,
            Scope::Decide {
                session: SESSION.into(),
                key: "0b5c2f7e-1d2a-4c3b-9e8f-0a1b2c3d4e5f".into(),
                number: 12,
                title: "Retry flaky desktop probes once before failing CI".into(),
                from: crate::insights::Lifecycle::Proposed,
                to: crate::insights::Lifecycle::Approved,
                expected_revision: 3,
            },
            "Approve #12?",
            &server,
            dark,
        );
        until(cx, h, |cx| panel.read(cx).probe_ready());
        capture(cx, h, &format!("decision-{mode}"));
        let (h, panel) = open(
            cx,
            Scope::Setup {
                mission: "mission-a".into(),
                mission_title: "Pilot backlog".into(),
                project: "project-a".into(),
                path: "/tmp/pilot".into(),
            },
            "Set up Insights",
            &server,
            dark,
        );
        until(cx, h, |cx| panel.read(cx).probe_ready());
        capture(cx, h, &format!("setup-{mode}"));
    }
    println!("insights: access, decision, revoke and setup panels rendered (light/dark)");
}

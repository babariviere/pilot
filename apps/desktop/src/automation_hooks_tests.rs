//! Hook model and transport checks: reading, editing that keeps unowned fields, toggles,
//! run results, and the exact-ACK PUT against an owned faux daemon.
use crate::{
    automation_hooks::{self as model, Draft, Kind, ProjectHooks, RunState},
    automation_hooks_fixture::{Mode, Server, sample},
    automation_hooks_transport::{self as wire, Saved},
};
use serde_json::{Value, json};
fn hooks() -> ProjectHooks {
    ProjectHooks::read("project-a", &sample()).unwrap()
}

#[test]
fn working_line_names_setup_or_checks_while_a_hook_runs() {
    let line = |automation: Value| model::working_line(&json!({ "automation": automation }));
    assert_eq!(
        line(
            json!({"state":"running","name":"Install dependencies","trigger":"workspace.created","startedAt":1})
        ),
        Some("Setting up workspace · Install dependencies".into())
    );
    assert_eq!(
        line(json!({"state":"waiting","name":"Tests","trigger":"run.finished","startedAt":1})),
        Some("Running checks · Tests".into())
    );
    assert_eq!(
        line(json!({"state":"running","name":"","trigger":"manual"})),
        Some("Setting up workspace".into())
    );
    assert_eq!(
        line(json!({"state":"running","name":"a\nb","trigger":"workspace.restored"})),
        Some("Setting up workspace · a".into())
    );
    assert_eq!(line(json!({"state":"ok","name":"Tests"})), None);
    assert_eq!(model::working_line(&json!({})), None);
}

#[test]
fn reads_hooks_with_their_kind_and_words() {
    let h = hooks();
    assert_eq!(h.revision, 3);
    let kinds: Vec<_> = h.items.iter().map(|h| h.kind).collect();
    assert_eq!(
        kinds,
        [Some(Kind::Setup), Some(Kind::Check), Some(Kind::Continue)]
    );
    assert_eq!(h.items[0].when(), "Workspace setup");
    assert_eq!(
        h.items[0].command().unwrap(),
        "pnpm install --frozen-lockfile"
    );
    assert_eq!(h.items[1].when(), "When packages/** or 1 more change");
    assert!(h.items[1].sends_failures());
    assert_eq!(h.items[2].when(), "When todos remain");
    assert!(!h.items[2].enabled);
    // A shape the editor can't represent stays listed, read-only.
    let odd = json!({"revision":1,"items":[{"id":"odd","name":"Odd","enabled":true,"on":["run.finished"],
        "when":{"openTodos":true,"filesChanged":true},"action":{"type":"followUp"}}]});
    assert_eq!(ProjectHooks::read("p", &odd).unwrap().items[0].kind, None);
    // Invalid saved definitions come back empty with an error.
    let invalid = ProjectHooks::read("p", &json!({"revision":2,"items":[],"error":"lint: timeoutMs must be between 1 s and 60 min\nsecond"})).unwrap();
    assert_eq!(
        invalid.error.as_deref(),
        Some("lint: timeoutMs must be between 1 s and 60 min")
    );
    for bad in [
        json!({"items":[]}),
        json!({"revision":1,"items":[{"id":"Bad ID","name":"x","enabled":true,"on":["run.finished"],"action":{"type":"followUp"}}]}),
        json!({"revision":1,"items":[sample()["items"][0], sample()["items"][0]]}),
        json!({"revision":1,"items":(0..33).map(|i| json!({"id":format!("h{i}"),"name":"x","enabled":true,"on":["run.finished"],"action":{"type":"followUp"}})).collect::<Vec<_>>()}),
    ] {
        assert!(ProjectHooks::read("p", &bad).is_none(), "{bad}");
    }
    let projects = model::parse_projects(&json!([
        {"id":"project-a","path":"/a","automations":sample()},
        {"id":"project-b","path":"/b"},
    ]))
    .unwrap();
    assert_eq!(projects.len(), 1);
    assert!(model::parse_projects(&json!([{"id":"p","automations":{"revision":"x"}}])).is_err());
}

#[test]
fn edits_keep_unowned_fields_order_and_argv() {
    let h = hooks();
    // Renaming the argv setup keeps argv, timeout and position.
    let mut draft = Draft::of(&h.items[0]);
    draft.name = "  Install  ".into();
    let items = model::build(&h, Some("install"), &draft).unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["name"], "Install");
    assert_eq!(
        items[0]["action"]["run"],
        json!({"argv":["pnpm","install","--frozen-lockfile"]})
    );
    assert_eq!(items[0]["action"]["timeoutMs"], 900000);
    assert_eq!(items[1], h.items[1].raw);
    // Changing the command saves shell text.
    draft.command = "pnpm install".into();
    let items = model::build(&h, Some("install"), &draft).unwrap();
    assert_eq!(items[0]["action"]["run"], json!({"shell":"pnpm install"}));
    // A check keeps cwd/env, and its paths and failure routing are the editor's.
    let mut draft = Draft::of(&h.items[1]);
    assert_eq!(draft.paths, "packages/**\napps/web/**");
    draft.paths = "".into();
    draft.send_failures = false;
    let items = model::build(&h, Some("checks"), &draft).unwrap();
    assert_eq!(items[1]["when"], json!({"filesChanged": true}));
    assert!(items[1]["action"].get("onFailure").is_none());
    assert_eq!(items[1]["action"]["env"], json!({"CI":"1"}));
    assert_eq!(items[1]["action"]["cwd"], "apps");
    // A check turned into continue drops the shell action.
    draft.kind = Kind::Continue;
    draft.message = "Keep going".into();
    let items = model::build(&h, Some("checks"), &draft).unwrap();
    assert_eq!(
        items[1]["action"],
        json!({"type":"followUp","message":"Keep going"})
    );
    assert_eq!(items[1]["when"], json!({"openTodos": true}));
    // New hooks get a unique ID from their name, enabled, at the end.
    let draft = Draft {
        kind: Kind::Check,
        name: "Install dependencies!".into(),
        command: "pnpm lint".into(),
        paths: "src/**, docs/*.md".into(),
        ..Draft::default()
    };
    let items = model::build(&h, None, &draft).unwrap();
    assert_eq!(items.len(), 4);
    assert_eq!(items[3]["id"], "install-dependencies");
    assert_eq!(items[3]["enabled"], true);
    assert_eq!(items[3]["on"], json!(["run.finished"]));
    assert_eq!(
        items[3]["when"],
        json!({"filesChanged":{"paths":["src/**","docs/*.md"]}})
    );
    assert_eq!(items[3]["action"]["onFailure"], "followUp");
    let draft = Draft {
        name: "Install".into(),
        command: "x".into(),
        ..Draft::default()
    };
    assert_eq!(
        model::build(&h, None, &draft).unwrap()[3]["id"],
        "install-2"
    );
    let draft = Draft {
        name: "日本語".into(),
        command: "x".into(),
        ..Draft::default()
    };
    let items = model::build(&h, None, &draft).unwrap();
    assert_eq!(items[3]["id"], "hook");
    assert_eq!(
        items[3]["on"],
        json!(["workspace.created", "workspace.restored"])
    );
}

#[test]
fn refuses_drafts_the_daemon_would_reject() {
    let h = hooks();
    let ok = Draft {
        name: "N".into(),
        command: "x".into(),
        ..Draft::default()
    };
    for (draft, error) in [
        (
            Draft {
                name: " ".into(),
                ..ok.clone()
            },
            "Name the hook.",
        ),
        (
            Draft {
                name: "é".repeat(81),
                ..ok.clone()
            },
            "The name is one line of at most 80 characters.",
        ),
        (
            Draft {
                command: "  ".into(),
                ..ok.clone()
            },
            "Enter a command.",
        ),
        (
            Draft {
                command: "x".repeat(8193),
                ..ok.clone()
            },
            "The command is at most 8 KiB.",
        ),
        (
            Draft {
                kind: Kind::Check,
                paths: "/abs".into(),
                ..ok.clone()
            },
            "Paths are relative globs using *, ** or ?.",
        ),
        (
            Draft {
                kind: Kind::Check,
                paths: "a/../b".into(),
                ..ok.clone()
            },
            "Paths are relative globs using *, ** or ?.",
        ),
        (
            Draft {
                kind: Kind::Check,
                paths: (0..17)
                    .map(|i| format!("p{i}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                ..ok.clone()
            },
            "Use at most 16 paths.",
        ),
        (
            Draft {
                kind: Kind::Continue,
                message: "m".repeat(2001),
                ..ok.clone()
            },
            "The message is at most 2,000 characters.",
        ),
    ] {
        assert_eq!(model::build(&h, None, &draft), Err(error));
    }
    assert!(model::build(&h, Some("gone"), &ok).is_err());
    let full = ProjectHooks::read("p", &json!({"revision":1,"items":(0..32).map(|i| json!({"id":format!("h{i}"),"name":"x","enabled":true,"on":["run.finished"],"when":{"openTodos":true},"action":{"type":"followUp"}})).collect::<Vec<_>>()})).unwrap();
    assert_eq!(
        model::build(&full, None, &ok),
        Err("A project can have at most 32 hooks.")
    );
}

#[test]
fn toggles_and_removals_change_only_their_hook() {
    let h = hooks();
    let on = model::toggled(&h, "continue", true).unwrap();
    assert_eq!(on[2]["enabled"], true);
    assert_eq!(&on[..2], &h.raw_items()[..2]);
    assert_eq!(model::toggled(&h, "gone", true), None);
    let removed = model::removed(&h, "checks").unwrap();
    assert_eq!(
        removed,
        vec![h.items[0].raw.clone(), h.items[2].raw.clone()]
    );
}

#[test]
fn last_run_is_newest_for_that_project_and_hook() {
    let chat = |id: &str, project: &str, runs: Value| {
        crate::local_model::chat(&json!({"id":id,"title":format!("Chat {id}"),"projectId":project,"state":"idle","automationRuns":runs})).unwrap()
    };
    let chats = vec![
        chat(
            "a",
            "project-a",
            json!([
                {"id":"t/checks","automationId":"checks","name":"Lint","definitionRevision":3,"trigger":"run.finished","state":"ok","attempt":1,"startedAt":10,"endedAt":20,"excerpt":"SECRET output"},
                {"id":"t/install","automationId":"install","name":"Install","definitionRevision":3,"trigger":"workspace.created","state":"failed","attempt":1,"exitCode":1,"endedAt":30,"excerpt":""}
            ]),
        ),
        chat(
            "b",
            "project-a",
            json!([
                {"id":"u/checks","automationId":"checks","state":"timed_out","attempt":1,"startedAt":40,"endedAt":50,"excerpt":""},
                {"id":"u/odd","automationId":"checks","state":"future","endedAt":90}
            ]),
        ),
        chat(
            "c",
            "project-b",
            json!([{"automationId":"checks","state":"failed","endedAt":99}]),
        ),
    ];
    assert!(!format!("{:?}", chats[0].automation_runs).contains("SECRET"));
    let (run, chat) = model::last_run(&chats, "project-a", "checks").unwrap();
    assert_eq!(
        (run.state, run.at, chat.id.as_str()),
        (RunState::TimedOut, 50, "b")
    );
    assert_eq!(model::status(run), ("Timed out".into(), model::Tone::Error));
    let (run, _) = model::last_run(&chats, "project-a", "install").unwrap();
    assert_eq!(
        model::status(run),
        ("Failed · exit 1".into(), model::Tone::Error)
    );
    assert!(model::last_run(&chats, "project-a", "continue").is_none());
}

fn block<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

#[test]
fn reads_projects_and_the_host_switch() {
    let s = Server::start();
    let client = crate::chat_settings::client().unwrap();
    let snapshot = block(wire::read(&client, &s.options)).unwrap();
    assert_eq!(snapshot.enabled, Some(true));
    assert_eq!(snapshot.projects.len(), 1);
    assert_eq!(snapshot.projects[0].revision, 3);
    assert!(
        s.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|(m, ..)| m == "GET")
    );
}

#[test]
fn saves_need_an_exact_ack_and_are_never_retried() {
    let s = Server::start();
    let client = crate::chat_settings::client().unwrap();
    let base = ProjectHooks::read("project-a", &sample()).unwrap();
    let items = model::toggled(&base, "continue", true).unwrap();
    let saved = block(wire::save(
        &client,
        &s.options,
        "project-a",
        3,
        items.clone(),
    ));
    let Saved::Ack(hooks) = saved else {
        panic!("{saved:?}")
    };
    assert_eq!((hooks.revision, hooks.raw_items()), (4, items.clone()));
    // A stale revision is a conflict carrying Local's list.
    let saved = block(wire::save(
        &client,
        &s.options,
        "project-a",
        3,
        items.clone(),
    ));
    assert!(
        matches!(saved, Saved::Conflict(Some(ref h)) if h.revision == 4),
        "{saved:?}"
    );
    for (mode, expect) in [
        (
            Mode::Rejected,
            Saved::Rejected("checks: cwd must be relative".into()),
        ),
        (
            Mode::Off,
            Saved::Refused("Automations are off on this host. Nothing was changed."),
        ),
        (Mode::Lost, Saved::Unknown),
    ] {
        s.state.lock().unwrap().mode = mode;
        let before = s.state.lock().unwrap().puts().len();
        assert_eq!(
            block(wire::save(
                &client,
                &s.options,
                "project-a",
                4,
                items.clone()
            )),
            expect
        );
        assert_eq!(
            s.state.lock().unwrap().puts().len(),
            before + 1,
            "one PUT, no retry"
        );
    }
    // Without the native capability nothing is sent.
    let port = s
        .options
        .loopback()
        .rsplit(':')
        .next()
        .unwrap()
        .trim_end_matches('/')
        .parse()
        .unwrap();
    let plain = crate::LocalOptions::synthetic(port);
    let before = s.state.lock().unwrap().puts().len();
    assert!(matches!(
        block(wire::save(&client, &plain, "project-a", 4, items)),
        Saved::Refused(_)
    ));
    assert_eq!(s.state.lock().unwrap().puts().len(), before);
}

use crate::{
    knowledge::{Data, Kind, Query, Route, parse, path, source},
    knowledge_fixture as f,
    knowledge_reader::{fetch, linked},
    mission_browser_fixture::{Reply, Server},
};
use serde_json::json;

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

#[test]
fn knowledge_paths_are_exact_and_encoded() {
    assert_eq!(
        path("project-A", &Route::List(Query::default())).unwrap(),
        "/api/projects/project-A/knowledge?limit=50"
    );
    let q = Query {
        kind: Some(Kind::Investigation),
        needs_check: true,
        q: "a&b 日本".into(),
        mission: Some("mission-A".into()),
        cursor: Some("abc".into()),
    };
    assert_eq!(
        path("project-A", &Route::List(q)).unwrap(),
        "/api/projects/project-A/knowledge?kind=investigation&missionId=mission-A&check=needs_check&q=a%26b+%E6%97%A5%E6%9C%AC&cursor=abc&limit=50"
    );
    assert_eq!(
        path(
            "project-A",
            &Route::Detail {
                id: "e".into(),
                revision: Some(2)
            }
        )
        .unwrap(),
        "/api/projects/project-A/knowledge/e?revision=2"
    );
    assert!(path("../x", &Route::List(Query::default())).is_err());
    assert!(
        path(
            "project-A",
            &Route::Detail {
                id: "a/b".into(),
                revision: None
            }
        )
        .is_err()
    );
    assert!(
        path(
            "project-A",
            &Route::List(Query {
                q: "x".repeat(201),
                ..Query::default()
            })
        )
        .is_err()
    );
}

#[test]
fn knowledge_responses_must_match_the_exact_request() {
    let list = Route::List(Query::default());
    assert!(
        matches!(parse("project-A", &list, f::page(vec![f::component()])), Ok(Data::Page(p)) if p.entries.len() == 1)
    );
    // Another project's row, a kind outside the filter or an unlinked row in a mission view fail loudly.
    let mut other = f::component();
    other["projectId"] = json!("project-B");
    assert!(parse("project-A", &list, f::page(vec![other])).is_err());
    let components = Route::List(Query {
        kind: Some(Kind::Component),
        ..Query::default()
    });
    assert!(parse("project-A", &components, f::page(vec![f::study()])).is_err());
    let mission = Route::List(Query {
        mission: Some("mission-A".into()),
        ..Query::default()
    });
    assert!(parse("project-A", &mission, f::page(vec![f::study()])).is_err());
    assert!(parse("project-A", &mission, f::linked()).is_ok());
    assert!(
        parse(
            "project-A",
            &list,
            json!({"entries":[],"more":true,"cursor":null})
        )
        .is_err()
    );
    let rows: Vec<_> = (0..51)
        .map(|i| f::summary(&format!("e{i}"), "component", "T", 1, "not_checked"))
        .collect();
    assert!(parse("project-A", &list, f::page(rows)).is_err());

    let current = Route::Detail {
        id: f::COMPONENT.into(),
        revision: None,
    };
    let pinned = Route::Detail {
        id: f::COMPONENT.into(),
        revision: Some(1),
    };
    let Ok(Data::Detail(d)) = parse("project-A", &current, f::detail(f::COMPONENT, 2)) else {
        panic!()
    };
    assert!(!d.historical());
    assert!(d.freshness.needs_check());
    // A current read answered with a historical body, or the reverse, is rejected.
    assert!(parse("project-A", &current, f::detail(f::COMPONENT, 1)).is_err());
    assert!(parse("project-A", &pinned, f::detail(f::COMPONENT, 2)).is_err());
    let Ok(Data::Detail(old)) = parse("project-A", &pinned, f::detail(f::COMPONENT, 1)) else {
        panic!()
    };
    assert!(old.historical());
    assert_eq!(
        old.freshness.label(),
        format!("Checked {}", crate::usage_overview::date(1_792_000_000_000))
    );
    assert!(parse("project-B", &current, f::detail(f::COMPONENT, 2)).is_err());

    let history = Route::History {
        id: f::COMPONENT.into(),
        cursor: None,
    };
    assert!(parse("project-A", &history, f::history(f::COMPONENT)).is_ok());
    let mut reversed = f::history(f::COMPONENT);
    reversed["revisions"].as_array_mut().unwrap().reverse();
    assert!(parse("project-A", &history, reversed).is_err());
}

#[test]
fn pinned_rows_never_borrow_the_current_check() {
    let mission = Route::List(Query {
        mission: Some("mission-A".into()),
        ..Query::default()
    });
    let row = |pinned: Option<u64>, state: &str| {
        let mut s = f::summary(f::COMPONENT, "component", "Code exploration", 2, state);
        s["link"] = match pinned {
            Some(p) => json!({"linkRevision":3,"pinnedRevision":p}),
            None => json!({"linkRevision":3}),
        };
        let Ok(Data::Page(p)) = parse("project-A", &mission, f::page(vec![s])) else {
            panic!()
        };
        p.entries[0].meta()
    };
    let checked = format!("Checked {}", crate::usage_overview::date(1_793_000_000_000));
    // An earlier pin names the current revision as the owner of the check state.
    assert_eq!(
        row(Some(1), "checked"),
        format!("Component · pinned revision 1 · current revision 2: {checked}")
    );
    assert_eq!(
        row(Some(1), "needs_check"),
        "Component · pinned revision 1 · current revision 2: Needs a check"
    );
    // The state still describes the pinned body when the pin is the current revision.
    assert_eq!(
        row(Some(2), "checked"),
        format!("Component · revision 2 · pinned to 2 · {checked}")
    );
    assert_eq!(
        row(None, "checked"),
        format!("Component · revision 2 · {checked}")
    );
    // A pin outside the entry's revisions is not this entry's link.
    for bad in [0, 3] {
        let mut s = f::summary(f::COMPONENT, "component", "T", 2, "checked");
        s["link"] = json!({"linkRevision":3,"pinnedRevision":bad});
        assert!(parse("project-A", &mission, f::page(vec![s])).is_err());
    }
    // Exact historical detail keeps its own state beside a checked current entry.
    let mut old = f::detail(f::COMPONENT, 1);
    old["entry"] = f::summary(f::COMPONENT, "component", "Code exploration", 2, "checked");
    old["freshness"] = json!({"state":"not_checked"});
    let pinned = Route::Detail {
        id: f::COMPONENT.into(),
        revision: Some(1),
    };
    let Ok(Data::Detail(d)) = parse("project-A", &pinned, old) else {
        panic!()
    };
    assert!(d.historical());
    assert_eq!(d.entry.freshness.label(), checked);
    assert_eq!(d.freshness.label(), "Not checked");
}

#[test]
fn knowledge_state_and_sources_stay_honest() {
    let Ok(Data::Detail(d)) = parse(
        "project-A",
        &Route::Detail {
            id: f::COMPONENT.into(),
            revision: None,
        },
        f::detail(f::COMPONENT, 2),
    ) else {
        panic!()
    };
    assert_eq!(d.freshness.label(), "Needs a check");
    assert!(d.freshness.detail().contains("Decision D29 changed"));
    assert!(d.freshness.detail().contains("may still be correct"));
    let unknown: crate::knowledge::Freshness =
        serde_json::from_value(json!({"state":"verified"})).unwrap();
    assert_eq!(unknown.label(), "Check state unknown");
    let sources: Vec<_> = d.revision.sources.iter().map(source).collect();
    assert_eq!(sources[0].title, "Repository file");
    assert!(
        sources[0]
            .locator
            .contains("docs/code-exploration.md at 0c3b")
    );
    assert_eq!(sources[0].web, None, "local files are not opened");
    assert_eq!(sources[1].title, "Public study");
    assert_eq!(
        sources[1].web.as_deref(),
        Some("https://example.com/exploration")
    );
    assert!(sources[2].locator.contains("report revision 2"));
    assert!(sources[3].locator.contains("decision decision-29"));
    let hostile =
        source(&json!({"type":"web","url":"javascript:alert(1)","accessedAt":"2026-01-01"}));
    assert_eq!(hostile.web, None);
    let dirty = source(&json!({"type":"repository","path":"a.md","dirty":true}));
    assert!(dirty.locator.contains("uncommitted"));
}

#[tokio::test(flavor = "current_thread")]
async fn knowledge_reader_is_hello_fenced_get_only() {
    let server = Server::start();
    f::install(&server);
    let client = client();
    let route = Route::List(Query::default());
    assert!(
        matches!(fetch(&client, &server.options, f::PROJECT, &route).await, Ok(Data::Page(p)) if p.entries.len() == 2)
    );
    let seen: Vec<_> = server
        .state
        .lock()
        .unwrap()
        .seen
        .iter()
        .map(|(_, p)| p.clone())
        .collect();
    assert_eq!(seen.first().map(String::as_str), Some("/api/hello"));
    assert_eq!(seen.last().map(String::as_str), Some("/api/hello"));
    // Missing routes are explicit errors in the reading window, never empty lists.
    let missing = Route::Detail {
        id: "gone".into(),
        revision: None,
    };
    assert!(
        fetch(&client, &server.options, f::PROJECT, &missing)
            .await
            .is_err()
    );
    server.reply(&f::list(Query::default()), Reply::json(503, json!({})));
    assert!(
        fetch(&client, &server.options, f::PROJECT, &route)
            .await
            .is_err()
    );
    // A mission's subset: an older daemon without the catalog shows no section.
    assert_eq!(
        linked(&client, &server.options, f::PROJECT, "mission-A")
            .await
            .unwrap()
            .unwrap()
            .entries
            .len(),
        2
    );
    assert!(
        linked(&client, &server.options, f::PROJECT, "mission-B")
            .await
            .unwrap()
            .is_none()
    );
    server.reply(
        &f::list(Query {
            mission: Some("mission-A".into()),
            ..Query::default()
        }),
        Reply::json(500, json!({})),
    );
    assert!(
        linked(&client, &server.options, f::PROJECT, "mission-A")
            .await
            .is_err()
    );
    assert!(server.all_gets());
}

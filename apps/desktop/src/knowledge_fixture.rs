//! Synthetic project knowledge responses for unit tests and hidden native probes only.
use crate::{
    knowledge::{Kind, Query, Route, path},
    mission_browser_fixture::{Reply, Server},
};
use serde_json::{Value, json};

pub(crate) const PROJECT: &str = "project-A";
pub(crate) const COMPONENT: &str = "entry-component";
pub(crate) const STUDY: &str = "entry-study";

pub(crate) fn summary(id: &str, kind: &str, title: &str, revision: u64, state: &str) -> Value {
    let mut freshness = json!({"state": state});
    if state == "needs_check" {
        freshness["pending"] = json!({"generation":1,"since":1_793_000_000_000u64,"reasons":["Decision D29 changed"],"triggers":1});
    }
    if state == "checked" {
        freshness["checked"] = json!({"at":1_793_000_000_000u64,"checker":"coordinator","coverage":"docs/code-exploration.md"});
    }
    json!({"id":id,"projectId":PROJECT,"kind":kind,"title":title,"synopsis":format!("{title}: what it is and why it matters 日本語 👩‍💻"),"revision":revision,"createdAt":1_793_000_000_000u64 + revision,"updatedAt":1_793_000_000_000u64,"origin":{"missionId":"mission-A","sessionId":"chat-A","recordedAt":1_793_000_000_000u64},"freshness":freshness})
}
pub(crate) fn component() -> Value {
    summary(COMPONENT, "component", "Code exploration", 2, "needs_check")
}
pub(crate) fn study() -> Value {
    summary(
        STUDY,
        "investigation",
        "Exploration patterns study",
        1,
        "not_checked",
    )
}
pub(crate) fn page(entries: Vec<Value>) -> Value {
    json!({"entries":entries,"more":false,"cursor":null})
}
pub(crate) fn linked() -> Value {
    let mut c = component();
    c["link"] = json!({"linkRevision":3,"pinnedRevision":1});
    let mut s = study();
    s["link"] = json!({"linkRevision":1});
    page(vec![c, s])
}
/// A mission pin to revision 1 beside a checked current revision 2. Revision 1 itself
/// was never checked, so nothing may present it as checked.
pub(crate) fn pinned_beside_checked(s: &Server) {
    let current = summary(COMPONENT, "component", "Code exploration", 2, "checked");
    let mut c = current.clone();
    c["link"] = json!({"linkRevision":3,"pinnedRevision":1});
    let mut linked = linked();
    linked["entries"][0] = c;
    s.reply(
        &list(Query {
            mission: Some("mission-A".into()),
            ..Query::default()
        }),
        Reply::json(200, linked),
    );
    let mut old = detail(COMPONENT, 1);
    old["entry"] = current;
    old["freshness"] = json!({"state":"not_checked"});
    s.reply(
        &path(
            PROJECT,
            &Route::Detail {
                id: COMPONENT.into(),
                revision: Some(1),
            },
        )
        .unwrap(),
        Reply::json(200, old),
    );
}
pub(crate) const BODY: &str = "## Purpose\nBounded, literal source exploration for agents.\n\n## Interfaces\n- `code_search` and `code_symbols`\n- `code_call_paths` from an exact callable\n\n## Gaps\nNo persistent index. Results are source-inferred, not runtime proof.";
pub(crate) fn detail(id: &str, revision: u64) -> Value {
    let entry = if id == COMPONENT {
        component()
    } else {
        study()
    };
    let current = entry["revision"].as_u64().unwrap();
    let freshness = if revision == current {
        entry["freshness"].clone()
    } else {
        json!({"state":"checked","checked":{"at":1_792_000_000_000u64,"checker":"coordinator","coverage":"docs/code-exploration.md"}})
    };
    let title = if revision == current {
        entry["title"].as_str().unwrap().to_owned()
    } else {
        format!("{} (as first written)", entry["title"].as_str().unwrap())
    };
    json!({"entry":entry,"freshness":freshness,"revision":{"knowledgeId":id,"revision":revision,"title":title,"synopsis":"Synopsis","reason":if revision > 1 {json!("Interfaces changed")} else {Value::Null},"author":{"type":"session","sessionId":"chat-A"},"recordedAt":1_793_000_000_000u64,"body":if revision == current {BODY.to_owned()} else {format!("{BODY}\n\nOriginal wording kept.")},"sources":[
        {"type":"repository","path":"docs/code-exploration.md","commit":"0c3b3238212603f5"},
        {"type":"web","url":"https://example.com/exploration","accessedAt":"2026-10-30","label":"Public study"},
        {"type":"artifact","sessionId":"chat-A","artifactId":"report","revision":2},
        {"type":"mission","missionId":"mission-A","decisionId":"decision-29"}
    ]}})
}
pub(crate) fn history(id: &str) -> Value {
    let first = json!({"revision":1,"title":"As first written","synopsis":"S","author":{"type":"session","sessionId":"chat-A"},"recordedAt":1_792_000_000_000u64});
    let revisions = if id == COMPONENT {
        vec![
            json!({"revision":2,"title":"Code exploration","synopsis":"S","reason":"Interfaces changed","author":{"type":"user"},"recordedAt":1_793_000_000_000u64}),
            first,
        ]
    } else {
        vec![first]
    };
    json!({"revisions":revisions,"more":false,"cursor":null})
}
pub(crate) fn list(query: Query) -> String {
    path(PROJECT, &Route::List(query)).unwrap()
}
pub(crate) fn install(s: &Server) {
    s.reply(
        &list(Query::default()),
        Reply::json(200, page(vec![component(), study()])),
    );
    s.reply(
        &list(Query {
            kind: Some(Kind::Component),
            ..Query::default()
        }),
        Reply::json(200, page(vec![component()])),
    );
    s.reply(
        &list(Query {
            needs_check: true,
            ..Query::default()
        }),
        Reply::json(200, page(vec![component()])),
    );
    s.reply(
        &list(Query {
            q: "zzz".into(),
            ..Query::default()
        }),
        Reply::json(200, page(vec![])),
    );
    s.reply(
        &list(Query {
            mission: Some("mission-A".into()),
            ..Query::default()
        }),
        Reply::json(200, linked()),
    );
    for (id, revisions) in [(COMPONENT, 2), (STUDY, 1)] {
        s.reply(
            &path(
                PROJECT,
                &Route::Detail {
                    id: id.into(),
                    revision: None,
                },
            )
            .unwrap(),
            Reply::json(200, detail(id, revisions)),
        );
        for r in 1..=revisions {
            s.reply(
                &path(
                    PROJECT,
                    &Route::Detail {
                        id: id.into(),
                        revision: Some(r),
                    },
                )
                .unwrap(),
                Reply::json(200, detail(id, r)),
            );
        }
        s.reply(
            &path(
                PROJECT,
                &Route::History {
                    id: id.into(),
                    cursor: None,
                },
            )
            .unwrap(),
            Reply::json(200, history(id)),
        );
    }
}

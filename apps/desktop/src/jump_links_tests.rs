use super::*;
use crate::jump::Query;
use crate::{jump, model::ReaderKey};
use serde_json::json;
use std::sync::Arc;

fn snapshot(value: serde_json::Value) -> Snapshot {
    Snapshot {
        chats: Arc::new(vec![crate::local_model::chat(&value).unwrap()]),
        projects: Arc::new(vec![]),
        scope: None,
        selected: Some("current".into()),
        archive: None,
        loaded: true,
        projects_error: false,
        reader: Some(Reader {
            chat: "current".into(),
            generation: 4,
        }),
    }
}
fn row(id: u64, text: &str) -> Message {
    Message::live(id, "assistant".into(), text.into()).anchored(ReaderKey::Entry {
        entry: id,
        model: None,
        block: None,
    })
}
fn links(c: &Catalog) -> Vec<&Entry> {
    c.search(&Query::new(""))
        .groups
        .iter()
        .filter(|g| g.kind == jump::Kind::Link)
        .flat_map(|g| g.rows.iter().map(|ix| &c.entries[*ix]))
        .collect()
}

#[test]
fn zero_one_multiple_and_canonical_deduplication() {
    let s = snapshot(json!({"id":"current"}));
    let empty = Catalog::with_links(&s, vec![]);
    assert!(links(&empty).is_empty());

    let s = snapshot(
        json!({"id":"current","archivedAt":1,"mode":"ask","boundPullRequests":["https://GitHub.com:443/o/r/pull/12"]}),
    );
    let one = Catalog::with_links(&s, vec![row(1, "[PR](https://github.com/o/r/pull/12)")]);
    assert_eq!(links(&one).len(), 1);
    let action = one.entries.iter().find(|e| e.is_pr).unwrap();
    assert_eq!(action.title, "Open pull request · o/r #12");
    assert!(
        matches!(&action.destination, Destination::OpenLink { reader, url }
        if reader.chat == "current" && url == "https://github.com/o/r/pull/12")
    );

    let multiple = Catalog::with_links(
        &s,
        vec![row(
            2,
            "https://github.com/another/repo/pull/12 https://linear.app/t/issue/ABC-1/修正 https://example.com/docs?one=1",
        )],
    );
    assert_eq!(links(&multiple).iter().filter(|e| e.is_pr).count(), 2);
    assert_eq!(links(&multiple).len(), 4);
    assert_eq!(links(&multiple)[0].title, "Open pull request · o/r #12");
    let filtered = multiple.search(&Query::new("ＡＢＣ"));
    assert_eq!(filtered.groups[0].rows.len(), 1);
    // The main palette never silently hides links beyond the regular suggestion limit.
    let many = Catalog::with_links(
        &s,
        vec![row(
            3,
            &(0..12)
                .map(|n| format!("https://example.com/{n} "))
                .collect::<String>(),
        )],
    );
    assert_eq!(links(&many).len(), 13);
}

#[test]
fn unsafe_unknown_and_other_chat_provenance_never_become_targets() {
    let mut s = snapshot(
        json!({"id":"current","boundPullRequests":["file:///o/r/pull/1","https://secret@github.com/o/r/pull/1","https://github.com/o/r/pull/1%0a"]}),
    );
    Arc::make_mut(&mut s.chats).push(
        crate::local_model::chat(
            &json!({"id":"other","boundPullRequests":["https://github.com/o/other/pull/2"]}),
        )
        .unwrap(),
    );
    let unknown = crate::github_event::Action::read(&json!({"id":"audit","kind":"pr_opened","prNumber":3,"exitCode":null,"url":"https://github.com/o/r/pull/3"})).unwrap();
    let rows = vec![
        row(
            1,
            "javascript:alert(1) file:///etc/passwd https://u:secret@example.com https://example.com/%0a https:// https://example.com/\\bad",
        ),
        Message::github(2, crate::github_event::Event::new(&unknown)),
    ];
    let c = Catalog::with_links(&s, rows);
    assert!(links(&c).is_empty());
    s.reader = None;
    assert!(
        links(&Catalog::with_links(
            &s,
            vec![row(1, "https://example.com")]
        ),)
        .is_empty()
    );
}

#[test]
fn confirmed_audit_and_loaded_window_limits_are_truthful() {
    let s = snapshot(json!({"id":"current"}));
    let action = crate::github_event::Action::read(&json!({"id":"audit","kind":"pr_opened","prNumber":3,"exitCode":0,"url":"https://github.com/o/r/pull/3","title":"修正 👩‍💻"})).unwrap();
    let c = Catalog::with_links(
        &s,
        vec![
            Message::github(2, crate::github_event::Event::new(&action)),
            row(3, &"https://example.com/a ".repeat(300)),
        ],
    );
    assert!(c.links_limited);
    assert_eq!(
        links(&c).iter().find(|e| e.is_pr).unwrap().title,
        "Open pull request · 修正 👩‍💻"
    );
    assert_eq!(links(&c).len(), 2);
    let mut switched = s.clone();
    switched.reader.as_mut().unwrap().generation += 1;
    assert!(!s.same(&switched));
    assert!(!c.same(&switched));
    switched.reader.as_mut().unwrap().generation -= 1;
    switched.reader.as_mut().unwrap().chat = "other".into();
    assert!(!s.same(&switched));
    assert!(jump::pr_url("https://github.com/o/r/pull/0").is_none());
}

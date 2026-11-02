use super::*;
use crate::slack_triage_fixture::{item, project};

fn board(items: Vec<Value>) -> Board {
    let project = Project::parse(&project("p1", "Atlas", &["C1"])).unwrap();
    Board {
        projects: vec![ProjectBoard {
            project,
            source: None,
            items: items.iter().map(|v| Item::parse(v).unwrap()).collect(),
            active_total: items.len() as u64,
        }],
    }
}

#[test]
fn parses_effective_triage_overrides_and_canonical_identity() {
    let mut raw = item(
        "m1",
        "p1",
        "Checkout fails 日本語 👩‍💻",
        "in_progress",
        "high",
        1_000,
    );
    raw["slack"]["overrides"] = json!({"type":"bug","label":null});
    raw["slack"]["label"] = Value::Null;
    raw["sessionIds"] = json!(["chat-old", "chat-new"]);
    raw["metadata"]["slackStart"] = json!({"outcome":"reacted","attemptedAt":1});
    let i = Item::parse(&raw).unwrap();
    assert_eq!(i.id, "m1");
    assert_eq!(i.project_id, "p1");
    assert_eq!(i.title, "Checkout fails 日本語 👩‍💻");
    assert_eq!(
        i.url,
        "https://acme.slack.com/archives/C1/p1000000100?team=T1"
    );
    assert_eq!(i.triage.status, Status::InProgress);
    assert_eq!(i.triage.severity, Severity::High);
    assert!(i.triage.overridden.kind && i.triage.overridden.label);
    assert!(!i.triage.overridden.severity);
    assert_eq!(
        i.triage.overridden_note().unwrap(),
        "You changed the type and label. Pilot keeps your choice."
    );
    assert_eq!(i.session_id.as_deref(), Some("chat-new"));
    assert!(i.started);
    assert_eq!(i.channel(), "#support");
    assert_eq!(
        i.meta(Some("Atlas"), 1_000 + 2 * 3_600_000),
        "Atlas · #support · Bug · High · 2h ago · 3 replies"
    );
    // Untrusted shapes are refused, never coerced into another message.
    for bad in [
        json!({"kind":"linear"}),
        {
            let mut r = raw.clone();
            r["id"] = json!("../x");
            r
        },
        {
            let mut r = raw.clone();
            r["slack"]["status"] = json!("closed");
            r
        },
        {
            let mut r = raw.clone();
            r.as_object_mut().unwrap().remove("url");
            r
        },
    ] {
        assert!(Item::parse(&bad).is_none(), "{bad}");
    }
}

#[test]
fn status_titles_carry_reasons_without_inventing_them() {
    let mut t = Item::parse(&item("m", "p1", "t", "dismissed", "low", 1))
        .unwrap()
        .triage;
    assert_eq!(t.status_title(), "Dismissed");
    t.closed_by_label = Some("Spam".into());
    assert_eq!(t.status_title(), "Closed · Spam");
    t.status = Status::Waiting;
    t.waiting_reason = Some("CSM to confirm".into());
    assert_eq!(t.status_title(), "Waiting · CSM to confirm");
}

#[test]
fn filters_hidden_and_dismissed_like_swift_and_sorts_by_severity_then_age() {
    let mut hidden = item("hidden", "p1", "Noise", "open", "critical", 5);
    hidden["slack"]["label"] = json!("Noise");
    let mut closed = item("closed", "p1", "Spam", "dismissed", "low", 6);
    closed["slack"]["closedByLabel"] = json!("Spam");
    let b = board(vec![
        item("low-new", "p1", "a", "open", "low", 9),
        item("crit", "p1", "b", "open", "critical", 1),
        item("low-old", "p1", "c", "open", "low", 2),
        item("done", "p1", "d", "done", "medium", 3),
        item("gone", "p1", "e", "dismissed", "high", 4),
        hidden,
        closed,
    ]);
    let ids = |f: &Filter| b.visible(f).into_iter().map(|i| i.id).collect::<Vec<_>>();
    let all = Filter::default();
    assert_eq!(ids(&all), ["crit", "done", "low-new", "low-old"]);
    assert_eq!(b.hidden_count(false), 2);
    let shown = Filter {
        show_hidden: true,
        ..all
    };
    assert_eq!(
        ids(&shown),
        ["hidden", "crit", "done", "low-new", "closed", "low-old"]
    );
    let dismissed = Filter {
        show_dismissed: true,
        ..all
    };
    assert_eq!(
        ids(&dismissed),
        ["crit", "gone", "done", "low-new", "closed", "low-old"]
    );
    assert_eq!(b.hidden_count(true), 2);
    let open = Filter {
        status: Some(Status::Open),
        ..all
    };
    assert_eq!(ids(&open), ["crit", "low-new", "low-old"]);
    assert_eq!(open.statuses(&b.visible(&open)), [Status::Open]);
    assert_eq!(
        all.statuses(&b.visible(&all)),
        [
            Status::Open,
            Status::InProgress,
            Status::Waiting,
            Status::Done
        ]
    );
    // A label-closed message shown through Show hidden brings its Dismissed column.
    assert!(
        shown
            .statuses(&b.visible(&shown))
            .contains(&Status::Dismissed)
    );
}

#[test]
fn keyboard_moves_and_successor_follow_columns() {
    let columns = vec![
        vec!["a".to_owned(), "b".to_owned(), "c".to_owned()],
        vec![],
        vec!["d".to_owned()],
    ];
    assert_eq!(sideways(&columns, "c", 1), Some((2, 0)));
    assert_eq!(sideways(&columns, "d", -1), Some((0, 0)));
    assert_eq!(sideways(&columns, "a", -1), None);
    assert_eq!(successor(&columns, "b").as_deref(), Some("c"));
    assert_eq!(successor(&columns, "c").as_deref(), Some("b"));
    assert_eq!(successor(&columns, "d"), None);
}

#[test]
fn changes_are_narrow_override_bodies() {
    assert_eq!(
        Change::Status(Status::Dismissed).body(),
        json!({"slack":{"status":"dismissed"}})
    );
    assert_eq!(
        Change::Kind(Kind::Question).body(),
        json!({"slack":{"type":"question"}})
    );
    assert_eq!(
        Change::Severity(Severity::Critical).body(),
        json!({"slack":{"severity":"critical"}})
    );
    assert_eq!(Change::Label(None).body(), json!({"slack":{"label":null}}));
    assert_eq!(
        Change::Label(Some("Product 日本".into())).body(),
        json!({"slack":{"label":"Product 日本"}})
    );
}

#[test]
fn board_replace_keeps_project_identity_and_excerpts_stay_bounded() {
    let mut b = board(vec![item("m1", "p1", "a", "open", "low", 1)]);
    let mut saved = Item::parse(&item("m1", "p1", "a", "done", "low", 2)).unwrap();
    assert!(b.replace(saved.clone()));
    assert_eq!(b.item("m1").unwrap().triage.status, Status::Done);
    saved.project_id = "p2".into();
    assert!(!b.replace(saved), "never moves a message across projects");
    let mut e = Excerpts::default();
    for n in 0..=Excerpts::LIMIT {
        e.set(&n.to_string(), ExcerptState::Loading);
    }
    assert!(e.get("0").is_none());
    assert!(e.get(&Excerpts::LIMIT.to_string()).is_some());
    e.set("x", ExcerptState::Unavailable("no".into()));
    // "x" evicted the oldest kept entry ("1"); a kept read in flight is not reread.
    assert!(e.needs_read("x") && e.needs_read("1"));
    assert!(!e.needs_read(&Excerpts::LIMIT.to_string()));
    assert!(
        Excerpt::parse(&json!({"itemId":"other","text":"t"}), "m1").is_none(),
        "an excerpt for another message is never shown"
    );
}

#[test]
fn sources_only_speak_when_they_say_something() {
    let s = |v: Value| Source::parse(&v).unwrap();
    assert!(s(json!({"kind":"slack","status":"ok"})).notice().is_none());
    assert_eq!(
        s(json!({"kind":"slack","status":"error","budgetLimited":true,
            "error":"Slack hourly budget reached. Resumes next hour."}))
        .notice(),
        Some((
            "Slack hourly budget reached. Resumes next hour.".into(),
            false
        ))
    );
    assert!(
        s(json!({"kind":"slack","status":"sign_in_required"}))
            .notice()
            .unwrap()
            .1
    );
    assert!(Source::parse(&json!({"kind":"linear","status":"error"})).is_none());
}

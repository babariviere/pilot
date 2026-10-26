use super::*;
use serde_json::json;
fn entry(id: u64, kind: &str) -> Value {
    json!({"id":id,"kind":kind,"model":[]})
}
fn question(id: u64) -> Value {
    json!({"id":id,"kind":"pilot.question","data":{"question":" Where should retries live? ","context":" Only the worker needs them. ","options":[{"label":"Shared client","detail":" Every caller ","suggested":true},{"label":"Sync worker"},{"label":" "}]},"model":[]})
}
#[test]
fn question_parses_swift_fields_limits_and_stable_identity() {
    let q = Question::parse(4, &question(4)["data"]).unwrap();
    assert_eq!(q.content.question, "Where should retries live?");
    assert_eq!(
        q.content.context.as_deref(),
        Some("Only the worker needs them.")
    );
    assert_eq!(q.content.options.len(), 2);
    assert!(q.content.options[0].suggested);
    assert_eq!(q.content.options[0].detail.as_deref(), Some("Every caller"));
    assert_eq!(
        q.identity,
        Question::parse(4, &question(4)["data"]).unwrap().identity
    );
    let mut changed = question(4);
    changed["data"]["options"][0]["label"] = "Different answer".into();
    assert_ne!(
        q.identity,
        Question::parse(4, &changed["data"]).unwrap().identity
    );
    assert!(Question::parse(0, &question(4)["data"]).is_err());
    let astral = json!({"question":"🧪".repeat(150)});
    assert!(Question::parse(4, &astral).is_ok());
    assert!(Question::parse(4, &json!({"question":"🧪".repeat(151)})).is_err());
}
#[test]
fn question_reply_ports_swift_order_bullets_and_own_words() {
    let q=Question::parse(1,&json!({"question":"Which checks?","options":[{"label":"Typecheck"},{"label":"Tests"},{"label":"Build"}],"multiSelect":true})).unwrap();
    assert_eq!(q.reply(&BTreeSet::new(), "  ").unwrap(), None);
    assert_eq!(
        q.reply(&BTreeSet::from([1]), "").unwrap().as_deref(),
        Some("Tests")
    );
    assert_eq!(
        q.reply(&BTreeSet::from([2, 0]), "").unwrap().as_deref(),
        Some("- Typecheck\n- Build")
    );
    assert_eq!(
        q.reply(&BTreeSet::from([0]), " Skip the slow ones ")
            .unwrap()
            .as_deref(),
        Some("Typecheck\n\nSkip the slow ones")
    );
    assert!(q.reply(&BTreeSet::from([7]), "").is_err());
    let single = Question::parse(
        1,
        &json!({"question":"Proceed?","options":[{"label":"Yes"}],"multiSelect":true}),
    )
    .unwrap();
    assert!(!single.content.multi);
}
#[test]
fn question_trim_matches_actual_foundation_including_zero_width_not_bom() {
    let points = [
        '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{85}', '\u{a0}', '\u{1680}', '\u{2000}',
        '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}',
        '\u{2008}', '\u{2009}', '\u{200a}', '\u{200b}', '\u{2028}', '\u{2029}', '\u{202f}',
        '\u{205f}', '\u{3000}',
    ];
    for c in points {
        assert_eq!(
            trim_reply(&format!("{c}reply{c}")),
            "reply",
            "U+{:04X}",
            c as u32
        );
    }
    assert_eq!(trim_reply("\u{feff}reply\u{feff}"), "\u{feff}reply\u{feff}");
    assert_eq!(trim_reply("\u{200b}"), "");
}
#[test]
fn question_pending_ports_actual_user_automatic_compaction_and_order() {
    let mut pending = Pending::default();
    pending.observe(
        &json!({"id":1,"kind":"pi.user","model":[{"role":"user","content":"Add retries"}]}),
    );
    pending.observe(&question(4));
    pending.observe(&entry(6, "pi.assistant"));
    assert_eq!(pending.current().unwrap().unwrap().identity.entry, 4);
    let compaction =
        json!({"id":8,"kind":"pi.compaction","model":[{"role":"user","content":"Summary"}]});
    pending.observe(&compaction);
    assert!(pending.current().unwrap().is_some());
    let mut reopened = Pending::default();
    reopened.observe(&compaction);
    reopened.observe(&question(4));
    assert!(reopened.current().unwrap().is_some());
    reopened.observe(
        &json!({"id":7,"kind":"pilot.activity","model":[{"role":"user","content":"Continue"}]}),
    );
    assert!(reopened.current().unwrap().is_none());
    reopened.observe(&question(3));
    assert!(reopened.current().unwrap().is_none());
    pending.observe(
        &json!({"id":5,"kind":"pi.user","model":[{"role":"user","content":"Sync worker"}]}),
    );
    assert!(pending.current().unwrap().is_none());
}
#[test]
fn question_malformed_latest_never_resurrects_old_or_authorizes_access() {
    let mut pending = Pending::default();
    pending.observe(&question(4));
    let mut bad = question(6);
    bad["data"]["question"] = " ".into();
    pending.observe(&bad);
    assert!(pending.current().is_err());
    let mut access = question(7);
    access["data"]["databaseAccess"] = json!({"id":"request-1","env":"prod","mode":"read"});
    let q = Question::parse(7, &access["data"]).unwrap();
    assert!(q.content.kind == Kind::AccessUnavailable);
    assert!(q.reply(&BTreeSet::from([0]), "").is_err());
    access["data"]["databaseAccess"] = json!({"mode":"invalid"});
    assert!(Question::parse(7, &access["data"]).unwrap().content.kind == Kind::AccessUnavailable);
}

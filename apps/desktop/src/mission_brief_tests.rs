use super::*;
use crate::mission_browser_fixture as fixture;
use serde_json::json;

fn source() -> Source {
    Source {
        key: fixture::key("mission-A"),
        project: "project-A".into(),
    }
}
fn wire(number: u64, text: &str) -> Value {
    json!({"missionId":"mission-A","revision":number,"markdown":text,"createdAt":1000,"authorSessionId":null})
}
#[test]
fn canonical_source_needs_exact_home_project_and_mission_not_title() {
    let catalog = crate::mission_browser::catalog(&fixture::catalog()).unwrap();
    let s = source();
    assert!(s.canonical(&catalog));
    let mut wrong = s.clone();
    wrong.project = "project-B".into();
    assert!(!wrong.canonical(&catalog));
    let mut wrong = s.clone();
    wrong.key.home.daemon = "foreign-daemon".into();
    assert!(!wrong.canonical(&catalog));
    let mut wrong = s.clone();
    wrong.key.id = "mission-a".into();
    assert!(!wrong.canonical(&catalog));
    let mut partial = fixture::catalog();
    partial["logicalMissions"] = json!([]);
    partial["truncated"] = json!(true);
    assert!(!s.canonical(&crate::mission_browser::catalog(&partial).unwrap()));
}
#[test]
fn current_and_immutable_revision_values_validate_exact_wire_identity() {
    let s = source();
    let value = wire(7, "# Brief 日本語 👩‍💻");
    assert_eq!(parse(&s, &value, Some(7)).unwrap().revision.number, 7);
    assert!(parse(&s, &value, Some(6)).is_err());
    for (field, invalid) in [
        ("missionId", json!("mission-a")),
        ("revision", json!(0)),
        ("revision", json!(-1)),
        ("revision", json!(MAX_REVISION + 1)),
        ("revision", json!("7")),
        ("createdAt", json!(-1)),
        ("createdAt", json!(null)),
        ("authorSessionId", json!("bad/id")),
        ("markdown", json!(null)),
    ] {
        let mut value = value.clone();
        value[field] = invalid;
        assert!(parse(&s, &value, None).is_err(), "invalid field {field}");
    }
    let mut invalid_owner = s;
    invalid_owner.project = "bad/id".into();
    assert!(parse(&invalid_owner, &value, None).is_err());
}
#[test]
fn supported_source_budget_counts_utf16_before_normalization() {
    let s = source();
    let text = "🧪".repeat(SOURCE_UTF16 / 2);
    assert!(text.len() <= SOURCE_BYTES);
    assert_eq!(
        parse(&s, &wire(1, &text), None).unwrap().markdown.as_ref(),
        text
    );
    assert!(parse(&s, &wire(1, &(text + "🧪")), None).is_err());
    assert!(
        parse(&s, &wire(1, &" ".repeat(SOURCE_UTF16 + 1)), None).is_err(),
        "limits apply before trim"
    );
}
#[test]
fn visible_copy_is_an_exact_unicode_prefix_not_full_or_editable_content() {
    let text = "界".repeat(DISPLAY_BYTES / 3) + "🧪";
    let b = parse(&source(), &wire(1, &text), None).unwrap();
    assert!(b.clipped());
    assert!(b.editable());
    assert!(text.is_char_boundary(b.visible().len()));
    assert!(b.visible().len() <= DISPLAY_BYTES);
    assert_eq!(b.visible(), &text[..DISPLAY_BYTES - 2]);
    assert_eq!(
        b.markdown.as_ref(),
        text,
        "full admitted copy stays distinct"
    );
    let b = parse(&source(), &wire(1, &"x".repeat(EDIT_BYTES + 1)), None).unwrap();
    assert!(!b.editable());
    assert!(b.clipped());
}
#[test]
fn history_is_bounded_unique_and_sorted_without_guessing_missing_revisions() {
    let values = json!([wire(4, "old"), wire(9, "new"), wire(2, "older")]);
    assert_eq!(
        history(&values)
            .unwrap()
            .iter()
            .map(|r| r.number)
            .collect::<Vec<_>>(),
        [9, 4, 2]
    );
    assert!(history(&json!([])).unwrap().is_empty());
    assert!(history(&json!([wire(2, "a"), wire(2, "b")])).is_err());
    assert!(
        history(&json!(
            (1..=HISTORY_COUNT + 1)
                .map(|n| wire(n as u64, "x"))
                .collect::<Vec<_>>()
        ))
        .is_err()
    );
    assert!(history(&json!({"revisions":[]})).is_err());
}
#[test]
fn save_capture_preserves_original_text_and_has_no_daemon_replay_identity() {
    let text = "\u{feff}  # Draft 🧪\n\u{0085} ";
    let save = Save::capture(source(), 0, "", text).unwrap();
    assert_eq!(save.markdown.as_ref(), text);
    assert_eq!(save.expected, 0);
    assert_ne!(save.id, Save::capture(source(), 0, "", text).unwrap().id);
    assert!(Save::capture(source(), MAX_REVISION, "", text).is_err());
    let long = "界".repeat(EDIT_BYTES / 3 + 1);
    assert!(Save::capture(source(), 0, "", &long).is_err());
    assert!(long.len() > EDIT_BYTES);
    assert!(
        Save::capture(source(), 0, "", "").is_ok(),
        "empty briefs are supported"
    );
}
#[test]
fn ack_requires_same_owner_supported_revision_and_ecmascript_normalized_capture() {
    let save = Save::capture(source(), 4, "Prior content", "\u{feff}  # Draft\n ").unwrap();
    let ack = parse(&source(), &wire(5, "# Draft"), None).unwrap();
    assert!(save.acknowledges(&ack));
    assert!(
        !save.acknowledges(&parse(&source(), &wire(4, "# Draft"), None).unwrap()),
        "changed captured base cannot acknowledge same revision"
    );
    let noop = Save::capture(source(), 4, "# Draft", "\u{feff}  # Draft\n ").unwrap();
    assert!(noop.acknowledges(&parse(&source(), &wire(4, "# Draft"), None).unwrap()));
    assert!(
        !noop.acknowledges(&ack),
        "normalized no-op must return SAME revision"
    );
    assert!(!save.acknowledges(&parse(&source(), &wire(6, "# Draft"), None).unwrap()));
    assert!(!save.acknowledges(&parse(&source(), &wire(5, "different"), None).unwrap()));
    let mut other = ack.clone();
    other.source.project = "project-B".into();
    assert!(!save.acknowledges(&other));
    let mut other = ack;
    other.source.key.home.lineage = "other-lineage".into();
    assert!(!save.acknowledges(&other));
    let text = "\u{0085}# Draft\u{0085}";
    let save = Save::capture(source(), 0, "", text).unwrap();
    assert!(save.acknowledges(&parse(&source(), &wire(1, text), None).unwrap()));
    assert!(!save.acknowledges(&parse(&source(), &wire(1, "# Draft"), None).unwrap()));
    assert!(
        !Save::capture(source(), 0, "", "")
            .unwrap()
            .acknowledges(&parse(&source(), &wire(1, "not empty"), None).unwrap())
    );
}

fn loaded(book: &mut Book, source: &Source, n: u64, text: &str) {
    book.ensure(source).unwrap();
    let brief = (n != 0).then(|| Arc::new(parse(source, &wire(n, text), None).unwrap()));
    book.get_mut(source).unwrap().receive(Current {
        source: source.clone(),
        brief,
    });
    book.get_mut(source).unwrap().edit().unwrap();
}
#[test]
fn empty_initial_save_creates_one_but_normalized_noop_keeps_revision() {
    let mut b = Book::default();
    let s = source();
    loaded(&mut b, &s, 0, "");
    let save = b.begin(&s).unwrap();
    assert!(save.acknowledges(&parse(&s, &wire(1, ""), None).unwrap()));
    b.finish(
        &save,
        Outcome::Confirmed(Arc::new(parse(&s, &wire(1, ""), None).unwrap())),
    );
    assert_eq!(b.get(&s).unwrap().draft.as_ref().unwrap().base, 1);
    let save = b.begin(&s).unwrap();
    assert!(save.acknowledges(&parse(&s, &wire(1, ""), None).unwrap()));
    assert!(!save.acknowledges(&parse(&s, &wire(2, ""), None).unwrap()));
}
#[test]
fn late_ack_records_its_owner_without_overwriting_newer_edit_or_other_source() {
    let mut b = Book::default();
    let s = source();
    loaded(&mut b, &s, 1, "one");
    b.get_mut(&s).unwrap().change("captured").unwrap();
    let save = b.begin(&s).unwrap();
    b.get_mut(&s).unwrap().change("newer private edit").unwrap();
    let mut other = s.clone();
    other.project = "project-B".into();
    b.ensure(&other).unwrap();
    assert!(
        b.begin(&other).is_err(),
        "global pending save slot stays bounded"
    );
    b.finish(
        &save,
        Outcome::Confirmed(Arc::new(parse(&s, &wire(2, "captured"), None).unwrap())),
    );
    let e = b.get(&s).unwrap();
    let d = e.draft.as_ref().unwrap();
    assert_eq!(d.text.as_ref(), "newer private edit");
    assert_eq!(d.base, 1);
    assert!(e.known.is_some());
    assert!(b.get(&other).unwrap().known.is_none());
    assert!(
        b.begin(&s).is_err(),
        "newer edit needs explicit latest-base review"
    );
    b.get_mut(&s).unwrap().use_latest().unwrap();
    assert_eq!(b.begin(&s).unwrap().expected, 2);
}
#[test]
fn reads_never_settle_unknown_and_known_ack_survives_later_failure() {
    let mut b = Book::default();
    let s = source();
    loaded(&mut b, &s, 1, "one");
    b.get_mut(&s).unwrap().change("two").unwrap();
    let first = b.begin(&s).unwrap();
    b.finish(
        &first,
        Outcome::Confirmed(Arc::new(parse(&s, &wire(2, "two"), None).unwrap())),
    );
    b.get_mut(&s).unwrap().change("three").unwrap();
    let save = b.begin(&s).unwrap();
    b.stopped();
    b.get_mut(&s).unwrap().receive(Current {
        source: s.clone(),
        brief: Some(Arc::new(parse(&s, &wire(3, "three"), None).unwrap())),
    });
    assert!(matches!(
        b.get(&s).unwrap().attempt.as_ref().unwrap().outcome,
        Outcome::Unknown(_)
    ));
    assert_eq!(b.get(&s).unwrap().known.as_ref().unwrap().save.id, first.id);
    assert!(b.begin(&s).is_err());
    b.finish(
        &save,
        Outcome::Confirmed(Arc::new(parse(&s, &wire(3, "three"), None).unwrap())),
    );
    assert!(
        matches!(
            b.get(&s).unwrap().attempt.as_ref().unwrap().outcome,
            Outcome::Unknown(_)
        ),
        "late response cannot replace retired pending lane"
    );
    b.get_mut(&s).unwrap().use_latest().unwrap();
    let next = b.begin(&s).unwrap();
    assert_eq!(next.expected, 3);
    assert_eq!(b.get(&s).unwrap().unconfirmed.len(), 1);
}
#[test]
fn capacity_overflow_keeps_existing_drafts_and_oversized_edit_is_copyable() {
    let mut b = Book::default();
    let s = source();
    loaded(&mut b, &s, 1, "one");
    let long = "界".repeat(EDIT_BYTES / 3 + 1);
    assert!(b.get_mut(&s).unwrap().change(&long).is_err());
    assert_eq!(
        b.get(&s).unwrap().draft.as_ref().unwrap().text.as_ref(),
        long
    );
    assert!(b.begin(&s).is_err());
    for n in 1..DRAFT_COUNT {
        let mut source = s.clone();
        source.key.id = format!("m{n}");
        b.ensure(&source).unwrap();
    }
    let mut extra = s.clone();
    extra.key.id = "overflow".into();
    assert!(b.ensure(&extra).is_err());
    assert_eq!(b.entries.len(), DRAFT_COUNT);
    assert_eq!(
        b.get(&s).unwrap().draft.as_ref().unwrap().text.as_ref(),
        long
    );
}
#[test]
fn known_conflicts_do_not_claim_unknown_or_consume_its_four_attempt_budget() {
    let mut b = Book::default();
    let s = source();
    loaded(&mut b, &s, 1, "one");
    b.get_mut(&s).unwrap().change("mine").unwrap();
    for _ in 0..6 {
        let a = b.begin(&s).unwrap();
        assert!(b.finish(&a, Outcome::Conflict));
        b.get_mut(&s).unwrap().use_latest().unwrap();
    }
    assert!(b.get(&s).unwrap().unconfirmed.is_empty());
    for _ in 0..4 {
        let a = b.begin(&s).unwrap();
        assert!(b.finish(&a, Outcome::Unknown("Lost response")));
        b.get_mut(&s).unwrap().use_latest().unwrap();
    }
    assert!(b.begin(&s).is_err());
    let e = b.get(&s).unwrap();
    assert_eq!(e.unconfirmed.len(), 3);
    assert!(matches!(
        e.attempt.as_ref().unwrap().outcome,
        Outcome::Unknown(_)
    ));
    assert_eq!(e.draft.as_ref().unwrap().text.as_ref(), "mine");
}
#[test]
fn reopening_edit_during_noop_save_preserves_new_editing_intent() {
    let mut b = Book::default();
    let s = source();
    loaded(&mut b, &s, 1, "one");
    let save = b.begin(&s).unwrap();
    b.get_mut(&s).unwrap().edit().unwrap();
    assert!(b.finish(
        &save,
        Outcome::Confirmed(Arc::new(parse(&s, &wire(1, "one"), None).unwrap()))
    ));
    let e = b.get(&s).unwrap();
    assert!(e.known.is_some());
    assert!(!e.confirmed_current_edit());
    assert_eq!(e.draft.as_ref().unwrap().text.as_ref(), "one");
}

use super::*;

fn actions() -> Actions {
    Actions {
        options: Some(LocalOptions::synthetic(1)),
        worker: None,
        reports: BTreeMap::new(),
        latest: None,
        error: None,
        next: 0,
        renames: Default::default(),
        latest_rename: None,
        rename_observers: Default::default(),
        restore: Default::default(),
    }
}
/// Evidence for the fixture chat as Local reports it: archived or open.
fn evidence(archived: bool) -> Evidence {
    let options = LocalOptions::synthetic(1);
    let mut raw = crate::chat_actions_fixture::source();
    if archived {
        raw["archivedAt"] = serde_json::json!(1234);
    }
    let target = Target::new(&options, crate::local_model::chat(&raw).unwrap());
    Evidence::read(&target, &raw, true).unwrap()
}
fn report(actions: &mut Actions, id: u64, evidence: Evidence, outcome: Option<Outcome>) {
    actions.reports.insert(
        evidence.target.chat.id.clone(),
        Report {
            id,
            evidence,
            outcome,
            observed_current: false,
        },
    );
}

#[test]
fn archived_restore_starts_ready_and_checks_only_the_exact_chat() {
    let mut a = actions();
    assert_eq!(a.restore_view("source"), RestoreView::Ready);
    let token = a
        .begin_restore_check("source")
        .expect("ready chat may check");
    assert_eq!(a.restore_view("source"), RestoreView::Busy);
    // One check at a time; no second check or repeat while the first is open.
    assert_eq!(a.begin_restore_check("source"), None);
    assert_eq!(a.begin_restore_check("other"), None);
    assert_eq!(a.restore_view("other"), RestoreView::Blocked(PENDING));
    // A completion for another chat or an older token is stale and changes nothing.
    assert!(!a.end_restore_check(token, "other"));
    assert!(!a.end_restore_check(token + 1, "source"));
    assert_eq!(a.restore_view("source"), RestoreView::Busy);
    assert!(a.end_restore_check(token, "source"));
    assert!(
        !a.end_restore_check(token, "source"),
        "a check completes once"
    );
    assert_eq!(a.restore_view("source"), RestoreView::Ready);
}

#[test]
fn archived_restore_inspection_failure_is_retryable_and_scoped_to_its_chat() {
    let mut a = actions();
    let token = a.begin_restore_check("source").unwrap();
    assert!(a.end_restore_check(token, "source"));
    a.restore_failed("source", "This Local chat is unavailable.");
    assert_eq!(
        a.restore_view("source"),
        RestoreView::Failed("This Local chat is unavailable.")
    );
    assert_eq!(a.restore_view("other"), RestoreView::Ready);
    // Nothing was submitted, so an explicit retry is allowed and clears the error.
    assert!(a.begin_restore_check("source").is_some());
    assert_eq!(a.restore_view("source"), RestoreView::Busy);
}

#[test]
fn archived_restore_follows_the_shared_report_pending_ack_reject_unknown() {
    let mut a = actions();
    let restore = evidence(true);
    assert!(
        !restore.archive && restore.can_archive,
        "archived evidence restores"
    );
    report(&mut a, 1, restore.clone(), None);
    assert_eq!(a.restore_view("source"), RestoreView::Busy);
    assert_eq!(a.begin_restore_check("source"), None);

    // ACK before the chat list shows it: no inferred composer, no repeat.
    a.reports.get_mut("source").unwrap().outcome = Some(Outcome::Acknowledged);
    assert_eq!(a.restore_view("source"), RestoreView::Restored);
    assert_eq!(a.begin_restore_check("source"), None);
    // The list confirming the open chat retires the report.
    let mut open = restore.target.chat.clone();
    open.archived = false;
    a.observe(&[open]);
    assert_eq!(a.restore_view("source"), RestoreView::Ready);

    let rejected = crate::chat_actions::INELIGIBLE;
    report(
        &mut a,
        2,
        restore.clone(),
        Some(Outcome::Rejected(rejected)),
    );
    assert_eq!(a.restore_view("source"), RestoreView::Failed(rejected));
    assert!(
        a.begin_restore_check("source").is_some(),
        "rejected is retryable"
    );
    a.restore = Default::default();

    report(&mut a, 3, restore, Some(Outcome::Unknown));
    assert_eq!(
        a.restore_view("source"),
        RestoreView::Blocked(RESTORE_UNKNOWN)
    );
    assert_eq!(
        a.begin_restore_check("source"),
        None,
        "Unknown is never repeated"
    );
}

#[test]
fn archived_restore_is_blocked_by_an_unconfirmed_archive_or_another_pending_action() {
    let mut a = actions();
    report(&mut a, 1, evidence(false), Some(Outcome::Unknown));
    assert_eq!(
        a.restore_view("source"),
        RestoreView::Blocked(ARCHIVE_UNKNOWN)
    );
    assert_eq!(a.begin_restore_check("source"), None);

    let mut a = actions();
    let mut other = evidence(false);
    other.target.chat.id = "other".into();
    report(&mut a, 1, other, None);
    assert_eq!(a.restore_view("source"), RestoreView::Blocked(PENDING));
    assert_eq!(a.begin_restore_check("source"), None);
}

#[test]
fn archived_notice_owns_its_chat_status_instead_of_the_sidebar() {
    let mut a = actions();
    report(&mut a, 1, evidence(true), Some(Outcome::Unknown));
    a.latest = Some("source".into());
    assert!(a.sidebar_report().is_some());
    assert!(a.show_inline(Some("source")));
    assert!(!a.show_inline(Some("source")), "unchanged inline target");
    assert!(a.sidebar_report().is_none());
    assert!(a.show_inline(None));
    assert!(a.sidebar_report().is_some());
}

#[test]
fn archived_restore_focus_intent_is_taken_once_for_its_chat() {
    let mut a = actions();
    let token = a.begin_restore_check("source").unwrap();
    assert!(
        !a.take_restore_focus("other"),
        "another chat never takes it"
    );
    assert!(
        !a.take_restore_focus("source"),
        "cleared after navigating away"
    );
    assert!(a.end_restore_check(token, "source"));
    assert!(a.begin_restore_check("source").is_some());
    assert!(a.take_restore_focus("source"));
    assert!(!a.take_restore_focus("source"));
}

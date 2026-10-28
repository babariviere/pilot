use super::*;
use serde_json::json;
pub(super) fn row() -> Row {
    Snapshot::read(
        &json!([{"id":42,"mode":"followUp","content":"Original 🦀","guardToken":"a".repeat(64)}]),
    )
    .rows
    .remove(0)
}
pub(super) fn source() -> Source {
    Source {
        home: crate::LocalOptions::synthetic(1).host(),
        chat: "source".into(),
    }
}
#[test]
fn captured_payload_mode_and_completion_are_exact_and_never_replayed() {
    let mut s = State::default();
    let r = row();
    let src = source();
    let op = s
        .begin(
            &src,
            &r,
            Change::Edit {
                text: "Edited 🦀".into(),
                mode: None,
            },
        )
        .unwrap();
    assert_eq!(op.row, r);
    assert!(matches!(op.change, Change::Edit { mode: None, .. }));
    assert!(s.begin(&src, &r, Change::Remove).is_err());
    let mut wrong = op.clone();
    wrong.id.push('x');
    assert!(!s.finish(&wrong, Outcome::Acknowledged));
    wrong = op.clone();
    wrong.source.chat = "other".into();
    assert!(!s.finish(&wrong, Outcome::Acknowledged));
    assert!(s.finish(&op, Outcome::Unknown("Lost ACK")));
    assert!(!s.finish(&op, Outcome::Acknowledged));
    assert!(s.begin(&src, &r, Change::Remove).is_err());
}
#[test]
fn structured_oversized_empty_and_unqualified_edits_fail_without_loss() {
    let mut r = row();
    let mut s = State::default();
    let src = source();
    for text in ["\u{feff} \n".into(), "x".repeat(TEXT_BYTES + 1)] {
        assert!(
            s.begin(&src, &r, Change::Edit { text, mode: None })
                .is_err()
        );
    }
    r.content = json!([{"type":"text","text":"Hello"},{"type":"image","data":"preserved"}]);
    let original = r.clone();
    assert!(
        s.begin(
            &src,
            &r,
            Change::Edit {
                text: "Hello".into(),
                mode: None
            }
        )
        .is_err()
    );
    assert_eq!(r, original);
    assert!(s.begin(&src, &r, Change::Remove).is_ok());
    let mut s = State::default();
    r.token = None;
    assert!(s.begin(&src, &r, Change::Remove).is_err());
}
#[test]
fn queue_snapshot_bounds_duplicates_and_unknown_mode_fail_closed() {
    for v in [
        json!([{"id":42,"mode":"write","content":"No"}]),
        json!([{"id":0,"mode":"steer","content":"No"}]),
        json!(vec![json!({"id":42,"mode":"steer","content":"No"}); 2]),
        json!([{"id":42,"mode":"steer","content":"x".repeat(SNAPSHOT_BYTES)}]),
    ] {
        assert!(Snapshot::read(&v).unavailable);
    }
    let r = row();
    assert_eq!(r.text(), Some("Original 🦀"));
    let s = Snapshot::read(&json!([{"id":1,"mode":"steer","content":"Legacy"}]));
    assert!(!s.unavailable);
    assert!(s.rows[0].token.is_none());
}

#[test]
fn retained_drafts_follow_the_current_capture() {
    let src = source();
    let r = row();
    let mut edited = r.clone();
    edited.content = json!("Edited 🦀");
    edited.token = Some("c".repeat(64));
    let edit = || Change::Edit {
        text: "Edited 🦀".into(),
        mode: None,
    };
    // Untouched drafts never pin a capture; unsaved text survives any race.
    let s = State::default();
    for current in [Some(&r), Some(&edited), None] {
        assert!(!s.retains(&r, false, current));
        assert!(s.retains(&r, true, current));
    }
    // Happy: an acknowledged edit pins its capture only until Local republishes,
    // then a fresh capture removes the current row with its own guard.
    let mut s = State::default();
    let op = s.begin(&src, &r, edit()).unwrap();
    assert!(s.retains(&r, false, Some(&edited)) && s.retains(&r, false, None));
    assert!(s.finish(&op, Outcome::Acknowledged));
    assert!(s.retains(&r, false, Some(&r)) && s.blocked());
    assert!(s.begin(&src, &r, Change::Remove).is_err());
    assert!(!s.retains(&r, false, Some(&edited)) && !s.retains(&r, false, None));
    let mut fresh = State::default();
    let remove = fresh.begin(&src, &edited, Change::Remove).unwrap();
    assert_eq!(remove.row.token, edited.token);
    // Refused before dispatch: nothing is pinned and the same capture may try again.
    let mut s = State::default();
    let op = s.begin(&src, &r, Change::Remove).unwrap();
    assert!(s.finish(&op, Outcome::NotSent("refused")));
    assert!(!s.blocked() && !s.retains(&r, false, Some(&r)));
    assert!(s.begin(&src, &r, Change::Remove).is_ok());
    // Unknown: kept whatever the queue shows later, and never repeated.
    for change in [edit(), Change::Remove] {
        let mut s = State::default();
        let op = s.begin(&src, &r, change).unwrap();
        assert!(s.finish(&op, Outcome::Unknown("lost")));
        assert!(
            !s.finish(&op, Outcome::Acknowledged),
            "visibility never settles it"
        );
        for current in [Some(&r), Some(&edited), None] {
            assert!(s.retains(&r, false, current) && s.blocked());
        }
        assert!(s.begin(&src, &r, Change::Remove).is_err());
    }
}

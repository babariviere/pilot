//! Changes rules on mock data: exact snapshot identity, history versus
//! now, unavailable versus empty, and Later without approval.

use pilot_day_native::{
    changes::{
        AttentionAsk, AttentionIntent, ChangeAttention, ChangePage, ChangeRef, ChangeRow,
        ChangesAvailability, ChangesScenario, Disposition, FileStatus, LandingState,
    },
    changes_contract as c,
    changes_desk::ChangesDesk,
    changes_project::{self as project, MISMATCH, PageInputs, sha256},
    model::{Delivery, OutcomeStatus},
};

fn titles(rows: &[ChangeRow]) -> Vec<&str> {
    rows.iter().map(|r| r.title.as_str()).collect()
}

fn find<'a>(desk: &'a ChangesDesk, title: &str) -> &'a ChangeRow {
    let list = desk.list();
    list.waiting
        .iter()
        .chain(&list.later)
        .chain(&list.earlier)
        .find(|r| r.title == title)
        .unwrap_or_else(|| panic!("no row {title}"))
}

fn open(desk: &mut ChangesDesk, snapshot_id: &str) -> ChangePage {
    let intent = ChangeRef {
        snapshot_id: snapshot_id.to_owned(),
    };
    desk.begin_open(&intent).expect("opens");
    let outcome = desk.settle_open(&intent);
    assert_eq!(
        outcome.status,
        OutcomeStatus::Accepted,
        "{}",
        outcome.message
    );
    desk.page(snapshot_id).expect("page")
}

fn intent(page: &ChangePage) -> AttentionIntent {
    let request = page.request.as_ref().expect("an open request");
    AttentionIntent {
        snapshot_id: page.identity.snapshot_id.clone(),
        request_id: request.request_id.clone(),
        revision: request.revision,
    }
}

#[test]
fn the_list_groups_by_review_request_and_keeps_unreadable_slots() {
    let desk = ChangesDesk::new(ChangesScenario::Review);
    let list = desk.list();
    assert_eq!(list.availability, ChangesAvailability::Available);
    assert_eq!(
        titles(&list.waiting),
        ["Review: History slice", "Review: Docs refresh"]
    );
    assert_eq!(titles(&list.later), ["Review: Search warm-up"]);
    assert_eq!(
        titles(&list.earlier),
        [
            "Review: Quieter notifications",
            "Review: History slice",
            "Tidy shell setup"
        ]
    );
    assert_eq!(list.unreadable, 1);
    assert_eq!(list.pending, 1);
    assert!(!list.more);
}

#[test]
fn unavailable_is_never_empty() {
    let empty = ChangesDesk::new(ChangesScenario::Empty);
    assert_eq!(empty.list().availability, ChangesAvailability::Available);
    assert!(empty.list().waiting.is_empty() && empty.list().earlier.is_empty());
    assert_eq!(empty.list().reason, "");

    let off = ChangesDesk::new(ChangesScenario::Unavailable);
    assert_eq!(off.list().availability, ChangesAvailability::Unavailable);
    assert!(off.list().reason.starts_with("Not captured."));
}

#[test]
fn landing_seen_once_stays_seen_with_a_note() {
    let desk = ChangesDesk::new(ChangesScenario::Review);
    let shell = find(&desk, "Tidy shell setup");
    assert_eq!(shell.landing, LandingState::Seen);
    assert_eq!(shell.branch, "main");
    assert!(shell.later_unclear);
    let notify = find(&desk, "Review: Quieter notifications");
    assert_eq!(notify.landing, LandingState::Seen);
    assert!(!notify.later_unclear);
    let docs = find(&desk, "Review: Docs refresh");
    assert_eq!(docs.landing, LandingState::Unchecked);
    assert_eq!(docs.landing_age, "");
}

#[test]
fn reopening_shows_the_exact_older_snapshot_not_the_newer_one() {
    let mut desk = ChangesDesk::new(ChangesScenario::Review);
    let newer = desk.list().waiting[0].clone();
    let older = desk.list().earlier[1].clone();
    assert_eq!(older.change, newer.change);
    assert_ne!(older.snapshot_id, newer.snapshot_id);

    let page = open(&mut desk, &older.snapshot_id);
    assert_eq!(page.identity.snapshot_id, older.snapshot_id);
    assert!(page.identity.head.starts_with(&older.head));
    assert_ne!(page.identity.head[..8], newer.head);
    assert_eq!(page.newer.as_deref(), Some(newer.snapshot_id.as_str()));
    // The exact kept patch of that snapshot, not the newer one's.
    assert!(page.patch.contains("+        self.loaded_older = true;"));
    assert!(!page.patch.contains("visible_anchor"));
    assert_eq!(sha256(&page.patch), page.identity.diff);
    assert_eq!(page.files.len(), 1);
    assert_eq!((page.files[0].added, page.files[0].removed), (1, 0));
    assert_eq!(page.reviews.len(), 1);
    assert_eq!(page.reviews[0].disposition, Disposition::RequestChanges);
    // The replaced request is history: nothing to put off.
    assert_eq!(page.row.attention, ChangeAttention::Closed);
    assert!(page.request.is_none());
    assert_eq!(page.requests.len(), 1);

    let current = open(&mut desk, &newer.snapshot_id);
    assert_eq!(current.newer, None);
    assert_eq!(current.row.attention, ChangeAttention::Waiting);
    assert!(current.reviews.is_empty());
}

#[test]
fn a_historical_approval_is_not_current_and_cannot_be_put_off() {
    let mut desk = ChangesDesk::new(ChangesScenario::Review);
    let notify = find(&desk, "Review: Quieter notifications")
        .snapshot_id
        .clone();
    let page = open(&mut desk, &notify);
    assert_eq!(page.reviews[0].disposition, Disposition::Approve);
    assert!(page.request.is_none());
    assert_eq!(page.landings[0].state, LandingState::Seen);
    assert_eq!(page.reported.len(), 1);
    let refused = desk
        .begin_attention(
            &AttentionIntent {
                snapshot_id: notify,
                request_id: page.requests[0].request_id.clone(),
                revision: page.requests[0].revision,
            },
            AttentionAsk::Later,
        )
        .unwrap_err();
    assert_eq!(refused.status, OutcomeStatus::Stale);
}

#[test]
fn later_defers_without_approval_and_names_the_revision_shown() {
    let mut desk = ChangesDesk::new(ChangesScenario::Review);
    let docs = find(&desk, "Review: Docs refresh").snapshot_id.clone();
    let before = open(&mut desk, &docs);
    let shown = intent(&before);
    assert_eq!(shown.revision, 1);

    let operation = desk
        .begin_attention(&shown, AttentionAsk::Later)
        .expect("sends");
    assert_eq!(
        find(&desk, "Review: Docs refresh").delivery,
        Delivery::Sending
    );
    let outcome = desk.settle_attention(&docs, &operation);
    assert_eq!(outcome.status, OutcomeStatus::Accepted);
    assert!(outcome.message.contains("nothing was approved"));

    let after = desk.page(&docs).expect("page");
    assert_eq!(after.row.attention, ChangeAttention::Later);
    assert_eq!(after.request.as_ref().map(|r| r.revision), Some(2));
    assert_eq!(after.reviews, before.reviews);
    assert_eq!(after.identity, before.identity);
    assert_eq!(
        titles(&desk.list().later),
        ["Review: Search warm-up", "Review: Docs refresh"]
    );
    assert_eq!(titles(&desk.list().waiting), ["Review: History slice"]);

    // The revision shown is gone: a second Later is stale and sends nothing.
    let stale = desk
        .begin_attention(&shown, AttentionAsk::Later)
        .unwrap_err();
    assert_eq!(stale.status, OutcomeStatus::Stale);

    // Bring back names the new revision.
    let back = intent(&after);
    let operation = desk
        .begin_attention(&back, AttentionAsk::BringBack)
        .expect("sends");
    desk.settle_attention(&docs, &operation);
    assert_eq!(
        desk.page(&docs).unwrap().row.attention,
        ChangeAttention::Waiting
    );
}

#[test]
fn a_lost_answer_is_unknown_and_only_a_check_settles_it() {
    let mut desk = ChangesDesk::new(ChangesScenario::Trouble);
    let docs = find(&desk, "Review: Docs refresh").snapshot_id.clone();
    let page = open(&mut desk, &docs);
    let shown = intent(&page);
    let operation = desk.begin_attention(&shown, AttentionAsk::Later).unwrap();
    let outcome = desk.settle_attention(&docs, &operation);
    assert_eq!(outcome.status, OutcomeStatus::Unknown);
    assert_eq!(desk.page(&docs).unwrap().row.delivery, Delivery::Unknown);

    let again = desk
        .begin_attention(&shown, AttentionAsk::Later)
        .unwrap_err();
    assert_eq!(again.status, OutcomeStatus::Rejected);

    let checked = desk
        .begin_check(&ChangeRef {
            snapshot_id: docs.clone(),
        })
        .unwrap();
    assert_eq!(checked, operation);
    assert_eq!(desk.page(&docs).unwrap().row.delivery, Delivery::Checking);
    let outcome = desk.settle_check(&docs, &checked);
    assert_eq!(outcome.status, OutcomeStatus::Accepted);
    assert!(
        outcome
            .message
            .starts_with("It arrived. Nothing was sent again.")
    );
    let after = desk.page(&docs).unwrap();
    assert_eq!(after.row.delivery, Delivery::Idle);
    assert_eq!(after.row.attention, ChangeAttention::Later);
    // Applied once: the revision moved by one.
    assert_eq!(after.request.unwrap().revision, 2);
}

#[test]
fn mode_changes_show_and_unknown_snapshots_do_not_open() {
    let mut desk = ChangesDesk::new(ChangesScenario::Review);
    let shell = find(&desk, "Tidy shell setup").snapshot_id.clone();
    let page = open(&mut desk, &shell);
    assert_eq!(page.files[0].status, FileStatus::Mode);
    let missing = desk
        .begin_open(&ChangeRef {
            snapshot_id: "snap_missing".into(),
        })
        .unwrap_err();
    assert_eq!(missing.status, OutcomeStatus::Rejected);
}

#[test]
fn partial_snapshots_show_omissions_and_binary_files() {
    let mut desk = ChangesDesk::new(ChangesScenario::Review);
    let docs = find(&desk, "Review: Docs refresh").snapshot_id.clone();
    let page = open(&mut desk, &docs);
    assert_eq!(page.omissions, ["2 images over 1 MiB were not kept."]);
    assert_eq!(page.files.len(), 2);
    assert!(page.files[1].binary);
    assert_eq!(page.files[1].status, FileStatus::Added);
    assert_eq!((page.files[0].added, page.files[0].removed), (2, 1));
    assert_eq!(page.diff_note, "");
}

#[test]
fn large_worlds_read_twenty_at_a_time_and_cap_long_diffs() {
    let mut desk = ChangesDesk::new(ChangesScenario::Large);
    let count = |d: &ChangesDesk| {
        let l = d.list();
        l.waiting.len() + l.later.len() + l.earlier.len()
    };
    assert_eq!(count(&desk), 20);
    assert!(desk.list().more);
    desk.more();
    assert_eq!(count(&desk), 40);
    desk.more();
    assert_eq!(count(&desk), 45);
    assert!(!desk.list().more);
    assert_eq!(desk.more().status, OutcomeStatus::Rejected);

    let long = desk.list().waiting[0].snapshot_id.clone();
    let page = open(&mut desk, &long);
    let file = &page.files[0];
    assert_eq!(file.added, 1200);
    assert_eq!(file.status, FileStatus::Added);
    // The diff view is virtualized: the whole patch goes to it.
    assert_eq!(page.patch.lines().count(), 1205);
    assert!(page.patch.len() < project::MAX_PATCH);
}

#[test]
fn patches_parse_renames_modes_binaries_and_counts() {
    let files = project::parse_patch(concat!(
        "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n",
        "--- a/old.ts\n+++ b/new.ts\n@@ -3,2 +3,2 @@ fn\n-a\n+b\n c\n\\ No newline at end of file\n",
        "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n",
        "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n",
        "diff --git a/i.png b/i.png\nnew file mode 100644\nBinary files /dev/null and b/i.png differ\n",
    ));
    let shown: Vec<(&str, &str, FileStatus, u32, u32, bool)> = files
        .iter()
        .map(|f| {
            (
                f.name.as_str(),
                f.old_name.as_str(),
                f.status,
                f.added,
                f.removed,
                f.binary,
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            ("new.ts", "old.ts", FileStatus::Renamed, 1, 1, false),
            ("run.sh", "", FileStatus::Mode, 0, 0, false),
            ("gone.txt", "", FileStatus::Deleted, 0, 2, false),
            ("i.png", "", FileStatus::Added, 0, 0, true),
        ]
    );
}

fn sample_history(snapshot: &str, patch: &str) -> c::History {
    let target = serde_json::json!({
        "projectId": "p", "sessionId": "s", "snapshotId": snapshot, "repositoryId": "r",
        "changeId": "chg", "baseCommitId": "b".repeat(40), "headCommitId": "h".repeat(40),
        "layer": "layer", "diffSha256": sha256(patch), "comparisonDigest": "d",
    });
    let request = serde_json::json!({
        "requestId": "q", "repositoryId": "r", "changeId": "chg", "operationId": "o",
        "base": { "changeId": "z", "commitId": "b".repeat(40) },
        "head": { "changeId": "chg", "commitId": "h".repeat(40) },
        "scope": { "kind": "layer" }, "source": "committed",
    });
    serde_json::from_value(serde_json::json!({
        "version": 1,
        "comparison": { "snapshotId": snapshot, "sequence": 1, "capturedAt": 1, "request": request, "status": "complete" },
        "snapshot": {
            "snapshotId": snapshot, "request": request, "workerId": "s", "status": "complete",
            "capturedAt": 1, "enrollmentTaskIds": [], "omissions": [], "before": [], "after": [],
            "changes": [], "diff": { "sha256": sha256(patch), "bytes": patch.len() },
            "creation": { "changeId": "chg", "commitId": "h", "operationId": "o", "kind": "k" },
        },
        "target": target,
        "reported": { "status": "unavailable", "reason": "x" },
        "landing": { "records": [], "next": null },
        "reviews": { "records": [], "next": null },
        "attention": { "records": [], "complete": true },
        "approval": "not-evaluated",
        "acceptance": "not-evaluated",
        "extra": "ignored",
    }))
    .expect("parses the v1 history")
}

fn inputs<'a>(
    history: &'a c::History,
    patch: &'a c::RetainedPatch,
    titles: &'a std::collections::HashMap<String, String>,
) -> PageInputs<'a> {
    PageInputs {
        history,
        patch: Ok(patch),
        row: None,
        request: None,
        newer: None,
        titles,
        local: None,
        now: 1,
        read_at: 1,
    }
}

#[test]
fn a_read_that_names_another_snapshot_shows_nothing() {
    let text = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    let titles = Default::default();
    let history = sample_history("snap_a", text);
    let patch = c::RetainedPatch {
        snapshot_id: "snap_a".into(),
        patch: text.into(),
    };
    let page = project::page("snap_a", &inputs(&history, &patch, &titles)).unwrap();
    assert_eq!(page.files[0].added, 1);
    assert_eq!(page.patch, text);
    assert_eq!(page.identity.snapshot_id, "snap_a");

    // Asked for another snapshot.
    assert_eq!(
        project::page("snap_b", &inputs(&history, &patch, &titles)).unwrap_err(),
        MISMATCH
    );
    // A patch from another snapshot.
    let other = c::RetainedPatch {
        snapshot_id: "snap_b".into(),
        patch: text.into(),
    };
    assert_eq!(
        project::page("snap_a", &inputs(&history, &other, &titles)).unwrap_err(),
        MISMATCH
    );
    // A patch whose bytes do not match the kept digest.
    let changed = c::RetainedPatch {
        snapshot_id: "snap_a".into(),
        patch: format!("{text}+c\n"),
    };
    let page = project::page("snap_a", &inputs(&history, &changed, &titles)).unwrap();
    assert!(page.files.is_empty());
    assert_eq!(page.patch, "");
    assert!(page.diff_note.contains("does not match its saved digest"));
    // A target for another head.
    let mut moved = history.clone();
    moved.target.head_commit_id = "g".repeat(40);
    assert_eq!(
        project::page("snap_a", &inputs(&moved, &patch, &titles)).unwrap_err(),
        MISMATCH
    );
}

#[test]
fn the_page_contract_keeps_slots_and_refuses_other_versions() {
    let page: c::ChangesPage = serde_json::from_value(serde_json::json!({
        "version": 1, "scope": "retained-comparisons-only", "status": "available",
        "changes": [{ "snapshotId": "snap_x", "sequence": 4, "unavailable": true }],
        "next": null,
    }))
    .unwrap();
    assert!(matches!(page.changes[0], c::PageEntry::Slot(_)));
    let titles = Default::default();
    let local = Default::default();
    let list = project::list(
        &project::ListInputs {
            pages: std::slice::from_ref(&page),
            requests: &[],
            titles: &titles,
            local: &local,
            now: 1,
        },
        1,
    );
    assert_eq!(list.availability, ChangesAvailability::Available);
    assert_eq!(list.unreadable, 1);

    let mut v2 = page.clone();
    v2.version = 2;
    let list = project::list(
        &project::ListInputs {
            pages: &[v2],
            requests: &[],
            titles: &titles,
            local: &local,
            now: 1,
        },
        1,
    );
    assert_eq!(list.availability, ChangesAvailability::Unavailable);
    assert_eq!(list.reason, project::UNREADABLE);
}

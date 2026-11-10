//! Kept-change evidence, never activity-derived completion or implicit acceptance.
use crate::{
    changes_contract as c,
    model::{DoneBasis, DoneEntry, Evidence},
};

/// Project one source-qualified history. A label needs matching saved evidence.
/// The caller qualifies profile/project/currentness; this function checks exact targets.
pub(crate) fn result(h: &c::History, after: u64, through: u64) -> Option<(u64, DoneEntry)> {
    if !crate::changes_project::exact(&h.target.snapshot_id, h, None) {
        return None;
    }
    let in_window = |at: u64| at > after && at <= through;
    let head = &h.target.head_commit_id;
    let latest_review = h
        .reviews
        .records
        .iter()
        .filter(|r| {
            r.record.confirmed.targets.contains(&h.target)
                && r.record.created_at <= through
                && r.record.confirmed.disposition != c::Disposition::Comment
        })
        .max_by_key(|r| r.sequence);
    let accepted = latest_review.filter(|r| {
        r.record.confirmed.disposition == c::Disposition::Approve && in_window(r.record.created_at)
    });
    let landed = h
        .landing
        .records
        .iter()
        .filter(|r| {
            r.target == h.target
                && r.result.status == c::LandingStatus::Observed
                && r.result
                    .default_ref
                    .as_ref()
                    .is_some_and(|s| s.starts_with("refs/heads/") && s.len() > 11)
                && r.result
                    .integrated_commit_id
                    .as_ref()
                    .is_some_and(|s| !s.is_empty())
                && r.result.observed_at.is_some_and(in_window)
        })
        .max_by_key(|r| r.sequence);
    let reported = h
        .reported
        .claims
        .iter()
        .filter(|r| {
            h.reported.status == "reported" && r.commit == *head && in_window(r.recorded_at)
        })
        .max_by_key(|r| r.recorded_at);
    let (at, basis, text) = if let Some(r) = accepted {
        (
            r.record.created_at,
            DoneBasis::Accepted,
            "Human approved this exact snapshot",
        )
    } else if let Some(r) = landed {
        (
            r.result.observed_at?,
            DoneBasis::Landed,
            "Pilot observed this exact change on the default branch",
        )
    } else {
        let r = reported?;
        (
            r.recorded_at,
            DoneBasis::Reported,
            "Agent reported this exact commit done",
        )
    };
    Some((
        at,
        DoneEntry {
            id: h.target.snapshot_id.clone(),
            text: text.into(),
            mission_title: String::new(),
            evidence: vec![Evidence {
                label: format!("Snapshot {} · commit {}", h.target.snapshot_id, head),
                ..Evidence::default()
            }],
            basis,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn sample_history(snapshot: &str, patch: &str) -> c::History {
        let target = serde_json::json!({
            "projectId": "p", "sessionId": "s", "snapshotId": snapshot, "repositoryId": "r",
            "changeId": "chg", "baseCommitId": "b".repeat(40), "headCommitId": "h".repeat(40),
            "layer": "layer", "diffSha256": crate::changes_project::sha256(patch), "comparisonDigest": "d",
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
            "changes": [], "diff": { "sha256": crate::changes_project::sha256(patch), "bytes": patch.len() },
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

    fn reported(h: &mut c::History) {
        h.reported.status = "reported".into();
        h.reported.claims.push(c::ReportedClaim {
            task_id: "task-a".into(),
            commit: h.target.head_commit_id.clone(),
            recorded_at: 10,
        });
    }
    fn review(h: &mut c::History, sequence: u64, disposition: c::Disposition) {
        h.reviews.records.push(c::ReviewEntry {
            sequence,
            record: c::ReviewRecord {
                id: format!("review-{sequence}"),
                operation_id: format!("operation-{sequence}"),
                created_at: 20 + sequence,
                confirmed: c::Confirmed {
                    targets: vec![h.target.clone()],
                    disposition,
                    body: "".into(),
                },
            },
        });
    }
    #[test]
    fn reported_requires_exact_claim_not_capture_activity_or_movement() {
        let mut h = sample_history("snapshot-a", "");
        assert!(result(&h, 0, 100).is_none(), "capture is not completion");
        reported(&mut h);
        assert_eq!(result(&h, 0, 100).unwrap().1.basis, DoneBasis::Reported);
        h.reported.claims[0].commit = "another-commit".into();
        assert!(result(&h, 0, 100).is_none());
        h.reported.claims[0].commit = h.target.head_commit_id.clone();
        h.reported.status = "unavailable".into();
        assert!(
            result(&h, 0, 100).is_none(),
            "claims behind unavailable status are not read"
        );
    }
    #[test]
    fn acceptance_is_human_exact_target_not_landing_or_another_snapshot() {
        let mut h = sample_history("snapshot-a", "");
        review(&mut h, 1, c::Disposition::Approve);
        assert_eq!(
            result(&h, 0, 100).unwrap().1.basis,
            DoneBasis::Accepted,
            "approval works without any reported claim"
        );
        h.reviews.records[0].record.confirmed.targets[0].head_commit_id = "other-head".into();
        assert!(result(&h, 0, 100).is_none());
        h.reviews.records[0].record.confirmed.targets[0] = h.target.clone();
        review(&mut h, 2, c::Disposition::RequestChanges);
        assert!(
            result(&h, 0, 100).is_none(),
            "a later changes request does not read as accepted"
        );
        h.target.snapshot_id = "other-snapshot".into();
        assert!(
            result(&h, 0, 100).is_none(),
            "mismatched history is refused"
        );
    }
    #[test]
    fn observed_landing_needs_the_exact_target_and_read_window() {
        let mut h = sample_history("snapshot-a", "");
        let target = json!({"projectId":"p", "sessionId":"s", "snapshotId":"snapshot-a", "repositoryId":"r", "changeId":"chg", "baseCommitId":"b".repeat(40), "headCommitId":"h".repeat(40), "layer":"layer", "diffSha256":crate::changes_project::sha256(""), "comparisonDigest":"d"});
        h.landing.records.push(serde_json::from_value(json!({ "observationId":"obs-a", "sequence":1, "target":target, "recordedAt":30, "result":{"status":"observed", "observedAt":30, "defaultRef":"refs/heads/main", "integratedCommitId":"i".repeat(40), "producer":{"kind":"default-branch"}} })).unwrap());
        assert_eq!(result(&h, 0, 100).unwrap().1.basis, DoneBasis::Landed);
        assert!(
            result(&h, 30, 100).is_none(),
            "previously seen events are not since-last-look results"
        );
        assert!(
            result(&h, 0, 29).is_none(),
            "future event is not current evidence"
        );
        h.landing.records[0].target.snapshot_id = "snapshot-b".into();
        assert!(result(&h, 0, 100).is_none());
        h.landing.records[0].target = h.target.clone();
        h.landing.records[0].result.status = c::LandingStatus::Unknown;
        assert!(
            result(&h, 0, 100).is_none(),
            "unknown landing is not Reported or Accepted"
        );
    }
}

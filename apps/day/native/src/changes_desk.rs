//! The rules for Changes on mock data. Rust owns every review request and
//! every state change; the screens send intents and show what this
//! publishes. The world is built as the daemon's v1 contract JSON and read
//! through the same mirrors and projection a native host would use.
//!
//! These are mock rules for the screens and their tests. The daemon's
//! retained-review and review-request services are the authority in
//! production; a trusted native host binds them behind the same read model.
//! Later and Bring back use the existing revision-checked review request
//! snooze and resume; they never approve, review or resume work.

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::{
    changes::{
        AttentionAsk, AttentionIntent, ChangeList, ChangePage, ChangeRef, ChangesScenario,
        FileStatus,
    },
    changes_contract as c,
    changes_project::{self as project, ChangeLocal, ListInputs, PageInputs, sha256},
    fixture::NOW,
    model::{Delivery, IntentOutcome, OutcomeStatus},
};

const MINUTE: u64 = 60_000;
/// Kept changes per page, as the daemon reads them.
pub const PAGE: usize = 20;
const REPOSITORY: &str = "repo_pilot";
const PROJECT: &str = "proj_pilot";

/// The words when an earlier Later or Bring back is not confirmed.
const UNSETTLED: &str =
    "An earlier request is not confirmed. Pilot checks it before it sends anything else.";
/// The words when the request shown changed.
const CHANGED: &str =
    "This review request changed since you read it. Nothing was sent. Read it again.";

/// One kept snapshot, as contract values.
#[derive(Debug, Clone)]
struct Kept {
    comparison: c::Comparison,
    target: c::Target,
    snapshot: c::Snapshot,
    landings: Vec<c::LandingRecord>,
    reviews: Vec<c::ReviewEntry>,
    reported: c::Reported,
    patch: Result<c::RetainedPatch, String>,
    /// Its source could not be qualified at the read: a slot, never empty.
    unreadable: bool,
}

/// One review request, as the service keeps it.
#[derive(Debug, Clone)]
struct Request {
    request_id: String,
    sequence: u64,
    snapshot_id: String,
    state: c::RequestState,
    revision: u32,
    operation_id: String,
    updated_at: u64,
    title: String,
}

/// What one mock kept change looks like.
#[derive(Debug, Clone, Default)]
struct Spec<'a> {
    key: &'a str,
    change: &'a str,
    session: &'a str,
    captured: u64,
    status: &'a str,
    source: &'a str,
    patch: Option<String>,
    omissions: &'a [&'a str],
    /// (status, minutes ago).
    landings: &'a [(&'a str, u64)],
    /// (disposition, body, minutes ago).
    reviews: &'a [(&'a str, &'a str, u64)],
    /// (state, revision, title, minutes ago).
    request: Option<(&'a str, u32, &'a str, u64)>,
    reported: &'a [(&'a str, u64)],
    unreadable: bool,
}

fn hex(seed: &str) -> String {
    sha256(seed)
}

fn read<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("mock world matches the v1 contract")
}

fn request_state(state: &str) -> c::RequestState {
    read(json!(state))
}

/// The manifest letter of a parsed file.
fn letter(status: FileStatus) -> &'static str {
    match status {
        FileStatus::Added => "A",
        FileStatus::Deleted => "D",
        FileStatus::Renamed => "R088",
        FileStatus::Modified | FileStatus::Mode => "M",
    }
}

struct Builder {
    kept: Vec<Kept>,
    requests: Vec<Request>,
    landing_sequence: u64,
    review_sequence: u64,
}

impl Builder {
    fn new() -> Self {
        Builder {
            kept: Vec::new(),
            requests: Vec::new(),
            landing_sequence: 0,
            review_sequence: 0,
        }
    }

    fn add(&mut self, spec: &Spec<'_>) {
        let sequence = self.kept.len() as u64 + 1;
        let snapshot_id = format!("snap_{}", &hex(&format!("snapshot {}", spec.key))[..20]);
        let base = hex(&format!("base {}", spec.key))[..40].to_owned();
        let head = hex(&format!("head {}", spec.key))[..40].to_owned();
        let captured_at = NOW - spec.captured * MINUTE;
        let source = if spec.source.is_empty() {
            "committed"
        } else {
            spec.source
        };
        let request = json!({
            "requestId": format!("cmp_{}", &hex(&format!("comparison {}", spec.key))[..16]),
            "repositoryId": REPOSITORY,
            "changeId": spec.change,
            "operationId": format!("op_{}", &hex(&format!("capture {}", spec.key))[..16]),
            "base": { "changeId": "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "commitId": base },
            "head": { "changeId": spec.change, "commitId": head },
            "scope": { "kind": "layer" },
            "source": source,
        });
        let files = spec
            .patch
            .as_deref()
            .map(project::parse_patch)
            .unwrap_or_default();
        let changes: Vec<Value> = files
            .iter()
            .map(|f| {
                let before = match f.status {
                    FileStatus::Added => Value::Null,
                    FileStatus::Renamed => json!(f.old_name),
                    _ => json!(f.name),
                };
                let after = if f.status == FileStatus::Deleted {
                    Value::Null
                } else {
                    json!(f.name)
                };
                json!({
                    "status": letter(f.status), "beforePath": before, "afterPath": after,
                    "beforeMode": "100644", "afterMode": "100644",
                    "beforeOid": hex(&format!("before {}", f.name))[..40],
                    "afterOid": hex(&format!("after {}", f.name))[..40],
                })
            })
            .collect();
        let sources = |before: bool| -> Vec<Value> {
            files
                .iter()
                .filter(|f| {
                    if before {
                        f.status != FileStatus::Added
                    } else {
                        f.status != FileStatus::Deleted
                    }
                })
                .map(|f| {
                    json!({
                        "path": if before && f.status == FileStatus::Renamed { &f.old_name } else { &f.name },
                        "mode": "100644", "gitOid": hex(&f.name)[..40],
                        "state": if f.binary { "binary" } else { "text" },
                        "sha256": hex(&format!("blob {}", f.name)), "bytes": 100,
                    })
                })
                .collect()
        };
        let diff = spec
            .patch
            .as_ref()
            .map(|p| json!({ "sha256": sha256(p), "bytes": p.len() }));
        let comparison: c::Comparison = read(json!({
            "snapshotId": snapshot_id, "sequence": sequence, "capturedAt": captured_at,
            "request": request, "status": spec.status,
        }));
        let target_json = json!({
            "projectId": PROJECT, "sessionId": spec.session, "snapshotId": snapshot_id,
            "repositoryId": REPOSITORY, "changeId": spec.change,
            "baseCommitId": base, "headCommitId": head, "layer": "layer",
            "diffSha256": diff.as_ref().map_or_else(String::new, |_| sha256(spec.patch.as_deref().unwrap_or(""))),
            "comparisonDigest": hex(&format!("digest {snapshot_id}")),
        });
        let target: c::Target = read(target_json.clone());
        let snapshot: c::Snapshot = read(json!({
            "snapshotId": snapshot_id, "request": request, "workerId": spec.session,
            "status": spec.status, "capturedAt": captured_at, "enrollmentTaskIds": [],
            "creation": { "changeId": spec.change, "commitId": head, "operationId": "op_create", "kind": "describe" },
            "omissions": spec.omissions, "before": sources(true), "after": sources(false),
            "changes": changes, "diff": diff,
        }));
        let landings = spec
            .landings
            .iter()
            .map(|(status, ago)| {
                self.landing_sequence += 1;
                let at = NOW - ago * MINUTE;
                let result = if *status == "unknown" {
                    json!({ "status": "unknown", "reason": "GitHub did not answer in time." })
                } else {
                    json!({
                        "status": status, "observedAt": at, "repository": "github.com/babariviere/pilot",
                        "defaultRef": "refs/heads/main",
                        "targetCommitId": hex(&format!("main {ago}"))[..40],
                        "integratedCommitId": head,
                        "producer": { "kind": "default-branch-containment" },
                    })
                };
                read(json!({
                    "observationId": format!("obs_{}", &hex(&format!("obs {} {ago}", spec.key))[..16]),
                    "sequence": self.landing_sequence, "target": target_json, "recordedAt": at,
                    "result": result,
                }))
            })
            .collect();
        let reviews = spec
            .reviews
            .iter()
            .map(|(disposition, body, ago)| {
                self.review_sequence += 1;
                read(json!({
                    "sequence": self.review_sequence,
                    "record": {
                        "id": format!("hrv_{}", &hex(&format!("review {} {ago}", spec.key))[..16]),
                        "operationId": format!("op_{}", &hex(&format!("review op {} {ago}", spec.key))[..16]),
                        "createdAt": NOW - ago * MINUTE,
                        "confirmed": {
                            "purpose": "review-disposition", "targets": [target_json],
                            "disposition": disposition, "body": body,
                            "expectedPriorRecordId": null, "packageDigest": hex(body),
                        },
                        "author": { "origin": "native-user", "assurance": "practical-native-action", "producerId": "pilot-app" },
                    },
                }))
            })
            .collect();
        let reported = if spec.reported.is_empty() {
            read(
                json!({ "status": "unavailable", "reason": "Exact completion claim producer unavailable" }),
            )
        } else {
            read(json!({
                "status": "reported",
                "claims": spec.reported.iter().map(|(task, ago)| json!({
                    "taskId": task, "commit": head, "recordedAt": NOW - ago * MINUTE,
                })).collect::<Vec<_>>(),
            }))
        };
        let patch = match &spec.patch {
            Some(p) => Ok(read(json!({ "snapshotId": snapshot_id, "patch": p }))),
            None => Err("No retained patch".to_owned()),
        };
        if let Some((state, revision, title, ago)) = spec.request {
            self.requests.push(Request {
                request_id: format!("rrq_{}", &hex(&format!("request {}", spec.key))[..16]),
                sequence: self.requests.len() as u64 + 1,
                snapshot_id: snapshot_id.clone(),
                state: request_state(state),
                revision,
                operation_id: format!("op_{}", &hex(&format!("request op {}", spec.key))[..16]),
                updated_at: NOW - ago * MINUTE,
                title: title.to_owned(),
            });
        }
        self.kept.push(Kept {
            comparison,
            target,
            snapshot,
            landings,
            reviews,
            reported,
            patch,
            unreadable: spec.unreadable,
        });
    }
}

const HISTORY_OLD: &str = "diff --git a/apps/desktop/src/history.rs b/apps/desktop/src/history.rs
index 3f2a1c0..77aa001 100644
--- a/apps/desktop/src/history.rs
+++ b/apps/desktop/src/history.rs
@@ -40,5 +40,6 @@ impl History {
     pub fn prepend(&mut self, older: Vec<Row>) {
         self.rows.splice(0..0, older);
+        self.loaded_older = true;
         self.scroll_to_tail();
     }
\x20
";

const HISTORY_NEW: &str = "diff --git a/apps/desktop/src/history.rs b/apps/desktop/src/history.rs
index 3f2a1c0..9b8e7d1 100644
--- a/apps/desktop/src/history.rs
+++ b/apps/desktop/src/history.rs
@@ -40,6 +40,11 @@ impl History {
     pub fn prepend(&mut self, older: Vec<Row>) {
-        self.rows.splice(0..0, older);
-        self.scroll_to_tail();
+        let anchor = self.visible_anchor();
+        self.rows.splice(0..0, older);
+        if let Some(anchor) = anchor {
+            self.restore(anchor);
+        } else {
+            self.scroll_to_tail();
+        }
     }
\x20
     fn visible_anchor(&self) -> Option<Anchor> {
diff --git a/apps/desktop/src/history_tests.rs b/apps/desktop/src/history_tests.rs
new file mode 100644
index 0000000..5d1c2aa
--- /dev/null
+++ b/apps/desktop/src/history_tests.rs
@@ -0,0 +1,6 @@
+#[test]
+fn prepend_keeps_the_reading_position() {
+    let mut history = History::with_rows(80);
+    history.prepend(rows(20));
+    assert_eq!(history.anchor(), Some(Anchor::row(40)));
+}
";

const NOTIFY: &str = "diff --git a/packages/daemon/src/notify.ts b/packages/daemon/src/notify.ts
index 1a2b3c4..5d6e7f8 100644
--- a/packages/daemon/src/notify.ts
+++ b/packages/daemon/src/notify.ts
@@ -12,2 +12,5 @@ export function shouldNotify(event: Event): boolean {
-\treturn true;
+\tif (event.kind === \"question\" || event.kind === \"failure\") return true;
+\treturn false;
 }
+
+export const SUMMARY_AT = \"18:00\";
";

const SEARCH: &str =
    "diff --git a/packages/daemon/src/search-index.ts b/packages/daemon/src/search/warm.ts
similarity index 88%
rename from packages/daemon/src/search-index.ts
rename to packages/daemon/src/search/warm.ts
index 0a0a0a0..1b1b1b1 100644
--- a/packages/daemon/src/search-index.ts
+++ b/packages/daemon/src/search/warm.ts
@@ -1,4 +1,4 @@
-export async function warmIndex(root: string) {
+export async function warm(root: string) {
 \tconst files = await list(root);
 \tawait Promise.all(files.map(index));
 }
";

const DOCS: &str = "diff --git a/docs/README.md b/docs/README.md
index 2222222..3333333 100644
--- a/docs/README.md
+++ b/docs/README.md
@@ -1,3 +1,4 @@
 # Pilot
\x20
-Pilot runs background agents.
+Pilot runs background agents on durable sessions.
+See Day for what needs you today.
diff --git a/docs/day.png b/docs/day.png
new file mode 100644
index 0000000..4444444
Binary files /dev/null and b/docs/day.png differ
";

const SHELL: &str = "diff --git a/scripts/bootstrap.sh b/scripts/bootstrap.sh
old mode 100644
new mode 100755
";

/// The review world: kept changes in every state the list shows.
fn review_world(b: &mut Builder) {
    b.add(&Spec {
        key: "unreadable",
        change: "qqqqrstuvwxyzqqq",
        session: "chat_old",
        captured: 4000,
        status: "complete",
        patch: Some(SHELL.into()),
        unreadable: true,
        ..Spec::default()
    });
    b.add(&Spec {
        key: "shell",
        change: "kmnoprstkmnoprst",
        session: "chat_shell",
        captured: 4400,
        status: "complete",
        patch: Some(SHELL.into()),
        landings: &[("observed", 4300), ("unknown", 120)],
        ..Spec::default()
    });
    b.add(&Spec {
        key: "history-1",
        change: "wvxyzlmnwvxyzlmn",
        session: "chat_history",
        captured: 1600,
        status: "complete",
        patch: Some(HISTORY_OLD.into()),
        reviews: &[(
            "request_changes",
            "The reading position still jumps when older messages arrive. Keep it put.",
            1500,
        )],
        request: Some(("replaced", 2, "Review: History slice", 50)),
        ..Spec::default()
    });
    b.add(&Spec {
        key: "notify",
        change: "plqrstuvplqrstuv",
        session: "chat_notify",
        captured: 420,
        status: "complete",
        patch: Some(NOTIFY.into()),
        reviews: &[("approve", "Looks right. One summary at 18:00.", 300)],
        landings: &[("observed", 200)],
        request: Some(("retired", 3, "Review: Quieter notifications", 290)),
        reported: &[("#4", 250)],
        ..Spec::default()
    });
    b.add(&Spec {
        key: "docs",
        change: "ytsrqponytsrqpon",
        session: "chat_docs",
        captured: 90,
        status: "partial",
        patch: Some(DOCS.into()),
        omissions: &["2 images over 1 MiB were not kept."],
        request: Some(("pending", 1, "Review: Docs refresh", 85)),
        ..Spec::default()
    });
    b.add(&Spec {
        key: "search",
        change: "nopqrstunopqrstu",
        session: "chat_search",
        captured: 180,
        status: "complete",
        patch: Some(SEARCH.into()),
        request: Some(("snoozed", 2, "Review: Search warm-up", 60)),
        ..Spec::default()
    });
    b.add(&Spec {
        key: "history-2",
        change: "wvxyzlmnwvxyzlmn",
        session: "chat_history",
        captured: 40,
        status: "complete",
        patch: Some(HISTORY_NEW.into()),
        request: Some(("pending", 1, "Review: History slice", 40)),
        ..Spec::default()
    });
}

/// Many kept changes, read 20 at a time, and one very long diff.
fn large_world(b: &mut Builder) {
    let long: String = std::iter::once(
        "diff --git a/apps/day/fixtures/long.ts b/apps/day/fixtures/long.ts\nnew file mode 100644\n--- /dev/null\n+++ b/apps/day/fixtures/long.ts\n@@ -0,0 +1,1200 @@\n".to_owned(),
    )
    .chain((1..=1200).map(|n| format!("+export const line{n} = {n};\n")))
    .collect();
    b.add(&Spec {
        key: "long",
        change: "lllllllllllllllll",
        session: "chat_long",
        captured: 3000,
        status: "complete",
        patch: Some(long),
        request: Some(("pending", 1, "Review: Long fixture", 2990)),
        ..Spec::default()
    });
    for n in 1..45u64 {
        let patch = format!(
            "diff --git a/src/file{n}.ts b/src/file{n}.ts\nindex 1111111..2222222 100644\n--- a/src/file{n}.ts\n+++ b/src/file{n}.ts\n@@ -1,1 +1,1 @@\n-export const value = {n};\n+export const value = {};\n",
            n + 1
        );
        let key = format!("large {n}");
        let change = format!("chg{n:013}");
        let landings: &[(&str, u64)] = if n % 3 == 0 { &[("observed", 30)] } else { &[] };
        b.add(&Spec {
            key: &key,
            change: &change,
            session: "chat_large",
            captured: 2900 - n * 60,
            status: "complete",
            patch: Some(patch),
            landings,
            ..Spec::default()
        });
    }
}

/// Changes on mock data: the kept snapshots, their review requests, and
/// the user's own Later and Bring back.
#[derive(Debug)]
pub struct ChangesDesk {
    kept: Vec<Kept>,
    requests: Vec<Request>,
    unavailable: Option<String>,
    capture: Option<c::CaptureStatus>,
    titles: HashMap<String, String>,
    now: u64,
    pages_read: usize,
    read_at: HashMap<String, u64>,
    local: HashMap<String, ChangeLocal>,
    /// The next Later or Bring back is applied but its answer is lost.
    lose_next: bool,
    /// Operations the service applied, by operation id, for lookups.
    applied: HashMap<String, String>,
    next_operation: u32,
    revision: u32,
    list: ChangeList,
}

impl ChangesDesk {
    /// A desk with the mock world of `scenario`.
    pub fn new(scenario: ChangesScenario) -> Self {
        let mut b = Builder::new();
        let mut unavailable = None;
        let mut capture = Some(c::CaptureStatus::default());
        match scenario {
            ChangesScenario::Review | ChangesScenario::Trouble => {
                review_world(&mut b);
                capture = Some(c::CaptureStatus {
                    pending: 1,
                    ..c::CaptureStatus::default()
                });
            }
            ChangesScenario::Large => large_world(&mut b),
            ChangesScenario::Empty => {}
            ChangesScenario::Unavailable => {
                capture = None;
                unavailable = Some(
                    "Not captured. No retained managed ownership binding for this chat. Reading does not enroll, capture or migrate existing work."
                        .to_owned(),
                );
            }
        }
        let titles = [
            ("chat_history", "History slice"),
            ("chat_notify", "Quieter notifications"),
            ("chat_docs", "Docs refresh"),
            ("chat_search", "Faster search"),
            ("chat_shell", "Tidy shell setup"),
            ("chat_long", "Long fixture"),
            ("chat_large", "Large refactor"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        let mut desk = ChangesDesk {
            kept: b.kept,
            requests: b.requests,
            unavailable,
            capture,
            titles,
            now: NOW,
            pages_read: 1,
            read_at: HashMap::new(),
            local: HashMap::new(),
            lose_next: scenario == ChangesScenario::Trouble,
            applied: HashMap::new(),
            next_operation: 0,
            revision: 0,
            list: ChangeList::default(),
        };
        desk.changed();
        desk
    }

    /// The list now.
    pub fn list(&self) -> &ChangeList {
        &self.list
    }

    fn changed(&mut self) {
        self.revision += 1;
        let pages = self.pages();
        let requests = self.request_entries();
        self.list = project::list(
            &ListInputs {
                pages: &pages,
                requests: &requests,
                titles: &self.titles,
                local: &self.local,
                now: self.now,
            },
            self.revision,
        );
    }

    fn outcome(&self, status: OutcomeStatus, message: &str) -> IntentOutcome {
        IntentOutcome {
            status,
            revision: self.revision,
            message: message.to_owned(),
        }
    }

    /// The v1 pages read so far, as the daemon sends them.
    fn pages(&self) -> Vec<c::ChangesPage> {
        self.pages_upto(self.pages_read)
    }

    /// The first `limit` v1 pages, as the daemon sends them.
    fn pages_upto(&self, limit: usize) -> Vec<c::ChangesPage> {
        if let Some(reason) = &self.unavailable {
            return vec![read(json!({
                "version": 1, "scope": "retained-comparisons-only", "status": "unavailable",
                "reason": reason, "changes": [], "next": null,
            }))];
        }
        let chunks: Vec<&[Kept]> = if self.kept.is_empty() {
            vec![&[]]
        } else {
            self.kept.chunks(PAGE).collect()
        };
        let total = chunks.len();
        chunks
            .into_iter()
            .take(limit)
            .enumerate()
            .map(|(at, chunk)| {
                let changes = chunk
                    .iter()
                    .map(|k| {
                        if k.unreadable {
                            return c::PageEntry::Slot(c::UnavailableSlot {
                                snapshot_id: k.comparison.snapshot_id.clone(),
                                sequence: k.comparison.sequence,
                                unavailable: true,
                            });
                        }
                        c::PageEntry::Row(Box::new(c::ChangeRow {
                            comparison: k.comparison.clone(),
                            target: k.target.clone(),
                            landing: k.landings.iter().max_by_key(|l| l.sequence).cloned(),
                            observed_landing: k
                                .landings
                                .iter()
                                .filter(|l| l.result.status == c::LandingStatus::Observed)
                                .max_by_key(|l| l.sequence)
                                .cloned(),
                        }))
                    })
                    .collect();
                c::ChangesPage {
                    version: 1,
                    scope: "retained-comparisons-only".into(),
                    status: "available".into(),
                    reason: None,
                    capture: self.capture.clone(),
                    changes,
                    next: (at + 1 < total)
                        .then(|| chunk.last().map_or(0, |k| k.comparison.sequence)),
                }
            })
            .collect()
    }

    fn request_entries(&self) -> Vec<c::RequestEntry> {
        self.requests
            .iter()
            .filter_map(|r| {
                let kept = self
                    .kept
                    .iter()
                    .find(|k| k.comparison.snapshot_id == r.snapshot_id)?;
                Some(c::RequestEntry::Row(Box::new(c::RequestRow {
                    request_id: r.request_id.clone(),
                    sequence: r.sequence,
                    state: r.state,
                    session_id: kept.target.session_id.clone(),
                    title: r.title.clone(),
                    comparison: kept.comparison.clone(),
                })))
            })
            .collect()
    }

    fn kept(&self, snapshot_id: &str) -> Option<&Kept> {
        self.kept
            .iter()
            .find(|k| k.comparison.snapshot_id == snapshot_id)
    }

    /// The v1 history of one snapshot, as the daemon sends it.
    fn history(&self, kept: &Kept) -> c::History {
        c::History {
            version: 1,
            comparison: kept.comparison.clone(),
            snapshot: kept.snapshot.clone(),
            target: kept.target.clone(),
            reported: kept.reported.clone(),
            landing: c::Paged {
                records: kept.landings.clone(),
                next: None,
            },
            reviews: c::Paged {
                records: kept.reviews.clone(),
                next: None,
            },
            attention: c::AttentionRecords {
                records: self
                    .requests
                    .iter()
                    .filter(|r| r.snapshot_id == kept.comparison.snapshot_id)
                    .map(|r| c::Attention {
                        request_id: r.request_id.clone(),
                        revision: r.revision,
                        state: r.state,
                        operation_id: r.operation_id.clone(),
                        updated_at: r.updated_at,
                    })
                    .collect(),
                complete: true,
            },
            approval: "not-evaluated".into(),
        }
    }

    /// One kept snapshot reopened, or why it cannot be shown. Null-like
    /// `Ok(None)` when it was not opened yet.
    pub fn page_result(&self, snapshot_id: &str) -> Result<Option<ChangePage>, String> {
        let Some(read_at) = self.read_at.get(snapshot_id).copied() else {
            return Ok(None);
        };
        let Some(kept) = self.kept(snapshot_id).filter(|k| !k.unreadable) else {
            return Err("Pilot could not read this kept change. Nothing is guessed.".into());
        };
        let history = self.history(kept);
        let pages = self.pages();
        let requests = self.request_entries();
        let row = pages.iter().flat_map(|p| &p.changes).find_map(|e| match e {
            c::PageEntry::Row(row) if row.comparison.snapshot_id == snapshot_id => {
                Some(row.as_ref())
            }
            _ => None,
        });
        // A newer snapshot may sit on a page not read yet; the service knows it.
        let all = self.pages_upto(usize::MAX);
        project::page(
            snapshot_id,
            &PageInputs {
                history: &history,
                patch: kept.patch.as_ref().map_err(Clone::clone),
                row,
                request: project::request_for(&requests, &kept.comparison),
                newer: project::newer(&all, &kept.comparison),
                titles: &self.titles,
                local: self.local.get(snapshot_id),
                now: self.now,
                read_at,
            },
        )
        .map(Some)
    }

    /// One kept snapshot reopened, or null when it was not opened or
    /// cannot be shown.
    pub fn page(&self, snapshot_id: &str) -> Option<ChangePage> {
        self.page_result(snapshot_id).ok().flatten()
    }

    /// Starts reading one kept snapshot.
    pub fn begin_open(&mut self, intent: &ChangeRef) -> Result<(), IntentOutcome> {
        match self.kept(&intent.snapshot_id) {
            None => Err(self.outcome(
                OutcomeStatus::Rejected,
                "Pilot has no kept change with this id here.",
            )),
            Some(k) if k.unreadable => Err(self.outcome(
                OutcomeStatus::Rejected,
                "Pilot could not read this kept change. Nothing is guessed.",
            )),
            Some(_) => Ok(()),
        }
    }

    /// Finishes reading one kept snapshot. Reading changes nothing.
    pub fn settle_open(&mut self, intent: &ChangeRef) -> IntentOutcome {
        self.read_at.insert(intent.snapshot_id.clone(), self.now);
        self.changed();
        match self.page_result(&intent.snapshot_id) {
            Ok(_) => self.outcome(OutcomeStatus::Accepted, ""),
            Err(message) => {
                self.read_at.remove(&intent.snapshot_id);
                self.changed();
                self.outcome(OutcomeStatus::Rejected, &message)
            }
        }
    }

    fn open_request(&self, snapshot_id: &str) -> Option<&Request> {
        self.requests
            .iter()
            .filter(|r| {
                r.snapshot_id == snapshot_id
                    && matches!(r.state, c::RequestState::Pending | c::RequestState::Snoozed)
            })
            .max_by_key(|r| r.sequence)
    }

    /// Starts a Later or Bring back named as the screen showed it. Records
    /// the operation before sending; a second send waits for this one.
    pub fn begin_attention(
        &mut self,
        intent: &AttentionIntent,
        ask: AttentionAsk,
    ) -> Result<String, IntentOutcome> {
        if !self.read_at.contains_key(&intent.snapshot_id) {
            return Err(self.outcome(
                OutcomeStatus::Rejected,
                "Open this change first. Nothing was sent.",
            ));
        }
        let local = self
            .local
            .get(&intent.snapshot_id)
            .cloned()
            .unwrap_or_default();
        if local.delivery != Delivery::Idle {
            return Err(self.outcome(OutcomeStatus::Rejected, UNSETTLED));
        }
        let wanted = match ask {
            AttentionAsk::Later => c::RequestState::Pending,
            AttentionAsk::BringBack => c::RequestState::Snoozed,
        };
        let fits = self.open_request(&intent.snapshot_id).is_some_and(|r| {
            r.request_id == intent.request_id && r.revision == intent.revision && r.state == wanted
        });
        if !fits {
            return Err(self.outcome(OutcomeStatus::Stale, CHANGED));
        }
        self.next_operation += 1;
        let operation = format!("op_attention_{}", self.next_operation);
        self.local.insert(
            intent.snapshot_id.clone(),
            ChangeLocal {
                delivery: Delivery::Sending,
                asked: Some(ask),
                operation: Some(operation.clone()),
            },
        );
        self.changed();
        Ok(operation)
    }

    /// The service applies a recorded Later or Bring back. When its answer
    /// is lost, the outcome is unknown and only a check can settle it.
    pub fn settle_attention(&mut self, snapshot_id: &str, operation: &str) -> IntentOutcome {
        let ask = self
            .local
            .get(snapshot_id)
            .and_then(|l| l.asked)
            .unwrap_or_default();
        let now = self.now;
        if let Some(request) = self
            .requests
            .iter_mut()
            .filter(|r| {
                r.snapshot_id == snapshot_id
                    && matches!(r.state, c::RequestState::Pending | c::RequestState::Snoozed)
            })
            .max_by_key(|r| r.sequence)
        {
            request.state = match ask {
                AttentionAsk::Later => c::RequestState::Snoozed,
                AttentionAsk::BringBack => c::RequestState::Pending,
            };
            request.revision += 1;
            request.operation_id = operation.to_owned();
            request.updated_at = now;
            self.applied
                .insert(operation.to_owned(), snapshot_id.to_owned());
        }
        if self.lose_next {
            self.lose_next = false;
            if let Some(local) = self.local.get_mut(snapshot_id) {
                local.delivery = Delivery::Unknown;
            }
            self.changed();
            return self.outcome(
                OutcomeStatus::Unknown,
                "Pilot sent it but heard nothing back. It sends nothing more until it checks.",
            );
        }
        self.local.remove(snapshot_id);
        self.changed();
        self.outcome(OutcomeStatus::Accepted, accepted(ask))
    }

    /// Starts a read of whether an unconfirmed Later or Bring back landed.
    pub fn begin_check(&mut self, intent: &ChangeRef) -> Result<String, IntentOutcome> {
        let local = self
            .local
            .get(&intent.snapshot_id)
            .cloned()
            .unwrap_or_default();
        match (local.delivery, local.operation) {
            (Delivery::Unknown, Some(operation)) => {
                if let Some(l) = self.local.get_mut(&intent.snapshot_id) {
                    l.delivery = Delivery::Checking;
                }
                self.changed();
                Ok(operation)
            }
            _ => Err(self.outcome(OutcomeStatus::Rejected, "There is nothing to check.")),
        }
    }

    /// Looks the recorded operation up. Never sends it again.
    pub fn settle_check(&mut self, snapshot_id: &str, operation: &str) -> IntentOutcome {
        let ask = self
            .local
            .get(snapshot_id)
            .and_then(|l| l.asked)
            .unwrap_or_default();
        self.local.remove(snapshot_id);
        self.changed();
        if self
            .applied
            .get(operation)
            .is_some_and(|s| s == snapshot_id)
        {
            let message = format!("It arrived. Nothing was sent again. {}", accepted(ask));
            self.outcome(OutcomeStatus::Accepted, &message)
        } else {
            self.outcome(
                OutcomeStatus::Rejected,
                "It did not arrive, and nothing was sent again. You can ask once more.",
            )
        }
    }

    /// Reads the next page of kept changes, if there is one.
    pub fn more(&mut self) -> IntentOutcome {
        if !self.list.more {
            return self.outcome(OutcomeStatus::Rejected, "Every kept change is read.");
        }
        self.pages_read += 1;
        self.changed();
        self.outcome(OutcomeStatus::Accepted, "")
    }
}

fn accepted(ask: AttentionAsk) -> &'static str {
    match ask {
        AttentionAsk::Later => "Put off. It still waits for your review; nothing was approved.",
        AttentionAsk::BringBack => "Back with the changes to review.",
    }
}

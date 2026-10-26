use super::*;
use serde_json::json;
pub(super) fn report() -> Value {
    json!({"base":"canonical-base","branch":"recorded/branch","files":[{"path":"src/日本語.rs","status":"modified","additions":1,"deletions":1}],"diff":"diff --git a/src/日本語.rs b/src/日本語.rs\n--- a/src/日本語.rs\n+++ b/src/日本語.rs\n@@ -1 +1 @@\n-old\n+new\n","truncated":false})
}
#[test]
fn exact_inventory_base_branch_and_literal_patch() {
    let s = Snapshot::parse(report()).unwrap();
    assert_eq!(s.base, "canonical-base");
    assert_eq!(s.branch.as_deref(), Some("recorded/branch"));
    assert!(!s.limited);
    assert!(s.files[0].patch.as_ref().unwrap().contains("+new"));
}
#[test]
fn malformed_counts_missing_flags_duplicate_paths_and_unknown_status_fail_closed() {
    for field in ["base", "files", "diff", "truncated"] {
        let mut v = report();
        v.as_object_mut().unwrap().remove(field);
        assert!(Snapshot::parse(v).is_err());
    }
    for (field, value) in [
        ("additions", json!(-1)),
        ("deletions", json!(1.5)),
        ("status", json!("future")),
    ] {
        let mut v = report();
        v["files"][0][field] = value;
        assert!(Snapshot::parse(v).is_err());
    }
    let mut v = report();
    let file = v["files"][0].clone();
    v["files"].as_array_mut().unwrap().push(file);
    assert!(Snapshot::parse(v).is_err());
}
#[test]
fn hostile_or_partial_patches_are_never_complete() {
    for patch in [
        "@@ -1 +1 @@\n+x\n",
        "diff --git a/x b/x\n--- a/src/日本語.rs\n+++ b/src/日本語.rs\n@@ -1,18446744073709551616 +1 @@\n+x\n",
        "diff --git a/x b/x\n--- a/src/日本語.rs\n+++ b/src/日本語.rs\n@@ -1 +1 @@\n+x\n",
        "Binary files a/x and b/x differ\n",
    ] {
        let mut v = report();
        v["diff"] = json!(patch);
        assert!(Snapshot::parse(v).unwrap().files[0].patch.is_none());
    }
    let mut v = report();
    v["diff"] = json!(report()["diff"].as_str().unwrap().repeat(2));
    assert!(Snapshot::parse(v).unwrap().files[0].patch.is_none());
}
#[test]
fn file_patch_render_and_empty_truncation_limits_are_truthful() {
    let mut v = report();
    v["files"]=json!((0..140).map(|i|json!({"path":format!("file-{i}"),"status":"untracked","additions":0,"deletions":0})).collect::<Vec<_>>());
    let s = Snapshot::parse(v).unwrap();
    assert_eq!(s.files.len(), 128);
    assert_eq!(s.total, 140);
    assert!(s.limited);
    let mut v = report();
    v["diff"] = json!("x".repeat(PATCH + 1));
    assert!(Snapshot::parse(v).unwrap().limited);
    let s = Snapshot::parse(json!({"base":"HEAD","files":[],"diff":"","truncated":true})).unwrap();
    assert!(s.limited);
    assert_eq!(display("a\n\u{202e}b"), "a\\u{a}\\u{202e}b");
    assert_eq!(preview(&"長".repeat(180)).chars().count(), 161);
}
#[test]
fn stale_completion_cannot_replace_new_request_and_error_retains_snapshot() {
    let mut state = State::default();
    let old = state.begin();
    let new = state.begin();
    assert!(!state.accept(old, Snapshot::parse(report())));
    assert!(state.busy);
    assert!(state.accept(new, Snapshot::parse(report())));
    let next = state.begin();
    assert!(state.accept(next, Err("offline")));
    assert!(state.snapshot.is_some());
    assert_eq!(state.error, Some("offline"));
}

#[test]
fn add_delete_rename_multiple_files_and_quoted_utf8_paths() {
    let files = json!([
        {"path":"new","status":"untracked","additions":1,"deletions":0},
        {"path":"gone","status":"deleted","additions":0,"deletions":1},
        {"path":"日本語.rs","previousPath":"old","status":"renamed","additions":1,"deletions":1}
    ]);
    let diff = concat!(
        "diff --git a/new b/new\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+added\n",
        "diff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n",
        "diff --git a/old b/quoted\n--- a/old\n+++ \"b/\\346\\227\\245\\346\\234\\254\\350\\252\\236.rs\"\n@@ -1 +1 @@\n-old\n+renamed\n"
    );
    let v = json!({"base":"BASE","files":files,"diff":diff,"truncated":false});
    let s = Snapshot::parse(v.clone()).unwrap();
    assert!(s.files.iter().all(|f| f.patch.is_some()));
    let mut wrong = v;
    wrong["files"][2]["previousPath"] = json!("not-old");
    assert!(Snapshot::parse(wrong).unwrap().files[2].patch.is_none());
    assert_eq!(path("\"b/\\377\"", "b/"), None);
    assert_eq!(path("\"b/\\999\"", "b/"), None);
    assert_eq!(
        display_patch("+new\n\tline\u{202e}"),
        "+new\n\tline\\u{202e}"
    );
}
#[test]
fn bounded_long_line_line_count_and_oversized_inventory() {
    for text in [
        format!(
            "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+{}\n",
            "x".repeat(1025)
        ),
        format!(
            "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +201 @@\n{}",
            "+x\n".repeat(201)
        ),
    ] {
        let mut limited = false;
        assert!(patches(&text, &mut limited).is_empty());
        assert!(limited);
    }
    let mut v = report();
    v["files"] = json!(
        (0..4097)
            .map(|i| json!({"path":i.to_string(),"status":"added","additions":0,"deletions":0}))
            .collect::<Vec<_>>()
    );
    assert!(Snapshot::parse(v).is_err());
}

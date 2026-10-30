use super::*;
use serde_json::json;

fn chat(id: &str, provider: &str, at: Value, percent: u64) -> Chat {
    local_model::chat(&json!({"id":id,"usage":{"subscription":{"provider":provider,"fetchedAt":at,"windows":[{"label":"5h","usedPercent":percent}]}}})).unwrap()
}

#[test]
fn newest_per_provider_uses_report_time_not_delivery_or_chat_activity() {
    let mut old = chat("old", "anthropic", json!(1_000), 90);
    old.archived = true; // Same Swift scope: a cached reading is not chat activity.
    let newest_chat = chat("new", "anthropic", json!(2_000), 0);
    let unknown_time = chat("unknown", "anthropic", Value::Null, 99);
    let codex = chat("codex", "openai", json!(1_500), 30);
    let rows = newest(&[newest_chat, codex, old, unknown_time]);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].provider, "Claude");
    assert_eq!(rows[0].windows[0].value, "0% used");
    assert_eq!(rows[0].windows[0].basis_points, 0);
    assert_eq!(rows[1].provider, "Codex");
    assert!(newest(&[]).is_empty());
}

#[test]
fn provider_identity_changes_do_not_relabel_or_fill_unknown_windows() {
    let before = chat("same-chat", "anthropic", json!(1_000), 90);
    let after = chat("same-chat", "openai", json!(2_000), 30);
    assert_eq!(newest(&[before])[0].provider, "Claude");
    let reports = newest(&[after]);
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].provider, "Codex");
    assert_eq!(reports[0].windows[0].value, "30% used");
    assert!(Snapshot::read(&json!({"fetchedAt":3000,"windows":[]})).is_none());
    let partial = Snapshot::read(&json!({"provider":"anthropic","fetchedAt":3000,
        "account":"private account text", "windows":[{"label":"5h","usedPercent":15},
        {"label":"Week"}]}))
    .unwrap();
    assert_eq!(partial.windows.len(), 1);
    assert_eq!(partial.windows[0].value, "15% used");
    assert!(!format!("{partial:?}").contains("private account"));
}

#[test]
fn unknown_stale_future_error_and_empty_are_not_fresh_or_zero() {
    let mut value = json!({"provider":"openai","fetchedAt":1_000,"windows":[],"error":"secret bearer credential"});
    let s = Snapshot::read(&value).unwrap();
    assert!(s.update_error);
    assert!(s.windows.is_empty());
    assert_eq!(s.freshness(601_001), "Not recent");
    assert_eq!(s.freshness(500), "Report time is in the future");
    assert_eq!(s.freshness(61_000), "Reported 1m ago");
    assert!(!format!("{s:?} {}", s.help()).contains("credential"));
    for at in [Value::Null, json!(-1), json!("1000"), json!(1e30)] {
        value["fetchedAt"] = at;
        assert_eq!(
            Snapshot::read(&value).unwrap().freshness(10),
            "Time unknown"
        );
    }
    value["provider"] = json!("future-provider");
    assert!(Snapshot::read(&value).is_none());
    assert!(Snapshot::read(&Value::Null).is_none());
}

#[test]
fn provider_windows_preserve_names_reset_and_extra_spend() {
    let s = Snapshot::read(&json!({"provider":"anthropic","windows":[
        {"label":"5h","usedPercent":105.2,"resetsAt":"2026-10-28T12:00:00Z"},
        {"label":"Week","usedPercent":0,"resetsAt":"bad"},
        {"label":"Extra [active] 46.17/200.00","usedPercent":23.1},
        {"label":"Model-specific","usedPercent":12.3},
        {"label":"bad","usedPercent":null},{"label":"negative","usedPercent":-1}
    ]}))
    .unwrap();
    assert_eq!(s.windows.len(), 4);
    assert_eq!(s.windows[0].value, "105% used");
    assert_eq!(s.windows[0].basis_points, 10_000);
    assert!(s.windows[0].warning);
    let reset = s.windows[0].resets_at.unwrap();
    assert!(s.windows[0].reset(reset - 1).starts_with("Resets "));
    assert_eq!(s.windows[0].reset(reset), "Reset passed · awaiting report");
    assert_eq!(s.windows[1].reset(reset), "Reset unknown");
    assert_eq!(s.windows[1].basis_points, 0);
    assert_eq!(s.windows[2].label, "Extra usage");
    assert_eq!(s.windows[2].value, "46.17/200.00");
    assert!(!s.windows[2].warning);
    assert_eq!(s.windows[3].label, "Model-specific");
}

#[test]
fn subscription_only_updates_change_chat_projection_and_replace_reports() {
    let before = chat("a", "anthropic", json!(1_000), 95);
    let after = chat("a", "anthropic", json!(2_000), 0);
    assert!(before != after, "subscription-only changes must reach Home");
    let rows = newest(&[after]);
    assert_eq!(rows[0].windows[0].value, "0% used");
    let failed = local_model::chat(&json!({"id":"a","usage":{"subscription":{"provider":"anthropic","fetchedAt":3_000,"error":"private error","windows":[]}}})).unwrap();
    let rows = newest(&[before, failed]);
    assert!(rows[0].update_error);
    assert!(
        rows[0].windows.is_empty(),
        "new unavailable snapshot must not masquerade as an old current limit"
    );
}

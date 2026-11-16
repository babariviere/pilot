//! Real service → native serialized host → bridge privacy controls and lookup-only recovery.
include!("support/intake_fixture.rs");
#[test]
fn privacy_controls_preserve_opt_ins_and_unknown_receipts_across_reopen() {
    let mut f = Fixture::with_daemon("day-diagnostics.ts");
    let b = f.bridge();
    let first = f.call(&b, "day.diagnosis.read", json!({}));
    let s = &first["value"]["snapshot"];
    assert_eq!(s["settings"]["remoteOperational"], false, "{first}");
    assert_eq!(s["settings"]["localFeatureUsage"], false);
    assert_eq!(f.stats("stats")["writes"], 0);
    let value = json!({"localDiagnostics":false,"localFeatureUsage":true,"remoteOperational":false,"productAnalytics":false});
    let request = json!({"binding":s["binding"],"action":"save","value":value});
    let saved = f.call(&b, "day.diagnosis.write", request.clone());
    assert_eq!(saved["value"]["outcome"]["state"], "accepted", "{saved}");
    assert_eq!(
        saved["value"]["snapshot"]["settings"]["localFeatureUsage"],
        true
    );
    assert_eq!(
        saved["value"]["snapshot"]["settings"]["remoteOperational"],
        false
    );
    assert_eq!(f.call(&b, "day.diagnosis.write", request)["error"], "stale");
    let fresh = f.call(&b, "day.diagnosis.read", json!({}));
    let s = &fresh["value"]["snapshot"];
    f.stats("lost");
    let unknown=f.call(&b,"day.diagnosis.write",json!({"binding":s["binding"],"action":"save","value":{"localDiagnostics":true,"localFeatureUsage":false,"remoteOperational":false,"productAnalytics":false}}));
    assert_eq!(unknown["value"]["outcome"]["state"], "pending", "{unknown}");
    let id = unknown["value"]["outcome"]["operationId"].clone();
    close(b);
    let b = f.bridge();
    let lookup = f.call(&b, "day.diagnosis.check", json!({"operationId":id}));
    assert_eq!(lookup["value"]["outcome"]["state"], "pending", "{lookup}");
    assert_eq!(f.stats("stats")["writes"], 2);
    assert_eq!(f.stats("stats")["sessions"], 0);
    let stopped = f.call(&b,"day.diagnosis.write",json!({"binding":"0".repeat(64),"action":"save","value":{"localDiagnostics":false,"localFeatureUsage":false,"remoteOperational":false,"productAnalytics":false}}));
    assert_eq!(
        stopped["value"]["outcome"]["state"], "accepted",
        "{stopped}"
    );
    assert_eq!(f.stats("stats")["writes"], 3);
    let old = f.call(&b, "day.diagnosis.check", json!({"operationId":id}));
    assert_eq!(old["value"]["outcome"]["state"], "pending", "{old}");
    assert_eq!(
        f.stats("stats")["writes"],
        3,
        "checking old unknown must not regrant"
    );
    close(b);
}
#[test]
fn native_refuses_secret_collector_paths_before_any_send() {
    let mut f = Fixture::with_daemon("day-diagnostics.ts");
    let b = f.bridge();
    let read = f.call(&b, "day.diagnosis.read", json!({}));
    let binding = &read["value"]["snapshot"]["binding"];
    for endpoint in [
        "https://collector.test/secret-key",
        "https://name:secret@collector.test",
        "https://collector.test/?key=secret",
    ] {
        let r=f.call(&b,"day.diagnosis.write",json!({"binding":binding,"action":"save","value":{"localDiagnostics":true,"localFeatureUsage":false,"remoteOperational":true,"productAnalytics":false,"endpoint":endpoint}}));
        assert_eq!(r["error"], "invalid", "{r}");
    }
    assert_eq!(f.stats("stats")["writes"], 0);
    close(b);
}

//! Real daemon → serialized native host → released JSON bridge, with a fake provider catalogue.
include!("support/intake_fixture.rs");

#[test]
fn native_settings_keep_exact_ack_and_unknown_is_lookup_only_across_reopen() {
    let mut f = Fixture::with_daemon("day/day-model-controls.ts");
    let b = f.bridge();
    let first = f.call(&b, "day.models.read", json!({}));
    let s = &first["value"]["snapshot"];
    assert_eq!(
        s["task"]["resolvedDefaultModel"], "fixture/small",
        "{first}"
    );
    assert_eq!(f.stats("stats")["writes"], 0);
    let mut defaults = s["defaults"].clone();
    defaults["defaultThinkingLevel"] = json!("high");
    let request = json!({"binding":s["binding"],"action":"defaults","value":defaults});
    let saved = f.call(&b, "day.models.write", request.clone());
    assert_eq!(saved["value"]["outcome"]["state"], "accepted", "{saved}");
    assert_eq!(f.stats("stats")["writes"], 1);
    assert_eq!(f.call(&b, "day.models.write", request)["error"], "stale");
    let fresh = f.call(&b, "day.models.read", json!({}));
    let s = &fresh["value"]["snapshot"];
    let mut defaults = s["defaults"].clone();
    defaults["defaultThinkingLevel"] = json!("low");
    f.stats("lost");
    let unknown = f.call(
        &b,
        "day.models.write",
        json!({"binding":s["binding"],"action":"defaults","value":defaults}),
    );
    assert_eq!(unknown["value"]["outcome"]["state"], "pending", "{unknown}");
    let id = unknown["value"]["outcome"]["operationId"].clone();
    let after = f.call(&b, "day.models.read", json!({}));
    assert_eq!(
        after["value"]["snapshot"]["defaults"]["defaultThinkingLevel"],
        "low"
    );
    assert_eq!(
        after["value"]["operations"].as_array().unwrap().len(),
        1,
        "GET is not an acknowledgement"
    );
    close(b);
    let b = f.bridge();
    let lookup = f.call(&b, "day.models.check", json!({"operationId":id}));
    assert_eq!(lookup["value"]["outcome"]["state"], "pending", "{lookup}");
    let stats = f.stats("stats");
    assert_eq!(stats["writes"], 2);
    assert_eq!(stats["sessions"], 0);
    assert_eq!(stats["settings"]["extensions"], json!(["keep"]));
    close(b);
}

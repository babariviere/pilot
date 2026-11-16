//! Released native JSON bridge and actual daemon storage, with fake MCP probes only.
include!("support/intake_fixture.rs");

#[test]
fn connection_setup_is_additive_and_lost_ack_never_replays_after_reopen() {
    let mut f = Fixture::with_daemon("day-connections.ts");
    let b = f.bridge();
    let first = f.call(&b, "day.connections.read", json!({}));
    let s = &first["value"]["snapshot"];
    assert_eq!(
        s["setup"]["entries"][1]["blocked"], "advanced_configuration",
        "{first}"
    );
    assert!(!first.to_string().contains("private-"));
    assert_eq!(f.stats("stats")["probes"], 0);
    let request = json!({"binding":s["binding"],"action":"add","value":{"name":"new","config":{"url":"https://new.example/mcp"}}});
    let saved = f.call(&b, "day.connections.write", request.clone());
    assert_eq!(saved["value"]["outcome"]["state"], "accepted", "{saved}");
    assert_eq!(
        f.call(&b, "day.connections.write", request)["error"],
        "stale"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["writes"], 1);
    assert_eq!(stats["probes"], 1);
    assert_eq!(stats["config"]["extra"], "keep");
    assert_eq!(
        stats["config"]["mcpServers"]["advanced"]["env"]["TOKEN"],
        "private-token"
    );
    let fresh = f.call(&b, "day.connections.read", json!({}));
    f.stats("lost");
    let unknown = f.call(&b, "day.connections.write", json!({"binding":fresh["value"]["snapshot"]["binding"],"action":"add","value":{"name":"another","config":{"url":"https://other.example/mcp"}}}));
    assert_eq!(unknown["value"]["outcome"]["state"], "pending", "{unknown}");
    let id = unknown["value"]["outcome"]["operationId"].clone();
    close(b);
    let b = f.bridge();
    let r = f.call(&b, "day.connections.read", json!({}));
    assert_eq!(r["value"]["operations"].as_array().unwrap().len(), 1, "{r}");
    let r = f.call(&b, "day.connections.check", json!({"operationId":id}));
    assert_eq!(r["value"]["outcome"]["state"], "pending", "{r}");
    assert_eq!(f.stats("stats")["writes"], 2);
    close(b);
}

//! Released JSON bridge and real daemon/storage. No live Slack account or model.
include!("support/intake_fixture.rs");

#[test]
fn a_send_lost_before_daemon_admission_can_be_set_aside_without_sending_again() {
    let mut f = Fixture::with_daemon("day-slack-controls.ts");
    let b = f.bridge();
    let read = f.call(&b, "day.slack.read", json!({}));
    f.stats("drop");
    let lost = f.call(&b, "day.slack.write", json!({"binding":read["value"]["snapshot"]["binding"],"action":"import","value":{"url":"https://example.slack.com/archives/COTHER/p1794843000000001"}}));
    assert_eq!(lost["value"]["outcome"]["state"], "unknown", "{lost}");
    let id = lost["value"]["outcome"]["operationId"].clone();
    let aside = f.call(&b, "day.slack.setAside", json!({"operationId":id}));
    assert_eq!(aside["value"]["outcome"]["state"], "set-aside", "{aside}");
    assert!(aside["value"]["operations"].as_array().unwrap().is_empty());
    let saved = f.call(&b, "day.slack.write", json!({"binding":aside["value"]["snapshot"]["binding"],"action":"save","value":{"channels":[],"mentionOnly":[],"groups":[]}}));
    assert_eq!(saved["value"]["outcome"]["state"], "accepted", "{saved}");
    close(b);
    let b = f.bridge();
    assert!(
        f.call(&b, "day.slack.read", json!({}))["value"]["operations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let stats = f.stats("stats");
    assert_eq!(stats["imports"], 0);
    assert_eq!(stats["external"], 0);
    close(b);
}

#[test]
fn slack_tracking_and_independent_import_are_fenced_and_unknown_never_replays() {
    let mut f = Fixture::with_daemon("day-slack-controls.ts");
    let b = f.bridge();
    let first = f.call(&b, "day.slack.read", json!({}));
    let s = &first["value"]["snapshot"];
    assert_eq!(s["source"]["configured"], false, "{first}");
    assert_eq!(f.stats("stats")["imports"], 0);
    let save = json!({"binding":s["binding"],"action":"save","value":{"channels":["C123"],"mentionOnly":["C123"],"groups":["support"]}});
    let ack = f.call(&b, "day.slack.write", save.clone());
    assert_eq!(ack["value"]["outcome"]["state"], "accepted", "{ack}");
    assert_eq!(f.call(&b, "day.slack.write", save)["error"], "stale");
    let fresh = f.call(&b, "day.slack.read", json!({}));
    let off = f.call(&b, "day.slack.write", json!({"binding":fresh["value"]["snapshot"]["binding"],"action":"save","value":{"channels":[],"mentionOnly":[],"groups":[]}}));
    assert_eq!(off["value"]["outcome"]["state"], "accepted", "{off}");
    let binding = off["value"]["snapshot"]["binding"].clone();
    let bad = f.call(&b, "day.slack.write", json!({"binding":binding,"action":"import","value":{"url":"https://example.slack.com/archives/COTHER/p1794843000000001?token=secret"}}));
    assert_eq!(bad["error"], "invalid");
    assert!(
        !std::fs::read_to_string(f.info["ledger"].as_str().unwrap())
            .unwrap()
            .contains("secret")
    );
    f.stats("lost");
    let unknown = f.call(&b, "day.slack.write", json!({"binding":binding,"action":"import","value":{"url":"https://example.slack.com/archives/COTHER/p1794843000000001"}}));
    assert_eq!(unknown["value"]["outcome"]["state"], "pending", "{unknown}");
    let id = unknown["value"]["outcome"]["operationId"].clone();
    assert_eq!(f.stats("stats")["intake"][0]["total"], 1);
    close(b);
    let b = f.bridge();
    let read = f.call(&b, "day.slack.read", json!({}));
    assert_eq!(
        read["value"]["operations"].as_array().unwrap().len(),
        1,
        "{read}"
    );
    let lookup = f.call(&b, "day.slack.check", json!({"operationId":id}));
    assert_eq!(lookup["value"]["outcome"]["state"], "pending", "{lookup}");
    let aside = f.call(&b, "day.slack.setAside", json!({"operationId":id}));
    assert_eq!(aside["value"]["outcome"]["state"], "set-aside", "{aside}");
    assert!(aside["value"]["operations"].as_array().unwrap().is_empty());
    let unlocked = f.call(&b, "day.slack.write", json!({"binding":aside["value"]["snapshot"]["binding"],"action":"save","value":{"channels":[],"mentionOnly":[],"groups":[]}}));
    assert_eq!(
        unlocked["value"]["outcome"]["state"], "accepted",
        "{unlocked}"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["imports"], 1);
    assert_eq!(stats["external"], 0);
    assert_eq!(stats["tracking"]["linearTeam"], "FAKE");
    assert_eq!(stats["tracking"]["slackChannels"], json!([]));
    close(b);
    let b = f.bridge();
    assert!(
        f.call(&b, "day.slack.read", json!({}))["value"]["operations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        f.stats("stats")["imports"],
        1,
        "setting aside never retries an import, including on reopen"
    );
    close(b);
}

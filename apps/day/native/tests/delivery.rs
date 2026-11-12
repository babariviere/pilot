include!("support/intake_fixture.rs");

fn fixture() -> Fixture {
    Fixture::with_daemon("day-delivery.ts")
}
fn read_delivery(f: &Fixture, b: &Bridge, kind: &str) -> Value {
    let r = f.call(b, "day.delivery.read", f.info[kind].clone());
    assert!(r["value"]["snapshot"]["targetId"].is_string(), "{r}");
    r["value"]["snapshot"].clone()
}
fn args(v: &Value, note: &str) -> Value {
    json!({"subject":v["subject"],"targetId":v["targetId"],"deliveryId":v["deliveryId"],
        "expectedRevision":v["verificationRevision"],"ownerSessionId":v["ownerSessionId"],"note":note})
}
fn write(f: &Fixture, b: &Bridge, v: &Value, action: &str, note: &str) -> Value {
    f.call(b, &format!("day.delivery.{action}"), args(v, note))
}
fn checked(f: &Fixture, b: &Bridge, id: &Value) -> Value {
    f.call(b, "day.delivery.check", json!({"operationId":id}))
}
const NOTE: &str = "  Keep exact bytes 👩🏽‍💻\nThis is not deployed.  ";

#[test]
fn canonical_task_and_standalone_outputs_done_reopen_and_exact_durable_send_back() {
    let mut f = fixture();
    let b = f.bridge();
    let page = read_delivery(&f, &b, "task");
    assert_eq!(page["completion"]["commit"], "a".repeat(40));
    assert_eq!(page["artifacts"][0]["artifactId"], "fake-artifact");
    assert_eq!(page["pullRequests"][0]["pullRequest"]["state"], "merged");
    assert_eq!(page["production"], "not_tracked");
    assert_eq!(page["verificationCurrent"], false);
    assert_eq!(
        f.stats("stats")["posts"],
        0,
        "passive reads never assess work"
    );
    let done = write(&f, &b, &page, "done", "");
    assert_eq!(done["value"]["outcome"]["state"], "accepted", "{done}");
    let done_page = read_delivery(&f, &b, "task");
    assert_eq!(done_page["verification"]["state"], "done");
    assert_eq!(done_page["verificationReceiptState"], "accepted");
    assert_eq!(write(&f, &b, &page, "done", "")["error"], "stale");
    let reopened = write(&f, &b, &done_page, "reopen", "");
    assert_eq!(
        reopened["value"]["outcome"]["state"], "accepted",
        "{reopened}"
    );
    let open = read_delivery(&f, &b, "task");
    let back = write(&f, &b, &open, "sendBack", NOTE);
    let outcome = &back["value"]["outcome"];
    assert_eq!(outcome["state"], "accepted", "{back}");
    assert_eq!(outcome["note"], NOTE);
    assert_eq!(
        outcome["lookup"]["receipt"]["result"],
        outcome["lookup"]["verificationReceipt"]["verification"]
    );
    assert_eq!(
        outcome["lookup"]["receipt"]["result"]["messageReceipt"],
        json!({"sessionId":f.info["worker"],"requestId":outcome["operationId"],"state":"admitted"})
    );
    let standalone = read_delivery(&f, &b, "chat");
    assert_eq!(standalone["outcome"]["reason"], "Synthetic report");
    assert_eq!(
        write(&f, &b, &standalone, "done", "")["value"]["outcome"]["state"],
        "accepted"
    );
    f.stats("new-outcome");
    assert_eq!(read_delivery(&f, &b, "chat")["verificationCurrent"], false);
    let stats = f.stats("stats");
    assert_eq!(stats["messages"].as_array().unwrap().len(), 1);
    assert_eq!(stats["messages"][0]["content"], NOTE);
    assert_eq!(stats["external"], 0);
    assert_eq!(stats["sessions"], 2, "no substitute or model sessions");
    close(b);
}

#[test]
fn lost_ack_survives_capture_close_reopen_blocks_retarget_and_check_never_resends() {
    let mut f = fixture();
    let b = f.bridge();
    let page = read_delivery(&f, &b, "task");
    f.stats("lost");
    let lost = write(&f, &b, &page, "sendBack", NOTE);
    let op = lost["value"]["outcome"]["operationId"].clone();
    assert_eq!(lost["value"]["outcome"]["state"], "unknown", "{lost}");
    assert_eq!(
        write(&f, &b, &page, "sendBack", "changed")["error"],
        "unknown"
    );
    // A canonical GET already knows the domain/outer success. It still cannot
    // settle the native operation or authorize another send.
    assert_eq!(read_delivery(&f, &b, "task")["verificationCurrent"], true);
    let generation = b.request_flush().unwrap();
    let captured = f.call(
        &b,
        "day.flush.ack",
        json!({"generation":generation,"view":{
        "place":"today","id":"","update":false,"goal":"","focused":"","questions":[]}}),
    );
    assert!(captured["value"].is_object(), "{captured}");
    assert_eq!(checked(&f, &b, &op)["error"], "busy");
    close(b);
    f.stats("new-delivery");
    let host = f.host();
    assert_eq!(host.saved_window().unwrap().view["place"], "today");
    let b = Bridge::new(DayRoot::new(host));
    let read = f.call(&b, "day.delivery.read", f.info["task"].clone());
    assert!(
        read["value"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["operationId"] == op && r["state"] == "unknown" && r["note"] == NOTE)
    );
    let page = &read["value"]["snapshot"];
    assert_eq!(page["verificationCurrent"], false);
    assert_eq!(write(&f, &b, page, "done", "")["error"], "unknown");
    let settled = checked(&f, &b, &op);
    assert_eq!(
        settled["value"]["outcome"]["state"], "accepted",
        "{settled}"
    );
    assert_ne!(
        settled["value"]["outcome"]["deliveryId"], page["deliveryId"],
        "historical ACK never retargets"
    );
    checked(&f, &b, &op);
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 1);
    assert_eq!(stats["lookups"], 2);
    assert_eq!(stats["messages"].as_array().unwrap().len(), 1);
    close(b);
}

#[test]
fn stale_canonical_delivery_cas_and_unavailable_owner_never_restore_or_substitute() {
    let mut f = fixture();
    let b = f.bridge();
    let stale = read_delivery(&f, &b, "task");
    f.stats("new-delivery");
    assert_eq!(write(&f, &b, &stale, "done", "")["error"], "stale");
    assert_eq!(f.stats("stats")["posts"], 0);
    let page = read_delivery(&f, &b, "task");
    f.stats("race");
    let rejected = write(&f, &b, &page, "done", "");
    assert_eq!(
        rejected["value"]["outcome"]["state"], "rejected",
        "{rejected}"
    );
    let page = read_delivery(&f, &b, "task");
    f.stats("hold-owner");
    let unavailable = write(&f, &b, &page, "sendBack", NOTE);
    assert_eq!(
        unavailable["value"]["outcome"]["state"], "rejected",
        "{unavailable}"
    );
    assert_eq!(f.stats("stats")["messages"], json!([]));
    close(b);
}

#[test]
fn malformed_pairs_and_exact_message_owner_note_envelope_are_check_only() {
    for malformed in ["domain-only", "wrong-note", "wrong-envelope", "wrong-owner"] {
        let mut f = fixture();
        let b = f.bridge();
        let page = read_delivery(&f, &b, "task");
        f.stats(&format!("malformed:{malformed}"));
        let lost = write(&f, &b, &page, "sendBack", NOTE);
        let op = lost["value"]["outcome"]["operationId"].clone();
        assert_eq!(
            lost["value"]["outcome"]["state"], "unknown",
            "{malformed}: {lost}"
        );
        f.stats("corrupt-lookup");
        assert_eq!(checked(&f, &b, &op)["value"]["outcome"]["state"], "unknown");
        assert_eq!(write(&f, &b, &page, "done", "")["error"], "unknown");
        close(b);
        f.stats("valid-pair");
        let b = f.bridge();
        assert_eq!(
            checked(&f, &b, &op)["value"]["outcome"]["state"],
            "accepted"
        );
        let stats = f.stats("stats");
        assert_eq!(stats["posts"], 1);
        assert_eq!(stats["messages"].as_array().unwrap().len(), 1);
        close(b);
    }
}

#[test]
fn capability_permission_malformed_note_scope_and_close_are_fail_closed() {
    let mut f = fixture();
    let b = f.bridge();
    let page = read_delivery(&f, &b, "task");
    for (action, note) in [
        ("done", "forbidden"),
        ("reopen", "forbidden"),
        ("sendBack", " \n "),
    ] {
        assert_eq!(write(&f, &b, &page, action, note)["error"], "invalid");
    }
    assert_eq!(
        write(&f, &b, &page, "sendBack", &"🐦".repeat(2001))["error"],
        "invalid"
    );
    let mut wrong = args(&page, "");
    wrong["subject"]["projectId"] = json!("foreign");
    assert_eq!(f.call(&b, "day.delivery.done", wrong)["error"], "identity");
    let mut wrong = args(&page, "");
    wrong["ownerSessionId"] = json!("another");
    assert_eq!(f.call(&b, "day.delivery.done", wrong)["error"], "stale");
    let mut wrong = args(&page, "");
    wrong["operationId"] = json!("caller-supplied");
    assert_eq!(f.call(&b, "day.delivery.done", wrong)["error"], "invalid");
    f.stats("deny");
    assert_eq!(write(&f, &b, &page, "done", "")["error"], "unavailable");
    f.stats("allow");
    std::fs::write(
        f.dir.join("nsh.json"),
        json!({"name":"Denied","id":"test.denied","capabilities":{}}).to_string(),
    )
    .unwrap();
    assert!(write(&f, &b, &page, "done", "")["error"].is_string());
    assert_eq!(f.stats("stats")["posts"], 0);
    close(b);
}

#[test]
fn ack_save_failure_keeps_pair_but_requires_cold_lookup() {
    let mut f = fixture();
    let b = f.bridge();
    let page = read_delivery(&f, &b, "task");
    f.stats("fail-save");
    let result = write(&f, &b, &page, "done", "");
    let outcome = &result["value"]["outcome"];
    assert_eq!(outcome["state"], "unknown", "{result}");
    assert_eq!(outcome["receiptSaved"], false);
    assert_eq!(outcome["lookup"]["receipt"]["state"], "accepted");
    assert_eq!(b.close().recv_blocking().unwrap(), Err(Error::Storage));
    f.stats("restore-ledger");
    let b = f.bridge();
    assert_eq!(
        checked(&f, &b, &outcome["operationId"])["value"]["outcome"]["state"],
        "accepted"
    );
    assert_eq!(f.stats("stats")["posts"], 1);
    close(b);
}

#[test]
fn standalone_lost_ack_after_transport_port_change_checks_original_outcome_only() {
    let mut f = fixture();
    let b = f.bridge();
    let page = read_delivery(&f, &b, "chat");
    f.stats("lost");
    let lost = write(&f, &b, &page, "done", "");
    assert_eq!(lost["value"]["outcome"]["state"], "unknown", "{lost}");
    let op = lost["value"]["outcome"]["operationId"].clone();
    close(b);
    let moved = f.stats("move-port");
    assert_ne!(f.info["source"]["port"], moved["port"]);
    f.info["source"]["port"] = moved["port"].clone();
    f.stats("new-outcome");
    let b = f.bridge();
    let page = read_delivery(&f, &b, "chat");
    assert_eq!(page["verificationCurrent"], false);
    assert_eq!(write(&f, &b, &page, "done", "")["error"], "unknown");
    let result = checked(&f, &b, &op);
    assert_eq!(result["value"]["outcome"]["state"], "accepted", "{result}");
    assert_ne!(result["value"]["outcome"]["deliveryId"], page["deliveryId"]);
    assert_eq!(f.stats("stats")["posts"], 1);
    close(b);
}

#[test]
fn typed_ts_facade_uses_the_real_public_channel_without_node_sdk_imports() {
    let mut f = fixture();
    let b = f.bridge();
    let adapter = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../deliveryBridge.ts");
    let source = format!(
        r#"
import {{host,mount,signal,Text}} from 'nsh';
import {{readDelivery,assessDelivery,checkDelivery}} from {adapter};
const result=signal('waiting'); mount(()=> <Text>{{result()}}</Text>);
setTimeout(async()=>{{
  try {{
    const window=host.params.day.window;
    const read=await readDelivery(window,{subject});
    if(!read.ok || !read.snapshot) throw new Error('read refused');
    const done=await assessDelivery(window,read.snapshot,'done');
    if(!done.ok || !done.outcome) throw new Error('done refused');
    const checked=await checkDelivery(window,done.outcome.operationId);
    result.set('result:'+JSON.stringify({{read,done,checked}}));
  }} catch(e) {{ result.set('result:'+JSON.stringify({{error:String(e)}})); }}
}},0);"#,
        adapter = json!(adapter.to_str().unwrap()),
        subject = f.info["task"]
    );
    let r = f.eval(&b, &source);
    assert_eq!(r["read"]["snapshot"]["production"], "not_tracked", "{r}");
    assert_eq!(r["done"]["outcome"]["state"], "accepted", "{r}");
    assert_eq!(
        r["checked"]["outcome"]["operationId"],
        r["done"]["outcome"]["operationId"]
    );
    assert_eq!(f.stats("stats")["posts"], 1);
    close(b);
}

#[test]
fn checking_a_saved_terminal_receipt_rechecks_current_daemon_scope_access() {
    let mut f = fixture();
    let b = f.bridge();
    let page = read_delivery(&f, &b, "task");
    let done = write(&f, &b, &page, "done", "");
    let op = done["value"]["outcome"]["operationId"].clone();
    assert_eq!(done["value"]["outcome"]["state"], "accepted");
    f.stats("deny");
    assert_eq!(checked(&f, &b, &op)["error"], "unknown");
    f.stats("allow");
    assert_eq!(
        checked(&f, &b, &op)["value"]["outcome"]["state"],
        "accepted"
    );
    assert_eq!(
        f.stats("stats")["posts"],
        1,
        "permission recovery never executes again"
    );
    close(b);
}

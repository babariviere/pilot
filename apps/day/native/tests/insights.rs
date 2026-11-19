//! Released native bridge against a disposable daemon with no worker or provider.
include!("support/intake_fixture.rs");

fn insights_fixture() -> Fixture {
    let mut command = Command::new("node");
    command.current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/daemon"));
    let entry =
        std::env::temp_dir().join(format!("day-insights-entry-{}.mjs", uuid::Uuid::new_v4()));
    std::fs::write(&entry, r#"
        import { writeFile } from "node:fs/promises";
        import { join } from "node:path";
        import { createInterface } from "node:readline";
        import { once } from "node:events";
        import { pathToFileURL } from "node:url";
        const { seedDayInsightsTracking, startDayInsightsFixture } =
            await import(pathToFileURL(join(process.cwd(), "src/testing/day-insights.ts")).href);
        const { createDaemonServer } =
            await import(pathToFileURL(join(process.cwd(), "src/server.ts")).href);
        const f = await startDayInsightsFixture();
        let server;
        try {
            const { workspace } = await seedDayInsightsTracking(f);
            const { daemonId, lineageId } = f.host;
            const token = "a".repeat(64);
            const authority = f.server.services.dependencies.nativeAuthority;
            const authenticate = authority.authenticate;
            authority.authenticate = (v) => authenticate(v === token ? f.nativeToken : v);
            await writeFile(join(f.home, "daemon-id"), daemonId);
            await writeFile(join(f.home, "storage-lineage"), lineageId);
            await writeFile(join(f.home, "github-app-capability"),
                JSON.stringify({ daemonId, lineageId, token }), { mode: 0o600 });
            // Compose the existing workspace handler without an executor or scheduler.
            const services = f.server.services;
            let withholdSave = false;
            let uncertain;
            const day = services.dayInsights;
            const admit = day.admit.bind(day);
            const status = day.status.bind(day);
            day.admit = async (op, firstEntry) => {
                if (withholdSave && JSON.parse(op.payload).action === "save") {
                    uncertain = op.operationId;
                    throw new Error("Synthetic unsettled Save");
                }
                return admit(op, firstEntry);
            };
            day.status = async () => ({
                ...(await status()),
                ...(uncertain ? { uncertainOperationId: uncertain } : {}),
            });
            server = createDaemonServer({
                ...services,
                insightsWorkspace: workspace,
                admitOperation: (op, ...args) => op.kind === "insights-workspace-lifecycle"
                    ? workspace.admit(op) : services.admitOperation(op, ...args),
            });
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            console.log(JSON.stringify({
                source: { profile: f.home, port: server.address().port, home: { daemonId, lineageId } },
                ledger: join(f.home, "native.jsonl"),
            }));
            for await (const line of createInterface({ input: process.stdin })) {
                const { action } = JSON.parse(line);
                if (action === "quit") break;
                if (action === "withhold-save") withholdSave = true;
                console.log(JSON.stringify({ starts: f.starts() }));
            }
        } finally {
            process.stdin.destroy();
            if (server) {
                server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
            }
            await f.close();
        }
    "#).unwrap();
    command.arg(&entry);
    let fixture = Fixture::with_command(command);
    std::fs::remove_file(entry).unwrap();
    fixture
}

fn snapshot(f: &Fixture, bridge: &Bridge) -> Value {
    let reply = f.call(bridge, "day.insights.read", json!({}));
    assert!(reply["value"]["snapshot"]["binding"].is_string(), "{reply}");
    reply["value"]["snapshot"].clone()
}

fn prepare(f: &Fixture, bridge: &Bridge, scope: &Value, intent: Value) -> Value {
    let reply = f.call(
        bridge,
        "day.insights.prepare",
        json!({"binding":scope["binding"],"intent":intent}),
    );
    assert!(reply["value"]["snapshot"]["token"].is_string(), "{reply}");
    reply["value"]["snapshot"]["token"].clone()
}

fn confirm(f: &Fixture, bridge: &Bridge, token: &Value) -> Value {
    let reply = f.call(bridge, "day.insights.confirm", json!({"token":token}));
    assert_eq!(reply["value"]["outcome"]["state"], "accepted", "{reply}");
    assert_eq!(reply["value"]["pending"], json!([]), "{reply}");
    reply["value"]["snapshot"].clone()
}

#[test]
fn connected_insights_pause_allows_one_safety_stop_during_an_uncertain_save() {
    let mut f = insights_fixture();
    let bridge = Bridge::new(DayRoot::new(
        NativeHost::open(
            serde_json::from_value(f.info["source"].clone()).unwrap(),
            PathBuf::from(f.info["ledger"].as_str().unwrap()),
        )
        .unwrap(),
    ));
    let initial = snapshot(&f, &bridge);
    let project = initial["projects"][0]["id"].clone();
    let mut settings = json!({"projectId":project,"model":"synthetic/terra","sourceProjectIds":[project],
        "excludeSessionIds":[],"perReportUsd":0.5,"monthlyUsd":10,"schedule":null});
    let setup = prepare(
        &f,
        &bridge,
        &initial,
        json!({"action":"setup","settings":settings}),
    );
    let applied = confirm(&f, &bridge, &setup);
    f.stats("withhold-save");
    settings["perReportUsd"] = json!(0.6);
    let save = prepare(
        &f,
        &bridge,
        &applied,
        json!({"action":"save","settings":settings}),
    );
    let result = f.call(&bridge, "day.insights.confirm", json!({"token":save}));
    let v = &result["value"];
    assert_eq!(v["outcome"]["state"], "unknown", "{result}");
    assert_eq!(v["pending"].as_array().unwrap().len(), 1);
    let blocked = &v["snapshot"];
    assert_eq!(blocked["canPause"], true);
    assert_eq!(blocked["canRun"], false);
    assert_eq!(blocked["hold"]["kind"], "uncertain");
    let other = f.call(
        &bridge,
        "day.insights.prepare",
        json!({
            "binding":blocked["binding"],"intent":{"action":"apply","settings":settings}
        }),
    );
    assert_eq!(other["error"], "busy");
    let pause = prepare(&f, &bridge, blocked, json!({"action":"pause"}));
    let result = f.call(&bridge, "day.insights.confirm", json!({"token":pause}));
    assert_eq!(result["value"]["outcome"]["state"], "accepted", "{result}");
    assert_eq!(result["value"]["pending"], v["pending"]);
    let paused = &result["value"]["snapshot"];
    assert_eq!(paused["state"], "paused");
    assert_eq!(paused["canPause"], false);
    assert_eq!(paused["hold"]["kind"], "uncertain");
    assert_eq!(paused["applied"], applied["applied"]);
    assert_eq!(
        f.call(&bridge, "day.insights.confirm", json!({"token":pause}))["error"],
        "stale"
    );
    assert_eq!(f.stats("stats")["starts"], 0);
    close(bridge);
}

#[test]
fn connected_insights_applies_exact_settings_without_resuming_and_verifies_only_after_shipping() {
    let mut f = insights_fixture();
    let bridge = Bridge::new(DayRoot::new(
        NativeHost::open(
            serde_json::from_value(f.info["source"].clone()).unwrap(),
            PathBuf::from(f.info["ledger"].as_str().unwrap()),
        )
        .unwrap(),
    ));
    let initial = snapshot(&f, &bridge);
    let project = initial["projects"][0]["id"].clone();
    let catalogue = f.call(
        &bridge,
        "day.insights.models",
        json!({"binding":initial["binding"],"projectId":project}),
    );
    assert_eq!(
        catalogue["value"]["snapshot"]["models"][0]["id"], "synthetic/terra",
        "{catalogue}"
    );

    let mut settings = json!({"projectId":project,"model":"synthetic/terra","sourceProjectIds":[project],
        "excludeSessionIds":[],"perReportUsd":0.230001,"monthlyUsd":10,"schedule":null});
    let setup = prepare(
        &f,
        &bridge,
        &initial,
        json!({"action":"setup","settings":settings}),
    );
    assert!(
        snapshot(&f, &bridge)["applied"].is_null(),
        "preflight must not apply settings"
    );
    let configured = confirm(&f, &bridge, &setup);
    let pause = prepare(&f, &bridge, &configured, json!({"action":"pause"}));
    let paused = confirm(&f, &bridge, &pause);
    assert_eq!(paused["state"], "paused");
    assert_eq!(configured["draftBinding"], paused["draftBinding"]);

    settings["perReportUsd"] = json!(0.450017);
    settings["excludeSessionIds"] = json!(["synthetic-omitted"]);
    settings["schedule"] = json!({"weekday":5,"time":"13:20","timeZone":"UTC"});
    let apply = prepare(
        &f,
        &bridge,
        &paused,
        json!({"action":"apply","settings":settings}),
    );
    assert_eq!(snapshot(&f, &bridge)["applied"], paused["applied"]);
    assert_eq!(
        f.call(
            &bridge,
            "day.insights.confirm",
            json!({"token":apply,"settings":{"model":"not-reviewed"}})
        )["error"],
        "invalid"
    );
    let applied = confirm(&f, &bridge, &apply);
    assert_eq!(applied["state"], "paused");
    assert_eq!(applied["applied"], settings);
    assert_ne!(applied["draftBinding"], paused["draftBinding"]);
    assert_eq!(
        f.call(&bridge, "day.insights.confirm", json!({"token":apply}))["error"],
        "stale"
    );

    let finding = applied["findings"]["items"][0].clone();
    let key = &finding["key"];
    assert_eq!(finding["lifecycle"], "proposed", "{applied}");
    let early = f.call(&bridge, "day.insights.prepare", json!({
        "binding":applied["binding"],"intent":{"action":"verify","key":key,"revision":finding["revision"]}
    }));
    assert_eq!(early["error"], "stale");
    let ship = prepare(
        &f,
        &bridge,
        &applied,
        json!({"action":"ship","key":key,"revision":finding["revision"]}),
    );
    let shipped = confirm(&f, &bridge, &ship);
    let row = &shipped["findings"]["items"][0];
    assert_eq!(row["lifecycle"], "shipped");
    let verify = prepare(
        &f,
        &bridge,
        &shipped,
        json!({"action":"verify","key":key,"revision":row["revision"]}),
    );
    assert_eq!(
        snapshot(&f, &bridge)["findings"]["items"][0]["lifecycle"],
        "shipped"
    );
    let verified = confirm(&f, &bridge, &verify);
    assert_eq!(verified["findings"]["items"][0]["lifecycle"], "verified");
    assert_eq!(verified["draftBinding"], applied["draftBinding"]);
    assert_eq!(f.stats("stats")["starts"], 0);
    close(bridge);
}

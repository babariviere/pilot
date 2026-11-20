//! Released native bridge against a disposable daemon with no worker or provider.
include!("support/intake_fixture.rs");

fn insights_fixture(mode: &str) -> Fixture {
    let mut command = Command::new("node");
    command.current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/daemon"));
    let entry =
        std::env::temp_dir().join(format!("day-insights-entry-{}.mjs", uuid::Uuid::new_v4()));
    std::fs::write(&entry, r#"
        import { mkdir, writeFile } from "node:fs/promises";
        import { join } from "node:path";
        import { createInterface } from "node:readline";
        import { once } from "node:events";
        import { pathToFileURL } from "node:url";
        const { seedDayInsightsTracking, startDayInsightsFixture } =
            await import(pathToFileURL(join(process.cwd(), "src/testing/day-insights.ts")).href);
        const { createDaemonServer } =
            await import(pathToFileURL(join(process.cwd(), "src/server.ts")).href);
        const fresh = process.argv[2] === "fresh";
        const f = await startDayInsightsFixture();
        let server;
        let schedules;
        let scheduleStore;
        try {
            const tracking = fresh ? undefined : await seedDayInsightsTracking(f);
            const { daemonId, lineageId } = f.host;
            const token = "a".repeat(64);
            const authority = f.server.services.dependencies.nativeAuthority;
            const authenticate = authority.authenticate;
            authority.authenticate = (v) => authenticate(v === token ? f.nativeToken : v);
            await writeFile(join(f.home, "daemon-id"), daemonId);
            await writeFile(join(f.home, "storage-lineage"), lineageId);
            await writeFile(join(f.home, "github-app-capability"),
                JSON.stringify({ daemonId, lineageId, token }), { mode: 0o600 });
            let services = f.server.services;
            if (fresh) {
                const fromDaemon = (name) => import(pathToFileURL(join(process.cwd(), "src", name + ".ts")).href);
                const { ModelCatalog } = await fromDaemon("models");
                const { ScheduleService } = await fromDaemon("schedules");
                const { ScheduleStore } = await fromDaemon("schedule-store");
                const { DayInsights } = await fromDaemon("day-insights");
                const { DayInsightsExecution } = await fromDaemon("day-insights-execution");
                const { InsightsWorkspace } = await fromDaemon("insights-workspace");
                const { ModelRuntime } = await import(import.meta.resolve("@earendil-works/pi-coding-agent",
                    pathToFileURL(join(process.cwd(), "package.json")).href));
                const { requiredAuthRegistration } = await fromDaemon("testing/required-auth");
                const secondPath = join(f.root, "terra-project");
                const agentDir = join(f.root, "catalog");
                await mkdir(join(secondPath, ".pi"), { recursive: true });
                await mkdir(agentDir);
                await f.projects.create({ path: secondPath, name: "Z synthetic report project" });
                await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["synthetic/source"] }));
                await writeFile(join(secondPath, ".pi", "settings.json"),
                    JSON.stringify({ enabledModels: ["openai-codex/gpt-6.1-terra:high"] }));
                const runtime = await ModelRuntime.create({
                    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false,
                });
                const terra = runtime.getModel("openai-codex", "gpt-6.1-terra");
                if (!terra) throw new Error("Missing pinned Terra model");
                let available = [terra, { ...terra, id: "source", provider: "synthetic" }];
                ModelRuntime.create = async () => ({
                    ...requiredAuthRegistration,
                    getAvailable: async () => available,
                });
                scheduleStore = new ScheduleStore(join(f.home, "fixture-schedules.sqlite"));
                schedules = new ScheduleService(scheduleStore, {
                    sessions: f.sessions, projects: f.projects, missions: f.store, home: f.host,
                    automationsEnabled: () => false,
                });
                await schedules.load();
                const models = new ModelCatalog(agentDir);
                const journal = services.journal;
                const owners = f.store.insightsOwner;
                const store = f.store.dayInsights;
                const workspace = f.store.insightsWorkspace;
                const day = new DayInsights({
                    home: f.home, host: f.host, projects: f.projects, models, store, owners, workspace,
                    sessions: f.sessions, allowance: f.store.dayInsightsAllowance,
                    admissionEpoch: f.sessions.insightsAdmissionEpoch,
                    runtime: new DayInsightsExecution({ sessions: f.sessions, owners, store, schedules, journal, models }),
                });
                services = {
                    ...services,
                    dependencies: { ...services.dependencies, models, schedules },
                    insightsWorkspace: new InsightsWorkspace({
                        home: f.home, host: f.host, projects: f.projects, models, store: workspace, journal,
                        legacyGuard: () => {
                            f.sessions.assertNoLegacyInsights();
                            schedules.assertNoLegacyInsights(f.host);
                        },
                    }),
                    dayInsights: day,
                };
                const original = services.dayInsights.preflight.bind(services.dayInsights);
                let badReply;
                services.dayInsights.preflight = async (...args) => {
                    if (badReply) return badReply;
                    const result = await original(...args);
                    return result;
                };
                const legacySchedule = {
                    id: "synthetic-legacy-rule", revision: 1, title: "Synthetic old rule", projectId: f.project.id,
                    trigger: "recurring", at: 3600000,
                    recurrence: { every: "week", weekday: 1, time: "01:00", timeZone: "UTC" },
                    target: { kind: "message", sessionId: "synthetic-retired-report", message: "Fixture only" },
                    insightsDestination: { sessionId: "synthetic-retired-report", projectId: f.project.id, missionId: "synthetic-mission" },
                    state: "pending", createdAt: 0, updatedAt: 0,
                };
                services.insightsFixture = async (action) => {
                    if (action === "zero") available[0] = { ...terra, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
                    if (action === "omitted") available[0] = { ...terra, cost: undefined };
                    if (action === "signed-out") available = available.slice(1);
                    if (["zero", "omitted", "signed-out"].includes(action))
                        await writeFile(join(agentDir, "auth.json"), JSON.stringify({ unavailableFixtureMarker: action }));
                    if (action === "legacy-schedule") await scheduleStore.create(legacySchedule);
                    if (action === "cancel-legacy-schedule")
                        await scheduleStore.replace(legacySchedule, { ...legacySchedule, revision: 2, state: "cancelled" });
                    if (action === "unlisted-refusal" || action === "refusal-with-payload")
                        badReply = { schemaVersion: 1, state: "blocked",
                            reason: action === "unlisted-refusal" ? "legacy_unlisted_backend_detail /synthetic/private.json" : "legacy_schedule_not_quiescent",
                            payload: action === "unlisted-refusal" ? null : {},
                        };
                    if (action === "legacy-journal") {
                        const { payloadHash } = await fromDaemon("operation-journal");
                        for (const [index, kind] of ["insights-create", "insights-revoke"].entries()) {
                            const op = {
                                schemaVersion: 1, operationId: "synthetic-legacy-" + index,
                                producerId: "synthetic-legacy-producer", sequence: index + 1,
                                origin: f.host, destination: f.host, kind, targetId: "synthetic-retired-report-" + index,
                                payload: "{}", payloadHash: payloadHash("{}"),
                            };
                            const receipt = await services.journal.execute(op, async () => ({ fixture: true }));
                            if (receipt.state !== "accepted") throw new Error("Fixture journal seed refused");
                        }
                    }
                };
            }
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
                insightsWorkspace: tracking?.workspace ?? services.insightsWorkspace,
                admitOperation: (op, ...args) => op.kind === "insights-workspace-lifecycle"
                    ? tracking.workspace.admit(op) : services.admitOperation(op, ...args),
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
                await services.insightsFixture?.(action);
                console.log(JSON.stringify({ starts: f.starts() }));
            }
        } finally {
            process.stdin.destroy();
            if (server) {
                server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
            }
            await schedules?.stop();
            await scheduleStore?.close();
            await f.close();
        }
    "#).unwrap();
    command
        .arg("--experimental-import-meta-resolve")
        .arg(&entry)
        .arg(mode);
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
fn connected_insights_fresh_two_project_review_uses_exact_catalog_choice() {
    let mut f = insights_fixture("fresh");
    let bridge = Bridge::new(DayRoot::new(
        NativeHost::open(
            serde_json::from_value(f.info["source"].clone()).unwrap(),
            PathBuf::from(f.info["ledger"].as_str().unwrap()),
        )
        .unwrap(),
    ));
    let initial = snapshot(&f, &bridge);
    assert_eq!(initial["state"], "off");
    assert!(initial["executionProjectId"].is_null());
    assert_eq!(initial["projects"].as_array().unwrap().len(), 2);
    let first = &initial["projects"][0]["id"];
    let second = &initial["projects"][1]["id"];
    let catalog = |project| {
        f.call(
            &bridge,
            "day.insights.models",
            json!({"binding":initial["binding"],"projectId":project}),
        )
    };
    assert_eq!(
        catalog(first)["value"]["snapshot"]["models"][0]["id"],
        "synthetic/source"
    );
    let model = catalog(second)["value"]["snapshot"]["models"][0].clone();
    assert_eq!(
        model,
        json!({"id":"openai-codex/gpt-6.1-terra","name":"GPT-6.1 Terra","provider":"openai-codex"})
    );
    let intent = json!({"action":"setup","settings":{"projectId":second,"model":model["id"],
        "sourceProjectIds":[first,second],"excludeSessionIds":[],"perReportUsd":5,"monthlyUsd":50,"schedule":null}});
    let review = |f: &Fixture, scope: &Value| {
        f.call(
            &bridge,
            "day.insights.prepare",
            json!({"binding":scope["binding"],"intent":intent}),
        )
    };
    let refused = |f: &Fixture, scope: &Value, reason| {
        assert_eq!(
            review(f, scope),
            json!({"version":1,"value":{"snapshot":null,"outcome":null,"reason":reason}})
        );
    };
    for mode in ["stats", "zero", "omitted"] {
        assert_eq!(f.stats(mode)["starts"], 0);
        let reply = review(&f, &initial);
        assert!(
            reply["value"]["snapshot"]["token"].is_string(),
            "{mode}: {reply}"
        );
        assert_eq!(reply["value"]["snapshot"]["intent"], intent);
    }
    assert!(snapshot(&f, &bridge)["applied"].is_null());
    let earlier_token = review(&f, &initial)["value"]["snapshot"]["token"].clone();
    f.stats("legacy-schedule");
    let current = snapshot(&f, &bridge);
    assert_eq!(current["state"], "off");
    refused(
        &f,
        &current,
        "An earlier Insights schedule still blocks setup. Check Schedules for the earlier rule. Nothing changed.",
    );
    assert_eq!(
        f.call(
            &bridge,
            "day.insights.confirm",
            json!({"token":earlier_token})
        )["error"],
        "stale"
    );
    f.stats("cancel-legacy-schedule");
    let current = snapshot(&f, &bridge);
    assert!(review(&f, &current)["value"]["snapshot"]["token"].is_string());
    f.stats("legacy-journal");
    refused(
        &f,
        &snapshot(&f, &bridge),
        "Pilot can’t verify that earlier Insights work has stopped. Check the earlier setup before trying again. Nothing changed.",
    );
    f.stats("signed-out");
    let current = snapshot(&f, &bridge);
    refused(
        &f,
        &current,
        "This model is no longer available for the report project. Choose another model and review again. Nothing changed.",
    );
    f.stats("unlisted-refusal");
    assert_eq!(
        review(&f, &current),
        json!({"version":1,"error":"unavailable"})
    );
    f.stats("refusal-with-payload");
    assert_eq!(review(&f, &current), json!({"version":1,"error":"invalid"}));
    assert!(snapshot(&f, &bridge)["applied"].is_null());
    assert_eq!(f.stats("stats")["starts"], 0);
    close(bridge);
}

#[test]
fn connected_insights_pause_allows_one_safety_stop_during_an_uncertain_save() {
    let mut f = insights_fixture("tracking");
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
    let mut f = insights_fixture("tracking");
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

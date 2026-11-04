import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation, InsightsSetupDefaults, ModelOption } from "@pilot/protocol";
import type { InsightsBacklog } from "./insights-backlog.ts";
import {
	INSIGHTS_INITIAL_DEFAULTS,
	insightsReviewBudget,
	insightsSetupDefaults,
	resolveInsightsInitialModel,
} from "./insights-defaults.ts";
import { admitInsightsOperation, INSIGHTS_DISCLOSURE, INSIGHTS_SETUP_MESSAGE } from "./insights-native.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

const option = (id: string, name = "Terra 6.1"): ModelOption => ({ id, provider: id.split("/")[0]!, name });

test("fixed initial defaults are conservative suggestions, not activation or a cost allowance", () => {
	assert.deepEqual(INSIGHTS_INITIAL_DEFAULTS, {
		recurrence: { every: "week", weekday: 5, time: "18:00", timeZone: "Europe/Paris" },
		requestedModel: "Terra 6.1",
		scope: {
			host: "local",
			projects: "admitted",
			includeArchived: true,
			sourceAccess: "read_only",
			coverage: "partial",
		},
		bounds: { inventoryPages: 1, historyPages: 2, entriesPerPage: 4 },
		budget: { usd: 5, period: "report", enforcement: "advisory", basis: "initial_assumption" },
		activationRequired: true,
	});
	for (const value of Object.values(INSIGHTS_INITIAL_DEFAULTS))
		if (typeof value === "object") assert.equal(Object.isFrozen(value), true);
	assert.equal(Object.isFrozen(INSIGHTS_INITIAL_DEFAULTS), true);
	const budget = insightsReviewBudget();
	assert.equal(budget.pricing, "unknown");
	assert.equal(budget.spendUsd, null);
	assert.match(budget.note, /Approximately \$5 per report/);
	assert.match(budget.note, /not a hard cap or approved spend/);
	assert.match(budget.note, /activation confirmation/);
	assert.match(budget.note, /do not infer zero cost/);
});

test("Terra resolves only a unique configured name, never a guessed ID, default or fuzzy substitute", async () => {
	assert.deepEqual(resolveInsightsInitialModel([option("custom/exact-id", "  terra   6.1 ")]), {
		state: "available",
		id: "custom/exact-id",
	});
	assert.deepEqual(resolveInsightsInitialModel([option("custom/a"), option("custom/a")]), {
		state: "available",
		id: "custom/a",
	});
	assert.deepEqual(resolveInsightsInitialModel([option("second/b"), option("first/a")]), {
		state: "ambiguous",
		ids: ["first/a", "second/b"],
	});
	for (const choices of [
		[],
		[option("custom/terra-6.1", "Unverified label")],
		[option("custom/sol", "Sol 6.1"), option("custom/terra-preview", "Terra 6.1 Preview")],
	])
		assert.deepEqual(resolveInsightsInitialModel(choices), { state: "unavailable", reason: "not_found" });
	const result = await insightsSetupDefaults("p", "/synthetic", {
		list: async () => ({ models: [option("custom/sol", "Sol 6.1")], defaultModel: "custom/sol" }),
	});
	assert.deepEqual(result.model, { state: "unavailable", reason: "not_found" });
	const failed = await insightsSetupDefaults("p", "/synthetic", {
		list: async () => {
			throw new Error("private configuration details");
		},
	});
	assert.deepEqual(failed.model, { state: "unavailable", reason: "catalog_unavailable" });
	assert.doesNotMatch(JSON.stringify(failed), /private configuration/);
});

test("passive defaults GET reads only the selected project's model metadata and never starts work", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "insights-defaults-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const models = new ModelCatalog(home);
	const cwd = join(home, "project");
	await mkdir(cwd);
	const project = await projects.create({ path: cwd, model: "custom/chosen" });
	const before = await readFile(join(home, "projects.json"));
	const paths: string[] = [];
	let choices = [option("configured/report-v1")],
		fail = false;
	t.mock.method(models, "list", async (path: string) => {
		paths.push(path);
		if (fail) throw new Error("private credential failure");
		return { models: choices, defaultModel: "custom/chosen" };
	});
	const forbidden = () => assert.fail("defaults must not admit work, read history or create grants");
	t.mock.method(sessions, "spawn", forbidden);
	t.mock.method(sessions, "spawnInsightsDurable", forbidden);
	t.mock.method(sessions, "dispatchInsightsReview", forbidden);
	t.mock.method(sessions, "insightsHostAdmission", forbidden);
	t.mock.method(sessions, "diagnosticContext", forbidden);
	t.mock.method(models, "generateTitle", forbidden);
	const server = createDaemonServer({ home, host: "127.0.0.1", port: 0 }, sessions, projects, models, terminals);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await sessions.shutdown();
		await terminals.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/insights/defaults`;
	assert.equal((await fetch(url)).status, 400);
	assert.equal((await fetch(`${url}?projectId=missing`)).status, 404);
	assert.equal((await fetch(`${url}?projectId=${project.id}`, { method: "POST" })).status, 405);
	const read = async () => {
		const response = await fetch(`${url}?projectId=${project.id}&cwd=/not-admitted`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		return (await response.json()) as InsightsSetupDefaults;
	};
	const result = await read();
	assert.equal(result.projectId, project.id);
	assert.deepEqual(result.defaults, INSIGHTS_INITIAL_DEFAULTS);
	assert.deepEqual(result.model, { state: "available", id: "configured/report-v1" });
	choices = [option("first/a"), option("second/b")];
	assert.equal((await read()).model.state, "ambiguous");
	choices = [];
	assert.deepEqual((await read()).model, { state: "unavailable", reason: "not_found" });
	fail = true;
	assert.deepEqual((await read()).model, { state: "unavailable", reason: "catalog_unavailable" });
	assert.deepEqual(paths, [cwd, cwd, cwd, cwd]);
	assert.deepEqual(await readFile(join(home, "projects.json")), before);
	assert.deepEqual(sessions.list(), []);
});

test("explicit native setup keeps its exact model/thinking and requires an immutable model choice", async () => {
	const calls: unknown[][] = [];
	const sessions = {
		spawnInsightsDurable: async (...args: unknown[]) => {
			calls.push(args);
			return { id: "report" };
		},
	} as unknown as SessionManager;
	const op = { kind: "insights-create", targetId: "report", operationId: "setup" } as DurableOperation;
	const payload = {
		projectId: "p",
		missionId: "m",
		model: "custom/user-choice",
		thinking: "low",
		disclosure: INSIGHTS_DISCLOSURE,
	};
	await admitInsightsOperation(sessions, {} as InsightsBacklog, op, payload);
	assert.deepEqual(calls, [
		[
			{
				projectId: "p",
				missionId: "m",
				model: "custom/user-choice",
				thinking: "low",
				message: INSIGHTS_SETUP_MESSAGE,
			},
			"report",
			"setup",
		],
	]);
	const { model: _model, ...missing } = payload;
	await assert.rejects(admitInsightsOperation(sessions, {} as InsightsBacklog, op, missing), /exact Insights payload/);
	assert.equal(calls.length, 1, "missing models cannot resolve differently during durable replay");
});

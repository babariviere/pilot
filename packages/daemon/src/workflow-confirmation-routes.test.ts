import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DaemonHello, DurableOperation, PreparedWorkflowConfirmation, SessionSummary } from "@pilot/protocol";
import { GitHubSetupService } from "./github-setup.ts";
import type { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

const host = { hostId: "app", daemonId: "host", lineageId: "lineage" };
async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "workflow-api-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, name: "Project" });
	const sessions = new SessionManager(home, projects);
	let coordinator: Pick<SessionSummary, "id" | "projectId" | "mode" | "archivedAt"> | undefined = {
		id: "lead",
		projectId: project.id,
		mode: "build",
	};
	t.mock.method(sessions, "get", () => coordinator as SessionSummary | undefined);
	t.mock.method(sessions, "spawn", async () => assert.fail("No worker may start"));
	const store = new MissionStore(":memory:");
	const mission = store.create({ projectId: project.id, title: "Plan", brief: "Immutable plan", planningVersion: 1 });
	store.join("lead", mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	const terminals = new TerminalManager();
	const native = new GitHubSetupService(home, host, { userHome: home, env: {} });
	await native.status();
	const capability = JSON.parse(await readFile(join(home, "github-app-capability"), "utf8")).token as string;
	const hello: DaemonHello = {
		...host,
		daemonVersion: "test",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "darwin",
		arch: "arm64",
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: true,
			coordinatorIsolation: true,
			independentExecution: true,
		},
	};
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		{ store, service: {} as MissionService },
	];
	args[12] = hello;
	args[17] = native;
	const server = createDaemonServer(...args);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await sessions.shutdown();
		await terminals.shutdown();
		await native.close();
		await store.durable();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	const packageUrl = `${root}/missions/${mission.id}/approval-package`;
	const prepare = async (): Promise<PreparedWorkflowConfirmation> => {
		const r = await fetch(packageUrl);
		assert.equal(r.status, 200);
		return r.json();
	};
	const operation = (kind: string, value: unknown, targetId = mission.id): DurableOperation => {
		const payload = JSON.stringify(value);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: host,
			destination: host,
			kind,
			targetId,
			payload,
			payloadHash: payloadHash(payload),
		};
	};
	const post = (op: DurableOperation, token: string | undefined = capability, receipt = false) =>
		fetch(`${root}/operations${receipt ? "/receipt" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(token ? { "x-pilot-github-capability": token } : {}) },
			body: JSON.stringify(op),
		});
	return {
		root,
		store,
		projects,
		project,
		mission,
		prepare,
		packageUrl,
		operation,
		post,
		capability,
		set coordinator(value: typeof coordinator) {
			coordinator = value;
		},
	};
}

test("all five workflow kinds require the existing native capability before reservation; Check is passive", async (t) => {
	const f = await fixture(t);
	const p = await f.prepare();
	for (const kind of [
		"workflow-approve",
		"workflow-revoke",
		"review-consent",
		"review-consent-revoke",
		"review-disposition",
	]) {
		const op = f.operation(kind, { purpose: kind, ...p });
		for (const token of ["", "forged", "user"]) assert.equal((await f.post(op, token)).status, 403);
		assert.deepEqual(await (await f.post(op, "", true)).json(), { state: "unknown" });
	}
	assert.equal(f.store.workflowConfirmations.latest(f.mission.id, false), undefined);
	assert.equal(f.store.workflowConfirmations.latest(f.mission.id, true), undefined);
	const op = f.operation("workflow-approve", { purpose: "workflow-approve", ...p });
	const receipt = await (await f.post(op)).json();
	assert.equal(receipt.state, "accepted");
	assert.deepEqual(await (await f.post(op, "", true)).json(), receipt);
	assert.deepEqual(await (await f.post(op)).json(), receipt);
	assert.equal(
		(await fetch(`${f.root}/missions/${f.mission.id}/reviewer-consent-package`)).status,
		503,
		"There is no installed provider/account/terms configuration producer",
	);
});

test("native bearer alone cannot spoof purpose, mutate the package or bless current matching state", async (t) => {
	const f = await fixture(t);
	const p = await f.prepare();
	for (const value of [
		{ purpose: "review-consent", ...p },
		{ purpose: "workflow-approve", ...p, actor: "user" },
		{ purpose: "workflow-approve", ...p, package: { ...p.package, coordinatorSessionId: "attacker" } },
	]) {
		const r = await (await f.post(f.operation("workflow-approve", value))).json();
		assert.equal(r.state, "rejected");
	}
	const op = f.operation("workflow-approve", { purpose: "workflow-approve", ...p });
	await f.projects.update(f.project.id, { name: "Other" });
	await f.projects.update(f.project.id, { name: "Project" });
	assert.equal((await (await f.post(op)).json()).state, "rejected", "project configuration ABA is fenced");
	const next = await f.prepare();
	f.coordinator = { id: "lead", projectId: "other", mode: "build" };
	assert.equal(
		(await (await f.post(f.operation("workflow-approve", { purpose: "workflow-approve", ...next }))).json()).state,
		"rejected",
	);
	assert.equal((await fetch(f.packageUrl)).status, 409);
});

test("package GET is no-store/read-only and cannot grant while held across membership revocation", async (t) => {
	const f = await fixture(t);
	const response = await fetch(f.packageUrl);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal((await fetch(f.packageUrl, { method: "POST" })).status, 405);
	assert.equal((await fetch(`${f.packageUrl}?actor=user`)).status, 400);
	const p = await response.json();
	f.store.join("alternate", f.mission.id);
	f.store.update(f.mission.id, { coordinatorSessionId: "alternate" });
	assert.equal(
		(await (await f.post(f.operation("workflow-approve", { purpose: "workflow-approve", ...p }))).json()).state,
		"rejected",
	);
	assert.equal(f.store.workflowConfirmations.latest(f.mission.id, false), undefined);
});

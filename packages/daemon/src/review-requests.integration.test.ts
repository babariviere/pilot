import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DaemonHello, ReviewRequestSuggestion } from "@pilot/protocol";
import { GitHubSetupService } from "./github-setup.ts";
import { dispositionTarget } from "./human-reviews.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { fixture, jj } from "./testing/shared-workspace.ts";
import { WorkerReviewDelivery } from "./worker-review-delivery.ts";

async function host(t: TestContext, enabled = true) {
	const f = fixture(),
		home = join(realpathSync(f.root), "home"),
		projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: realpathSync(f.source) });
	const sessions = new SessionManager(home, projects),
		store = new MissionStore(":memory:");
	// Isolate request/custody transport from unrelated role transitions and repository refresh.
	t.mock.method(sessions, "missionChanged", () => {});
	t.mock.method(sessions, "requestMainRefresh", () => {});
	t.mock.method(sessions, "refreshMissionPullRequests", () => {});
	const service = new MissionService(store, sessions, projects),
		terminals = new TerminalManager();
	const mission = store.create({ title: "Exact suggestions", projectId: project.id, planningVersion: 1 });
	const lead = randomUUID(),
		other = randomUUID();
	for (const id of [lead, other]) {
		// biome-ignore lint/complexity/useLiteralKeys: Persisted metadata only, never a reviewer/provider.
		sessions["metas"].set(id, {
			id,
			title: "Coordinator",
			cwd: project.path,
			projectId: project.id,
			mode: "build",
			createdAt: 1,
			updatedAt: 1,
		});
		store.join(id, mission.id);
	}
	store.update(mission.id, { coordinatorSessionId: lead });
	const add = async (member: boolean, sourceProject = project) => {
		const sessionId = randomUUID();
		if (member) store.join(sessionId, mission.id);
		const scope = member
			? { version: 1 as const, sessionId, missionId: mission.id, taskIds: ["enrollment-context"] }
			: { version: 2 as const, sessionId, projectId: sourceProject.id };
		const w = await f.store.create(
			sourceProject.path,
			join(home, "sessions", sessionId, "workspace"),
			undefined,
			undefined,
			scope,
		);
		// biome-ignore lint/complexity/useLiteralKeys: Persisted fixture metadata, not capture on read.
		sessions["metas"].set(sessionId, {
			id: sessionId,
			title: "Ordering",
			cwd: w.path,
			projectId: sourceProject.id,
			mode: "build",
			createdAt: 1,
			updatedAt: 1,
			...(member ? {} : { retainedScope: scope as Extract<typeof scope, { version: 2 }> }),
			workspace: { source: sourceProject.path, base: w.base, jj: true, shared: w.shared! },
		});
		writeFileSync(join(w.path, "a.txt"), "exact request source\n");
		jj(w.path, "commit", "-m", "Retained ordering");
		const binding = member
			? await f.store.ownership.sessionBinding(sessionId, mission.id, w.shared!.repository, w.shared!.name)
			: await f.store.ownership.projectSessionBinding(
					sessionId,
					sourceProject.id,
					w.shared!.repository,
					w.shared!.name,
				);
		assert.ok(binding);
		// biome-ignore lint/complexity/useLiteralKeys: Explicit test capture, never request creation.
		const delivery = new WorkerReviewDelivery(f.store.ownership, sessions["reviewSnapshots"]);
		await delivery.checkpoint(
			sessionId,
			async () => binding,
			() => f.store.observeOwnership(w.path, w.shared!),
		);
		await delivery.close();
		const reader = sessions.nativeReviewReader(
			sessionId,
			member ? mission.id : undefined,
			sourceProject.id,
			() => {},
			true,
		);
		const comparison = (await reader.list(0)).comparisons[0];
		const target = dispositionTarget(sourceProject.id, await reader.get(comparison.snapshotId));
		const suggestion: ReviewRequestSuggestion = {
			operationId: randomUUID(),
			target,
			title: "Check ordering",
			reason: "Optional review suggestion",
			replacesRequestId: null,
			replacesExpectedRevision: null,
		};
		return { sessionId, w, target, comparison, suggestion };
	};
	const identity = { hostId: "daemon", daemonId: "host", lineageId: "lineage" };
	const native = new GitHubSetupService(home, identity, { userHome: home, env: {} });
	await native.status();
	const capability = JSON.parse(readFileSync(join(home, "github-app-capability"), "utf8")).token as string;
	const hello: DaemonHello = {
		...identity,
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
		enabled ? { store, service } : undefined,
	];
	args[12] = hello;
	args[17] = native;
	const server = createDaemonServer(...args);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await service.notices.stop();
		await sessions.shutdown();
		await terminals.shutdown();
		await native.close();
		await store.durable();
		store.close();
		await f.store.close();
		f.close();
	});
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const request = (path: string, method = "GET", body?: unknown, token = capability) =>
		fetch(`${api}/${path}`, {
			method,
			headers: { "content-type": "application/json", ...(token ? { "x-pilot-github-capability": token } : {}) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { f, project, projects, sessions, store, service, mission, lead, other, add, request };
}

test("real native standalone producer and global reader have no capture inference, impersonation or gate", async (t) => {
	const h = await host(t),
		a = await h.add(false),
		b = await h.add(true);
	const g = fixture();
	t.after(() => g.close());
	const secondProject = await h.projects.create({ path: realpathSync(g.source) });
	const c = await h.add(false, secondProject);
	assert.deepEqual(await (await h.request("review/requests")).json(), { requests: [], next: null });
	assert.equal((await h.request("review/requests/suggest", "POST", a.suggestion, "")).status, 403);
	assert.equal(
		(await h.request("review/requests/suggest", "POST", { ...a.suggestion, actor: "native-user" })).status,
		400,
	);
	assert.equal((await h.request("review/requests/required", "POST", a.suggestion)).status, 404);
	assert.equal((await h.request("review/requests/suggest", "POST", { ...a.suggestion, required: true })).status, 400);
	const first = await h.request("review/requests/suggest", "POST", a.suggestion);
	assert.equal(first.status, 200); // simulate a lost response body
	const recovered = await (await h.request(`review/requests/operations/${a.suggestion.operationId}`)).json();
	assert.equal(recovered.state, "pending");
	assert.deepEqual(await (await h.request("review/requests/suggest", "POST", a.suggestion)).json(), recovered);
	assert.equal(
		(await h.request(`review/requests/operations/${a.suggestion.operationId}`, "GET", undefined, "")).status,
		403,
	);
	const coor = (await h.service.call(h.lead, "requestReview", { request: b.suggestion })) as { requestId: string };
	assert.equal((await h.request("review/requests/suggest", "POST", c.suggestion)).status, 200);
	const page = await (await h.request("review/requests", "GET", undefined, "")).json();
	assert.equal(page.requests.length, 3);
	assert.equal(page.requests[2].projectId, secondProject.id);
	assert.deepEqual(page.requests[0].comparison, a.comparison);
	assert.equal(page.requests[0].actionability, "unknown");
	assert.deepEqual(
		Object.keys(page.requests[0]).sort(),
		["requestId", "sequence", "state", "actionability", "projectId", "sessionId", "title", "comparison"].sort(),
	);
	assert.equal((await (await h.request(`review/requests?sessionId=${a.sessionId}`)).json()).requests.length, 1);
	assert.equal((await h.request("review/requests?missionId=ignored")).status, 400);
	assert.equal((await h.request("review/requests?after=1.5")).status, 400);
	assert.equal((await h.request("review/requests?sessionId=one&sessionId=two")).status, 400);
	assert.equal((await h.request("review/requests/cancel", "POST", a.suggestion)).status, 404);
	await assert.rejects(
		h.service.call(h.other, "requestReview", { request: b.suggestion }),
		/Only the mission coordinator/,
	);
	await assert.rejects(
		h.service.call(h.lead, "requestReview", { request: { ...a.suggestion, operationId: randomUUID() } }),
		/same-project coordinator/,
	);
	assert.equal(h.store.reviewRequests.requirement(a.target).state, "requested");
	const snooze = { operationId: randomUUID(), requestId: recovered.requestId, expectedRevision: 1, reason: "Later" };
	assert.equal((await h.request("review/requests/snooze", "POST", snooze)).status, 200);
	assert.equal((await (await h.request("review/requests")).json()).requests[0].state, "snoozed");
	assert.equal(
		(await h.request("review/requests/resume", "POST", { ...snooze, operationId: randomUUID(), expectedRevision: 2 }))
			.status,
		200,
	);
	assert.equal(
		(
			await h.request("review/requests/withdraw", "POST", {
				...snooze,
				operationId: randomUUID(),
				expectedRevision: 3,
			})
		).status,
		200,
	);
	assert.equal(h.store.reviewRequests.requirement(a.target).state, "withdrawn");
	assert.equal((await (await h.request(`review/requests/${recovered.requestId}/history`)).json()).length, 4);
	assert.equal(
		(await (await h.request(`review/requests/operations/${a.suggestion.operationId}`)).json()).state,
		"pending",
	);
	assert.equal((await (await h.request("review/requests")).json()).requests[0].state, "withdrawn");
	await h.service.call(h.lead, "retireReview", {
		request: {
			operationId: randomUUID(),
			requestId: coor.requestId,
			expectedRevision: 1,
			reason: "My suggestion no longer useful",
		},
	});
	assert.equal(h.store.reviewRequests.get(coor.requestId)!.state, "retired");
	const nativeOther = await (
		await h.request("review/requests/suggest", "POST", { ...b.suggestion, operationId: randomUUID() })
	).json();
	const later = { ...b.suggestion, operationId: randomUUID(), title: "Different creator" };
	h.store.update(h.mission.id, { coordinatorSessionId: h.other });
	await assert.rejects(h.service.call(h.lead, "requestReview", { request: later }), /Only the mission coordinator/);
	await assert.rejects(
		h.service.call(h.other, "retireReview", {
			request: {
				operationId: randomUUID(),
				requestId: nativeOther.requestId,
				expectedRevision: 1,
				reason: "Not mine",
			},
		}),
		/original coordinator/,
	);
	assert.equal(h.store.humanReviews.targetState(a.target).latestRecordId, null);
});

test("current project/member/custody checks are repeated after real async reads; missing source is unavailable", async (t) => {
	const h = await host(t),
		a = await h.add(true);
	const receipt = (await h.service.call(h.lead, "requestReview", { request: a.suggestion })) as { requestId: string };
	const original = h.sessions.nativeReviewReader.bind(h.sessions);
	let leave = true;
	const mock = t.mock.method(h.sessions, "nativeReviewReader", (...args: Parameters<typeof original>) => {
		const reader = original(...args),
			comparison = reader.comparison.bind(reader);
		t.mock.method(reader, "comparison", async (id: string) => {
			const c = await comparison(id);
			if (leave) {
				leave = false;
				h.store.leave(a.sessionId);
			}
			return c;
		});
		return reader;
	});
	assert.notEqual((await h.request("review/requests")).status, 200);
	await assert.rejects(
		h.service.call(h.lead, "retireReview", {
			request: {
				operationId: randomUUID(),
				requestId: receipt.requestId,
				expectedRevision: 1,
				reason: "No longer member",
			},
		}),
		/same-project coordinator/,
	);
	mock.mock.restore();
	h.store.join(a.sessionId, h.mission.id);
	assert.equal((await h.request("review/requests")).status, 200);
	// Workspace loss is not source loss: exact retained reads need no live file fallback.
	rmSync(a.w.path, { recursive: true, force: true });
	assert.equal((await h.request("review/requests")).status, 200);
	// Project access changes must not silently drop a queue row or widen source access.
	const require = h.projects.require.bind(h.projects);
	t.mock.method(h.projects, "require", (id: string) => {
		if (id === h.project.id) throw new Error("Project access unavailable");
		return require(id);
	});
	const unavailable = await h.request("review/requests");
	assert.notEqual(unavailable.status, 200);
	assert.ok(!(await unavailable.json()).requests);
});

test("absent request source is explicit service-unavailable, never an empty reviewed queue", async (t) => {
	const h = await host(t, false),
		res = await h.request("review/requests");
	assert.equal(res.status, 503);
	assert.match((await res.json()).error, /Authoritative Review requests unavailable/);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { DaemonHello, DurableOperation, ReviewDispositionPayload } from "@pilot/protocol";
import { GitHubSetupService } from "./github-setup.ts";
import { lineRange } from "./human-review-anchors.ts";
import { dispositionTarget, HumanReviews } from "./human-reviews.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { retainedReviewFixture } from "./testing/retained-review.ts";
import { fixture, jj } from "./testing/shared-workspace.ts";
import { WorkerReviewDelivery } from "./worker-review-delivery.ts";

test("qualified real retained custody seals feedback through workspace loss and ledger writes revoke held admission", async () => {
	const f = await retainedReviewFixture();
	const store = new MissionStore(join(f.root, "missions.sqlite"));
	try {
		f.commit("exact retained feedback\n");
		await f.run();
		const page = await f.reader.list(0),
			snapshot = await f.reader.get(page.comparisons[0].snapshotId);
		const target = dispositionTarget("project", snapshot);
		const source = new HumanReviews({ store: store.humanReviews, qualify: (t) => f.reader.qualify(t) });
		const request = await source.prepare({
			purpose: "review-disposition",
			targets: [target],
			disposition: "comment",
			body: "Native feedback",
			expectedPriorRecordId: null,
			packageDigest: "0".repeat(64),
		});
		const qualified = await f.reader.qualify(target);
		qualified.revalidate();
		await f.observe();
		assert.throws(qualified.revalidate, /custody changed/);
		const payload = JSON.stringify(await source.prepare(request));
		const operation = {
			schemaVersion: 1 as const,
			operationId: randomUUID(),
			producerId: "native-test",
			sequence: 1,
			origin: { hostId: "app", daemonId: "host", lineageId: "lineage" },
			destination: { hostId: "daemon", daemonId: "host", lineageId: "lineage" },
			kind: "review-disposition",
			targetId: JSON.parse(payload).packageDigest as string,
			payload,
			payloadHash: payloadHash(payload),
		};
		await source.record(operation, JSON.parse(payload));
		rmSync(f.w.path, { recursive: true, force: true });
		assert.equal((await source.history(target)).length, 1);
		assert.equal((await source.extraction()).length, 1);
		f.revoke();
		await assert.rejects(source.lookup(operation), /revoked/i);
	} finally {
		await store.durable();
		store.close();
		await f.dispose();
	}
});

test("production native-only feedback transport preserves standalone custody without mission or readiness inference", async (t) => {
	const f = fixture(),
		home = join(realpathSync(f.root), "home");
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: realpathSync(f.source) });
	const sessions = new SessionManager(home, projects),
		store = new MissionStore(":memory:"),
		terminals = new TerminalManager();
	const sessionId = randomUUID(),
		scope = { version: 2 as const, sessionId, projectId: project.id };
	const w = await f.store.create(
		f.source,
		join(home, "sessions", sessionId, "workspace"),
		undefined,
		undefined,
		scope,
	);
	// biome-ignore lint/complexity/useLiteralKeys: Inject persisted metadata, not a feedback/readiness producer.
	sessions["metas"].set(sessionId, {
		id: sessionId,
		title: "Standalone",
		cwd: w.path,
		projectId: project.id,
		mode: "build",
		createdAt: 1,
		updatedAt: 1,
		retainedScope: scope,
		workspace: { source: project.path, base: w.base, jj: true, shared: w.shared! },
	});
	writeFileSync(join(w.path, "a.txt"), "native retained text\n");
	jj(w.path, "commit", "-m", "Changed retained text");
	const binding = (await f.store.ownership.projectSessionBinding(
		sessionId,
		project.id,
		w.shared!.repository,
		w.shared!.name,
	))!;
	// biome-ignore lint/complexity/useLiteralKeys: Test capture before transport, never enrollment/capture on reads.
	const delivery = new WorkerReviewDelivery(f.store.ownership, sessions["reviewSnapshots"]);
	await delivery.checkpoint(
		sessionId,
		async () => binding,
		() => f.store.observeOwnership(w.path, w.shared!),
	);
	await delivery.close();
	const reader = sessions.nativeReviewReader(sessionId, undefined, project.id, () => {});
	const page = await reader.list(0),
		snapshot = await reader.get(page.comparisons[0].snapshotId),
		target = dispositionTarget(project.id, snapshot);
	const host = { hostId: "daemon", daemonId: "host", lineageId: "lineage" };
	const native = new GitHubSetupService(home, host, { userHome: home, env: {} });
	await native.status();
	const capability = JSON.parse(readFileSync(join(home, "github-app-capability"), "utf8")).token as string;
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
		{ store, service: {} as never },
	];
	args[12] = hello;
	args[17] = native;
	const server = createDaemonServer(...args);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await sessions.shutdown();
		await terminals.shutdown();
		await native.close();
		await store.durable();
		store.close();
		await f.store.close();
		f.close();
	});
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const request = (path: string, method: string, body?: unknown, token = capability) =>
		fetch(`${api}/${path}`, {
			method,
			headers: { "content-type": "application/json", ...(token ? { "x-pilot-github-capability": token } : {}) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const input: ReviewDispositionPayload = {
		purpose: "review-disposition",
		targets: [target],
		disposition: "comment",
		body: "Native user feedback",
		expectedPriorRecordId: null,
		packageDigest: "0".repeat(64),
		feedback: {
			draft: null,
			annotations: [
				{
					id: "native-annotation",
					body: "Original native reason",
					supersedes: null,
					anchor: {
						kind: "lines",
						snapshotId: target.snapshotId,
						ranges: [
							lineRange(
								Buffer.from("native retained text\n"),
								{
									side: "after",
									path: "a.txt",
									sha256: snapshot.after.find((e) => e.path === "a.txt")!.sha256!,
								},
								1,
								1,
							),
						],
					},
				},
			],
			findings: [],
			resolveAnnotationIds: [],
			supersedes: null,
		},
	};
	for (const token of ["", "forged"]) {
		assert.equal((await request("review-feedback/prepare", "POST", input, token)).status, 403);
		assert.equal((await request("review-feedback/drafts/draft", "GET", undefined, token)).status, 403);
	}
	const targetResponse = await request("review-feedback/target", "POST", {
		projectId: project.id,
		sessionId,
		snapshotId: snapshot.snapshotId,
	});
	assert.equal(targetResponse.status, 200);
	assert.deepEqual(await targetResponse.json(), target);
	const content = {
		targets: input.targets,
		disposition: input.disposition,
		body: input.body,
		feedback: input.feedback,
	};
	const saved = await request("review-feedback/drafts/draft", "PUT", { expectedRevision: 0, content });
	assert.equal(saved.status, 200);
	assert.equal(saved.headers.get("cache-control"), "no-store");
	assert.equal(store.humanReviews.outbox().length, 0);
	const prepared = await request("review-feedback/prepare", "POST", input);
	assert.equal(prepared.status, 200);
	const confirmed = (await prepared.json()) as ReviewDispositionPayload,
		payload = JSON.stringify(confirmed);
	const operation: DurableOperation = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: "native",
		sequence: 1,
		origin: host,
		destination: host,
		kind: "review-disposition",
		targetId: confirmed.packageDigest,
		payload,
		payloadHash: payloadHash(payload),
	};
	assert.equal((await request("operations", "POST", operation, "")).status, 403);
	const receipt = await (await request("operations", "POST", operation)).json();
	assert.equal(receipt.state, "accepted");
	assert.deepEqual(await (await request("operations/receipt", "POST", operation)).json(), receipt);
	assert.deepEqual(await (await request("operations", "POST", operation)).json(), receipt);
	assert.equal(store.humanReviews.outbox().length, 1);
	const projected = await request("review-feedback/annotations/native-annotation/projection", "POST", { target });
	assert.equal(projected.status, 200);
	assert.equal((await projected.json()).state, "same");
	const approvalResponse = await request("review-feedback/prepare", "POST", { ...input, disposition: "approve" });
	const approval = (await approvalResponse.json()) as ReviewDispositionPayload,
		approvalPayload = JSON.stringify(approval);
	const approvalOp = {
		...operation,
		sequence: 2,
		operationId: randomUUID(),
		targetId: approval.packageDigest,
		payload: approvalPayload,
		payloadHash: payloadHash(approvalPayload),
	};
	assert.equal(
		(await (await request("operations", "POST", approvalOp)).json()).state,
		"rejected",
		"no fabricated required-check, request or agent-review producers",
	);
	rmSync(w.path, { recursive: true, force: true });
	// Retirement leaves the original project/custody metadata, not a live workspace requirement.
	// biome-ignore lint/complexity/useLiteralKeys: Model an archived worker without adopting or deleting custody.
	sessions["metas"].get(sessionId)!.archivedAt = Date.now();
	assert.equal((await request("review-feedback/history", "POST", { target, after: 0 })).status, 200);
	await projects.update(project.id, { name: "Current config" });
	assert.equal(store.list().length, 0, "no fake mission/tasks or request inference");
	// Current project changes revoke new reads, including already accepted receipt lookup.
	// biome-ignore lint/complexity/useLiteralKeys: Model a current metadata move, not a role adoption.
	sessions["metas"].get(sessionId)!.projectId = "other";
	assert.notEqual((await request("operations/receipt", "POST", operation)).status, 200);
	assert.notEqual((await request("review-feedback/drafts/draft", "GET")).status, 200);
});

// biome-ignore-all lint/complexity/useLiteralKeys: Await production lifecycle work without invoking capture or seeding custody.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type {
	DaemonHello,
	DurableOperation,
	HumanReviewContent,
	HumanReviewDraft,
	HumanReviewRecord,
	NativeReviewSnapshot,
	OperationReceipt,
	ReviewDispositionPayload,
	ReviewDispositionTarget,
} from "@pilot/protocol";
import { GitHubSetupService } from "./github-setup.ts";
import { lineRange } from "./human-review-anchors.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { payloadHash } from "./operation-journal.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionFactories, SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { fixture, jj, until } from "./testing/session-workspace.ts";

const host = { hostId: "daemon", daemonId: "manual-review-fixture", lineageId: "manual-review-lineage" };
const hello: DaemonHello = {
	...host,
	daemonVersion: "test",
	protocolVersion: 1,
	minimumClientProtocolVersion: 1,
	platform: process.platform,
	arch: process.arch,
	capabilities: {
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
		coordinatorIsolation: true,
		independentExecution: true,
	},
};

/** Synthetic tool effects run in a genuinely managed worker workspace, never a provider. */
class FakeReviewAgent implements SessionWorker {
	readonly ready = Promise.resolve();
	state: "idle" | "working" = "idle";
	turns = 0;
	private readonly packet: (packet: KernelPacket) => void;
	private readonly exit: (worker: SessionWorker, code: number | null) => void;
	private readonly run: () => void;
	get busy() {
		return this.state === "working";
	}
	constructor(
		packet: (packet: KernelPacket) => void,
		exit: (worker: SessionWorker, code: number | null) => void,
		run: () => void,
	) {
		this.packet = packet;
		this.exit = exit;
		this.run = run;
	}
	send(_command: KernelCommand) {}
	async request(command: Extract<KernelCommand, { requestId: string }>) {
		if (command.type !== "input") return;
		this.state = "working";
		this.packet({ type: "working", working: true });
		this.run();
		this.turns++;
		this.state = "idle";
		this.packet({ type: "working", working: false });
	}
	async hasChildren() {
		return false;
	}
	async close() {
		this.exit(this, 0);
	}
}

test("normal managed agent changes support native manual feedback, exact retries and restart", async (t) => {
	let stop: (() => Promise<void>) | undefined;
	// Teardown hooks run in registration order. Close consumers before the fixture deletes its files.
	t.after(async () => {
		await stop?.();
	});
	let turn: (cwd: string) => void = () => {};
	const agents: FakeReviewAgent[] = [];
	const worker: SessionFactories["worker"] = (spec, packet, exit) => {
		const agent = new FakeReviewAgent(packet, exit, () => turn(spec.cwd));
		agents.push(agent);
		return agent;
	};
	const f = await fixture(t, {}, { worker });
	let sessions = f.sessions;
	const storePath = join(f.home, "missions.sqlite");
	let store: MissionStore;
	let api = "";
	let capability = "";
	const open = async () => {
		store = new MissionStore(storePath);
		const service = new MissionService(store, sessions, f.projects);
		const terminals = new TerminalManager();
		const native = new GitHubSetupService(f.home, host, { userHome: f.home, env: {} });
		await native.status();
		// The actual app-owned capability boundary, not a body actor or agent-tool grant.
		capability = JSON.parse(readFileSync(join(f.home, "github-app-capability"), "utf8")).token as string;
		const args: Parameters<typeof createDaemonServer> = [
			{ home: f.home, host: "127.0.0.1", port: 0 },
			sessions,
			f.projects,
			new ModelCatalog(f.home),
			terminals,
			{ store, service },
		];
		args[12] = hello;
		args[17] = native;
		const server = createDaemonServer(...args);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
		stop = async () => {
			stop = undefined;
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			await server.closePlanning();
			service.notices.stop();
			await sessions.shutdown();
			await terminals.shutdown();
			await native.close();
			await store.durable();
			store.close();
		};
	};
	const request = (path: string, method = "GET", body?: unknown, token = capability) =>
		fetch(`${api}/${path}`, {
			method,
			headers: { "content-type": "application/json", "x-pilot-github-capability": token },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const ok = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
		const response = await request(path, method, body);
		const value = await response.json();
		assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(value)}`);
		return value as T;
	};
	let sequence = 0;
	const operation = (confirmed: ReviewDispositionPayload): DurableOperation => {
		const payload = JSON.stringify(confirmed);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: "native-manual-review-fixture",
			sequence: ++sequence,
			origin: { ...host, hostId: "app" },
			destination: host,
			kind: "review-disposition",
			targetId: confirmed.packageDigest,
			payload,
			payloadHash: payloadHash(payload),
		};
	};
	const prepare = (content: HumanReviewContent) =>
		ok<ReviewDispositionPayload>("review-feedback/prepare", "POST", {
			...content,
			purpose: "review-disposition",
			expectedPriorRecordId: null,
			packageDigest: "0".repeat(64),
		});
	const history = (target: ReviewDispositionTarget) =>
		ok<{ sequence: number; record: HumanReviewRecord }[]>("review-feedback/history", "POST", { target, after: 0 });
	await open();
	const firstText = "first line\noriginal review line\nlast line\n";
	let changeId = "";
	let firstCommit = "";
	turn = (cwd) => {
		writeFileSync(join(cwd, "review.txt"), firstText);
		jj(cwd, "commit", "-m", "Add review example");
		[changeId, firstCommit] = jj(cwd, "log", "--no-graph", "-r", "@-", "-T", 'change_id ++ " " ++ commit_id').split(
			" ",
		) as [string, string];
	};
	const created = await sessions.spawn({ projectId: f.project.id, message: "Create the review example" });
	await sessions["starting"].get(created.id);
	assert.equal(agents[0]?.turns, 1, sessions.get(created.id)?.error ?? "Fake agent did not finish its turn");
	// Join the work started by the worker's real idle packet. Do not call checkpoint/capture here.
	await sessions["workerReviewDelivery"]["tail"];
	const chats = await ok<{ chats: { id: string }[] }>(`projects/${f.project.id}/review`);
	assert.deepEqual(
		chats.chats.map((c) => c.id),
		[created.id],
	);
	const reviewPath = `sessions/${created.id}/review`;
	const page = await ok<{ comparisons: { snapshotId: string; request: NativeReviewSnapshot["request"] }[] }>(
		reviewPath,
	);
	const comparison = page.comparisons.find(
		(c) => c.request.head.commitId === firstCommit && c.request.scope.kind === "layer",
	);
	assert.ok(comparison, "production ownership observation retained the fake agent's exact jj commit");
	const snapshot = await ok<NativeReviewSnapshot>(`${reviewPath}/${comparison.snapshotId}`);
	assert.equal(snapshot.workerId, created.id);
	assert.equal(snapshot.request.changeId, changeId);
	assert.equal(snapshot.status, "complete");
	assert.match(
		(await ok<{ patch: string }>(`${reviewPath}/${snapshot.snapshotId}/patch`)).patch,
		/original review line/,
	);
	const target = await ok<ReviewDispositionTarget>("review-feedback/target", "POST", {
		projectId: f.project.id,
		sessionId: created.id,
		snapshotId: snapshot.snapshotId,
	});
	const blob = snapshot.after.find((e) => e.path === "review.txt")!;
	const source = await ok<{ text: string }>(
		`${reviewPath}/${snapshot.snapshotId}/source?side=after&path=review.txt&sha256=${blob.sha256}`,
	);
	assert.equal(source.text, firstText);
	const content: HumanReviewContent = {
		targets: [target],
		disposition: "comment",
		body: "Keep this explanation.\nThis is a fixture user's comment.",
		feedback: {
			draft: null,
			annotations: [
				{
					id: "original-line-comment",
					body: "Explain this exact line.",
					supersedes: null,
					anchor: {
						kind: "lines",
						snapshotId: snapshot.snapshotId,
						ranges: [
							lineRange(
								Buffer.from(source.text),
								{ side: "after", path: "review.txt", sha256: blob.sha256! },
								2,
								2,
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
	for (const token of ["", "forged-agent-capability"]) {
		assert.equal((await request("review-feedback/prepare", "POST", content, token)).status, 403);
		assert.equal(
			(await request("review-feedback/drafts/line-draft", "PUT", { expectedRevision: 0, content }, token)).status,
			403,
		);
	}
	const draft = await ok<HumanReviewDraft>("review-feedback/drafts/line-draft", "PUT", {
		expectedRevision: 0,
		content,
	});
	assert.deepEqual(draft.content, content);
	assert.deepEqual(await history(target), [], "saving a draft never submits feedback");
	const comment = await prepare({
		...content,
		feedback: { ...content.feedback!, draft: { id: draft.id, revision: draft.revision } },
	});
	const stale = operation(
		await prepare({ ...content, body: "Prepared before the first submission", feedback: undefined }),
	);
	const commentOp = operation(comment);
	assert.equal((await request("operations", "POST", commentOp, "")).status, 403);
	assert.deepEqual(await ok("operations/receipt", "POST", commentOp), { state: "unknown" });
	assert.deepEqual(await history(target), [], "lookup of a missing operation never submits it");
	const commentReceipt = await ok<OperationReceipt>("operations", "POST", commentOp);
	assert.equal(commentReceipt.state, "accepted", JSON.stringify(commentReceipt));
	assert.deepEqual(await ok("operations", "POST", commentOp), commentReceipt, "exact duplicate does not append");
	assert.deepEqual(await ok("operations/receipt", "POST", commentOp), commentReceipt);
	assert.notEqual((await request("operations/receipt", "POST", commentOp, "forged-agent-capability")).status, 200);
	assert.deepEqual(
		store!.humanReviews.targetState(target).blockingReviewIds,
		[],
		"Comment does not approve or request changes",
	);
	assert.equal(
		(await request("review-feedback/drafts/line-draft", "PUT", { expectedRevision: 0, content })).status,
		409,
		"stale draft revision cannot overwrite saved feedback",
	);
	assert.equal(
		(await ok<OperationReceipt>("operations", "POST", stale)).state,
		"rejected",
		"changed prior invalidates a held package",
	);
	assert.equal((await history(target)).length, 1);
	const changes = await prepare({
		targets: [target],
		disposition: "request_changes",
		body: "Change the second line before delivery.",
	});
	const changesOp = operation(changes);
	// Lose the HTTP ACK after the real native action has finished. Recovery only looks up this envelope.
	let forwarded = 0;
	const lossy = createServer(async (_req, res) => {
		forwarded++;
		await ok<OperationReceipt>("operations", "POST", changesOp);
		res.destroy();
	});
	lossy.listen(0, "127.0.0.1");
	await once(lossy, "listening");
	try {
		await assert.rejects(fetch(`http://127.0.0.1:${(lossy.address() as AddressInfo).port}`, { method: "POST" }));
	} finally {
		await new Promise<void>((resolve) => lossy.close(() => resolve()));
	}
	assert.equal(forwarded, 1);
	const changesReceipt = await ok<OperationReceipt>("operations/receipt", "POST", changesOp);
	assert.equal(changesReceipt.state, "accepted");
	const originalHistory = await history(target);
	assert.deepEqual(
		originalHistory.map((r) => r.record.confirmed),
		[comment, changes],
	);
	assert.equal(originalHistory[0]!.record.author.origin, "native-user");
	assert.equal(originalHistory[0]!.record.author.assurance, "practical-native-action");
	assert.equal(store!.humanReviews.targetState(target).blockingReviewIds.length, 1);
	assert.equal(
		(
			await ok<OperationReceipt>(
				"operations",
				"POST",
				operation(await prepare({ targets: [target], disposition: "approve", body: "Must remain unavailable" })),
			)
		).state,
		"rejected",
		"no fabricated checks or independent reviewer, no production Approve",
	);

	let nextCommit = "";
	turn = (cwd) => {
		jj(cwd, "edit", changeId);
		writeFileSync(join(cwd, "review.txt"), "first line\nrevised second line\nlast line\n");
		jj(cwd, "describe", "-m", "Revise review example");
		nextCommit = jj(cwd, "log", "--no-graph", "-r", "@", "-T", "commit_id");
		jj(cwd, "new");
	};
	await sessions.send(created.id, "Revise the example", "followUp", randomUUID());
	await until(() => agents[0]!.turns === 2);
	await sessions["workerReviewDelivery"]["tail"];
	const revisedPage = await ok<typeof page>(reviewPath);
	const revised = revisedPage.comparisons.find(
		(c) => c.request.head.commitId === nextCommit && c.request.scope.kind === "layer",
	);
	assert.ok(revised);
	const nextTarget = await ok<ReviewDispositionTarget>("review-feedback/target", "POST", {
		projectId: f.project.id,
		sessionId: created.id,
		snapshotId: revised.snapshotId,
	});
	assert.equal(nextTarget.changeId, target.changeId);
	assert.notEqual(nextTarget.headCommitId, target.headCommitId);
	assert.deepEqual(await history(nextTarget), [], "a revised change never inherits manual feedback");
	assert.deepEqual(store!.humanReviews.targetState(nextTarget).blockingReviewIds, []);
	assert.deepEqual(await history(target), originalHistory, "original exact review remains readable");
	assert.notEqual(
		(
			await request("review-feedback/prepare", "POST", {
				...changes,
				targets: [{ ...nextTarget, headCommitId: firstCommit }],
			})
		).status,
		200,
		"retained target cannot claim another commit",
	);
	const altered = { ...changes, targets: [nextTarget] };
	const alteredReceipt = await ok<OperationReceipt>("operations", "POST", operation(altered));
	assert.equal(alteredReceipt.state, "rejected", "old package cannot authorize a different revision");
	assert.notEqual(
		(
			await request("operations/receipt", "POST", {
				...changesOp,
				payload: JSON.stringify(altered),
				payloadHash: payloadHash(JSON.stringify(altered)),
			})
		).status,
		200,
		"same operation identity cannot change bytes",
	);

	await stop!();
	sessions = await f.manager();
	await open();
	assert.equal(agents.length, 1, "restart and passive reads never start another fake agent");
	assert.deepEqual(await history(target), originalHistory);
	assert.deepEqual(await history(nextTarget), []);
	assert.deepEqual(await ok("review-feedback/drafts/line-draft"), draft);
	assert.deepEqual(
		await ok("operations/receipt", "POST", changesOp),
		changesReceipt,
		"lost ACK reconciles after restart without resubmission",
	);
	assert.deepEqual(await ok("operations/receipt", "POST", commentOp), commentReceipt);
	assert.deepEqual(await ok("operations/receipt", "POST", stale), await ok("operations", "POST", stale));
	assert.equal(store!.humanReviews.targetState(target).blockingReviewIds.length, 1);
	assert.equal(store!.humanReviews.targetState(nextTarget).latestRecordId, null);
	assert.deepEqual(await ok<NativeReviewSnapshot>(`${reviewPath}/${snapshot.snapshotId}`), snapshot);
	assert.equal(store!.list().length, 0, "no synthetic mission, required request or gate activation");
	assert.equal(store!.reviewRequests.page(0).records.length, 0);
	assert.equal((await history(target)).length, 2);
	await f.assertSourceUnchanged();
	t.diagnostic(
		"real managed creation + jj capture; anchored draft; Comment + Request changes; duplicate dedupe; lost-ACK lookup; stale/package refusal; new-revision isolation; exact restart readback; Approve blocked",
	);
});

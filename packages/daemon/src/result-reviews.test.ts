import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeliveredWork, NativeReviewSnapshot } from "@pilot/protocol";
import { MissionStore } from "./missions.ts";
import { ResultReviews } from "./result-reviews.ts";

test("line comments read original bytes, reject unrelated snapshots and keep old context after a new result", async () => {
	const dir = await mkdtemp(join(tmpdir(), "result-anchors-"));
	const store = new MissionStore(join(dir, "missions.sqlite"));
	const page: DeliveredWork = {
		version: 1,
		subject: { kind: "chat", projectId: "p", sessionId: "worker" },
		targetId: "target",
		deliveryId: "a".repeat(64),
		ownerSessionId: "worker",
		submission: {
			id: "s",
			kind: "code",
			claim: "Fix",
			limitations: "",
			evidence: [{ kind: "snapshot", snapshotId: "snap" }],
		},
		pullRequests: [],
		artifacts: [],
		production: "not_tracked",
		verification: null,
		verificationCurrent: false,
		verificationReceiptState: "unknown",
		verificationRevision: 0,
		pendingOperationId: null,
	};
	const content = "first\r\nchanged\r\nlast\n";
	const snapshot: NativeReviewSnapshot = {
		snapshotId: "snap",
		workerId: "worker",
		request: {
			requestId: "r",
			repositoryId: "repo",
			changeId: "change",
			operationId: "op",
			base: { changeId: "change", commitId: "b".repeat(40) },
			head: { changeId: "change", commitId: "c".repeat(40) },
			scope: { kind: "layer" },
			source: "committed",
		},
		status: "complete",
		capturedAt: 1,
		enrollmentTaskIds: [],
		creation: { changeId: "change", commitId: "b".repeat(40), operationId: "op", kind: "created" },
		omissions: [],
		before: [],
		after: [
			{
				path: "src/file.ts",
				mode: "100644",
				gitOid: "c".repeat(40),
				state: "text",
				sha256: "d".repeat(64),
				bytes: Buffer.byteLength(content),
			},
		],
		changes: [
			{
				status: "added",
				beforePath: null,
				afterPath: "src/file.ts",
				beforeMode: "",
				afterMode: "100644",
				beforeOid: "",
				afterOid: "c".repeat(40),
			},
		],
		diff: { sha256: "e".repeat(64), bytes: 20 },
	};
	let revoked = false;
	const service = new ResultReviews({
		store,
		deliveries: { read: async () => structuredClone(page), readNow: () => structuredClone(page) },
		reader: () => ({
			get: async () => {
				if (revoked) throw Error("Revoked");
				return snapshot;
			},
			diff: async () => "unused",
			readExact: async () => Buffer.from(content),
		}),
	});
	try {
		const anchor = {
			kind: "lines" as const,
			snapshotId: "snap",
			side: "after" as const,
			path: "src/file.ts",
			start: 2,
			end: 3,
			blobSha256: "d".repeat(64),
			excerpt: "invented client words",
		};
		const edit = {
			operationId: "line-1",
			deliveryId: page.deliveryId!,
			expectedRevision: 0,
			kind: "comment" as const,
			body: "Keep these exact lines",
			anchor,
		};
		assert.equal(
			(
				(await service.save(page.subject, {
					...edit,
					operationId: "unrelated",
					anchor: { ...anchor, snapshotId: "unrelated" },
				})) as { state?: string }
			).state,
			"rejected",
		);
		const saved = await service.save(page.subject, edit);
		assert.equal(saved.anchor.kind, "lines");
		if (saved.anchor.kind !== "lines") throw Error("Expected line anchor");
		assert.equal(saved.anchor.excerpt, "changed\r\nlast\n");
		const beyond = await service.save(page.subject, {
			...edit,
			operationId: "phantom-final-line",
			expectedRevision: 1,
			anchor: { ...anchor, start: 4, end: 4 },
		});
		assert.equal(
			"state" in beyond && beyond.state,
			"rejected",
			"A final LF does not create a selectable empty source line",
		);
		assert.equal((await service.read(page.subject)).revision, 1);
		page.deliveryId = "f".repeat(64);
		delete page.submission;
		assert.equal((await service.read(page.subject)).entries[0]!.deliveryId, "a".repeat(64));
		assert.equal((await service.diff(page.subject, "snap")).files[0]!.after!.text, content);
		revoked = true;
		await assert.rejects(service.diff(page.subject, "snap"));
	} finally {
		await store.durable();
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("private comments keep original versions across reopen; stale saves and changed receipts refuse", async () => {
	const dir = await mkdtemp(join(tmpdir(), "result-review-"));
	let store = new MissionStore(join(dir, "missions.sqlite"));
	const page: DeliveredWork = {
		version: 1,
		subject: { kind: "chat", projectId: "project", sessionId: "worker" },
		targetId: "target",
		deliveryId: "a".repeat(64),
		ownerSessionId: "worker",
		pullRequests: [],
		artifacts: [],
		production: "not_tracked",
		verification: null,
		verificationCurrent: false,
		verificationReceiptState: "unknown",
		verificationRevision: 0,
		pendingOperationId: null,
	};
	const deliveries = { read: async () => structuredClone(page), readNow: () => structuredClone(page) };
	const make = () =>
		new ResultReviews({
			store,
			deliveries,
			reader: () => {
				throw Error("no linked comparison");
			},
		});
	try {
		let service = make();
		const edit = {
			operationId: "save-1",
			deliveryId: page.deliveryId!,
			expectedRevision: 0,
			kind: "comment" as const,
			body: "Check keyboard cancel",
			anchor: { kind: "general" as const },
		};
		const saved = await service.save(page.subject, edit);
		assert.equal("revision" in saved ? saved.revision : null, 1);
		await store.durable();
		store.close();
		store = new MissionStore(join(dir, "missions.sqlite"));
		service = make();
		assert.deepEqual(await service.lookup(page.subject, edit.operationId), saved);
		assert.deepEqual(await service.save(page.subject, edit), saved);
		await assert.rejects(service.save(page.subject, { ...edit, body: "Changed replay" }));
		const refused = await service.save(page.subject, { ...edit, operationId: "stale", body: "Other window" });
		assert.equal("state" in refused ? refused.state : null, "rejected");
		assert.deepEqual(await service.lookup(page.subject, "stale"), refused);
		page.deliveryId = "b".repeat(64);
		assert.equal((await service.read(page.subject)).entries[0]!.deliveryId, "a".repeat(64));
		assert.equal(
			"state" in (await service.save(page.subject, { ...edit, operationId: "old", expectedRevision: 1 })),
			true,
		);
		assert.equal((await service.read(page.subject)).entries.length, 1);
		assert.equal(page.verification, null);
	} finally {
		await store.durable();
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a long review pages without erasing old anchors or losing its personal note", async () => {
	const dir = await mkdtemp(join(tmpdir(), "result-pages-"));
	const store = new MissionStore(join(dir, "missions.sqlite"));
	const page: DeliveredWork = {
		version: 1,
		subject: { kind: "chat", projectId: "p", sessionId: "s" },
		targetId: "t",
		deliveryId: "a".repeat(64),
		ownerSessionId: "s",
		pullRequests: [],
		artifacts: [],
		production: "not_tracked",
		verification: null,
		verificationCurrent: false,
		verificationReceiptState: "unknown",
		verificationRevision: 0,
		pendingOperationId: null,
	};
	const service = new ResultReviews({
		store,
		deliveries: { read: async () => page, readNow: () => page },
		reader: () => {
			throw Error("No source");
		},
	});
	try {
		for (let i = 0; i < 105; i++)
			await service.save(page.subject, {
				operationId: `comment-${i}`,
				deliveryId: page.deliveryId!,
				expectedRevision: i,
				kind: i === 0 ? "note" : "comment",
				body: i === 0 ? "Only for me" : `Comment ${i}`,
				anchor: { kind: "general" },
			});
		const latest = await service.read(page.subject);
		assert.equal(latest.revision, 105);
		assert.equal(latest.entries.length, 20);
		assert.equal(latest.entries[0]!.revision, 86);
		assert.equal(latest.nextBefore, 86);
		assert.equal(latest.personalNote, "Only for me");
		const earlier = await service.read(page.subject, latest.nextBefore!);
		assert.equal(earlier.entries[0]!.revision, 66);
		assert.equal(earlier.entries.at(-1)!.revision, 85);
		assert.equal(earlier.revision, 105);
		assert.equal((await service.lookup(page.subject, "comment-1"))?.body, "Comment 1");
	} finally {
		await store.durable();
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

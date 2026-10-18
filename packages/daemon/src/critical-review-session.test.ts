import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { openSessionStorage } from "../../kernel/src/storage.ts";
import {
	captureSessionHistory,
	type SessionHistoryCapture,
	type SessionHistorySelection,
} from "./critical-review-session.ts";
import { CriticalReviewStore } from "./critical-review-store.ts";
import { CriticalReviewVault } from "./critical-review-vault.ts";

async function fixture() {
	const home = await realpath(await mkdtemp(join(tmpdir(), "review-session-")));
	const store = new CriticalReviewStore(join(home, "reviews", "records.sqlite"), () => 100);
	const vault = new CriticalReviewVault(join(home, "vault"), store);
	await vault.recover();
	const opened: (() => Promise<void>)[] = [];
	async function source(sourceId: string, text: string): Promise<SessionHistorySelection> {
		const directory = join(home, sourceId);
		const owned = await openSessionStorage(directory);
		const session = createSession(owned.storage);
		opened.push(async () => {
			await session.close(context);
			owned.release();
		});
		const { root, entry } = await session.commit(async (tx) => {
			const root = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const entry = await tx.appendEntry(root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: text, timestamp: 0 }],
			});
			await tx.createSubmission({
				conversationId: root.id,
				requestId: "legacy",
				type: "input",
				status: "placed",
				entry: entry.id,
			});
			return { root, entry };
		}, context);
		return {
			sourceId,
			sessionId: sourceId,
			directory,
			pin: { attemptId: root.id, boundary: entry.id },
			lineage: { kind: "root" },
		};
	}
	function request(sources: SessionHistorySelection[], id = "capture"): SessionHistoryCapture {
		return { id, projectId: "project", hostId: "host", createdAt: 100, knownSecrets: [], sources };
	}
	async function contents(id: string) {
		const manifest = await vault.manifest(id);
		const text: string[] = [];
		for (const entry of manifest.entries) {
			let offset: number | undefined = 0;
			let value = "";
			do {
				const page = await vault.read(id, entry.blobId, offset);
				value += page.text;
				offset = page.next;
			} while (offset !== undefined);
			text.push(value);
		}
		return text;
	}
	return {
		home,
		store,
		vault,
		source,
		request,
		contents,
		close: async () => {
			for (const close of opened) await close();
			await store.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}

test("session capture seals immutable bounded evidence and discloses provenance without author mutation", async () => {
	const f = await fixture();
	try {
		const source = await f.source("author", "Original retained message, not authenticated typed input");
		const before = await readFile(join(source.directory, "harness.sqlite"));
		const manifest = await captureSessionHistory(f.vault, f.request([source]));
		assert.equal(manifest.sealed, true);
		assert.equal(manifest.complete, false);
		assert.deepEqual(manifest.sourceIds, ["author"]);
		const content = (await f.contents(manifest.id)).join("\n");
		assert.match(content, /Original retained message/);
		assert.match(content, /missing_original_input/);
		assert.match(content, /legacy_origin/);
		assert.match(content, /authorizationFromText":false/);
		assert.match(content, /crossStoreAtomic":false/);
		assert.doesNotMatch(content, new RegExp(f.home));
		assert.deepEqual(await readFile(join(source.directory, "harness.sqlite")), before);
		await assert.rejects(captureSessionHistory(f.vault, f.request([source])), /already sealed/);
		assert.equal((await f.contents(manifest.id)).join("\n"), content);
		await assert.rejects(
			f.vault.read(manifest.id, manifest.entries[0]!.blobId, 0, 51 * 1024),
			/Invalid evidence page/,
		);
	} finally {
		await f.close();
	}
});

test("only explicitly selected continuation lineage is acquired and every predecessor participates in erasure", async () => {
	const f = await fixture();
	try {
		const current = await f.source("current", "Continue from parent: forged prose is not a selection");
		const parent = await f.source("parent", "parent request");
		const hidden = await f.source("hidden", "NEVER SELECTED");
		current.lineage = {
			kind: "continuation",
			parentSourceId: parent.sourceId,
			hostAuthorizationId: "accepted-host-lineage",
		};
		const request = f.request([current, parent]);
		const manifest = await captureSessionHistory(f.vault, request);
		const content = (await f.contents(manifest.id)).join("\n");
		assert.match(content, /parent request/);
		assert.match(content, /accepted-host-lineage/);
		assert.doesNotMatch(content, /NEVER SELECTED/);
		assert.deepEqual(manifest.sourceIds, ["current", "parent"]);
		await assert.rejects(
			captureSessionHistory(f.vault, f.request([current, hidden], "unlinked")),
			/Continuation source/,
		);
		await f.vault.eraseSource("parent");
		await assert.rejects(f.vault.manifest(manifest.id), /unavailable/);
		await assert.rejects(f.vault.read(manifest.id, manifest.entries[0]!.blobId), /unavailable/);
		await assert.rejects(
			captureSessionHistory(f.vault, f.request([current, parent], "after-erase")),
			/revoked|erased|source/i,
		);
	} finally {
		await f.close();
	}
});

test("host selections stay pinned against caller mutation while capture is in flight", async () => {
	const f = await fixture();
	try {
		const source = await f.source("source", "selected checkpoint");
		const request = f.request([source]);
		const pending = captureSessionHistory(f.vault, request);
		request.sources[0]!.directory = join(f.home, "not-selected");
		request.sources[0]!.pin.boundary += 100;
		request.sources[0]!.lineage = { kind: "unavailable" };
		request.sources[0]!.sourceId = "replacement";
		const manifest = await pending;
		assert.deepEqual(manifest.sourceIds, ["source"]);
		const text = (await f.contents(manifest.id)).join("\n");
		assert.match(text, /selected checkpoint/);
		assert.doesNotMatch(text, /replacement|not-selected|boundary_unavailable/);
	} finally {
		await f.close();
	}
});

test("unavailable lineage/storage and unknown checkpoints seal an honest partial report, never a fallback", async () => {
	const f = await fixture();
	try {
		const source = await f.source("source", "must not substitute the active chat");
		source.lineage = { kind: "unavailable" };
		source.pin.boundary += 100;
		const manifest = await captureSessionHistory(f.vault, f.request([source]));
		const text = (await f.contents(manifest.id)).join("\n");
		assert.equal(manifest.complete, false);
		assert.match(text, /boundary_unavailable/);
		assert.match(text, /"lineage":\{"kind":"unavailable"/);
		assert.doesNotMatch(text, /must not substitute/);
		const missing = { ...source, directory: join(f.home, "absent"), pin: { attemptId: 1, boundary: 0 } };
		await captureSessionHistory(f.vault, f.request([missing], "missing"));
		assert.match((await f.contents("missing")).join("\n"), /history_unavailable/);
		assert.equal((await readdir(f.home)).includes("absent"), false);
	} finally {
		await f.close();
	}
});

test("secret omission and source invalidation prevent raw-history reads and late publication", async (t) => {
	const f = await fixture();
	try {
		const source = await f.source("source", "synthetic private credential");
		const request = f.request([source]);
		request.knownSecrets = ["synthetic private credential"];
		const manifest = await captureSessionHistory(f.vault, request);
		assert.ok(manifest.omissions.some((item) => item.reason === "secret"));
		assert.doesNotMatch((await f.contents(manifest.id)).join("\n"), /synthetic private credential/);
		let entered!: () => void, release!: () => void;
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const capture = f.vault.capture.bind(f.vault);
		t.mock.method(f.vault, "capture", async (...args: Parameters<typeof capture>) => {
			entered();
			await gate;
			return capture(...args);
		});
		const pending = captureSessionHistory(f.vault, f.request([source], "revoked-during-capture"));
		const rejection = assert.rejects(pending, /invalidated|aborted/i);
		try {
			await reached;
			await f.vault.eraseSource("source");
		} finally {
			release();
		}
		await rejection;
		assert.equal(await f.store.get("evidence", "revoked-during-capture"), undefined);
		await assert.rejects(f.vault.manifest(manifest.id), /unavailable/);
	} finally {
		await f.close();
	}
});

test("cancellation before capture, during worker acquisition and during staging leaves no sealed or staged evidence", async (t) => {
	const f = await fixture();
	try {
		const source = await f.source("source", "offline fixture");
		await assert.rejects(captureSessionHistory(f.vault, f.request([source]), AbortSignal.abort()), /abort/i);
		const controller = new AbortController();
		const pending = captureSessionHistory(f.vault, f.request([source], "worker-cancel"), controller.signal);
		const cancelled = assert.rejects(pending, /cancel/i);
		controller.abort();
		await cancelled;
		let entered!: () => void, release!: () => void;
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const rpc = f.store.rpc.bind(f.store);
		let held = false;
		t.mock.method(f.store, "rpc", async (method: string, args: Record<string, unknown> = {}) => {
			const result = await rpc(method, args);
			if (method === "vaultStage" && !held) {
				held = true;
				entered();
				await gate;
			}
			return result;
		});
		const stagingController = new AbortController();
		const staging = captureSessionHistory(f.vault, f.request([source], "stage-cancel"), stagingController.signal);
		const rejected = assert.rejects(staging, /abort/i);
		try {
			await reached;
			stagingController.abort();
		} finally {
			release();
		}
		await rejected;
		assert.deepEqual(await f.store.list("evidence"), []);
		assert.deepEqual(await f.store.rpc("stagedCaptures"), []);
		assert.deepEqual(await readdir(f.vault.root), []);
		const resumed = await captureSessionHistory(f.vault, f.request([source], "after-cancel"));
		assert.equal(resumed.sealed, true, "cancellation releases capture admission and vault staging");
	} finally {
		await f.close();
	}
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { CriticalReviewEvidence } from "@pilot/protocol";
import { REVIEW_RETENTION } from "./critical-review-retention.ts";
import { CriticalReviewStore } from "./critical-review-store.ts";
import {
	CriticalReviewVault,
	evidenceDigest,
	REVIEW_VAULT_LIMITS,
	type ReviewCapture,
	type ReviewSelection,
} from "./critical-review-vault.ts";
import { canonicalJSON } from "./operation-journal.ts";

class LeasedVault extends CriticalReviewVault {
	hold(until: Promise<void>) {
		return this.serial(() => until);
	}
}
async function fixture(clock = () => 100) {
	const home = await realpath(await mkdtemp(join(tmpdir(), "review-vault-")));
	const store = new CriticalReviewStore(join(home, "db", "records.sqlite"), clock);
	const vault = new LeasedVault(join(home, "vault"), store);
	const capture = (selections: ReviewSelection[], id = "manifest"): ReviewCapture => ({
		id,
		projectId: "project",
		hostId: "host",
		sourceIds: ["source"],
		createdAt: 100,
		selections,
		knownSecrets: ["fixture-secret"],
	});
	return {
		home,
		store,
		vault,
		capture,
		close: async () => {
			await store.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}
const selection = (selectionId: string, text = "hello"): ReviewSelection => ({
	selectionId,
	sourceId: "source",
	label: `src/${selectionId}.ts`,
	selected: true,
	category: "source",
	bytes: Buffer.from(text),
});
const exactRequest = (manifest: CriticalReviewEvidence) => ({
	manifestId: manifest.id,
	manifestSha256: manifest.sha256,
	blobs: manifest.entries.map(({ blobId, sha256, bytes }) => ({ blobId, sha256, length: bytes })),
});

function replaceManifest(home: string, manifest: CriticalReviewEvidence): void {
	const db = new DatabaseSync(join(home, "db", "records.sqlite"));
	try {
		db.prepare("UPDATE review_records SET body=? WHERE kind='evidence' AND id=?").run(
			canonicalJSON(manifest),
			manifest.id,
		);
	} finally {
		db.close();
	}
}

test("sealed IDs, private bytes, no live paths, secret/unselected/binary omissions", async () => {
	const f = await fixture();
	try {
		const manifest = await f.vault.capture(
			f.capture([
				selection("safe"),
				{ ...selection("unselected"), selected: false, file: { root: "/never/open", relative: "file" } },
				{ ...selection("env"), label: ".env.local" },
				selection("known", "fixture-secret"),
				selection("token", `ghp_${"a".repeat(36)}`),
				{ ...selection("binary"), bytes: Buffer.from([0, 255]) },
			]),
		);
		assert.equal(manifest.entries.length, 1);
		assert.equal(manifest.complete, false);
		assert.deepEqual(
			manifest.omissions.map((item) => item.reason),
			["unselected", "secret", "secret", "secret", "binary"],
		);
		const entry = manifest.entries[0]!;
		assert.deepEqual(await f.vault.read(manifest.id, entry.blobId), { text: "hello" });
		assert.equal(JSON.stringify(manifest).includes(f.home), false);
		assert.equal((await stat(join(f.home, "vault"))).mode & 0o777, 0o700);
		assert.equal((await stat(join(f.home, "vault", manifest.id, entry.blobId))).mode & 0o777, 0o600);
		await assert.rejects(f.vault.read(manifest.id, "other"), /outside/);
		await assert.rejects(f.vault.read("../manifest", entry.blobId), /Invalid/);
		await assert.rejects(f.vault.capture(f.capture([selection("safe")])), /sealed/);
	} finally {
		await f.close();
	}
});

test("host selection rejects traversal, directory/file symlinks and secret files before reads", async () => {
	const f = await fixture();
	try {
		const source = join(f.home, "source");
		await mkdir(source);
		await writeFile(join(source, "safe.ts"), "selected source");
		await symlink(source, join(source, "link"));
		await symlink(join(source, "safe.ts"), join(source, "alias.ts"));
		const manifest = await f.vault.capture(
			f.capture(
				["safe.ts", "../source/safe.ts", "link/safe.ts", "alias.ts", ".env", "/etc/passwd"].map((path, n) => ({
					...selection(`s${n}`),
					bytes: undefined,
					file: { root: source, relative: path },
				})),
			),
		);
		assert.equal(manifest.entries.length, 1);
		assert.equal((await f.vault.read(manifest.id, manifest.entries[0]!.blobId)).text, "selected source");
		assert.equal(manifest.omissions.length, 5);
		assert.equal(manifest.omissions.find((item) => item.selectionId === "s4")!.reason, "secret");
	} finally {
		await f.close();
	}
});

test("blob/guidance/read/path limits are explicit and paginated", async () => {
	const f = await fixture();
	try {
		const manifest = await f.vault.capture(
			f.capture([
				{ ...selection("large"), bytes: Buffer.alloc(REVIEW_VAULT_LIMITS.blobBytes + 1, 97) },
				{
					...selection("guidance"),
					category: "guidance",
					bytes: Buffer.alloc(REVIEW_VAULT_LIMITS.guidanceBytes + 1, 97),
				},
				selection("safe", "abcdef"),
			]),
		);
		assert.deepEqual(
			manifest.omissions.map((x) => x.reason),
			["quota", "quota"],
		);
		const blob = manifest.entries[0]!.blobId;
		assert.deepEqual(await f.vault.read(manifest.id, blob, 0, 3), { text: "abc", next: 3 });
		assert.deepEqual(await f.vault.read(manifest.id, blob, 3, 3), { text: "def" });
		await assert.rejects(f.vault.read(manifest.id, blob, 0, 51201), /page/);
		await assert.rejects(
			f.vault.capture(
				f.capture(
					Array.from({ length: 20001 }, () => selection("x")),
					"over",
				),
			),
			/Invalid/,
		);
	} finally {
		await f.close();
	}
});

test("UTF-8 paging preserves exact text and rejects mid-character offsets", async () => {
	const f = await fixture();
	try {
		const manifest = await f.vault.capture(f.capture([selection("unicode", "aé🙂z")]));
		const blob = manifest.entries[0]!.blobId;
		assert.deepEqual(await f.vault.read(manifest.id, blob, 0, 2), { text: "a", next: 1 });
		assert.deepEqual(await f.vault.read(manifest.id, blob, 1, 2), { text: "é", next: 3 });
		assert.deepEqual(await f.vault.read(manifest.id, blob, 3, 4), { text: "🙂", next: 7 });
		await assert.rejects(f.vault.read(manifest.id, blob, 2, 4), /boundary/);
		await assert.rejects(f.vault.read(manifest.id, blob, 3, 1), /small/);
	} finally {
		await f.close();
	}
});

test("failed seal cleans staged bytes; modified/deleted blobs never fall back to live data", async () => {
	const f = await fixture();
	try {
		await assert.rejects(f.vault.capture(f.capture([selection("same"), selection("same")])), /identity/);
		assert.deepEqual(await readdir(join(f.home, "vault")), []);
		const manifest = await f.vault.capture(f.capture([selection("safe")]));
		const blob = manifest.entries[0]!.blobId;
		await writeFile(join(f.home, "vault", manifest.id, blob), "other");
		await assert.rejects(f.vault.read(manifest.id, blob), /digest/);
		await Promise.all([
			rm(join(f.home, "vault", manifest.id), { recursive: true, force: true }),
			f.vault.read(manifest.id, blob).catch(() => undefined),
		]);
		await assert.rejects(f.vault.read(manifest.id, blob));
		assert.equal(
			(await readFile(join(f.home, "db", "records.sqlite"))).includes(Buffer.from("fixture-secret")),
			false,
		);
	} finally {
		await f.close();
	}
});

test("exact reads preserve original BOM/CRLF/UTF-8/empty bytes and detach all results", {
	timeout: 10000,
}, async () => {
	const f = await fixture();
	try {
		const originals = [Buffer.from("\ufefffirst\r\né🙂\r\n"), Buffer.alloc(0)];
		const manifest = await f.vault.capture(
			f.capture(originals.map((bytes, i) => ({ ...selection(`s${i}`), bytes }))),
		);
		const request = exactRequest(manifest);
		request.blobs.reverse();
		const result = await f.vault.readExact(request);
		assert.deepEqual(result.manifest, manifest);
		assert.deepEqual(
			result.blobs.map(({ blobId }) => blobId),
			request.blobs.map(({ blobId }) => blobId),
		);
		for (const [i, entry] of manifest.entries.entries()) {
			const blob = result.blobs.find(({ blobId }) => blobId === entry.blobId)!;
			assert.deepEqual(blob.bytes, Uint8Array.from(originals[i]!));
			assert.equal(blob.length, originals[i]!.length);
			assert.equal(blob.sha256, await evidenceDigest(originals[i]!));
		}
		result.blobs[1]!.bytes.fill(0);
		result.manifest.entries[0]!.label = "changed";
		result.manifest.sourceIds.push("changed");
		request.blobs[0]!.sha256 = "0".repeat(64);
		const fresh = await f.vault.readExact(exactRequest(manifest));
		assert.deepEqual(fresh.manifest, manifest);
		assert.deepEqual(fresh.blobs[0]!.bytes, Uint8Array.from(originals[0]!));
		assert.deepEqual(fresh.blobs[1]!.bytes, new Uint8Array());
	} finally {
		await f.close();
	}
});

test("exact reads check all pins, membership and duplicates before opening blobs", { timeout: 10000 }, async () => {
	const f = await fixture();
	try {
		const manifest = await f.vault.capture(f.capture([selection("a"), selection("b")]));
		const other = await f.vault.capture(f.capture([selection("other")], "other"));
		const request = exactRequest(manifest);
		await assert.rejects(f.vault.readExact({ ...request, manifestId: "../manifest" }), /Invalid/);
		await assert.rejects(f.vault.readExact({ ...request, manifestSha256: "0".repeat(64) }), /pin/);
		await assert.rejects(
			f.vault.readExact({ ...request, blobs: [...request.blobs, request.blobs[0]!] }),
			/selection/,
		);
		await assert.rejects(f.vault.readExact({ ...request, blobs: exactRequest(other).blobs }), /selection/);
		for (const pin of [{ sha256: "0".repeat(64) }, { length: 4 }]) {
			await assert.rejects(
				f.vault.readExact({ ...request, blobs: [{ ...request.blobs[0]!, ...pin }] }),
				/selection/,
			);
		}
		// A missing first blob cannot hide an invalid later pin, even with a valid manifest hash.
		await rm(join(f.home, "vault", manifest.id, request.blobs[0]!.blobId));
		await assert.rejects(
			f.vault.readExact({ ...request, blobs: [request.blobs[0]!, { ...request.blobs[1]!, length: 6 }] }),
			/selection/,
		);
		const duplicate = { ...manifest, entries: [manifest.entries[0]!, manifest.entries[0]!] };
		duplicate.sha256 = await evidenceDigest(
			Buffer.from(canonicalJSON({ entries: duplicate.entries, omissions: [] })),
		);
		replaceManifest(f.home, duplicate);
		await assert.rejects(f.vault.readExact(exactRequest(duplicate)), /selection|pin/);
	} finally {
		await f.close();
	}
});

test("exact reads enforce selected count, blob and aggregate byte limits", { timeout: 10000 }, async () => {
	const f = await fixture();
	try {
		const manifest = await f.vault.capture(
			f.capture(
				Array.from({ length: 9 }, (_, i) => ({
					...selection(`s${i}`),
					bytes: Buffer.alloc(REVIEW_VAULT_LIMITS.exactReadBlobBytes, 97),
				})),
			),
		);
		const request = exactRequest(manifest);
		for (const length of [
			-1,
			0.5,
			NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER,
			REVIEW_VAULT_LIMITS.exactReadBlobBytes + 1,
		]) {
			await assert.rejects(
				f.vault.readExact({ ...request, blobs: [{ ...request.blobs[0]!, length }] }),
				/selection/,
			);
		}
		await assert.rejects(f.vault.readExact({ ...request, blobs: [] }), /request/);
		await assert.rejects(
			f.vault.readExact({ ...request, blobs: Array.from({ length: 21 }, () => request.blobs[0]!) }),
			/request/,
		);
		await assert.rejects(f.vault.readExact(request), /quota/);
		const result = await f.vault.readExact({ ...request, blobs: request.blobs.slice(0, 8) });
		assert.equal(
			result.blobs.reduce((n, blob) => n + blob.bytes.length, 0),
			REVIEW_VAULT_LIMITS.exactReadTotalBytes,
		);
	} finally {
		await f.close();
	}
});

test("exact reads reject missing, unsealed, changed, expired and erased evidence", { timeout: 10000 }, async () => {
	let now = 100;
	const f = await fixture(() => now);
	try {
		const manifest = await f.vault.capture(f.capture([selection("a")]));
		const request = exactRequest(manifest);
		await assert.rejects(f.vault.readExact({ ...request, manifestId: "missing" }), /unavailable/);
		replaceManifest(f.home, { ...manifest, sealed: false } as unknown as CriticalReviewEvidence);
		await assert.rejects(f.vault.readExact(request), /unavailable/);
		replaceManifest(f.home, { ...manifest, sha256: "0".repeat(64) });
		await assert.rejects(f.vault.readExact(request), /unavailable/);
		replaceManifest(f.home, manifest);
		now += REVIEW_RETENTION.rawMs;
		await assert.rejects(f.vault.readExact(request), /unavailable/);
		now = 100;
		await f.store.rpc("eraseSource", { source: "source" });
		// Tombstoned bytes may remain on disk, but neither read API can reopen them.
		assert.equal((await stat(join(f.home, "vault", manifest.id, request.blobs[0]!.blobId))).size, 5);
		await assert.rejects(f.vault.readExact(request), /unavailable/);
		await assert.rejects(f.vault.read(manifest.id, request.blobs[0]!.blobId), /unavailable/);
	} finally {
		await f.close();
	}
});

test("exact reads reject corrupt, truncated, missing and unsafe blob files", { timeout: 10000 }, async () => {
	const f = await fixture();
	try {
		const manifest = await f.vault.capture(f.capture([selection("a")]));
		const request = exactRequest(manifest);
		const path = join(f.home, "vault", manifest.id, request.blobs[0]!.blobId);
		await writeFile(path, "other");
		await assert.rejects(f.vault.readExact(request), /digest/);
		await writeFile(path, "hi");
		await assert.rejects(f.vault.readExact(request), /unavailable/);
		await rm(path);
		await assert.rejects(f.vault.readExact(request));
		await writeFile(join(f.home, "alias"), "hello");
		await symlink(join(f.home, "alias"), path);
		await assert.rejects(f.vault.readExact(request));
	} finally {
		await f.close();
	}
});

test("exact request snapshots and queued read/erase leases preserve ordering", { timeout: 10000 }, async () => {
	const f = await fixture();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const manifest = await f.vault.capture(f.capture([selection("a")]));
		const request = exactRequest(manifest);
		const held = f.vault.hold(gate);
		const read = f.vault.readExact(request);
		request.manifestId = "changed";
		request.blobs[0]!.sha256 = "0".repeat(64);
		const erase = f.vault.eraseSource("source");
		const laterRead = assert.rejects(f.vault.readExact(exactRequest(manifest)), /unavailable/);
		release();
		await held;
		const result = await read;
		assert.deepEqual(result.blobs[0]!.bytes, Uint8Array.from(Buffer.from("hello")));
		await erase;
		await laterRead;
		await assert.rejects(f.vault.read(manifest.id, manifest.entries[0]!.blobId), /unavailable/);
		// A completed erase does not recall already returned detached copies.
		assert.equal(Buffer.from(result.blobs[0]!.bytes).toString(), "hello");
	} finally {
		release();
		await f.close();
	}
});

test("exact reads honor pre-aborted and queued cancellation without blocking erase", { timeout: 10000 }, async () => {
	const f = await fixture();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const manifest = await f.vault.capture(f.capture([selection("a")]));
		const request = exactRequest(manifest);
		await assert.rejects(f.vault.readExact(request, AbortSignal.abort()), { name: "AbortError" });
		const held = f.vault.hold(gate);
		const controller = new AbortController();
		const read = assert.rejects(f.vault.readExact(request, controller.signal), { name: "AbortError" });
		controller.abort();
		const erase = f.vault.eraseSource("source");
		release();
		await Promise.all([held, read, erase]);
		await assert.rejects(f.vault.readExact(request), /unavailable/);
	} finally {
		release();
		await f.close();
	}
});

test("in-flight exact reads recheck cancellation, revocation and complete manifest metadata", {
	timeout: 10000,
}, async (t) => {
	for (const mode of ["cancel", "revoke", "change"] as const) {
		const f = await fixture();
		try {
			const manifest = await f.vault.capture(f.capture([selection("a", "a".repeat(128 * 1024))]));
			const controller = new AbortController();
			const probe = await open(join(f.home, "vault", manifest.id, manifest.entries[0]!.blobId), "r");
			const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
			await probe.close();
			const original = prototype.read;
			let reads = 0;
			const mocked = t.mock.method(prototype, "read", async function (this: typeof probe, ...args: unknown[]) {
				const result = await Reflect.apply(original, this, args);
				if (++reads === 1) {
					if (mode === "cancel") controller.abort();
					else if (mode === "revoke") await f.store.rpc("eraseSource", { source: "source" });
					else replaceManifest(f.home, { ...manifest, hostId: "changed" });
				}
				return result;
			});
			try {
				await assert.rejects(
					f.vault.readExact(exactRequest(manifest), controller.signal),
					mode === "cancel" ? { name: "AbortError" } : /unavailable|changed/,
				);
				assert.ok(reads >= 1, "cancellation/revocation occurs after a real file read");
				if (mode === "cancel") {
					assert.equal(reads, 1);
					assert.equal((await f.vault.readExact(exactRequest(manifest))).blobs[0]!.length, 128 * 1024);
				}
			} finally {
				mocked.mock.restore();
			}
		} finally {
			await f.close();
		}
	}
});

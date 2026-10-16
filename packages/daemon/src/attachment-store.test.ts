import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AttachmentUpload, DurableOperation, OperationHost } from "@pilot/protocol";
import { AttachmentStore } from "./attachment-store.ts";
import { payloadHash } from "./operation-journal.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
	"base64",
);
const origin: OperationHost = { hostId: "mac", daemonId: "origin", lineageId: "history" };
const destination: OperationHost = { hostId: "box", daemonId: "target", lineageId: "history" };
function metadata(bytes = png): AttachmentUpload {
	return { uploadId: randomUUID(), sha256: payloadHash(bytes.toString("binary")), bytes: bytes.length, origin };
}
function uploadMetadata(): AttachmentUpload {
	const value = metadata();
	// payloadHash intentionally accepts UTF-8 strings; image hashes use original binary bytes.
	value.sha256 = createHash("sha256").update(png).digest("hex");
	return value;
}

import { createHash } from "node:crypto";

async function* chunks(data = png) {
	for (let i = 0; i < data.length; i += 7) yield data.subarray(i, i + 7);
}
function operation(): DurableOperation {
	return {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: "app",
		sequence: 1,
		origin,
		destination,
		kind: "chat-create-attached",
		targetId: randomUUID(),
		payload: "{}",
		payloadHash: payloadHash("{}"),
	};
}
test("staging works before chat creation and uncertain receipt ownership survives restart", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-upload-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new AttachmentStore(home);
	const upload = uploadMetadata();
	const ref = await store.stage(upload, chunks());
	const op = operation();
	const paths = await store.adopt(op, [ref]);
	assert.equal(paths.length, 1);
	assert.deepEqual(await readFile(paths[0]!), png);
	assert.ok(paths[0]!.startsWith(home));
	const reopened = new AttachmentStore(home);
	assert.deepEqual(await reopened.adopt(op, [ref]), paths);
	await assert.rejects(reopened.discard(ref.uploadId), /Receipt-owned/);
	await assert.rejects(reopened.adopt({ ...op, operationId: randomUUID() }, [ref]), /another operation/);
});
test("invalid, incomplete, conflicting and cross-origin uploads never become adopted paths", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-upload-faults-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new AttachmentStore(home);
	const upload = uploadMetadata();
	await assert.rejects(store.stage(upload, chunks(png.subarray(0, 30))), /digest\/length/);
	await assert.rejects(store.adopt(operation(), [upload]), /not ready/);
	await store.stage(upload, chunks());
	await assert.rejects(store.stage({ ...upload, sha256: "0".repeat(64) }, chunks()), /other bytes\/owner/);
	await assert.rejects(store.adopt({ ...operation(), origin: destination }, [upload]), /another origin/);
	await assert.rejects(
		store.adopt(
			operation(),
			Array.from({ length: 9 }, () => upload),
		),
		/8 distinct/,
	);
	await assert.rejects(store.stage({ ...uploadMetadata(), bytes: 101 * 1024 * 1024 }, chunks()), /Invalid image/);
	await store.discard(upload.uploadId);
	await assert.rejects(store.adopt(operation(), [upload]), /not ready/);
});
test("same upload ID on separate hosts cannot substitute bytes, and PNG dimensions are bounded", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-upload-hosts-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const local = new AttachmentStore(join(home, "local"));
	const remote = new AttachmentStore(join(home, "remote"));
	const upload = uploadMetadata();
	await local.stage(upload, chunks());
	await assert.rejects(remote.adopt(operation(), [upload]), /not ready/);
	const huge = Buffer.from(png);
	huge.writeUInt32BE(24_000_001, 16);
	const invalid = { ...uploadMetadata(), sha256: createHash("sha256").update(huge).digest("hex") };
	await assert.rejects(remote.stage(invalid, chunks(huge)), /24 megapixels/);
});

test("transfer freeze covers admitted bodies, metadata and cleanup before releasing blockers", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-upload-freeze-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new AttachmentStore(home),
		upload = uploadMetadata();
	let finish!: () => void;
	const bodyGate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	async function* body() {
		await bodyGate;
		yield png;
	}
	const staging = store.stage(upload, body());
	assert.equal(store.blockers().length, 1, "registered before the first await");
	const release = store.freezeAdmissions();
	await assert.rejects(store.stage(uploadMetadata(), chunks()), /frozen/);
	await assert.rejects(store.discard(upload.uploadId), /frozen/);
	assert.equal(store.blockers().length, 1);
	finish();
	await staging;
	assert.deepEqual(store.blockers(), []);
	release();
	await store.discard(upload.uploadId);
});

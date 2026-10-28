import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { iterationManifest } from "./iteration-manifest.mjs";

test("local readiness signs exact source with unchanged publisher trust", () => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
	const archive = Buffer.from("synthetic full-payload bytes");
	const source = "a".repeat(40);
	const pem = privateKey.export({ type: "pkcs8", format: "pem" });
	const record = {
		schema: 1,
		source,
		platform: "macos",
		build: "101.1",
		version: "1.2.3",
		archive: "Pilot-Next-macos-arm64.zip",
		bytes: archive.length,
		sha256: createHash("sha256").update(archive).digest("hex"),
	};
	const result = iterationManifest(record, archive, source, pem, key);
	const signed = JSON.parse(result.signed);
	const bytes = Buffer.from(signed.signed, "base64");
	assert.equal(verify(null, bytes, publicKey, Buffer.from(signed.signature, "base64")), true);
	const manifest = JSON.parse(bytes);
	assert.equal(manifest.source, source);
	assert.equal(manifest.application_id, "com.babariviere.pilot-next");
	assert.equal(manifest.channel, "desktop-stable");
	assert.deepEqual(JSON.parse(result.pin), { schema: 1, source, archive_asset_id: 1 });
	assert.throws(() => iterationManifest(record, archive, "b".repeat(40), privateKey, key), /source/);
	assert.throws(() => iterationManifest(record, Buffer.from("changed"), source, privateKey, key), /identity/);
	assert.throws(() => iterationManifest(record, archive, source, pem, Buffer.alloc(32).toString("base64")), /key/);
});

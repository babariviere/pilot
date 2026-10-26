import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import test from "node:test";
import { fixtureEnvelope } from "./fixture-update.ts";

test("fixture signing binds exact archive and isolated synthetic identity", () => {
	const archive = Buffer.from("synthetic archive bytes, not a trusted production update");
	const { envelope, publicKey } = fixtureEnvelope(archive, "101.1", "0.1.1");
	const key = createPublicKey({
		key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64")]),
		format: "der",
		type: "spki",
	});
	const bytes = Buffer.from(envelope.signed, "base64");
	assert.equal(verify(null, bytes, key, Buffer.from(envelope.signature, "base64")), true);
	assert.equal(
		verify(null, Buffer.concat([bytes, Buffer.from(" ")]), key, Buffer.from(envelope.signature, "base64")),
		false,
	);
	const value = JSON.parse(bytes.toString());
	assert.equal(value.application_id, "com.example.synthetic.next");
	assert.equal(value.archive_size, archive.length);
	assert.equal(value.archive_asset_id, 12);
});

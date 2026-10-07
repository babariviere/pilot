import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("release verification checks exact archive bytes against bundled public key", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-signature-test-"));
	try {
		const archive = join(dir, "Pilot-arm64.zip");
		const data = Buffer.from("archive bytes");
		writeFileSync(archive, data);
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const rawKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
		const signature = sign(null, data, privateKey).toString("base64");
		const verify = (key = rawKey, sig = signature) =>
			spawnSync(process.execPath, [new URL("../verify-update.mjs", import.meta.url).pathname, archive, key, sig]);
		assert.equal(verify().status, 0);
		assert.notEqual(verify(Buffer.alloc(32).toString("base64")).status, 0);
		assert.notEqual(verify(rawKey, "invalid").status, 0);
		writeFileSync(archive, "tampered archive");
		assert.notEqual(verify().status, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

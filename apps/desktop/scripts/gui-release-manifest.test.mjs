import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assets, envelope, metadata, sealLinux, verifyRelease } from "./gui-release-manifest.mjs";

const source = "a".repeat(40);
const bytes = Buffer.from("synthetic GUI archive, not a production executable");
const keys = generateKeyPairSync("ed25519");
const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicBase64 = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
function record(platform = "macos") {
	return {
		schema: 1,
		platform,
		source,
		version: "1.2.3",
		build: "200.1",
		archive: assets[platform][0],
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

test("Rust metadata authenticates exact bytes, own asset ID and GUI identity", () => {
	const value = metadata(record(), bytes, "macos", 123, source, "v1.2.3");
	assert.equal(value.bundle_name, "Pilot Next.app");
	assert.equal(value.archive_name, "Pilot-Next-macos-arm64.zip");
	assert.equal(value.archive_asset_id, 123);
	const signed = JSON.parse(envelope(value, pem, publicBase64));
	assert.deepEqual(JSON.parse(Buffer.from(signed.signed, "base64")), value);
	assert(verify(null, Buffer.from(signed.signed, "base64"), keys.publicKey, Buffer.from(signed.signature, "base64")));
	assert(
		!verify(
			null,
			Buffer.from(`${Buffer.from(signed.signed, "base64")} `),
			keys.publicKey,
			Buffer.from(signed.signature, "base64"),
		),
	);
});

test("source/tag/platform/Swift archive/hash/size/build mismatches fail closed", () => {
	for (const change of [
		{ source: "b".repeat(40) },
		{ platform: "linux" },
		{ archive: "Pilot-arm64.zip" },
		{ sha256: "0".repeat(64) },
		{ bytes: 1 },
		{ build: "01.2" },
		{ version: "1.2.3-beta" },
	])
		assert.throws(() => metadata({ ...record(), ...change }, bytes, "macos", 123, source, "v1.2.3"));
	for (const id of [0, -1, NaN, 1.1]) assert.throws(() => metadata(record(), bytes, "macos", id, source, "v1.2.3"));
	assert.throws(() => metadata(record(), bytes, "macos", 123, source, "desktop-v1.2.3"));
});

test("Linux envelope binds full GUI ZIP and immutable source, never a headless runtime", () => {
	const value = metadata(record("linux"), bytes, "linux", 456, source, "v1.2.3");
	assert.equal(value.source, source);
	assert.equal(value.bundle_name, "Pilot Next");
	assert.equal(value.platform, "linux");
	assert.equal(value.archive_name, "Pilot-Next-linux-x64.zip");
});

test("signing requires matching explicitly pinned Ed25519 key", () => {
	assert.throws(() => envelope({}, pem, Buffer.alloc(32).toString("base64")), /compiled trust key/);
	const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
	assert.throws(() => envelope({}, rsa.privateKey.export({ type: "pkcs8", format: "pem" }), publicBase64), /Ed25519/);
});

test("finalization requires authenticated GUI envelopes matching current uploaded bytes", () => {
	const release = { draft: true, prerelease: false, tag_name: "v1.2.3", assets: [] };
	const envelopes = {};
	for (const [platform, [archiveName, manifestName]] of Object.entries(assets)) {
		const value = metadata(record(platform), bytes, platform, platform === "macos" ? 123 : 456, source, "v1.2.3");
		release.assets.push({
			id: value.archive_asset_id,
			name: archiveName,
			state: "uploaded",
			size: bytes.length,
			digest: `sha256:${value.archive_sha256}`,
		});
		envelopes[manifestName] = envelope(value, pem, publicBase64);
	}
	const both = ["macos", "linux"];
	verifyRelease(release, envelopes, publicBase64, source, "v1.2.3");
	verifyRelease(
		release,
		{ "desktop-macos-arm64-update.json": envelopes["desktop-macos-arm64-update.json"] },
		publicBase64,
		source,
		"v1.2.3",
		["macos"],
	);
	assert.throws(() =>
		verifyRelease(
			release,
			{ "desktop-macos-arm64-update.json": envelopes["desktop-macos-arm64-update.json"] },
			publicBase64,
			source,
			"v1.2.3",
		),
	);
	for (const change of [{ id: 999 }, { digest: `sha256:${"0".repeat(64)}` }, { size: 1 }, { state: "new" }]) {
		const changed = structuredClone(release);
		Object.assign(changed.assets[0], change);
		assert.throws(() => verifyRelease(changed, envelopes, publicBase64, source, "v1.2.3", both));
	}
	assert.throws(() => verifyRelease({ ...release, draft: false }, envelopes, publicBase64, source, "v1.2.3", both));
	assert.throws(() => verifyRelease(release, envelopes, Buffer.alloc(32).toString("base64"), source, "v1.2.3", both));
	assert.throws(() => verifyRelease(release, envelopes, publicBase64, "b".repeat(40), "v1.2.3", both));
});

test("Linux inventory signature covers raw bytes, refusal flags and identity", () => {
	const directory = mkdtempSync(join(tmpdir(), "gui-release-faux-"));
	try {
		const value = {
			schema: 1,
			kind: "linux-gui-distribution",
			source,
			bundle_build: "200.1",
			short_version: "1.2.3",
			build: { version: "1.2.3" },
			application_id: "com.babariviere.pilot-next",
			bundled_launch: true,
			installer: true,
			updater: true,
			native_visual_execution: false,
		};
		const path = join(directory, "linux-gui-package.json");
		const raw = `${JSON.stringify(value, null, 2)}\n`;
		writeFileSync(path, raw);
		sealLinux(directory, source, "200.1", pem, publicBase64);
		const signature = Buffer.from(readFileSync(join(directory, "linux-gui-package.sig"), "utf8").trim(), "base64");
		assert(verify(null, Buffer.from(raw), createPublicKey(pem), signature));
		assert(!verify(null, Buffer.from(JSON.stringify(value)), createPublicKey(pem), signature));
		for (const change of [
			{ bundled_launch: false },
			{ updater: false },
			{ native_visual_execution: true },
			{ source: "b".repeat(40) },
			{ bundle_build: "100" },
		]) {
			writeFileSync(path, JSON.stringify({ ...value, ...change }));
			assert.throws(() => sealLinux(directory, source, "200.1", pem, publicBase64));
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

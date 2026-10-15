import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { authenticateArchive, authenticateManifest, validateManifest } from "./release-manifest.mjs";
import { packagePlan, probe, serviceUnit } from "./service.mjs";

const good = {
	schemaVersion: 1,
	platform: "linux",
	arch: "x64",
	version: "1.38.0",
	tag: "v1.38.0",
	commit: "a".repeat(40),
	protocolVersion: 1,
	minimumClientProtocolVersion: 1,
	minimumGlibc: "2.28",
	node: { version: "24.21.0", modules: "137" },
	archive: { name: "Pilot-linux-x64.tar.gz", size: 1, sha256: "a".repeat(64) },
};

test("signed manifests reject tampering, wrong keys, unsupported schema/platform/protocol and archive substitution", () => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const data = Buffer.from(JSON.stringify(good));
	const signature = sign(null, data, privateKey);
	assert.deepEqual(authenticateManifest(data, signature, publicKey), good);
	assert.throws(() => authenticateManifest(Buffer.concat([data, Buffer.from(" ")]), signature, publicKey));
	assert.throws(() => authenticateManifest(data, signature, generateKeyPairSync("ed25519").publicKey));
	assert.throws(() => authenticateManifest(data, signature.subarray(1), publicKey));
	for (const override of [
		{ platform: "darwin" },
		{ schemaVersion: 2 },
		{ arch: "arm64" },
		{ tag: "v1.39.0" },
		{ protocolVersion: 3 },
		{ minimumClientProtocolVersion: 2 },
		{ archive: { ...good.archive, name: "../../bad" } },
	])
		assert.throws(() => validateManifest({ ...good, ...override }));
	assert.throws(() => authenticateArchive(good, Buffer.from("x")));
});

test("capability failures are explicit and dnf plans never request a global Node/pnpm/jj install", () => {
	const calls = [];
	const check = (command, args) => {
		calls.push([command, args]);
		return { ok: ["git", "bash", "dnf", "systemctl"].includes(command), output: "", error: "" };
	};
	const result = probe({ check, platform: "linux", arch: "x64", user: "fixture", uid: 1000 });
	assert.equal(result.ok, false);
	assert.equal(result.requirements.find((r) => r.id === "linger").ok, false);
	assert.deepEqual(result.lingerSetup.command, ["sudo", "loginctl", "enable-linger", "fixture"]);
	assert.equal(result.packagePlan.manager, "dnf");
	assert.ok(result.packagePlan.command.includes("systemd"));
	assert.ok(!result.packagePlan.command.some((arg) => /^(node|nodejs|pnpm|jj)$/.test(arg)));
	assert.ok(calls.every(([command, args]) => command !== "sudo" && !args.includes("enable-linger")));
	assert.equal(
		probe({ check, platform: "darwin", arch: "x64", user: "fixture", uid: 0 }).requirements.find(
			(r) => r.id === "user",
		).ok,
		false,
	);
	assert.equal(packagePlan(() => ({ ok: false })).command, null);
});

test("unit is relocatable, quotes paths, uses the private tools and orderly process-group shutdown", () => {
	const unit = serviceUnit('/home/u/runtime % " space', "/home/u");
	assert.match(unit, /ExecStart="\/home\/u\/runtime %% \\" space\/node\/bin\/node"/);
	assert.match(unit, /KillMode=mixed/);
	assert.match(unit, /TimeoutStopSec=120/);
	assert.match(unit, /WantedBy=default.target/);
	assert.match(unit, /UMask=0077/);
	assert.match(unit, /runtime %%/);
	assert.doesNotMatch(unit, /pnpm|nohup|sudo|enable-linger/);
	assert.throws(() => serviceUnit("/tmp/\nmalicious", "/home/u"));
	assert.throws(() => serviceUnit("/tmp/bad:path", "/home/u"));
	assert.match(serviceUnit("/tmp/$dollar", "/home/u"), /ExecStart="\/tmp\/\$\$dollar/);
});

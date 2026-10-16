import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authenticateArchive, authenticateManifest, validateManifest } from "./release-manifest.mjs";
import { packagePlan, probe, publishUnit, serviceUnit } from "./service.mjs";

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
	minimumGlibcxx: "3.4.21",
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
	const archive = Buffer.from("archive");
	authenticateArchive(
		{
			...good,
			archive: { ...good.archive, size: archive.length, sha256: createHash("sha256").update(archive).digest("hex") },
		},
		archive,
	);
});

test("release signing CLI requires the pinned key pair and rechecks the actual archive", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-signature-contract-"));
	try {
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const archive = Buffer.from("production archive");
		const manifest = {
			...good,
			archive: { ...good.archive, size: archive.length, sha256: createHash("sha256").update(archive).digest("hex") },
		};
		const data = Buffer.from(`${JSON.stringify(manifest)}\n`);
		writeFileSync(join(dir, "runtime-manifest.json"), data);
		writeFileSync(join(dir, "Pilot-linux-x64.tar.gz"), archive);
		const env = {
			...process.env,
			LINUX_RUNTIME_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }),
			LINUX_RUNTIME_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
		};
		const invoke = (overrides) =>
			spawnSync(process.execPath, [new URL("./release-manifest.mjs", import.meta.url).pathname, "sign", dir], {
				env: { ...env, ...overrides },
				encoding: "utf8",
			});
		const signed = invoke({});
		assert.equal(signed.status, 0, signed.stderr);
		const signature = Buffer.from(readFileSync(join(dir, "runtime-manifest.json.sig"), "utf8").trim(), "base64");
		assert.deepEqual(authenticateManifest(data, signature, publicKey), manifest);
		assert.notEqual(invoke({ LINUX_RUNTIME_PUBLIC_KEY: Buffer.alloc(32).toString("base64") }).status, 0);
		assert.notEqual(invoke({ LINUX_RUNTIME_PRIVATE_KEY: "" }).status, 0);
		writeFileSync(join(dir, "Pilot-linux-x64.tar.gz"), "bad");
		assert.notEqual(invoke({}).status, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
	assert.match(unit, /WorkingDirectory=%h\n/);
	assert.match(unit, /ExecStartPre=-.*linux-coordinator-probe.ts.*--output.*coordinator-preflight.json/);
	assert.match(unit, /UMask=0077/);
	assert.match(unit, /runtime %%/);
	assert.doesNotMatch(unit, /pnpm|nohup|sudo|enable-linger/);
	assert.throws(() => serviceUnit("/tmp/\nmalicious", "/home/u"));
	assert.throws(() => serviceUnit("/tmp/bad:path", "/home/u"));
	assert.match(serviceUnit("/tmp/$dollar", "/home/u"), /ExecStart="\/tmp\/\$\$dollar/);
});

test("atomic unit publication is idempotent but never replaces a different concurrent installer", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-unit-publish-"));
	try {
		const file = join(dir, "user/pilotd.service");
		publishUnit(file, "first runtime");
		publishUnit(file, "first runtime");
		assert.throws(() => publishUnit(file, "different runtime"));
		assert.equal(readFileSync(file, "utf8"), "first runtime");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("initial service installation fails closed, never overwrites foreign units and does not start implicitly", {
	skip: process.platform !== "linux" || process.getuid() === 0,
}, () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-service-contract-"));
	try {
		const home = join(dir, "home");
		const root = join(dir, "runtime with spaces");
		const tools = join(dir, "tools");
		const unit = join(home, ".config/systemd/user/pilotd.service");
		for (const path of [home, root, tools, join(root, "node/bin")]) mkdirSync(path, { recursive: true });
		copyFileSync(new URL("./service.mjs", import.meta.url), join(root, "service.mjs"));
		for (const command of ["bash", "git", "dnf"])
			writeFileSync(join(tools, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		writeFileSync(join(tools, "loginctl"), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_LINGER"\n', { mode: 0o755 });
		writeFileSync(
			join(tools, "systemctl"),
			'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_LOG"\ncase "$*" in *FragmentPath*) printf "%s" "$FIXTURE_FRAGMENT";; esac\n',
			{ mode: 0o755 },
		);
		const node = join(root, "node/bin/node");
		writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const env = {
			...process.env,
			HOME: home,
			PATH: tools,
			FIXTURE_LOG: join(dir, "commands"),
			FIXTURE_LINGER: "no",
			FIXTURE_FRAGMENT: "",
		};
		const invoke = (action, overrides = {}) =>
			spawnSync(process.execPath, [join(root, "service.mjs"), action], {
				env: { ...env, ...overrides },
				encoding: "utf8",
			});
		assert.notEqual(invoke("install").status, 0);
		assert.equal(existsSync(unit), false);
		env.FIXTURE_LINGER = "yes";
		assert.notEqual(invoke("install", { FIXTURE_FRAGMENT: "/usr/lib/systemd/user/pilotd.service" }).status, 0);
		assert.equal(existsSync(unit), false);
		writeFileSync(node, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		assert.notEqual(invoke("install").status, 0);
		assert.equal(existsSync(unit), false);
		writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const installed = invoke("install");
		assert.equal(installed.status, 0, installed.stderr);
		assert.equal(JSON.parse(installed.stdout).started, false);
		assert.match(readFileSync(unit, "utf8"), /runtime with spaces\/node\/bin\/node/);
		assert.doesNotMatch(readFileSync(env.FIXTURE_LOG, "utf8"), /--user start/);
		writeFileSync(unit, "foreign unit\n");
		for (const action of ["install", "start", "stop"]) assert.notEqual(invoke(action).status, 0);
		assert.equal(readFileSync(unit, "utf8"), "foreign unit\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

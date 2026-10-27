import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import release from "../../../package.json" with { type: "json" };
import { daemonHello } from "./hello.ts";
import { inspectRuntime, OWNER_FILE, ownRuntime, type RuntimeBuild } from "./runtime-owner.ts";
import { type ReservationReceipt, UpdateReservation } from "./update-reservation.ts";

const build: RuntimeBuild = {
	schema: 1,
	source: "a".repeat(40),
	version: release.version,
	protocol: 1,
	platform: process.platform,
	arch: process.arch,
	node: process.versions.node,
};
const capabilities = {
	independentExecution: true,
	coordinatorIsolation: false,
	powerManagement: false,
	systemSleepEvents: false,
	swiftUIArtifacts: false,
};
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), "pilot-owner-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return join(root, "profile");
}
async function port(): Promise<number> {
	const server = createServer();
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const value = (server.address() as { port: number }).port;
	await new Promise<void>((ok) => server.close(() => ok()));
	return value;
}
test("profile lease precedes listener/ready, refuses duplicate owners and preserves the permanent inode", async (t) => {
	const home = await fixture(t),
		p = await port();
	const owner = await ownRuntime(home, p, true, build);
	t.after(() => owner.close());
	assert.equal(await inspectRuntime(home, p, build), "starting");
	assert.equal((await fetch(`http://127.0.0.1:${p}/api/hello`)).status, 503);
	await assert.rejects(ownRuntime(home, p + 1, true, build), /runtime_profile_owned/);
	const hello = await daemonHello(home, capabilities);
	owner.install((_, res) => res.end("fixture"));
	owner.ready(hello);
	assert.equal(owner.server.requestTimeout, 300_000);
	assert.equal(owner.server.headersTimeout, 60_000);
	assert.equal(owner.server.keepAliveTimeout, 5000);
	assert.equal(owner.server.maxConnections, undefined);
	assert.equal(await inspectRuntime(home, p, build), "ready");
	assert.equal(await (await fetch(`http://127.0.0.1:${p}/api/hello`)).text(), "fixture");
	const before = await readFile(join(home, OWNER_FILE));
	await owner.close();
	assert.equal(await inspectRuntime(home, p, build), "idle");
	assert.deepEqual(await readFile(join(home, OWNER_FILE)), before);
	const successor = await ownRuntime(home, p, true, build);
	await successor.close();
});
test("bundled admission never adopts a legacy profile, even an empty existing directory", async (t) => {
	const home = await fixture(t);
	await mkdir(home, { mode: 0o700 });
	await writeFile(join(home, "retained-draft"), "unchanged", { mode: 0o600 });
	await assert.rejects(ownRuntime(home, await port(), true, build), /runtime_profile_unproven/);
	await assert.rejects(readFile(join(home, OWNER_FILE)), { code: "ENOENT" });
	assert.equal(await readFile(join(home, "retained-draft"), "utf8"), "unchanged");
});
test("retained startup pins the live record and signed module root without changing legacy callers", async (t) => {
	const home = await fixture(t),
		p = await port(),
		root = join(home, "retained-runtime");
	const owner = await ownRuntime(home, p, true, build, root);
	t.after(() => owner.close());
	owner.ready(await daemonHello(home, capabilities));
	assert.equal(await inspectRuntime(home, p, build, root), "ready");
	await assert.rejects(inspectRuntime(home, p, build, join(home, "replaceable-app")), /runtime_incompatible/);
	const recordPath = join(home, ".daemon-owner.json");
	const original = await readFile(recordPath, "utf8");
	const redirected = join(home, "forged-root");
	await writeFile(recordPath, JSON.stringify({ ...JSON.parse(original), runtimeRoot: redirected }), { mode: 0o600 });
	await assert.rejects(inspectRuntime(home, p, build, redirected), /runtime_proof_invalid/);
	await writeFile(recordPath, original, { mode: 0o600 });
	assert.equal(await inspectRuntime(home, p, build), "ready");
	await owner.close();
	assert.equal(await inspectRuntime(home, p, build, redirected), "idle");
});
test("a guarded ordinary runtime can be attested, but its legacy profile cannot be auto-started", async (t) => {
	const home = await fixture(t),
		p = await port();
	await mkdir(home, { mode: 0o700 });
	const owner = await ownRuntime(home, p, false, build);
	t.after(() => owner.close());
	owner.ready(await daemonHello(home, capabilities));
	assert.equal(await inspectRuntime(home, p, build), "ready");
	await owner.close();
	await assert.rejects(inspectRuntime(home, p, build), /runtime_profile_unproven/);
	await assert.rejects(ownRuntime(home, p, true, build), /runtime_profile_unproven/);
});
test("wrong source, version, architecture, port and changed canonical identity fail closed", async (t) => {
	const home = await fixture(t),
		p = await port();
	const owner = await ownRuntime(home, p, true, build);
	t.after(() => owner.close());
	owner.ready(await daemonHello(home, capabilities));
	for (const altered of [{ source: "b".repeat(40) }, { version: "0.0.0" }, { arch: "wrong" }]) {
		await assert.rejects(inspectRuntime(home, p, { ...build, ...altered }), /runtime_incompatible/);
	}
	await assert.rejects(inspectRuntime(home, p + 1, build), /runtime_incompatible/);
	await writeFile(join(home, "daemon-id"), "not-the-daemon", { mode: 0o600 });
	await assert.rejects(inspectRuntime(home, p, build), /runtime_identity_changed/);
});
test("a matching hello/PID/record cannot substitute for a live lease and signed boot challenge", async (t) => {
	const home = await fixture(t),
		p = await port();
	const owner = await ownRuntime(home, p, true, build);
	t.after(() => owner.close());
	const recordPath = join(home, ".daemon-owner.json");
	const original = await readFile(recordPath, "utf8");
	const record = JSON.parse(original);
	await writeFile(recordPath, JSON.stringify({ ...record, secret: "0".repeat(64) }));
	await assert.rejects(inspectRuntime(home, p, build), /runtime_proof_invalid/);
	await writeFile(recordPath, original);
	await owner.close();
	const fake = createServer((_, res) => res.end(JSON.stringify({ daemonId: "spoofed", pid: record.pid })));
	await new Promise<void>((ok) => fake.listen(p, "127.0.0.1", ok));
	t.after(() => new Promise<void>((ok) => fake.close(() => ok())));
	assert.equal(await inspectRuntime(home, p, build), "idle"); // Never reuse an unlocked stale record.
	await assert.rejects(ownRuntime(home, p, true, build), /runtime_listener_unavailable/);
});
test("symlinked profile/lease, malformed/truncated and oversized owner records are refused", async (t) => {
	const home = await fixture(t),
		p = await port();
	const owner = await ownRuntime(home, p, true, build);
	t.after(() => owner.close());
	const path = join(home, ".daemon-owner.json");
	for (const text of ["{", "x".repeat(20_000)]) {
		await writeFile(path, text);
		await assert.rejects(inspectRuntime(home, p, build), /runtime_owner_unconfirmed/);
	}
	const alias = `${home}-alias`;
	await symlink(home, alias);
	await assert.rejects(ownRuntime(alias, p, true, build), /runtime_profile_unsafe/);
	await owner.close();
	await rm(join(home, OWNER_FILE));
	await symlink(join(home, "retained"), join(home, OWNER_FILE));
	await assert.rejects(ownRuntime(home, p, true, build));
});

test("native update proof pins boot/root and an uninterrupted idle reservation without lifecycle signals", async (t) => {
	const home = await fixture(t),
		p = await port();
	const runtimeRoot = "/synthetic/immutable/Contents/Resources/runtime";
	const owner = await ownRuntime(home, p, true, build, runtimeRoot);
	let frozen = 0,
		clock = 0;
	const gate = new UpdateReservation(
		{
			freezeAdmissions() {
				frozen++;
				return () => {
					frozen--;
				};
			},
			async blockers() {
				return [];
			},
		},
		() => clock,
		100,
	);
	t.after(async () => {
		gate.close();
		await owner.close();
	});
	owner.updates(async (action, value) => {
		const receipt = value as ReservationReceipt;
		if (action === "prepare") return gate.prepare(receipt.operationId);
		if (action === "cancel") {
			gate.cancel(receipt);
			return receipt;
		}
		return gate.verify(receipt);
	});
	owner.ready(await daemonHello(home, capabilities));
	const record = JSON.parse(await readFile(join(home, ".daemon-owner.json"), "utf8"));
	assert.equal(record.runtimeRoot, runtimeRoot);
	const mac = (body: string) =>
		createHmac("sha256", Buffer.from(record.secret, "hex")).update(`update/v1\n${body}`).digest("hex");
	async function request(
		action: string,
		receipt: unknown,
		altered: Record<string, unknown> = {},
		headers: Record<string, string> = {},
	) {
		const raw = JSON.stringify({ boot: record.boot, nonce: "a".repeat(64), action, receipt, ...altered });
		return fetch(`http://127.0.0.1:${p}/__pilot_runtime_update/v1`, {
			method: "POST",
			headers: { "x-pilot-update-proof": mac(raw), ...headers },
			body: raw,
		});
	}
	const input = { operationId: "12345678-1234-1234-1234-123456789abc" };
	assert.equal((await request("prepare", input, {}, { origin: "https://untrusted.invalid" })).status, 403);
	assert.equal((await request("prepare", input, { boot: "wrong" })).status, 409);
	assert.equal((await request("prepare", input, {}, { "x-pilot-update-proof": "0".repeat(64) })).status, 409);
	assert.equal(frozen, 0);
	const response = await request("prepare", input);
	assert.equal(response.status, 200);
	const envelope = (await response.json()) as { body: string; mac: string };
	assert.equal(envelope.mac, mac(envelope.body));
	const proof = JSON.parse(envelope.body);
	assert.equal(proof.runtimeRoot, runtimeRoot);
	assert.deepEqual(proof.build, build);
	assert.equal(frozen, 1);
	assert.equal((await request("verify", proof.receipt)).status, 200);
	clock = 100;
	assert.equal((await request("verify", proof.receipt)).status, 409);
	assert.equal(frozen, 0);
	assert.equal((await request("prepare", input)).status, 409);
});

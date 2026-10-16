import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { CredentialClient } from "@pilot/kernel/credential-client";
import type { SetupChallenge, SetupRun, SetupServerMessage } from "@pilot/protocol";
import { WebSocket } from "ws";
import { CredentialBroker } from "./credential-broker.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { SetupService } from "./setup.ts";
import { TerminalManager } from "./terminals.ts";

const worker = new URL("./setup-worker.ts", import.meta.url).href;
const clientModule = new URL("../../kernel/src/credential-client.ts", import.meta.url).href;
const fakeNetwork = `
globalThis.fetch=async(input)=>{
 const url=String(input);
 if(url.endsWith('/deviceauth/usercode')) return Response.json({device_auth_id:'private-device',user_code:'ABCD-EFGH',interval:0});
 if(url.endsWith('/deviceauth/token')) return Response.json({authorization_code:'private-auth-code',code_verifier:'private-verifier'});
 if(url==='https://platform.claude.com/v1/oauth/token') return Response.json({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600});
 if(url==='https://auth.openai.com/oauth/token') return Response.json({access_token:'e30.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}})).toString('base64')+'.x',refresh_token:'private-refresh',expires_in:3600});
 throw Error('No real network in setup fixtures');
};`;

async function fixture(
	t: TestContext,
	helper = `${fakeNetwork}\nawait import(${JSON.stringify(worker)});`,
	timeoutMs = 5000,
) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pilot-setup-test-")));
	const helperFile = join(dir, "helper.mjs");
	await writeFile(helperFile, helper);
	const broker = new CredentialBroker(dir);
	await broker.start();
	const setup = new SetupService(broker, {
		helperFile,
		timeoutMs,
		mcp: () => ({ checking: false, servers: [{ name: "linear", transport: "http", state: "connected" }] }),
	});
	t.after(async () => {
		await setup.close();
		await broker.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { dir, broker, setup };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 8000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Setup fixture timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
const runRequest = { provider: "anthropic", method: "manual_code" } as const;

test("real pre-chat PTY uses pinned SDK, canonical scoped broker and hidden single-use input without config writes", async (t) => {
	const checkScope = `
const {credentialClient}=await import(${JSON.stringify(clientModule)});
const c=credentialClient();
if(process.env.PILOT_SETUP_CANARY || process.env.ANTHROPIC_API_KEY || process.env.NODE_OPTIONS) throw Error('Inherited secret environment');
try {await c.request({op:'read',namespace:'pi',key:'openai'});throw Error('scope allowed');}catch(e){if(e.code!=='unauthorized')throw e;}
if((await c.pi.list()).some(v=>v.providerId!=='anthropic'))throw Error('list scope allowed');
`;
	const { dir, setup } = await fixture(t, `${checkScope}\n${fakeNetwork}\nawait import(${JSON.stringify(worker)});`);
	await writeFile(join(dir, "settings.json"), '{"extensions":["must-not-load"]}', { mode: 0o600 });
	await writeFile(join(dir, "models.json"), "malformed executable configuration", { mode: 0o600 });
	const old = process.env.PILOT_SETUP_CANARY;
	process.env.PILOT_SETUP_CANARY = "private-environment";
	t.after(() => {
		if (old === undefined) delete process.env.PILOT_SETUP_CANARY;
		else process.env.PILOT_SETUP_CANARY = old;
	});
	const readiness = await setup.readiness();
	assert.equal(readiness.providers.find((p) => p.id === "anthropic")!.credential, "missing");
	assert.equal(readiness.integrations[0]!.state, "connected");
	assert.equal(readiness.integrations[1]!.state, "not_configured");
	assert.ok(readiness.integrations.every((entry) => entry.login === "unsupported"));
	const run = setup.start(runRequest),
		messages: SetupServerMessage[] = [];
	setup.attach(run.id, (message) => messages.push(message));
	assert.throws(() => setup.start(runRequest), /still running/);
	await until(() => messages.some((message) => message.type === "setup.challenge"));
	const challenge = (messages.find((m) => m.type === "setup.challenge") as { challenge: SetupChallenge }).challenge;
	assert.throws(() => setup.answer(run.id, challenge.id, "private-code#wrong-state"), /complete code#state/);
	const answer = `private-code#${new URL(challenge.url).searchParams.get("state")}`;
	setup.answer(run.id, challenge.id, answer);
	assert.throws(() => setup.answer(run.id, challenge.id, answer), /no longer/);
	await until(() => setup.get(run.id).state === "done");
	assert.equal(setup.blockers().length, 0);
	assert.equal((await setup.readiness()).providers.find((p) => p.id === "anthropic")!.credential, "configured");
	const stored = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
	assert.equal(stored.anthropic.access, "private-access");
	const replay: SetupServerMessage[] = [];
	setup.attach(run.id, (message) => replay.push(message));
	assert.equal(replay.length, 1);
	for (const secret of [answer, "private-code", "private-access", "private-refresh", "private-environment"])
		assert.equal(JSON.stringify([...messages, ...replay, readiness]).includes(secret), false);
	assert.equal(await readFile(join(dir, "models.json"), "utf8"), "malformed executable configuration");
	assert.equal(await readFile(join(dir, "settings.json"), "utf8"), '{"extensions":["must-not-load"]}');
});

test("device setup completes without any manual input, while distinct hosts retain independent auth", async (t) => {
	const first = await fixture(t),
		second = await fixture(t);
	const run = first.setup.start({ provider: "openai-codex", method: "device_code" });
	await until(() => first.setup.get(run.id).state === "done");
	assert.equal(
		(await first.setup.readiness()).providers.find((p) => p.id === "openai-codex")!.credential,
		"configured",
	);
	assert.equal((await second.setup.readiness()).providers.find((p) => p.id === "openai-codex")!.credential, "missing");
	assert.throws(() => second.setup.get(run.id), /Unknown setup/);
	assert.equal(await readFile(join(second.dir, "auth.json"), "utf8"), "{}");
});

test("cancel fences delayed auth, timeout requires reauthentication and live/retiring PTYs block frozen updates", async (t) => {
	const { setup, broker, dir } = await fixture(t);
	const run = setup.start(runRequest);
	await until(() => setup.get(run.id).state === "waiting");
	const release = setup.freezeAdmissions(),
		releaseOther = setup.freezeAdmissions();
	release();
	release();
	assert.throws(() => setup.start({ provider: "openai-codex", method: "device_code" }), /frozen/);
	assert.equal(setup.blockers().length, 1);
	const cancelled = await setup.cancel(run.id);
	assert.equal(cancelled.state, "cancelled");
	assert.equal(cancelled.reauthenticationRequired, true);
	await until(() => setup.blockers().length === 0);
	releaseOther();
	assert.equal(
		(await setup.readiness()).providers.find((p) => p.id === "anthropic")!.credential,
		"reauthentication_required",
	);
	assert.equal(await readFile(join(dir, "auth.json"), "utf8"), "{}");
	assert.deepEqual(await setup.logout("anthropic"), { state: "missing" });
	assert.equal((await setup.readiness()).providers.find((p) => p.id === "anthropic")!.credential, "missing");
	const endpoint = broker.grant(),
		client = new CredentialClient(endpoint);
	assert.deepEqual(await client.request({ op: "status", namespace: "pi", key: "anthropic" }), { state: "missing" });
	broker.revoke(endpoint);
	await client.close();
	const timeoutFixture = await fixture(t, `${fakeNetwork}\nawait import(${JSON.stringify(worker)});`, 500);
	const timeout = timeoutFixture.setup.start(runRequest);
	await until(() => timeoutFixture.setup.get(timeout.id).state === "failed");
	assert.equal(timeoutFixture.setup.get(timeout.id).reauthenticationRequired, true);
});

test("oversized or secret-bearing raw helper output is never forwarded/replayed; stopped helper retains no challenge", async (t) => {
	for (const text of ["private-token-server-body\n", "x".repeat(70_000)]) {
		const { setup } = await fixture(t, `process.stdout.write(${JSON.stringify(text)});setInterval(()=>{},1000);`);
		const run = setup.start(runRequest),
			messages: SetupServerMessage[] = [];
		setup.attach(run.id, (value) => messages.push(value));
		await until(() => setup.get(run.id).state === "failed");
		await until(() => setup.blockers().length === 0);
		assert.equal(JSON.stringify(messages).includes("private-token-server-body"), false);
		assert.equal(
			messages.some((m) => m.type === "setup.output"),
			false,
		);
		assert.equal(JSON.stringify(setup.list()).includes("private-token"), false);
	}
});

test("hard helper death and authority restart retain uncertainty; unavailable brokerage fails closed", async (t) => {
	const pidMarker = `await (await import('node:fs/promises')).writeFile(new URL('./helper.pid',import.meta.url),String(process.pid));`;
	const { setup, broker, dir } = await fixture(
		t,
		`${pidMarker}\n${fakeNetwork}\nawait import(${JSON.stringify(worker)});`,
	);
	const run = setup.start(runRequest);
	await until(() => setup.get(run.id).state === "waiting");
	const pid = Number(await readFile(join(dir, "helper.pid"), "utf8"));
	process.kill(pid, "SIGKILL");
	await until(() => setup.get(run.id).state === "failed");
	await until(() => setup.blockers().length === 0);
	assert.equal(setup.get(run.id).reauthenticationRequired, true);
	await setup.close();
	await broker.close();
	const restarted = new CredentialBroker(dir);
	await restarted.start();
	const endpoint = restarted.grant(),
		client = new CredentialClient(endpoint);
	try {
		assert.deepEqual(await client.request({ op: "status", namespace: "pi", key: "anthropic" }), {
			state: "reauthentication_required",
		});
		await assert.rejects(setup.readiness(), /authority unavailable/);
		assert.equal(await readFile(join(dir, "auth.json"), "utf8"), "{}");
	} finally {
		await client.close();
		await restarted.close();
	}
});

test("real setup HTTP/WebSocket API works without chats and refuses unsupported flows, stale answers and browser origins", async (t) => {
	const { setup, dir } = await fixture(t);
	const projects = new ProjectStore(dir),
		sessions = new SessionManager(dir, projects),
		terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: dir, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(dir),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		setup,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const sockets: WebSocket[] = [];
	t.after(async () => {
		for (const ws of sockets) ws.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
	});
	const ready = await fetch(`${base}/api/setup`);
	assert.equal(ready.status, 200);
	assert.equal(ready.headers.get("cache-control"), "no-store");
	const start = await fetch(`${base}/api/setup/runs`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(runRequest),
	});
	assert.equal(start.status, 201);
	const run = (await start.json()) as SetupRun;
	const ws = new WebSocket(`${base.replace("http:", "ws:")}/api/setup/runs/${run.id}/terminal/ws`);
	sockets.push(ws);
	const messages: SetupServerMessage[] = [];
	ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
	await once(ws, "open");
	await until(() => messages.some((m) => m.type === "setup.challenge"));
	ws.send(JSON.stringify({ type: "setup.answer", challengeId: "old-run-challenge", answer: "private-code" }));
	await until(() => messages.some((m) => m.type === "setup.error"));
	assert.equal(JSON.stringify(messages).includes("private-code"), false);
	const cancelled = await fetch(`${base}/api/setup/runs/${run.id}`, { method: "DELETE" });
	assert.equal(cancelled.status, 200);
	assert.equal(((await cancelled.json()) as SetupRun).reauthenticationRequired, true);
	assert.equal((await fetch(`${base}/api/setup/runs`)).status, 200);
	assert.equal((await fetch(`${base}/api/setup`, { headers: { origin: "https://evil.test" } })).status, 403);
	const unsupported = await fetch(`${base}/api/setup/runs`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider: "google", method: "manual_code", token: "private-request" }),
	});
	assert.equal(unsupported.status, 409);
	assert.equal((await unsupported.text()).includes("private-request"), false);
	assert.equal((await fetch(`${base}/api/setup/integrations/slack/sign-in`, { method: "POST" })).status, 409);
	assert.equal(sessions.list().length, 0);
});

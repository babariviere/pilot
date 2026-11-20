import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ConnectionControls } from "./connection-controls.ts";
import { McpSetupError, McpSetupStore } from "./mcp/mcp-setup.ts";
import { McpStatusService } from "./mcp/mcp-status.ts";
import { nativePlanningFixture } from "../missions/planning/native-mission-planning.fixture.ts";

test("native connections read cached checks, preserve advanced entries and refuse stale/lost intents", async (t) => {
	let probes = 0,
		logins = 0;
	const mcp = new McpStatusService({
		probe: async () => {
			probes++;
			return {
				complete: true,
				configProblems: 0,
				servers: [{ name: "service", transport: "http", state: "needs_sign_in", canSignIn: true }],
			};
		},
		login: async (_name, { signal }) => {
			logins++;
			await new Promise((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
		},
	});
	const f = await nativePlanningFixture({ mcp, connections: true });
	t.after(async () => {
		await mcp.close();
		await f.close();
	});
	const config = join(f.home, "mcp.json");
	await writeFile(
		config,
		'{"advancedNumber":9007199254740993,"mcpServers":{"advanced":{"url":"https://example.test/mcp","headers":{"Authorization":"private-token"}},"service":{"url":"https://example.test/mcp"}}}',
	);
	const headers = { "x-pilot-github-capability": f.capability };
	const read = async () => {
		const r = await fetch(`${f.root}/api/connection-controls`, { headers });
		assert.equal(r.status, 200);
		assert.equal(r.headers.get("cache-control"), "no-store");
		return r.json();
	};
	const denied = await fetch(`${f.root}/api/connection-controls`);
	assert.equal(denied.status, 403);
	await denied.arrayBuffer();
	const first = await read();
	await read();
	assert.equal(probes, 0, "Settings reads cannot launch MCP connections");
	assert.equal(logins, 0);
	assert.equal(first.setup.entries[0].blocked, "advanced_configuration");
	assert.doesNotMatch(JSON.stringify(first), /private-token|Authorization/);
	const op = (binding: string, action: string, value: unknown) =>
		f.operation("global-connections", { purpose: "connection-controls", binding, action, value }, binding);
	const add = op(first.binding, "add", { name: "new", config: { url: "https://new.example/mcp" } });
	const receipt = await (await f.post(add)).json();
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	const bytes = await readFile(config, "utf8");
	assert.match(bytes, /9007199254740993/);
	assert.match(bytes, /private-token/);
	assert.equal(probes, 1, "configuration save schedules a check");
	assert.deepEqual(await (await f.post(add)).json(), receipt);
	assert.equal(probes, 1, "same operation never repeats effects");
	const stale = await (await f.post(op(first.binding, "sign-in", { server: "service" }))).json();
	assert.equal(stale.state, "rejected");
	assert.equal(logins, 0);
	const fresh = await read();
	const start = await (await f.post(op(fresh.binding, "sign-in", { server: "service" }))).json();
	assert.equal(start.state, "accepted", JSON.stringify(start));
	assert.equal(logins, 1);
	const waiting = await read();
	const cancel = await (
		await f.post(op(waiting.binding, "cancel", { server: "service", expectedStartedAt: 0 }))
	).json();
	assert.equal(cancel.state, "rejected");
	assert.equal(mcp.get("service")?.signIn?.state, "waiting");
	const cancelled = await (
		await f.post(
			op(waiting.binding, "cancel", { server: "service", expectedStartedAt: mcp.get("service")!.signIn!.startedAt }),
		)
	).json();
	assert.equal(cancelled.state, "accepted", JSON.stringify(cancelled));
	const check = await fetch(`${f.root}/api/connection-controls/check`, { method: "POST", headers });
	assert.equal(check.status, 200);
	await check.arrayBuffer();
	assert.equal(probes, 2);
	// Entered effects are never recovered by calling the handler again.
	const controls = new ConnectionControls(new McpSetupStore(f.home), mcp);
	await assert.rejects(controls.admit(add, f.journal, false), /lookup only/);
});

test("connection write acknowledgement loss stays pending through passive reads and receipt lookup", async (t) => {
	const f = await nativePlanningFixture({ connections: true });
	t.after(() => f.close());
	const apply = McpSetupStore.prototype.apply;
	let writes = 0;
	t.mock.method(McpSetupStore.prototype, "apply", async function (this: McpSetupStore, value: unknown) {
		writes++;
		await apply.call(this, value);
		throw new McpSetupError(503, "mcp_setup_unavailable");
	});
	const headers = { "x-pilot-github-capability": f.capability };
	const read = async () => (await fetch(`${f.root}/api/connection-controls`, { headers })).json();
	const s = await read();
	const op = f.operation(
		"global-connections",
		{
			purpose: "connection-controls",
			binding: s.binding,
			action: "add",
			value: { name: "example", config: { url: "https://example.test/mcp" } },
		},
		s.binding,
	);
	assert.equal((await (await f.post(op)).json()).state, "pending");
	assert.equal((await read()).setup.entries[0].name, "example");
	assert.equal((await (await f.post(op, true)).json()).state, "pending");
	assert.equal((await (await f.post(op)).json()).state, "pending");
	assert.equal(writes, 1);
});

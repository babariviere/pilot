import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MissionStore } from "../missions/missions.ts";
import { AgentCli } from "./agent-cli.ts";
import { openTerminalCli } from "./terminal-cli.ts";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = promisify(execFile);

test("a terminal in any directory can read the profile without an agent grant", async (t) => {
	const home = await mkdtemp("/tmp/pilot-cli-");
	t.after(() => rm(home, { recursive: true, force: true }));
	const missions = new MissionStore(":memory:");
	const mission = missions.create({ projectId: "project", title: "Terminal mission" });
	missions.writeBrief(mission.id, "# Read from terminal", 0);
	const api = new AgentCli();
	const close = await openTerminalCli(home, api, {
		chats: () => [{ id: "chat", title: "Saved chat", archivedAt: 123 }],
		canReadChat: (id) => id === "chat",
		history: async () => ({ entries: [], more: false }),
		missions,
	});
	t.after(async () => {
		close();
		await missions.durable();
		missions.close();
	});
	const opts = { cwd: "/", env: { PILOT_HOME: home } };
	const pilot = async (...args: string[]) => (await run(process.execPath, [cliPath, ...args], opts)).stdout;
	assert.equal((await lstat(join(home, "cli"))).mode & 0o777, 0o700);
	assert.equal((await lstat(join(home, "cli/s"))).mode & 0o777, 0o600);
	assert.equal(JSON.parse(await pilot("context", "--json")).mode, "terminal");
	assert.deepEqual(JSON.parse(await pilot("chats", "list")), {
		chats: [{ id: "chat", title: "Saved chat", archivedAt: 123 }],
	});
	assert.deepEqual(JSON.parse(await pilot("chats", "read", "chat")), { messages: [], more: false, nextBefore: null });
	assert.equal(JSON.parse(await pilot("missions", "list")).missions[0].id, mission.id);
	assert.equal(await pilot("missions", "brief", mission.id), "# Read from terminal");
	await assert.rejects(pilot("chats", "read", "hidden"), /Not found in this Pilot profile/);
	await assert.rejects(
		run(process.execPath, [cliPath, "chats", "list"], { ...opts, env: { ...opts.env, PILOT_CLI_PORT: "4319" } }),
		/CLI access is not available/,
	);

	const status = (method: string, path: string, headers?: Record<string, string>) =>
		new Promise((resolve, reject) => {
			const req = request({ socketPath: join(home, "cli/s"), method, path, headers }, (res) => {
				res.resume();
				resolve(res.statusCode);
			});
			req.on("error", reject);
			req.end();
		});
	assert.equal(await status("POST", `/api/agent-cli/v1/missions/${mission.id}/brief`), 405);
	assert.equal(await status("GET", "/api/sessions"), 404);
	assert.equal(await status("GET", "/api/agent-cli/v1/chats", { Origin: "https://example.test" }), 403);
	assert.equal(await status("GET", "/api/agent-cli/v1/chats", { Authorization: "Bearer test" }), 403);
	assert.equal(missions.brief(mission.id)?.revision, 1);
});

test("terminal access refuses a non-private directory or an unexpected socket file", async (t) => {
	const home = await mkdtemp("/tmp/pilot-cli-");
	t.after(() => rm(home, { recursive: true, force: true }));
	const dir = join(home, "cli");
	await mkdir(dir, { mode: 0o755 });
	await chmod(dir, 0o755);
	const api = new AgentCli();
	const reads = { chats: () => [], canReadChat: () => false, history: async () => ({ entries: [], more: false }) };
	await assert.rejects(openTerminalCli(home, api, reads), /mode 0700/);
	await chmod(dir, 0o700);
	const path = join(dir, "s");
	await writeFile(path, "keep");
	await assert.rejects(openTerminalCli(home, api, reads), /Unexpected file/);
	assert((await lstat(path)).isFile());
});

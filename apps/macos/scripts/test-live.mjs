#!/usr/bin/env node
// Real pilotd, real workers, native views. No credentials, model spend, or user daemon changes.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const home = await mkdtemp(join(tmpdir(), "native-live-"));
const agent = join(home, "agent");
const project = join(home, "project");
await Promise.all([mkdir(agent), mkdir(project)]);
console.log(`Live test data and captures: ${home}`);
const portProbe = tcpServer().listen(0, "127.0.0.1");
await once(portProbe, "listening");
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const daemonURL = `http://127.0.0.1:${port}`;
let daemon;
let stopping = false;
const startDaemon = () => {
	daemon = spawn(process.execPath, ["packages/daemon/src/main.ts"], {
		cwd: repo,
		env: { ...process.env, PILOT_PORT: String(port), PILOT_HOME: join(home, "data"), PILOT_AGENT_DIR: agent },
		stdio: ["ignore", "inherit", "inherit"],
	});
};
async function stopDaemon() {
	if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
	const exited = once(daemon, "exit");
	daemon.kill("SIGTERM");
	await exited;
}
async function healthy() {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try { if ((await fetch(daemonURL + "/api/projects")).ok) return; } catch {}
		await delay(50);
	}
	throw new Error("Isolated daemon did not become healthy");
}
let serial = 0;
const provider = createServer(async (req, res) => {
	try {
		if (req.url === "/restart") {
			await stopDaemon();
			// The native client must actually observe an outage, then resubscribe.
			await delay(1_500);
			if (stopping) throw new Error("Test is stopping");
			startDaemon();
			await healthy();
			res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
			return;
		}
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		const last = body.messages.at(-1);
		const draft = body.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("draft the shared mission state"));
		let delta = { content: "Deterministic local reply. No repository changes." };
		let finish = "stop";
		if (draft && last.role === "user") {
			const name = body.tools.find(t => t.function.name === "codemode").function.name;
			const code = [
				'text(await tools.mission({action:"update",goal:"Live drafted goal"}));',
				'text(await tools.mission({action:"brief",markdown:"# Live draft\\n\\nDeterministic worker draft.",expectedRevision:0}));',
				'text(await tools.mission({action:"decide",text:"Keep data local"}));',
				'text(await tools.mission({action:"task",title:"Drafted task"}));',
				'text(await tools.mission({action:"comment",text:"Agent clarification"}));',
				'text(await tools.read({path:' + JSON.stringify(join(repo, "packages/kernel/skills/pilot-artifacts/SKILL.md")) + '}));',
				'text(await tools.artifact({action:"create",title:"Live image",kind:"image",source:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII="}));',
			].join("\n");
			delta = { tool_calls: [{ index: 0, id: `call_${++serial}`, type: "function",
				function: { name, arguments: JSON.stringify({ code }) } }] };
			finish = "tool_calls";
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = { id: `reply_${serial}`, object: "chat.completion.chunk", created: 1, model: "deterministic",
			choices: [{ index: 0, delta, finish_reason: null }] };
		res.write("data: " + JSON.stringify(chunk) + "\n\n");
		res.write("data: " + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }],
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + "\n\n");
		res.end("data: [DONE]\n\n");
	} catch (error) {
		console.error(error);
		if (!res.headersSent) res.writeHead(500);
		res.end(String(error));
	}
}).listen(0, "127.0.0.1");
await once(provider, "listening");
const providerURL = `http://127.0.0.1:${provider.address().port}`;
await writeFile(join(agent, "models.json"), JSON.stringify({
	providers: { "live-test": { baseUrl: providerURL + "/v1", api: "openai-completions", apiKey: "offline",
		models: [{ id: "deterministic", contextWindow: 32_000, maxTokens: 4_000 }] } },
}));
await writeFile(join(agent, "settings.json"), JSON.stringify({
	defaultProvider: "live-test", defaultModel: "deterministic", enabledModels: ["live-test/deterministic"],
}));
try {
	startDaemon();
	await healthy();
	const response = await fetch(daemonURL + "/api/projects", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "Live verification", path: project, workspace: "direct" }),
	});
	if (!response.ok) throw new Error(await response.text());
	const test = spawn("apps/macos/scripts/test.sh", ["--filter", "liveMissionFlows"], {
		cwd: repo,
		env: { ...process.env, PILOT_LIVE_TEST_URL: daemonURL, PILOT_LIVE_CONTROL_URL: providerURL,
			PILOT_LIVE_CAPTURE_DIR: home },
		stdio: "inherit",
	});
	const [code] = await once(test, "exit");
	process.exitCode = code ?? 1;
} finally {
	stopping = true;
	await stopDaemon();
	provider.closeAllConnections();
	await new Promise(resolve => provider.close(resolve));
}

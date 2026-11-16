/** Real native ingress/storage, invented MCP check and sign-in, no external connections. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { mock } from "node:test";
import { McpSetupStore } from "../mcp-setup.ts";
import { McpStatusService } from "../mcp-status.ts";
import { nativePlanningFixture } from "../native-mission-planning.fixture.ts";

let probes = 0,
	logins = 0,
	writes = 0,
	lost = false;
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
const ledger = join(f.home, "commands.jsonl"),
	config = join(f.home, "mcp.json");
await writeFile(
	config,
	JSON.stringify({
		extra: "keep",
		mcpServers: {
			service: { url: "https://example.test/mcp" },
			advanced: { command: "custom", args: ["private-secret"], env: { TOKEN: "private-token" } },
		},
	}),
);
const apply = McpSetupStore.prototype.apply;
mock.method(McpSetupStore.prototype, "apply", async function (this: McpSetupStore, value: unknown) {
	const records = (await readFile(ledger, "utf8"))
		.trim()
		.split("\n")
		.map((s) => JSON.parse(s));
	assert(
		records.some((r) => r.operation?.kind === "connection-controls"),
		"native journal precedes effect",
	);
	writes++;
	await apply.call(this, value);
	if (lost) {
		lost = false;
		throw new Error("Lost domain acknowledgement");
	}
});
console.log(
	JSON.stringify({
		source: {
			profile: f.home,
			port: Number(new URL(f.root).port),
			home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId },
			project_id: f.project.id,
			project_path: f.project.path,
		},
		ledger,
	}),
);
for await (const line of createInterface({ input: process.stdin })) {
	const c = JSON.parse(line);
	if (c.action === "quit") break;
	if (c.action === "lost") lost = true;
	console.log(JSON.stringify({ writes, probes, logins, config: JSON.parse(await readFile(config, "utf8")) }));
}
process.stdin.destroy();
await mcp.close();
await f.close();

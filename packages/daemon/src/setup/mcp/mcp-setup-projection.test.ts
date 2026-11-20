import assert from "node:assert/strict";
import { test } from "node:test";
import { projectMcpSetup } from "./mcp-setup-projection.ts";

test("MCP setup projects only literal nonsecret fields without normalization", () => {
	for (const config of [
		{ url: "HTTPS://EXAMPLE.TEST:443/mcp" },
		{ url: "https://example.test/mcp", enabled: false, exposure: "hidden", timeout: 12 },
		{ command: "example-mcp", type: "stdio", args: [], env: {} },
	])
		assert.deepEqual(projectMcpSetup("example", config), { name: "example", config });
});

test("MCP setup never returns secret-bearing, advanced or host-local values", () => {
	const secret = "never-export-this-value";
	const entries = [
		{ url: "https://example.test/mcp", headers: { Authorization: secret } },
		{ url: "https://example.test/mcp", oauth: { clientSecret: secret } },
		{ url: "https://example.test/mcp", auth: { provider: secret } },
		{ url: "https://example.test/mcp", description: secret },
		{ url: "https://example.test/mcp", toolExposure: { [secret]: "direct" } },
		{ url: `https://user:${secret}@example.test/mcp` },
		{ url: `https://example.test/mcp?token=${secret}` },
		{ url: `https://example.test/${secret}` },
		{ url: `https://example.test/mcp#${secret}` },
		{ command: "example", env: { TOKEN: secret } },
		{ command: "example", args: [secret] },
		{ command: `/Users/${secret}/example` },
		{ command: "example", cwd: secret },
		{ command: "example", futureField: secret },
	];
	for (const value of entries) {
		const result = projectMcpSetup("example", value);
		assert.ok(result.blocked);
		assert.equal(result.config, undefined);
		assert.equal(JSON.stringify(result).includes(secret), false);
	}
});

test("MCP setup rejects local endpoints, ambiguity and invalid scalar shapes", () => {
	for (const value of [
		{ url: "http://localhost/mcp" },
		{ url: "https://127.0.0.1/mcp" },
		{ url: "https://localhost./mcp" },
		{ url: "https://example.local/mcp" },
		{ url: "https://example.test:4430/mcp" },
		{ url: "https://example.test/mcp", command: "example" },
		{ command: "example", timeout: Number.POSITIVE_INFINITY },
		{ command: "example", enabled: "true" },
		{ command: "!echo" },
		{ command: "~/bin/example" },
		{ command: "example", exposure: "future" },
	])
		assert.ok(projectMcpSetup("example", value).blocked);
});

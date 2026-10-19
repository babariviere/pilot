import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";

test("read-only hosts explicitly deny model scope writes", () => {
	assert.equal(loadConfig({}).modelScopeReadOnly, undefined);
	assert.equal(loadConfig({ PILOT_MODEL_SCOPE_READ_ONLY: "1" }).modelScopeReadOnly, true);
	assert.equal(loadConfig({}).mcpSetupReadOnly, undefined);
	assert.equal(loadConfig({ PILOT_MCP_SETUP_READ_ONLY: "1" }).mcpSetupReadOnly, true);
});

test("shared workspace retention defaults to 1 day and zero disables automatic cleanup", () => {
	assert.equal(loadConfig({}).workspaceRetentionMs, 86_400_000);
	assert.equal(loadConfig({ PILOT_WORKSPACE_RETENTION_DAYS: "7" }).workspaceRetentionMs, 7 * 86_400_000);
	assert.equal(loadConfig({ PILOT_WORKSPACE_RETENTION_DAYS: "0" }).workspaceRetentionMs, Number.POSITIVE_INFINITY);
});

test("workspace retention rejects malformed and unsafe durations", () => {
	for (const value of ["", "-1", "NaN", "Infinity", "1.5", "9007199254740992"]) {
		assert.throws(
			() => loadConfig({ PILOT_WORKSPACE_RETENTION_DAYS: value }),
			/Invalid PILOT_WORKSPACE_RETENTION_DAYS/,
		);
	}
});

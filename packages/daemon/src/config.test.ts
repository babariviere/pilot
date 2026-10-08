import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";

test("shared workspace retention defaults to 30 days and zero disables automatic cleanup", () => {
	assert.equal(loadConfig({}).workspaceRetentionMs, 30 * 86_400_000);
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

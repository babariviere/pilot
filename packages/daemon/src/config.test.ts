import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getPilotConfigDir, loadConfig } from "./config.ts";

test("Pilot configuration lives outside pi's agent directory and runtime data", () => {
	assert.equal(getPilotConfigDir({}), join(homedir(), ".config", "pilot"));
	assert.equal(getPilotConfigDir({ XDG_CONFIG_HOME: "/custom/config" }), "/custom/config/pilot");
	assert.equal(
		getPilotConfigDir({ PILOT_AGENT_DIR: "/agent", PILOT_HOME: "/data", XDG_CONFIG_HOME: "" }),
		join(homedir(), ".config", "pilot"),
	);
});

test("read-only hosts explicitly deny model scope writes", () => {
	assert.equal(loadConfig({}).modelScopeReadOnly, undefined);
	assert.equal(loadConfig({ PILOT_MODEL_SCOPE_READ_ONLY: "1" }).modelScopeReadOnly, true);
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

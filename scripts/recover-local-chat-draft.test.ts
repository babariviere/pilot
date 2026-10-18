import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("quit-app Local draft repair preserves exact backups and pending operations", () => {
	const result = spawnSync(
		"python3",
		["-m", "unittest", "discover", "-s", "scripts", "-p", "test_recover_local_chat_draft.py", "-v"],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

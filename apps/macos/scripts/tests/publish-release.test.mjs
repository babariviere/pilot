import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("draft publication looks up the numeric asset ID without a published Git tag", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-draft-test-"));
	try {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const log = join(dir, "calls.jsonl");
		writeFileSync(
			join(bin, "gh"),
			`#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "release" && args[1] === "create" && args.includes("--draft")) {
	console.log("https://github.com/owner/repo/releases/tag/untagged-draft");
} else if (args[0] === "release" && args[1] === "upload") {
} else if (args[0] === "release" && args[1] === "view" &&
	args[args.indexOf("--json") + 1] === "databaseId" && args[args.indexOf("--jq") + 1] === ".databaseId") {
	console.log("12345");
} else if (args[0] === "api" && args[1] === "repos/owner/repo/releases/12345/assets" &&
	args[args.indexOf("--jq") + 1] === '.[] | select(.name == "Pilot-arm64.zip") | .id') {
	console.log("67890");
} else {
	console.error("Unexpected gh call (draft tag lookup returns 404): " + JSON.stringify(args));
	process.exit(1);
}
`,
			{ mode: 0o755 },
		);
		// Exercise the exact draft creation/upload/lookup block, without signing or publishing remotely.
		const script = readFileSync(new URL("../publish-release.sh", import.meta.url), "utf8");
		const start = script.indexOf('gh release create "$tag"');
		const end = script.indexOf('python3 "$here/scripts/release_metadata.py" appcast', start);
		assert.ok(start >= 0 && end > start, "draft upload block must exist");
		const result = spawnSync("bash", ["-euo", "pipefail", "-c", `${script.slice(start, end)}\nprintf '%s' "$asset_id"`], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				CALL_LOG: log,
				tag: "pilot-3.1",
				archive: join(dir, "Pilot-arm64.zip"),
				PILOT_UPDATE_REPOSITORY: "owner/repo",
				GITHUB_SHA: "test-commit",
				build_version: "3.1",
			},
		});
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.endsWith("67890"), result.stdout);
		const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
		assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
			["release", "create"],
			["release", "upload"],
			["release", "view"],
			["api", "repos/owner/repo/releases/12345/assets"],
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("stable draft upload looks up the numeric asset ID and allows retrying failed uploads", () => {
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
if (args[0] === "release" && args[1] === "upload" && args.includes("--clobber")) {
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
		// Exercise the exact draft upload/lookup block, without signing or publishing remotely.
		const script = readFileSync(new URL("../publish-release.sh", import.meta.url), "utf8");
		const start = script.indexOf('gh release upload "$tag" "$archive"');
		const end = script.indexOf('python3 "$here/scripts/release_metadata.py" appcast', start);
		assert.ok(start >= 0 && end > start, "draft upload block must exist");
		const result = spawnSync(
			"bash",
			["-euo", "pipefail", "-c", `${script.slice(start, end)}\nprintf '%s' "$asset_id"`],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					CALL_LOG: log,
					tag: "v0.2.0",
					archive: join(dir, "Pilot-arm64.zip"),
					dmg: join(dir, "Pilot-arm64.dmg"),
					PILOT_UPDATE_REPOSITORY: "owner/repo",
					GITHUB_SHA: "test-commit",
					build_version: "3.1",
				},
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.endsWith("67890"), result.stdout);
		const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
		assert.deepEqual(
			calls.map((args) => args.slice(0, 2)),
			[
				["release", "upload"],
				["release", "upload"],
				["release", "view"],
				["api", "repos/owner/repo/releases/12345/assets"],
			],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const scenario of ["dev", "stable-first", "stable-upgrade", "older-app", "older-build", "api-error"]) {
	test(`publication safety: ${scenario}`, () => {
		const dir = mkdtempSync(join(tmpdir(), "pilot-publication-test-"));
		try {
			const bin = join(dir, "bin");
			mkdirSync(bin);
			const log = join(dir, "calls.jsonl");
			writeFileSync(
				join(bin, "gh"),
				`#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const scenario = process.env.SCENARIO;
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "release" && args[1] === "upload") {
} else if (args[0] === "release" && args[1] === "view") {
  console.log("12345");
} else if (args[0] === "api" && args[1].endsWith("/12345/assets")) {
  console.log("67890");
} else if (args[0] === "api" && args[1].endsWith("/releases/latest") && scenario !== "dev") {
  if (scenario === "stable-first" || scenario === "api-error") {
    console.error(scenario === "stable-first" ? "HTTP 404" : "HTTP 403");
    process.exit(1);
  }
  console.log(JSON.stringify({tag_name: scenario === "older-app" ? "v0.3.0" : "v0.1.0",
    assets: [{name: "appcast.xml", id: 777}]}));
} else if (args[0] === "api" && args[1].endsWith("/assets/777")) {
  console.log('<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>' +
    (scenario === "older-build" ? "11.1" : "9.1") + '</sparkle:version></item></channel></rss>');
} else if (args[0] === "release" && args[1] === "edit") {
  const valid = scenario === "dev" ? args.includes("--prerelease") && args.includes("--latest=false") :
    args.includes("--latest") && !args.includes("--prerelease");
  if (!valid) process.exit(1);
} else {
  console.error("Unexpected call: " + JSON.stringify(args));
  process.exit(1);
}
`,
				{ mode: 0o755 },
			);
			const app = join(dir, "Pilot.app");
			mkdirSync(join(app, "Contents"), { recursive: true });
			const plist = spawnSync(
				"python3",
				[
					"-c",
					"import plistlib,sys; plistlib.dump({'CFBundleVersion':'10.1','CFBundleShortVersionString':'0.2.0','PilotUpdateRepository':'owner/repo','LSMinimumSystemVersion':'14.0'},open(sys.argv[1],'wb'))",
					join(app, "Contents/Info.plist"),
				],
				{ encoding: "utf8" },
			);
			assert.equal(plist.status, 0, plist.stderr);
			const archive = join(dir, "Pilot-arm64.zip");
			writeFileSync(archive, "signed archive fixture");
			const script = readFileSync(new URL("../publish-release.sh", import.meta.url), "utf8");
			const start = script.indexOf('gh release upload "$tag" "$archive"');
			assert.ok(start > 0);
			const result = spawnSync("bash", ["-euo", "pipefail", "-c", script.slice(start)], {
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					CALL_LOG: log,
					SCENARIO: scenario,
					here: new URL("../../", import.meta.url).pathname,
					stage: dir,
					app,
					archive,
					dmg: join(dir, "Pilot-arm64.dmg"),
					tag: scenario === "dev" ? "dev-0123456789ab" : "v0.2.0",
					kind: scenario === "dev" ? "dev" : "stable",
					app_version: "0.2.0",
					build_version: "10.1",
					PILOT_UPDATE_REPOSITORY: "owner/repo",
					signature: Buffer.alloc(64).toString("base64"),
				},
			});
			if (scenario === "api-error") assert.notEqual(result.status, 0);
			else assert.equal(result.status, 0, result.stderr);
			const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
			assert.deepEqual(
				calls.filter((args) => args[1] === "upload").map((args) => args[3]),
				[archive, join(dir, "Pilot-arm64.dmg"), join(dir, "appcast.xml")],
			);
			const edits = calls.filter((args) => args[1] === "edit");
			assert.equal(edits.length, ["dev", "stable-first", "stable-upgrade"].includes(scenario) ? 1 : 0);
			if (scenario === "dev") assert.ok(!calls.some((args) => args[1].endsWith("/releases/latest")));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

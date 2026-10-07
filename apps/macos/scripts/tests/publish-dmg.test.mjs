import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const scenario of [
	"success",
	"existing-dmg",
	"prerelease",
	"draft",
	"missing-zip",
	"api-error",
	"download-error",
	"wrong-version",
	"codesign-error",
	"dmg-error",
	"upload-error",
]) {
	test(`manual installer: ${scenario}`, () => {
		const dir = mkdtempSync(join(tmpdir(), "pilot installer test-"));
		try {
			const bin = join(dir, "bin");
			const scripts = join(dir, "scripts");
			mkdirSync(bin);
			mkdirSync(scripts);
			for (const name of ["publish-dmg.sh", "release_metadata.py"]) {
				copyFileSync(new URL(`../${name}`, import.meta.url), join(scripts, name));
			}
			const log = join(dir, "calls.jsonl");
			const mock = `#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = process.env.SCENARIO;
appendFileSync(process.env.CALL_LOG, JSON.stringify([tool, ...args]) + "\\n");
if (tool === "gh") {
  if (args[0] !== "release") process.exit(1);
  if (args[1] === "view") {
    if (scenario === "api-error") process.exit(1);
    const assets = ["Pilot-arm64.zip", "appcast.xml"];
    if (scenario === "existing-dmg") assets.push("Pilot-arm64.dmg");
    console.log(JSON.stringify({tagName: "v1.2.3", isDraft: scenario === "draft",
      isPrerelease: scenario === "prerelease", assets: assets.filter(name => scenario !== "missing-zip" || name !== "Pilot-arm64.zip")
        .map(name => ({name, state: "uploaded"}))}));
  } else if (args[1] === "download") {
    if (args[2] !== "v1.2.3" || scenario === "download-error") process.exit(1);
    writeFileSync(join(args[args.indexOf("--dir") + 1], "Pilot-arm64.zip"), "archive fixture");
  } else if (args[1] === "upload") {
    if (args[2] !== "v1.2.3" || args.includes("--clobber") || scenario === "upload-error") process.exit(1);
  } else process.exit(1);
} else if (tool === "ditto") {
  const contents = join(args[3], "Pilot.app/Contents");
  mkdirSync(contents, {recursive: true});
  writeFileSync(join(contents, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>' +
    (scenario === "wrong-version" ? "1.2.2" : "1.2.3") + '</string></dict></plist>');
} else if (tool === "codesign") {
  if (scenario === "codesign-error") process.exit(1);
} else if (tool === "make-dmg") {
  if (scenario === "dmg-error") process.exit(1);
  writeFileSync(args[1], "disk image fixture");
} else process.exit(1);
`;
			for (const tool of ["gh", "ditto", "codesign", "make-dmg"]) {
				writeFileSync(join(bin, tool), mock, { mode: 0o755 });
			}
			writeFileSync(join(scripts, "create-dmg.sh"), '#!/bin/bash\nset -euo pipefail\nmake-dmg "$@"\n');
			const result = spawnSync("bash", [join(scripts, "publish-dmg.sh")], {
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					SCENARIO: scenario,
					CALL_LOG: log,
					GH_TOKEN: "test-only-token",
					PILOT_UPDATE_REPOSITORY: "owner/repo",
				},
			});
			const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
			if (scenario === "success") {
				assert.equal(result.status, 0, result.stderr);
				assert.deepEqual(
					calls.map((args) => args.slice(0, args[0] === "gh" ? 2 : 1)),
					[["gh", "release"], ["gh", "release"], ["ditto"], ["codesign"], ["make-dmg"], ["gh", "release"]],
				);
				assert.ok(calls[3].includes("--verify") && calls[3].includes("--strict"));
			} else {
				assert.notEqual(result.status, 0, result.stdout);
			}
			const uploads = calls.filter((args) => args[0] === "gh" && args[2] === "upload");
			assert.equal(uploads.length, ["success", "upload-error"].includes(scenario) ? 1 : 0);
			if (uploads.length) {
				assert.equal(uploads[0][3], "v1.2.3");
				assert.ok(uploads[0][4].endsWith("/Pilot-arm64.dmg"));
				assert.ok(!uploads[0].includes("--clobber"));
			}
			// The temporary extraction and image are cleaned up even on failure.
			const download = calls.find((args) => args[0] === "gh" && args[2] === "download");
			if (download) {
				assert.throws(() => readFileSync(join(download[download.indexOf("--dir") + 1], "release.json")), {
					code: "ENOENT",
				});
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

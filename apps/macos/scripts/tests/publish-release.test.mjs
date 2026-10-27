import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envelope, metadata } from "../../../desktop/scripts/gui-release-manifest.mjs";

// A synthetic, correctly signed macOS GUI draft for finalize-release.sh.
function signedGuiDraft() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const pem = privateKey.export({ type: "pkcs8", format: "pem" });
	const publicBase64 = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
	const source = "a".repeat(40);
	const bytes = Buffer.from("synthetic GUI archive");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const record = { schema: 1, platform: "macos", source, version: "0.2.0", archive: "Pilot-Next-macos-arm64.zip", build: "1", bytes: bytes.length, sha256 };
	const value = metadata(record, bytes, "macos", 123, source, "v0.2.0");
	const release = {
		draft: true,
		prerelease: false,
		tag_name: "v0.2.0",
		assets: [{ id: 123, name: "Pilot-Next-macos-arm64.zip", state: "uploaded", size: bytes.length, digest: `sha256:${sha256}` }],
	};
	return { publicBase64, source, release: JSON.stringify(release), envelope: envelope(value, pem, publicBase64) };
}

test("dev publishing is rejected before any packaging or remote calls", () => {
	const result = spawnSync("bash", [new URL("../publish-release.sh", import.meta.url).pathname], {
		encoding: "utf8",
		env: {
			...process.env,
			GH_TOKEN: "test-only-token",
			PILOT_UPDATE_REPOSITORY: "owner/repo",
			SPARKLE_PRIVATE_KEY: "test-only-key",
			RELEASE_TAG: "dev-0123456789ab",
			RELEASE_KIND: "dev",
		},
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Only stable releases can be published/);
});

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
				["release", "view"],
				["api", "repos/owner/repo/releases/12345/assets"],
			],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const scenario of ["stable-first", "stable-upgrade", "older-app", "older-build", "api-error", "incomplete"]) {
	test("publication safety: " + scenario, () => {
		const dir = mkdtempSync(join(tmpdir(), "pilot-publication-test-"));
		const gui = signedGuiDraft();
		try {
			const bin = join(dir, "bin");
			mkdirSync(bin);
			const log = join(dir, "calls.jsonl");
			writeFileSync(
				join(bin, "gh"),
				"#!" + process.execPath + "\n" +
					String.raw`const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const scenario = process.env.SCENARIO;
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\n");
const feed = (build) => '<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>' +
  '<sparkle:version>' + build + '</sparkle:version><sparkle:shortVersionString>0.2.0</sparkle:shortVersionString></item></channel></rss>';
if (args[0] === "release" && args[1] === "view" && args[args.indexOf("--json") + 1] === "isDraft,isPrerelease,assets") {
  const names = ["Pilot-arm64.zip", "appcast.xml", "Pilot-Next-macos-arm64.zip", "desktop-macos-arm64-update.json"];
  console.log(JSON.stringify({isDraft: true, isPrerelease: false,
    assets: names.filter((name) => scenario !== "incomplete" || !name.startsWith("desktop-"))
      .map((name) => ({name, state: "uploaded"}))}));
} else if (args[0] === "release" && args[1] === "view") {
  console.log("12345");
} else if (args[0] === "api" && args[1].endsWith("/releases/12345")) {
  console.log(process.env.GUI_RELEASE);
} else if (args[0] === "api" && args[1].endsWith("/12345/assets") && args.join(" ").includes("desktop-macos-arm64-update.json")) {
  console.log("556");
} else if (args[0] === "api" && args[1].endsWith("/assets/556")) {
  process.stdout.write(process.env.GUI_ENVELOPE);
} else if (args[0] === "api" && args[1].endsWith("/12345/assets")) {
  console.log("555");
} else if (args[0] === "api" && args[1].endsWith("/assets/555")) {
  console.log(feed("10.1"));
} else if (args[0] === "api" && args[1].endsWith("/releases/latest")) {
  if (scenario === "stable-first" || scenario === "api-error") {
    console.error(scenario === "stable-first" ? "HTTP 404" : "HTTP 403");
    process.exit(1);
  }
  console.log(JSON.stringify({tag_name: scenario === "older-app" ? "v0.3.0" : "v0.1.0",
    assets: [{name: "appcast.xml", id: 777}]}));
} else if (args[0] === "api" && args[1].endsWith("/assets/777")) {
  console.log(feed(scenario === "older-build" ? "11.1" : "9.1"));
} else if (args[0] === "release" && args[1] === "edit") {
  const valid = args.includes("--draft=false") && args.includes("--latest") && !args.includes("--prerelease");
  if (!valid) process.exit(1);
} else {
  console.error("Unexpected call: " + JSON.stringify(args));
  process.exit(1);
}
`,
				{ mode: 0o755 },
			);
			const result = spawnSync("bash", [new URL("../finalize-release.sh", import.meta.url).pathname], {
				encoding: "utf8",
				env: {
					...process.env,
					PATH: bin + ":" + process.env.PATH,
					CALL_LOG: log,
					SCENARIO: scenario,
					GH_TOKEN: "test-only-token",
					RELEASE_TAG: "v0.2.0",
					PILOT_UPDATE_REPOSITORY: "owner/repo",
					RELEASE_SOURCE: gui.source,
					PILOT_NEXT_UPDATER_PUBLIC_KEY: gui.publicBase64,
					GUI_RELEASE: gui.release,
					GUI_ENVELOPE: gui.envelope,
				},
			});
			if (["api-error", "incomplete"].includes(scenario)) assert.notEqual(result.status, 0);
			else assert.equal(result.status, 0, result.stderr);
			const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
			assert.ok(!calls.some((args) => args[1] === "upload"));
			const edits = calls.filter((args) => args[1] === "edit");
			assert.equal(edits.length, ["stable-first", "stable-upgrade"].includes(scenario) ? 1 : 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("macOS upload never publishes the draft", () => {
	const script = readFileSync(new URL("../publish-release.sh", import.meta.url), "utf8");
	assert.doesNotMatch(script, /gh release edit|--draft=false|releases\/latest/);
});

test("promotion copies the verified ZIP byte-for-byte without repackaging", () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-promote-zip-"));
	try {
		const source = join(dir, "verified app.zip");
		const destination = join(dir, "release.zip");
		const bytes = Buffer.from("verified ZIP bytes\0with binary data");
		writeFileSync(source, bytes);
		const script = readFileSync(new URL("../publish-release.sh", import.meta.url), "utf8");
		const start = script.indexOf('if [ -n "${2:-}" ]; then');
		const end = script.indexOf("\nfi", start) + "\nfi".length;
		assert.ok(start >= 0 && end > start);
		const result = spawnSync("bash", ["-euo", "pipefail", "-c",
			`ditto() { echo "Unexpected repackaging" >&2; return 1; }\n${script.slice(start, end)}`,
			"_", "unused app", source], {
			encoding: "utf8",
			env: { ...process.env, archive: destination },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readFileSync(destination), bytes);
		const missing = spawnSync("bash", ["-euo", "pipefail", "-c", script.slice(start, end),
			"_", "unused app", join(dir, "missing.zip")], {
			encoding: "utf8", env: { ...process.env, archive: destination },
		});
		assert.notEqual(missing.status, 0, "missing verified archive must not fall back to repackaging");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

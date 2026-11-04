import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("runtime smoke invocation supports file-based workers", () => {
	const script = readFileSync(new URL("../check-runtime.sh", import.meta.url), "utf8");
	const invocation = script.match(/^\.\/node\/bin\/node(.*?) <<'JS'$/m);
	assert.ok(invocation, "Find the production smoke invocation");
	const dir = mkdtempSync(join(tmpdir(), "pilot runtime worker-"));
	try {
		writeFileSync(
			join(dir, "worker.mjs"),
			'import { parentPort } from "node:worker_threads"; parentPort.postMessage("ok");',
		);
		const args = invocation[1].trim().split(/\s+/).filter(Boolean);
		const check = spawnSync(process.execPath, args, {
			cwd: dir,
			encoding: "utf8",
			timeout: 10000,
			input: `
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
const worker = new Worker(new URL('./worker.mjs', import.meta.url));
const result = await new Promise((resolve, reject) => {
  worker.once('message', resolve);
  worker.once('error', reject);
});
assert.equal(result, 'ok');
`,
		});
		assert.equal(check.status, 0, check.stderr || String(check.error));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runtime architecture check accepts arm64 and rejects x86_64", { skip: process.platform !== "darwin" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "pilot runtime test-"));
	try {
		const nodeDir = join(dir, "node/bin");
		mkdirSync(nodeDir, { recursive: true });
		// Stub only the Node smoke test, keeping the real file, lipo and otool checks.
		writeFileSync(join(nodeDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const toolsDir = join(dir, "tools");
		mkdirSync(toolsDir);
		// Newer lipo accepts reordered arguments, but CI's Xcode 26.2 requires the input first.
		writeFileSync(
			join(toolsDir, "lipo"),
			'#!/bin/sh\n[ -f "$1" ] && [ "$2" = -verify_arch ] || exit 1\nexec /usr/bin/lipo "$@"\n',
			{ mode: 0o755 },
		);
		const binary = join(dir, "addon.node");
		for (const arch of ["arm64", "x86_64"]) {
			const compile = spawnSync("xcrun", ["clang", "-arch", arch, "-x", "c", "-c", "-", "-o", binary], {
				input: "int pilot_runtime_test(void) { return 0; }\n",
				encoding: "utf8",
			});
			assert.equal(compile.status, 0, compile.stderr);
			// Invoke exactly as the bundle and publisher do, including executable permissions.
			const check = spawnSync(new URL("../check-runtime.sh", import.meta.url).pathname, [dir], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${toolsDir}:${process.env.PATH}` },
			});
			if (arch === "arm64") {
				assert.equal(check.status, 0, check.stderr);
			} else {
				assert.notEqual(check.status, 0, "x86_64 runtime binary must be rejected");
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

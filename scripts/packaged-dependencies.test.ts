import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("packaged dependency verification archives, relocates, checks and cleans up on success or failure", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "packaged-dependencies-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const native = join(directory, "apps/macos/scripts");
	const bin = join(directory, "bin");
	const temp = join(directory, "temp");
	for (const path of [native, bin, temp]) await mkdir(path, { recursive: true });
	await writeFile(
		join(native, "bundle-runtime.sh"),
		`#!/bin/sh
set -eu
mkdir "$1"
printf fixture > "$1/sentinel"
echo bundle >> "$FIXTURE_LOG"
`,
		{ mode: 0o755 },
	);
	await writeFile(
		join(native, "check-runtime.sh"),
		`#!/bin/sh
set -eu
case "$1" in */relocated/runtime) ;; *) exit 9 ;; esac
test "$(cat "$1/sentinel")" = fixture
echo check >> "$FIXTURE_LOG"
exit "$FIXTURE_EXIT"
`,
		{ mode: 0o755 },
	);
	await writeFile(
		join(bin, "ditto"),
		`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const [source, target] = args.slice(-2);
if (args[0] === '-c') {
  if (args.slice(0, -2).join(' ') !== '-c -k --keepParent') process.exit(8);
  fs.cpSync(source, target + '.tree', {recursive: true});
  fs.writeFileSync(target, 'archive');
  fs.appendFileSync(process.env.FIXTURE_LOG, 'archive\\n');
} else {
  if (args.slice(0, -2).join(' ') !== '-x -k') process.exit(8);
  fs.cpSync(source + '.tree', path.join(target, 'runtime'), {recursive: true});
  fs.appendFileSync(process.env.FIXTURE_LOG, 'extract\\n');
}
`,
		{ mode: 0o755 },
	);
	const script = fileURLToPath(new URL("./check-packaged-dependencies.sh", import.meta.url));
	for (const exit of [0, 7]) {
		const log = join(directory, `calls-${exit}`);
		const result = spawnSync("bash", [script], {
			cwd: directory,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				RUNNER_TEMP: temp,
				FIXTURE_LOG: log,
				FIXTURE_EXIT: String(exit),
			},
			timeout: 10_000,
		});
		assert.equal(result.status, exit, result.stderr);
		assert.equal(await readFile(log, "utf8"), "bundle\narchive\nextract\ncheck\n");
		assert.deepEqual(await readdir(temp), []);
	}
});

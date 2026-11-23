import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const installer = fileURLToPath(new URL("./install-pilot-cli.ts", import.meta.url));

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pilot-cli-install-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "test home");
	const runtime = join(root, "Pilot's $(printf wrong).app", "Contents/Resources/runtime");
	const node = join(runtime, "node/bin/node");
	const cli = join(runtime, "packages/daemon/src/cli/cli.ts");
	const skill = join(runtime, "packages/kernel/skills/pilot-cli/SKILL.md");
	const installedSkill = join(home, ".agents/skills/pilot-cli/SKILL.md");
	const bin = join(home, ".local/bin");
	const destination = join(bin, "pilot");
	mkdirSync(home);
	mkdirSync(dirname(node), { recursive: true });
	mkdirSync(dirname(cli), { recursive: true });
	mkdirSync(dirname(skill), { recursive: true });
	writeFileSync(skill, "Original skill");
	writeFileSync(node, '#!/bin/sh\nexport USED_BUNDLED_NODE=yes\nexec "$TEST_NODE" "$@"\n');
	chmodSync(node, 0o700);
	writeFileSync(
		cli,
		`
		const args: string[] = process.argv.slice(2);
		console.log(JSON.stringify({ args, cwd: process.cwd(), bundledNode: process.env.USED_BUNDLED_NODE }));
		process.exitCode = 23;
	`,
	);
	const options = { cwd: root, env: { HOME: home, PATH: join(root, "no PATH"), TEST_NODE: process.execPath } };
	const args = [installer, relative(root, runtime)];
	return {
		home,
		root,
		bin,
		destination,
		node,
		cli,
		skill,
		installedSkill,
		options,
		args,
		install: () => spawnSync(process.execPath, args, { ...options, encoding: "utf8" }),
	};
}

test("installs an executable launcher using the selected runtime, not PATH or cwd", (t) => {
	const f = fixture(t);
	const installed = f.install();
	assert.equal(installed.status, 0, installed.stderr);
	assert.deepEqual(readdirSync(f.bin), ["pilot"]);
	assert.ok(lstatSync(f.destination).isSymbolicLink());
	assert.equal(readFileSync(f.installedSkill, "utf8"), "Original skill");

	const args = ["--help", "", "two words", "don't expand $(printf wrong)"];
	const run = spawnSync(f.destination, args, { ...f.options, cwd: f.home, encoding: "utf8" });
	assert.equal(run.status, 23, run.stderr);
	assert.deepEqual(JSON.parse(run.stdout), { args, cwd: f.home, bundledNode: "yes" });
});

for (const kind of ["legacy symlink", "dangling symlink", "unrelated file", "directory"] as const) {
	test(`refuses a ${kind} without replacing it`, (t) => {
		const f = fixture(t);
		const target = join(f.root, "legacy-pilot");
		mkdirSync(f.bin, { recursive: true });
		if (kind === "legacy symlink") writeFileSync(target, "legacy binary");
		if (kind === "unrelated file") writeFileSync(f.destination, "keep me");
		else if (kind === "directory") mkdirSync(f.destination);
		else symlinkSync(target, f.destination);

		const result = f.install();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Refusing to replace .*Inspect it and move it aside/);
		assert.deepEqual(readdirSync(f.bin), ["pilot"]);
		if (kind === "unrelated file") assert.equal(readFileSync(f.destination, "utf8"), "keep me");
		else if (kind === "directory") assert.ok(lstatSync(f.destination).isDirectory());
		else assert.equal(readlinkSync(f.destination), target);
		if (kind === "legacy symlink") assert.equal(readFileSync(target, "utf8"), "legacy binary");
	});
}

for (const part of [".local", ".local/bin"]) {
	test(`does not follow a symlink at ${part}`, (t) => {
		const f = fixture(t);
		const outside = join(f.root, "outside home");
		const directory = join(f.home, part);
		mkdirSync(outside);
		mkdirSync(dirname(directory), { recursive: true });
		symlinkSync(outside, directory);
		const result = f.install();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /it must be a directory, not a symlink or other file/);
		assert.deepEqual(readdirSync(outside), []);
	});
}

test("an incomplete runtime does not create anything in the home", (t) => {
	const f = fixture(t);
	chmodSync(f.node, 0o600);
	const missingNode = f.install();
	assert.equal(missingNode.status, 1);
	assert.match(missingNode.stderr, /Expected executable bundled Node/);
	chmodSync(f.node, 0o700);
	rmSync(f.cli);
	const missingCli = f.install();
	assert.equal(missingCli.status, 1);
	assert.match(missingCli.stderr, /Expected readable Pilot CLI source/);
	assert.deepEqual(readdirSync(f.home), []);
});

test("rerunning the command updates both payloads without replacing stable links", (t) => {
	const f = fixture(t);
	assert.equal(f.install().status, 0);
	const launcher = readlinkSync(f.destination);
	const skill = readlinkSync(dirname(f.installedSkill));
	writeFileSync(f.cli, 'console.log("New CLI");\n');
	writeFileSync(f.skill, "New skill");
	assert.equal(f.install().status, 0);
	assert.equal(readlinkSync(f.destination), launcher);
	assert.equal(readlinkSync(dirname(f.installedSkill)), skill);
	assert.equal(readFileSync(f.installedSkill, "utf8"), "New skill");
	const run = spawnSync(f.destination, ["--help"], { ...f.options, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout.trim(), "New CLI");
	rmSync(f.skill);
	assert.equal(f.install().status, 1);
	assert.equal(readFileSync(f.installedSkill, "utf8"), "New skill");
	assert.equal(spawnSync(f.destination, [], { ...f.options, encoding: "utf8" }).stdout.trim(), "New CLI");
});

test("refuses an unrelated skill without installing the launcher", (t) => {
	const f = fixture(t);
	mkdirSync(dirname(f.installedSkill), { recursive: true });
	writeFileSync(f.installedSkill, "Keep this skill");
	const result = f.install();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Refusing to replace .*pilot-cli/);
	assert.deepEqual(readdirSync(f.bin), []);
	assert.equal(readFileSync(f.installedSkill, "utf8"), "Keep this skill");
});

test("concurrent installs cannot replace an unrelated entry or leave a partial pair", async (t) => {
	const f = fixture(t);
	const run = promisify(execFile);
	const results = await Promise.allSettled([
		run(process.execPath, f.args, f.options),
		run(process.execPath, f.args, f.options),
	]);
	assert.ok(results.some((result) => result.status === "fulfilled"));
	for (const result of results)
		if (result.status === "rejected") assert.match(result.reason.stderr, /install is locked/);
	assert.deepEqual(readdirSync(f.bin), ["pilot"]);
	assert.equal(readFileSync(f.installedSkill, "utf8"), "Original skill");
});

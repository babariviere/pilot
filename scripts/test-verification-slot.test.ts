import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./verification-slot.py", import.meta.url));
const hold = [process.execPath, "-e", 'console.log("ready"); setInterval(() => {}, 1000)'];

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "verification slots "));
	t.after(() => rm(home, { recursive: true, force: true }));
	return home;
}

function run(t: TestContext, home: string, group = "swift", command = hold, cwd = home) {
	const child = spawn("python3", [runner, group, "--", ...command], {
		cwd,
		env: { ...process.env, PILOT_HOME: home },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (data) => {
		stdout += data;
	});
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const closed = once(child, "close");
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await closed;
	});
	async function waitFor(stream: "stdout" | "stderr", pattern: RegExp) {
		const output = () => (stream === "stdout" ? stdout : stderr);
		while (!pattern.test(output())) {
			assert.ok(child.exitCode === null && child.signalCode === null, `exited before ${pattern}: ${stderr}`);
			await once(child[stream], "data", { signal: AbortSignal.timeout(10_000) });
		}
		return output();
	}
	return { child, closed, waitFor, output: () => ({ stdout, stderr }) };
}

test("one Swift slot serializes different workspaces, reporting holder PID, path and age", async (t) => {
	const home = await fixture(t);
	const firstDir = join(home, "workspace one");
	const secondDir = join(home, "workspace two");
	await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
	const first = run(t, home, "swift", hold, firstDir);
	await first.waitFor("stdout", /ready/);
	const second = run(t, home, "swift", hold, secondDir);
	const progress = await second.waitFor("stderr", /waiting.*held \d+s/);
	assert.ok(progress.includes(`PID ${first.child.pid}`));
	assert.ok(progress.includes(firstDir));
	assert.equal(second.output().stdout, "");
	first.child.kill("SIGTERM");
	await first.closed;
	await second.waitFor("stdout", /ready/);
	assert.match(second.output().stderr, /acquired slot 1\/1/);
});

test("two Node slots run together, a third waits, Swift has an independent pool", async (t) => {
	const home = await fixture(t);
	const first = run(t, home, "node");
	const second = run(t, home, "node");
	await Promise.all([first.waitFor("stdout", /ready/), second.waitFor("stdout", /ready/)]);
	const third = run(t, home, "node");
	const swift = run(t, home);
	const progress = await third.waitFor("stderr", /waiting.*slot 2:/);
	assert.ok(progress.includes(`PID ${first.child.pid}`));
	assert.ok(progress.includes(`PID ${second.child.pid}`));
	await swift.waitFor("stdout", /ready/);
	assert.equal(third.output().stdout, "");
	first.child.kill("SIGTERM");
	await third.waitFor("stdout", /ready/);
});

test("a SIGKILL crash leaves metadata but immediately makes the same slot reusable", async (t) => {
	const home = await fixture(t);
	const first = run(t, home);
	await first.waitFor("stdout", /ready/);
	const path = join(home, "verification/swift/1.lock");
	const old = JSON.parse(await readFile(path, "utf8"));
	assert.equal(old.pid, first.child.pid, "exec leaves no separate lock supervisor");
	first.child.kill("SIGKILL");
	await first.closed;
	assert.equal(JSON.parse(await readFile(path, "utf8")).pid, old.pid);
	const next = run(t, home);
	await next.waitFor("stdout", /ready/);
	assert.equal(JSON.parse(await readFile(path, "utf8")).pid, next.child.pid);
});

test("a killed launcher cannot free the slot while its inherited child is still running", async (t) => {
	const home = await fixture(t);
	const parent = run(t, home, "swift", [
		"/bin/bash",
		"-c",
		'"$1" -e \'console.log("child:" + process.pid); setInterval(() => {}, 1000)\' & wait',
		"test",
		process.execPath,
	]);
	const output = await parent.waitFor("stdout", /child:\d+/);
	const pid = Number(/child:(\d+)/.exec(output)?.[1]);
	t.after(() => {
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	});
	const exited = once(parent.child, "exit");
	parent.child.kill("SIGKILL");
	await exited;
	const next = run(t, home);
	await next.waitFor("stderr", /waiting/);
	assert.equal(next.output().stdout, "");
	process.kill(pid, "SIGKILL");
	await parent.closed;
	await next.waitFor("stdout", /ready/);
});

test("old or malformed holder metadata never permits stealing a live kernel lock", async (t) => {
	const home = await fixture(t);
	const first = run(t, home);
	await first.waitFor("stdout", /ready/);
	await writeFile(join(home, "verification/swift/1.lock"), "stale or truncated metadata");
	const second = run(t, home);
	await second.waitFor("stderr", /waiting.*metadata pending/);
	assert.equal(second.output().stdout, "");
	second.child.kill("SIGINT");
	const [, signal] = await second.closed;
	assert.equal(signal, null);
	assert.equal(second.child.exitCode, 130);
	assert.equal(first.child.exitCode, null);
});

test("machine-wide configuration changes the slot limit", async (t) => {
	const home = await fixture(t);
	await mkdir(join(home, "verification"));
	await writeFile(join(home, "verification/limits.json"), JSON.stringify({ swift: 2, node: 1 }));
	const first = run(t, home);
	const second = run(t, home);
	await Promise.all([first.waitFor("stdout", /ready/), second.waitFor("stdout", /ready/)]);
	assert.match(first.output().stderr + second.output().stderr, /slot 2\/2/);
	const node = run(t, home, "node");
	await node.waitFor("stdout", /ready/);
	const waiting = run(t, home, "node");
	await waiting.waitFor("stderr", /waiting.*1 total/);
});

test("invalid limits fail visibly and never run the command", async (t) => {
	const home = await fixture(t);
	await mkdir(join(home, "verification"));
	for (const config of ["broken", "null", "[]", '{"other":2}', '{"swift":0}', '{"node":true}', '{"node":65}']) {
		await writeFile(join(home, "verification/limits.json"), config);
		const check = run(t, home);
		await check.closed;
		assert.equal(check.child.exitCode, 1, config);
		assert.equal(check.output().stdout, "");
		assert.match(check.output().stderr, /\[verification\]/);
	}
});

test("exit status, arguments, inherited descriptors and failed exec preserve/release the slot", async (t) => {
	const home = await fixture(t);
	const check = run(t, home, "swift", [
		"/bin/bash",
		"-c",
		'exec "$@"',
		"test",
		process.execPath,
		"-e",
		"console.log(process.argv[1]); process.exit(42)",
		"argument with spaces",
	]);
	await check.closed;
	assert.equal(check.child.exitCode, 42);
	assert.equal(check.output().stdout, "argument with spaces\n");
	const missing = run(t, home, "swift", [join(home, "nonexistent-command")]);
	await missing.closed;
	assert.equal(missing.child.exitCode, 1);
	assert.match(missing.output().stderr, /\[verification\].*No such file/);
	const next = run(t, home);
	await next.waitFor("stdout", /ready/);
});

test("Swift-style script re-exec keeps the same PID and slot without acquiring twice", async (t) => {
	const home = await fixture(t);
	const path = join(home, "entry.sh");
	await writeFile(
		path,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not JavaScript
		'if [ "${PILOT_VERIFICATION_SWIFT_PID:-}" != "$$" ]; then\n' +
			'exec python3 "$1" swift -- /bin/bash "$0" "$1"\nfi\n' +
			'unset PILOT_VERIFICATION_SWIFT_PID\nexec "$NODE" -e \'console.log("ready"); setInterval(() => {}, 1000)\'\n',
	);
	const check = run(t, home, "swift", ["env", `NODE=${process.execPath}`, "/bin/bash", path, runner]);
	await check.waitFor("stdout", /ready/);
	assert.equal(check.output().stderr.match(/acquired/g)?.length, 1);
	const waiting = run(t, home);
	await waiting.waitFor("stderr", /waiting/);
	assert.equal(waiting.output().stdout, "");
});

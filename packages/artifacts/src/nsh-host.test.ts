import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callArtifactHost, readArtifactHostBinding } from "./nsh-host.ts";
import { nshSource } from "./nsh-source.ts";

const host = process.env.NSH_ARTIFACT_TEST_HOST;
const options = { skip: !host ? "Run apps/day/scripts/test-artifact-source.mjs for the native compiler" : false };

test("NSH installed helper binds exact runtime source and bytes, not a loose executable", async (t) => {
	const { createHash } = await import("node:crypto");
	const root = await mkdtemp(join(tmpdir(), "nsh-binding-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "packages/artifacts/native");
	await mkdir(directory, { recursive: true });
	const executable = join(directory, "pilot-artifact-host");
	const bytes = Buffer.from("synthetic native bytes, not executed");
	await writeFile(executable, bytes, { mode: 0o755 });
	const identity = {
		schema: 1,
		kind: "nsh-source-host",
		runtime: "nsh 0.5.0",
		source: "a".repeat(40),
		recipe: "b".repeat(64),
	};
	const descriptor = {
		schema: 1,
		identity,
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	const stamp = { schema: 1, source: identity.source, platform: "darwin", arch: "arm64" };
	const write = (value: unknown) => writeFile(join(directory, "artifact-host.json"), JSON.stringify(value));
	await writeFile(join(root, "runtime-build.json"), JSON.stringify(stamp));
	await assert.rejects(readArtifactHostBinding(executable));
	await write(descriptor);
	assert.deepEqual(await readArtifactHostBinding(executable), identity);
	for (const changed of [
		{ ...descriptor, identity: { ...identity, source: "c".repeat(40) } },
		{ ...descriptor, sha256: "0".repeat(64) },
		{ ...descriptor, bytes: 1 },
	]) {
		await write(changed);
		await assert.rejects(readArtifactHostBinding(executable));
	}
	await write(descriptor);
	await writeFile(executable, "tampered");
	await assert.rejects(readArtifactHostBinding(executable));
	await rm(executable);
	await symlink(join(root, "runtime-build.json"), executable);
	await assert.rejects(readArtifactHostBinding(executable));
});
function captured(source: string) {
	const metadata = nshSource(source, "demo.tsx");
	return {
		artifactId: "11111111-1111-1111-1111-111111111111",
		sourceSessionId: "owner",
		revision: 2,
		entry: metadata.entry,
		source,
		sourceSha256: metadata.sourceSha256,
		sourceBytes: metadata.sourceBytes,
	};
}

test("NSH production compiler consumes exact source only and never grants rendering", options, async () => {
	const source =
		"import { Text, signal } from 'nsh'; export default function Artifact() { const n=signal(1); return <Text>{n()}</Text>; }";
	const request = captured(source);
	const result = (await callArtifactHost({ action: "compile", captured: request }, undefined, host)) as {
		artifactId: string;
		revision: number;
		sourceSha256: string;
		code: string;
		rendering: string;
		reason: string;
	};
	assert.equal(result.artifactId, request.artifactId);
	assert.equal(result.revision, 2);
	assert.equal(result.sourceSha256, request.sourceSha256);
	assert.equal(result.rendering, "unsupported");
	assert.match(result.reason, /not qualified/);
	assert.ok(!result.code.includes("<Text>"));
	for (const change of [
		{ source: `${source}\n` },
		{ sourceSha256: "0".repeat(64) },
		{ sourceBytes: 1 },
		{ revision: 0 },
		{ entry: "../demo.tsx" },
		{ artifactId: "other" },
		{ bytecode: [0, 1] },
	])
		await assert.rejects(
			callArtifactHost({ action: "compile", captured: { ...request, ...change } }, undefined, host),
			/Invalid/,
		);
});

test("NSH production compiler rejects import/export reach-through without reading outside files", options, async () => {
	for (const source of [
		"import './absent.tsx'; export default () => null;",
		"export {default} from '/etc/passwd';",
		"export * from 'https://artifact.invalid/a.js'; export default () => null;",
		"import * as rt from 'nsh'; export default () => rt;",
		"import {Shader} from 'nsh'; export default () => null;",
		"import {host} from 'nsh'; export default () => host;",
		"import {mount} from 'nsh'; export default () => null;",
		"import {text} from 'nsh:rt'; export default () => text('x');",
		"import {Bridge} from 'pilot-day/native'; export default () => Bridge;",
		"export default () => import('process');",
		"const x = import.meta.url; export default () => x;",
		"import x = require('fs'); export default () => x;",
		"type X = import('fs').X; export default () => null;",
		"export default function() { return <Text>; }",
		"export const A = 1;",
	])
		await assert.rejects(
			callArtifactHost({ action: "compile", captured: captured(source) }, undefined, host),
			/Artifact.tsx/,
		);
	// Compiler preparation never runs top-level code or historical callbacks.
	const source = "throw Error('not executed'); export default () => null;";
	const result = (await callArtifactHost({ action: "compile", captured: captured(source) }, undefined, host)) as {
		rendering: string;
	};
	assert.equal(result.rendering, "unsupported");
});

test(
	"NSH supplied examples prepare without filesystem resolution; unqualified motion is refused",
	options,
	async () => {
		for (const name of ["summary", "charts", "flow", "sequence", "mockup"]) {
			const source = await readFile(
				new URL(`../../kernel/skills/pilot-artifacts/nsh/examples/${name}.tsx`, import.meta.url),
				"utf8",
			);
			if (name === "mockup") {
				await assert.rejects(
					callArtifactHost({ action: "compile", captured: captured(source) }, undefined, host),
					/allowlist/,
				);
			} else {
				const result = (await callArtifactHost(
					{ action: "compile", captured: captured(source) },
					undefined,
					host,
				)) as { rendering: string };
				assert.equal(result.rendering, "unsupported");
			}
		}
	},
);

test("NSH helper transport joins the owned helper before it releases a slot or settles", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nsh-host-transport-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const executable = join(root, "helper");
	const program = join(root, "program.cjs");
	const pids = join(root, "pids");
	const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
	await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)}\n`, { mode: 0o700 });
	// Each helper records its own PID (exec keeps it), so the test can see that it was reaped.
	const script = (body: string) =>
		writeFile(program, `require("node:fs").appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");\n${body}`);
	const started = async () => (await readFile(pids, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
	// Settlement must follow the direct helper's exit and reaping. This is not subtree evidence.
	const joined = async (count: number) => {
		const list = await started();
		assert.equal(list.length, count);
		for (const pid of list) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		await rm(pids, { force: true });
	};
	const fail = async (body: string, error: RegExp) => {
		await script(body);
		await assert.rejects(callArtifactHost({}, undefined, executable), error);
		await joined(1);
	};
	await fail("process.stdin.resume(); process.stdout.write('not json');", /Invalid/);
	// Oversized output: the helper stays alive, so only the transport's kill can end it.
	await fail("process.stdout.write('x'.repeat(5*1024*1024)); setInterval(() => {}, 1000);", /output exceeds/);

	// Cancellation: a complete reply already written is not accepted, and both slots stay
	// held until each helper is joined.
	await script("process.stdout.write(JSON.stringify({value: 1})); setInterval(() => {}, 1000);");
	const controller = new AbortController();
	const waiting = callArtifactHost({}, controller.signal, executable);
	const second = callArtifactHost({}, controller.signal, executable);
	await assert.rejects(callArtifactHost({}, undefined, executable), /busy/);
	for (let tries = 0; (await started()).length < 2; tries++) {
		assert.ok(tries < 500, "helpers did not start");
		await delay(10);
	}
	controller.abort();
	await assert.rejects(callArtifactHost({}, undefined, executable), /busy/);
	const stopped = await Promise.allSettled([waiting, second]);
	assert.ok(stopped.every((result) => result.status === "rejected" && /canceled/.test(String(result.reason))));
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	await joined(2);
	// An already-canceled request never starts a helper.
	await assert.rejects(callArtifactHost({}, controller.signal, executable), { name: "AbortError" });
	await joined(0);

	await fail("setInterval(() => {}, 1000);", /5 second deadline/);
	await fail("process.exit(13);", /host failed/);
	// A helper that closes stdout early settles only after it exits.
	await script("process.stdout.end(JSON.stringify({value: 2})); setTimeout(() => {}, 300);");
	assert.equal(await callArtifactHost({}, undefined, executable), 2);
	await joined(1);

	// Spawn failures settle and release their slots; repeated failures never become busy.
	const blocked = join(root, "not-executable");
	await writeFile(blocked, "#!/bin/sh\n");
	await chmod(blocked, 0o600);
	for (const path of [join(root, "missing"), blocked, join(root, "missing"), blocked])
		await assert.rejects(callArtifactHost({}, undefined, path), /unavailable/);

	await script(
		"process.stdout.write(JSON.stringify({value: [process.env.HOME ?? null, process.env.NSH_ARTIFACT_TEST_HOST ?? null]}));",
	);
	assert.deepEqual(await callArtifactHost({}, undefined, executable), [null, null]);
	const identity = {
		schema: 1,
		kind: "nsh-source-host",
		runtime: "nsh 0.5.0",
		source: "a".repeat(40),
		recipe: "b".repeat(64),
	};
	await script(`process.stdout.write(JSON.stringify({value:null,identity:${JSON.stringify(identity)}}));`);
	assert.equal(await callArtifactHost({}, undefined, executable, identity), null);
	await assert.rejects(
		callArtifactHost({}, undefined, executable, { ...identity, source: "c".repeat(40) }),
		/Invalid/,
	);
	await script("process.stdout.write(JSON.stringify({value:null,error:'ambiguous'}));");
	await assert.rejects(callArtifactHost({}, undefined, executable), /Invalid/);
});

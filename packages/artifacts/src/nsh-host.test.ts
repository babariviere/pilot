import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callArtifactHost } from "./nsh-host.ts";
import { nshSource } from "./nsh-source.ts";

const host = process.env.NSH_ARTIFACT_TEST_HOST;
const options = { skip: !host ? "Run apps/day/scripts/test-artifact-source.mjs for the native compiler" : false };
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

test("NSH helper transport joins after cancellation and rejects oversized/malformed host responses", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nsh-host-transport-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const executable = join(root, "helper");
	const program = join(root, "program.cjs");
	const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
	await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)}\n`, { mode: 0o700 });
	const script = (body: string) => writeFile(program, body);
	await script("process.stdin.resume(); process.stdout.write('not json');");
	await assert.rejects(callArtifactHost({}, undefined, executable), /Invalid/);
	await script("process.stdin.resume(); process.stdout.write('x'.repeat(5*1024*1024));");
	await assert.rejects(callArtifactHost({}, undefined, executable), /output exceeds/);
	await script("setInterval(() => {}, 1000);");
	const controller = new AbortController();
	const waiting = callArtifactHost({}, controller.signal, executable);
	const second = callArtifactHost({}, controller.signal, executable);
	await assert.rejects(callArtifactHost({}, undefined, executable), /busy/);
	controller.abort();
	const stopped = await Promise.allSettled([waiting, second]);
	assert.ok(stopped.every((result) => result.status === "rejected" && /canceled/.test(String(result.reason))));
	await script("setInterval(() => {}, 1000);");
	await assert.rejects(callArtifactHost({}, undefined, executable), /5 second deadline/);
	await script("process.exit(13);");
	await assert.rejects(callArtifactHost({}, undefined, executable), /host failed/);
	await script(
		"process.stdout.write(JSON.stringify({value: [process.env.HOME ?? null, process.env.NSH_ARTIFACT_TEST_HOST ?? null]}));",
	);
	assert.deepEqual(await callArtifactHost({}, undefined, executable), [null, null]);
});

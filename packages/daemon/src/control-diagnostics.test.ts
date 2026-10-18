import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { SessionDiagnostics } from "@pilot/protocol";
import { CONTROL_SYSTEM_PROMPT } from "../../kernel/src/control-context.ts";
import { createPilotTool } from "../../kernel/src/pilot-tool.ts";
import { CONTROL_DIAGNOSTIC_BYTES, CONTROL_LOG_SCAN_BYTES, ControlDiagnostics } from "./control-diagnostics.ts";
import { ControlPilot } from "./control-pilot.ts";
import { isCredentialField, redactDiagnosticText } from "./diagnostic-redaction.ts";

const id = "00000000-0000-4000-8000-000000000001";
const stamp = "2026-10-18T10:00:00.000Z";

async function fixture(t: TestContext) {
	const home = await realpath(await mkdtemp(join(tmpdir(), "control-diagnostics-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	const directory = join(home, "sessions", id);
	const root = join(home, "Test.app/Contents/Resources/runtime");
	await mkdir(join(directory, "durable"), { recursive: true });
	await mkdir(root, { recursive: true });
	let enabled = true;
	let evidenceReads = 0;
	const options = {
		home,
		runtimeRoot: root,
		daemonId: "daemon",
		lineageId: "lineage",
		daemonLog: join(home, "daemon.log"),
		localDiagnostics: () => enabled,
		health: () => ({ workers: { total: 0 }, connectivity: { state: "unknown" }, pause: { update: false } }),
		sessionDirectory: (sessionId: string) => {
			assert.equal(sessionId, id);
			return directory;
		},
		evidence: async (sessionId: string, limit: number) => {
			evidenceReads++;
			assert.equal(sessionId, id);
			assert.ok(limit <= 40);
			return { sessionId, evidence: [{ kind: "execution.completed", at: stamp }] } as unknown as SessionDiagnostics;
		},
		evidenceSummary: (): unknown => ({ stalls: 0, rssBytes: 123 }),
	};
	const service = new ControlDiagnostics(options);
	return {
		home,
		directory,
		root,
		options,
		service,
		evidenceReads: () => evidenceReads,
		setEnabled: (value: boolean) => {
			enabled = value;
		},
	};
}

test("credential redaction covers headers, nested JSON, provider tokens, keys, URLs and multiline secrets", () => {
	const inputs = [
		"Authorization: Bearer header-value",
		"Proxy-Authorization: Basic dXNlcjpwYXNz",
		'{"headers":{"x-api-key":"nested-value"}}',
		'{"accessToken":"camel-value","refresh_token":"refresh-value"}',
		"api_key=env-value",
		"key = generic-value",
		"AWS_SECRET_ACCESS_KEY=aws-value",
		"Cookie: session=cookie-value",
		"Set-Cookie: session=set-value; HttpOnly",
		"https://user:url-value@example.test/path",
		"https://example.test/path?signature=signed-value",
		"sk-provider-value",
		"ghp_githubvalue",
		"xoxb-slackvalue",
		"-----BEGIN PRIVATE KEY-----\nshort-key-value\n-----END PRIVATE KEY-----",
		"token:\n continuation-value",
		"a".repeat(64),
		'{"api\\u005fkey":"encoded-value"}',
		`[${stamp}] {"api\\u005fkey":"encoded-value"}`,
		"https://example.test/path?api%5Fkey=encoded-value",
	];
	for (const input of inputs) {
		const redacted = redactDiagnosticText(input);
		assert.match(redacted, /REDACTED/, input);
		assert.doesNotMatch(
			redacted,
			/(?:header|nested|camel|refresh|env|generic|aws|cookie|set|url|signed|provider|short-key|continuation)-value|githubvalue|slackvalue|a{64}/,
		);
	}
	assert.equal(redactDiagnosticText("worker ready, 123 ms"), "worker ready, 123 ms");
	assert.equal(isCredentialField("clientSecret"), true);
});

test("health distinguishes running daemon/runtime, installed bundle, unknown app and fenced update state without writes", async (t) => {
	const f = await fixture(t);
	await writeFile(
		join(f.root, "../../Info.plist"),
		"<plist><key>CFBundleShortVersionString</key><string>1.2.3</string><key>CFBundleVersion</key><string>10123.1</string></plist>",
	);
	const before = await readdir(f.home);
	const result = await f.service.call("health", {});
	assert.equal(result.untrusted, true);
	assert.equal(result.quotedContent.app.installedBuild, "10123.1");
	assert.equal(result.quotedContent.app.runningVersion, "unavailable");
	assert.equal(result.quotedContent.runtime.node, process.versions.node);
	assert.ok(result.quotedContent.daemon.uptimeMs >= 0);
	assert.equal(result.quotedContent.update.available, false);
	assert.deepEqual(await readdir(f.home), before, "a read must not create the update directory");
	await mkdir(join(f.home, "runtime-update"));
	const journal = JSON.stringify({
		schema: 1,
		revision: 1,
		daemonId: "daemon",
		lineageId: "lineage",
		phase: "waiting",
		version: "1.3.0",
		privateKey: "never-return",
	});
	await writeFile(join(f.home, "runtime-update/current.json"), journal);
	const health = await f.service.call("health", {});
	assert.deepEqual(health.quotedContent.update, { available: true, phase: "waiting", version: "1.3.0", revision: 1 });
	assert.equal(await readFile(join(f.home, "runtime-update/current.json"), "utf8"), journal);
	assert.doesNotMatch(JSON.stringify(health), /never-return/);
	await writeFile(join(f.home, "runtime-update/current.json"), journal.replace('"daemon"', '"foreign"'));
	assert.equal((await f.service.call("health", {})).quotedContent.update.available, false);
});

test("logs tail rotated/current files, filter literal redacted text and dates, and never read transcript", async (t) => {
	const f = await fixture(t);
	await writeFile(
		f.options.daemonLog,
		`[${stamp}] newer READY [literal]\n[${stamp}] Authorization: Bearer needle-secret\n`,
	);
	await writeFile(`${f.options.daemonLog}.1`, "[2026-10-17T10:00:00Z] older ready\n");
	const result = await f.service.call("logs", { source: "daemon", q: "ready", since: stamp });
	assert.deepEqual(
		result.quotedContent.records.map((row: { text: string }) => row.text),
		[`[${stamp}] newer READY [literal]`],
	);
	assert.equal(
		(await f.service.call("logs", { source: "daemon", q: "needle-secret" })).quotedContent.records.length,
		0,
	);
	assert.equal((await f.service.call("logs", { source: "daemon", q: "[literal]" })).quotedContent.records.length, 1);
	await writeFile(join(f.directory, "lifecycle.jsonl"), `${JSON.stringify({ at: stamp, kind: "worker.parked" })}\n`);
	await writeFile(
		join(f.directory, "durable/performance.jsonl"),
		`${JSON.stringify({ at: Date.parse(stamp), totalMs: 2 })}\n`,
	);
	await writeFile(
		join(f.directory, "durable/tool-activity.jsonl"),
		`${JSON.stringify({ at: Date.parse(stamp), category: "read" })}\n`,
	);
	await writeFile(join(f.directory, "durable/messages.jsonl"), "conversation-never-read");
	assert.equal((await f.service.call("logs", { source: "lifecycle", sessionId: id })).quotedContent.records.length, 1);
	const session = await f.service.call("logs", { source: "session", sessionId: id, since: stamp });
	assert.equal(session.quotedContent.records.length, 2);
	assert.doesNotMatch(JSON.stringify(session), /conversation-never-read/);
	assert.equal(f.evidenceReads(), 0);
});

test("log scans, records, UTF-8 response bytes and incomplete records are bounded", async (t) => {
	const f = await fixture(t);
	const line = `[${stamp}] ${"🤖".repeat(1500)}\n`;
	await writeFile(f.options.daemonLog, line.repeat(1000));
	const result = await f.service.call("logs", { source: "daemon", limit: 40 });
	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= CONTROL_DIAGNOSTIC_BYTES);
	assert.ok(result.quotedContent.records.length <= 40);
	assert.equal(result.quotedContent.scanBytes, CONTROL_LOG_SCAN_BYTES * 2);
	await writeFile(f.options.daemonLog, `partial-${"x".repeat(CONTROL_LOG_SCAN_BYTES * 2)}`);
	assert.deepEqual((await f.service.call("logs", { source: "daemon" })).quotedContent.records, []);
	await writeFile(f.options.daemonLog, `[${stamp}] complete\nunfinished-secret`);
	const complete = await f.service.call("logs", { source: "daemon" });
	assert.equal(complete.truncated, true);
	assert.doesNotMatch(JSON.stringify(complete), /unfinished-secret/);
});

test("invalid inputs and symlinks are rejected without returning filesystem errors or arbitrary content", async (t) => {
	const f = await fixture(t);
	for (const args of [
		{ source: "other" },
		{ source: "daemon", limit: 41 },
		{ source: "daemon", limit: 0 },
		{ source: "daemon", limit: 1.1 },
		{ source: "daemon", q: "x".repeat(201) },
		{ source: "daemon", since: "yesterday" },
		{ source: "session", sessionId: "../../secret" },
	])
		await assert.rejects(f.service.call("logs", args));
	await writeFile(join(f.home, "private"), "arbitrary-content\n");
	await symlink(join(f.home, "private"), f.options.daemonLog);
	const linked = await f.service.call("logs", { source: "daemon" });
	assert.equal(linked.quotedContent.available, false);
	assert.doesNotMatch(JSON.stringify(linked), /arbitrary-content|ELOOP|private/);
	await rm(join(f.directory, "durable"), { recursive: true });
	await symlink(f.home, join(f.directory, "durable"));
	assert.equal((await f.service.call("logs", { source: "session", sessionId: id })).quotedContent.available, false);
	await rm(f.directory, { recursive: true });
	await symlink(f.home, f.directory);
	assert.equal((await f.service.call("logs", { source: "lifecycle", sessionId: id })).quotedContent.available, false);
});

test("telemetry disabled is explicit and reads no evidence; host and targeted summaries remain quoted and redacted", async (t) => {
	const f = await fixture(t);
	f.setEnabled(false);
	const disabled = await f.service.call("telemetry", {});
	assert.equal(disabled.quotedContent.enabled, false);
	assert.match(disabled.quotedContent.reason, /disabled/);
	assert.equal(f.evidenceReads(), 0);
	assert.equal((await f.service.call("logs", { source: "session", sessionId: id })).quotedContent.enabled, false);
	f.setEnabled(true);
	assert.equal((await f.service.call("telemetry", {})).quotedContent.summary.rssBytes, 123);
	assert.equal((await f.service.call("telemetry", { sessionId: id })).quotedContent.evidence.length, 1);
	assert.equal(f.evidenceReads(), 1);
	f.options.evidenceSummary = () => ({
		apiKey: "never-return",
		text: "Authorization: bearer never-return",
		data: [{ secret: "never-return" }],
	});
	assert.doesNotMatch(JSON.stringify(await f.service.call("telemetry", {})), /never-return/);
	f.options.evidence = async () => {
		f.setEnabled(false);
		return { evidence: [{ secret: "never-return" }] } as unknown as SessionDiagnostics;
	};
	assert.equal((await f.service.call("telemetry", { sessionId: id })).quotedContent.enabled, false);
});

test("concurrent diagnostics reads have bounded admission and release capacity on failure", async (t) => {
	const f = await fixture(t);
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.options.evidence = async () => {
		await blocked;
		throw new Error("synthetic read failure");
	};
	const calls = Array.from({ length: 4 }, () => f.service.call("telemetry", { sessionId: id }));
	const settled = Promise.allSettled(calls);
	await assert.rejects(f.service.call("health", {}), /busy/);
	release();
	assert.ok((await settled).every((result) => result.status === "rejected"));
	await f.service.call("health", {});
});

test("session log reads withhold evidence when local consent changes during the asynchronous read", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.directory, "lifecycle.jsonl"), `${JSON.stringify({ at: stamp, kind: "worker.parked" })}\n`);
	let observations = 0;
	f.options.localDiagnostics = () => ++observations === 1;
	const result = await f.service.call("logs", { source: "lifecycle", sessionId: id });
	assert.equal(result.quotedContent.enabled, false);
	assert.equal(result.quotedContent.records.length, 0);
	assert.doesNotMatch(JSON.stringify(result), /worker.parked/);
});

test("large telemetry projections keep newest evidence and report the actual UTF-8 wrapper bound", async (t) => {
	const f = await fixture(t);
	f.options.evidence = async () =>
		({
			evidence: Array.from({ length: 40 }, (_, i) => ({ kind: `item-${i}`, text: "🤖 ".repeat(1000) })),
			truncation: { returned: 40, available: 40, encodedBytes: 0, maxBytes: 65536, truncated: false },
		}) as unknown as SessionDiagnostics;
	const result = await f.service.call("telemetry", { sessionId: id, limit: 40 });
	assert.equal(result.truncated, true);
	assert.equal(result.quotedContent.evidence[0].kind, "item-0");
	assert.ok(result.quotedContent.evidence.length < 40);
	assert.equal(result.quotedContent.truncation.returned, result.quotedContent.evidence.length);
	assert.equal(result.quotedContent.truncation.encodedBytes, Buffer.byteLength(JSON.stringify(result)));
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= CONTROL_DIAGNOSTIC_BYTES);
});

test("journal-only hosts expose an explicitly current-process daemon ring without shell access", async (t) => {
	const f = await fixture(t);
	const options = {
		...f.options,
		daemonLog: undefined,
		daemonTail: () => ({ text: `[${stamp}] ring record\n`, available: true, truncated: true }),
	};
	const service = new ControlDiagnostics(options);
	const result = await service.call("logs", { source: "daemon", q: "record", since: stamp });
	assert.equal(result.quotedContent.records.length, 1);
	assert.match(result.quotedContent.reason, /Current-process/);
	assert.equal(result.truncated, true);
});

test("only the supervised Control role can dispatch all three actions and schema/prompt expose one tool", async (t) => {
	const f = await fixture(t);
	const service = new ControlPilot({
		isControl: (caller) => caller === "control",
		diagnostics: f.service,
		sessions: {
			list: () => {
				throw new Error("no session listing");
			},
			get: () => undefined,
			history: async () => {
				throw new Error("no transcript");
			},
		},
		missions: () => [],
		projects: () => [],
		linear: () => [],
	});
	const tool = createPilotTool(async (action, args) => (await service.call("control", action, args)) as never);
	for (const action of ["health", "logs", "telemetry"] as const) {
		await assert.rejects(service.call("ordinary", action, {}), /Only the control/);
		const result = await tool.execute(
			"call",
			{ action, ...(action === "logs" ? { source: "daemon" as const } : {}) },
			undefined,
			undefined,
			{} as never,
		);
		assert.match(JSON.stringify(result), /untrusted/);
	}
	assert.match(CONTROL_SYSTEM_PROMPT, /health, logs and telemetry before delegating/);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, SessionCompletion } from "@pilot/protocol";
import { Type } from "typebox";
import type { DatabaseCall } from "./database-tool.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { QUESTION_ENTRY } from "./question-tool.ts";
import { KernelSession } from "./session.ts";
import { TOOL_ACTIVITY_FILE, type ToolActivityRecord } from "./tool-activity.ts";

async function open(
	t: TestContext,
	name: string,
	databases: { databases?: boolean; callDatabase?: DatabaseCall; root?: string } = {},
) {
	const root = databases.root ?? (await mkdtemp(join(tmpdir(), "pilot-question-")));
	const cleanup: Array<() => Promise<void>> = [];
	t.after(async () => {
		try {
			for (const close of cleanup.reverse()) await close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "pilot-question-test", models: [{ id: "offline" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	const effects: string[] = [];
	let notifyWaiting!: () => void;
	const waiting = new Promise<void>((resolve) => {
		notifyWaiting = resolve;
	});
	const options: Partial<NativeAdapterOptions> = {
		agentDir: join(root, "agent"),
		projectTrusted: false,
		settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "codemode"] }),
		sessionOptions: {
			modelRuntime,
			model: faux.getModel(),
			customTools: [
				{
					name: "question_wait",
					label: "Wait",
					description: "Synthetic post-reply gate",
					parameters: Type.Object({}),
					execute: async (_id, _args, signal) => {
						notifyWaiting();
						if (!signal?.aborted)
							await new Promise<void>((resolve) =>
								signal?.addEventListener("abort", () => resolve(), { once: true }),
							);
						return { content: [], details: {} };
					},
				},
				{
					name: "question_effect",
					label: "Effect",
					description: "Synthetic effect",
					parameters: Type.Object({ value: Type.String() }),
					execute: async (_id, args) => {
						effects.push((args as { value: string }).value);
						return { content: [{ type: "text", text: (args as { value: string }).value }], details: {} };
					},
				},
			],
		},
		loaderOptions: {
			cwd: root,
			agentDir: join(root, "agent"),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Offline question integration.",
			extensionFactories: [createCodemodeExtension({ models: false, mode: "on" })],
		},
	};
	const openAdapter = NativeAdapter.open;
	const refreshUsage = NativeAdapter.prototype.refreshUsage;
	const refreshes: Promise<void>[] = [];
	t.mock.method(
		NativeAdapter.prototype,
		"refreshUsage",
		function (this: NativeAdapter, ...args: Parameters<typeof refreshUsage>) {
			const refresh = refreshUsage.apply(this, args);
			refreshes.push(refresh);
			return refresh;
		},
	);
	t.mock.method(NativeAdapter, "open", (adapterOptions: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, {
			...adapterOptions,
			...options,
			sessionOptions: {
				...adapterOptions.sessionOptions,
				...options.sessionOptions,
				customTools: [
					...(adapterOptions.sessionOptions?.customTools ?? []),
					...(options.sessionOptions?.customTools ?? []),
				],
			},
		}),
	);
	const completions: SessionCompletion[] = [];
	const awaited: (string | undefined)[] = [];
	const reopen = () =>
		KernelSession.open(
			{
				sessionId: name,
				cwd: root,
				storageDir: join(root, "storage"),
				...(databases.databases ? { databases: true } : {}),
			},
			{
				...(databases.callDatabase ? { callDatabase: databases.callDatabase } : {}),
				onQuestionAwaited: (question) => awaited.push(question),
				onWorking: (working, completion) => {
					if (!working && completion && completion.outcomeAt !== completions.at(-1)?.outcomeAt)
						completions.push(completion);
				},
			},
		);
	let session = await reopen();
	cleanup.push(async () => {
		await Promise.all(refreshes);
		await session.close();
	});
	return {
		get session() {
			return session;
		},
		faux,
		completions,
		awaited,
		effects,
		waiting,
		async reopen() {
			await session.close();
			session = await reopen();
		},
		storageDir: join(root, "storage"),
	};
}

async function questions(session: KernelSession) {
	const view = await session.conversation.context(BACKGROUND_CONTEXT);
	return view.entries.filter((entry) => entry.kind === QUESTION_ENTRY).map((entry) => entry.data);
}

async function settled(completions: SessionCompletion[], count: number) {
	const deadline = Date.now() + 10_000;
	while (completions.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	return completions[count - 1];
}

async function questionPublished(session: KernelSession, count = 1) {
	const deadline = Date.now() + 5000;
	while ((await questions(session)).length < count && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal((await questions(session)).length, count);
}

test("direct ask_user saves a result, ends the turn and starts a new turn on reply", { timeout: 20_000 }, async (t) => {
	const { session, faux, completions, awaited } = await open(t, "direct-question");
	let seen = "";
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Where?" }), { stopReason: "toolUse" }),
		(view) => {
			const call = view.messages.findIndex(
				(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
			);
			assert.equal(view.messages[call + 1]?.role, "toolResult", "reply preserves tool-call/result pairing");
			seen = JSON.stringify(view.messages);
			return fauxAssistantMessage("Answered.");
		},
		fauxAssistantMessage("Automatic processed."),
	]);
	await session.submit("ask", "Add retries", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(faux.state.callCount, 1);
	assert.equal((await settled(completions, 1))?.outcome, "question");
	assert.ok(!awaited.some((question) => question !== undefined), "no suspended tool call");
	assert.deepEqual(await questions(session), [{ question: "Where?", options: [] }]);
	const saved = (await session.conversation.context(BACKGROUND_CONTEXT)).messages.find(
		(message) => message.role === "toolResult" && message.toolName === "ask_user",
	);
	assert.match(JSON.stringify(saved), /Question saved.*Awaiting the human reply/);
	assert.doesNotMatch(JSON.stringify(saved), /Sync worker/);
	await session.submit("mission:send:auto", "Not an answer", "followUp");
	assert.equal(faux.state.callCount, 1, "automatic input cannot answer a saved question");
	await session.submit("reply", "Sync worker", "steer");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.match(seen, /Sync worker/);
	assert.equal((await settled(completions, 2))?.outcome, "done");
});

test("coordinator answers start a new turn and retain provenance and reply deduplication", {
	timeout: 20_000,
}, async (t) => {
	const { session, faux, effects } = await open(t, "coordinator-question");
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Which checks?" }), { stopReason: "toolUse" }),
		(view) => {
			assert.match(JSON.stringify(view.messages), /Tests/);
			return fauxAssistantMessage(fauxToolCall("question_effect", { value: "new turn" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Answered."),
		fauxAssistantMessage("Notice handled."),
	]);
	await session.submit("ask", "Ask", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	const entries = (await session.conversation.context(BACKGROUND_CONTEXT)).entries;
	const questionId = Number(entries.find((entry) => entry.kind === QUESTION_ENTRY)!.id);
	await session.submit("mission:send:from:lead:mission:notice", "Not an answer", "steer");
	assert.deepEqual(effects, []);
	await assert.rejects(
		session.submit(
			"mission:send:from:lead:mission:stale",
			"Wrong",
			"followUp",
			false,
			true,
			undefined,
			undefined,
			false,
			questionId + 1,
		),
		/no longer pending/,
	);
	const requestId = "mission:send:from:lead:mission:answer";
	await session.submit(requestId, "Tests", "followUp", false, true, undefined, undefined, false, questionId);
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(effects, ["new turn"]);
	await session.submit(requestId, "Tests", "followUp", false, true, undefined, undefined, false, questionId);
	assert.deepEqual(effects, ["new turn"], "accepted reply retries never replay effects");
	const events: AgentEvent[] = [];
	await session.watch("answer-provenance", (batch) => {
		events.push(...batch);
	});
	const snapshot = events.find((event) => event.type === "snapshot");
	assert.ok(
		snapshot?.type === "snapshot" &&
			snapshot.entries.some(
				(entry) =>
					entry.kind === "pi.user" &&
					(entry as unknown as { origin?: string }).origin === "coordinator" &&
					(entry as unknown as { sourceSessionId?: string }).sourceSessionId === "lead",
			),
	);
	await session.unwatch("answer-provenance");
});

test("codemode cannot run subsequent effects or save a second question before reply", {
	timeout: 20_000,
}, async (t) => {
	const f = await open(t, "codemode-question");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'await tools.question_effect({value:"before"}); await tools.ask_user({question:"First?"}); try { await tools.question_effect({value:"after"}); } catch {} try { await tools.ask_user({question:"Second?"}); } catch {} await tools.question_effect({value:"escaped"});',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Reply handled in a new turn."),
		fauxAssistantMessage("Notice handled."),
	]);
	await f.session.submit("ask", "Ask", "followUp");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal((await settled(f.completions, 1))?.outcome, "question");
	assert.deepEqual(f.effects, ["before"]);
	assert.deepEqual(await questions(f.session), [{ question: "First?", options: [] }]);
	await f.session.submit("native:jobs.result:auto", "Not an answer", "steer");
	assert.equal(f.faux.state.callCount, 1);
	await f.session.submit("reply", "Tests", "steer");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(f.effects, ["before"], "reply never resumes the old script");
	const calls = f.faux.state.callCount;
	await f.session.submit("reply", "Tests", "steer");
	assert.equal(f.faux.state.callCount, calls, "lost ACK must not repeat a turn");
});

test("Stop clears a saved question without running subsequent effects or held automatic input", {
	timeout: 20_000,
}, async (t) => {
	const f = await open(t, "cancelled-question");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'await tools.question_effect({value:"before"}); try { await tools.ask_user({question:"Continue?"}); } catch {} await tools.question_effect({value:"after"});',
			}),
			{ stopReason: "toolUse" },
		),
	]);
	await f.session.submit("ask", "Ask", "followUp");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	await f.session.submit("mission:send:auto", "Keep held", "followUp");
	const snapshots: AgentEvent[] = [];
	const capture = (events: AgentEvent[]) => snapshots.push(...events);
	await f.session.watch("paged-pending", capture, false, false, true);
	assert.ok(snapshots.find((e) => e.type === "snapshot")?.history?.question);
	await f.session.unwatch("paged-pending");
	await f.session.abort();
	for (const label of ["stopped", "restored"]) {
		if (label === "restored") await f.reopen();
		snapshots.length = 0;
		await f.session.watch(label, capture, false, false, true);
		assert.equal(snapshots.find((e) => e.type === "snapshot")?.history?.question, null);
		await f.session.unwatch(label);
	}
	assert.deepEqual(f.effects, ["before"]);
	assert.equal(f.faux.state.callCount, 1);
});

test("Stop during the reply turn keeps the accepted answer without replaying effects", {
	timeout: 20_000,
}, async (t) => {
	const f = await open(t, "accepted-then-stopped");
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Continue?" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'await tools.question_wait({}); await tools.question_effect({value:"after"});',
			}),
			{ stopReason: "toolUse" },
		),
	]);
	await f.session.submit("ask", "Ask", "followUp");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	await f.session.submit("answer", "Retain my answer", "steer");
	await f.waiting;
	await f.session.abort();
	assert.deepEqual(f.effects, []);
	assert.ok(
		(await f.session.conversation.context(BACKGROUND_CONTEXT)).messages.some(
			(message) => message.role === "user" && message.content === "Retain my answer",
		),
	);
	await f.reopen();
	await f.session.submit("answer", "Retain my answer", "steer");
	assert.deepEqual(f.effects, []);
	assert.equal(f.faux.state.callCount, 2);
});

test("kernel replacement keeps the saved question and never replays earlier or later effects", {
	timeout: 20_000,
}, async (t) => {
	const f = await open(t, "recovered-question");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'await tools.question_effect({value:"before"}); await tools.ask_user({question:"Continue?"}); await tools.question_effect({value:"after"});',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Recovered answer handled."),
		fauxAssistantMessage("Held notice handled."),
	]);
	await f.session.submit("ask", "Ask", "followUp");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	await f.session.submit("mission:send:auto", "Not an answer", "followUp");
	await f.reopen();
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(f.effects, ["before"]);
	assert.equal(f.faux.state.callCount, 1);
	assert.equal((await questions(f.session)).length, 1);
	const snapshots: AgentEvent[] = [];
	await f.session.watch(
		"restored-pending",
		(events) => {
			snapshots.push(...events);
		},
		false,
		false,
		true,
	);
	assert.ok(snapshots.find((event) => event.type === "snapshot")?.history?.question);
	await f.session.unwatch("restored-pending");
	await f.session.submit("answer", "Continue", "steer");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(f.effects, ["before"]);
	const calls = f.faux.state.callCount;
	await f.session.submit("answer", "Continue", "steer");
	assert.equal(f.faux.state.callCount, calls);
});

test("safe tool drain completes without a reply and preserves the saved question across reopen", {
	timeout: 20_000,
}, async (t) => {
	const f = await open(t, "drained-question");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'await tools.ask_user({question:"Continue?"}); await tools.question_effect({value:"after"});',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Reply handled."),
	]);
	await f.session.submit("ask", "Ask", "followUp");
	await questionPublished(f.session);
	await f.session.pauseForUpdate();
	assert.deepEqual(f.effects, []);
	assert.equal(f.faux.state.callCount, 1);
	await f.reopen();
	assert.equal((await questions(f.session)).length, 1);
	await f.session.submit("answer", "Continue", "steer");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(f.effects, []);
	assert.equal(f.faux.state.callCount, 2);
});

test("db through codemode queries pilotd, and a pending grant asks the user", { timeout: 20_000 }, async (t) => {
	const calls: Array<[string, unknown]> = [];
	const { session, faux, completions } = await open(t, "database-question", {
		databases: true,
		callDatabase: async (action, args): Promise<JsonValue> => {
			calls.push([action, args]);
			if (action === "query")
				return { env: "local", mode: "read", columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false };
			return {
				status: "pending",
				env: "prod",
				mode: "read",
				question: {
					question: "Allow read access to the prod database?",
					options: [{ label: "Allow read access to prod" }, { label: "Deny" }],
					databaseAccess: { id: "request-1", env: "prod", mode: "read" },
				},
			};
		},
	});
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'const r = await tools.db({action:"query",env:"local",sql:"select 1 as n"}); text(JSON.stringify(r.rows)); await tools.db({action:"access",env:"prod"});',
			}),
			{ stopReason: "toolUse" },
		),
	]);
	await session.submit("ask", "Count users", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(calls, [
		["query", { env: "local", sql: "select 1 as n" }],
		["access", { env: "prod" }],
	]);
	const messages = (await session.conversation.context(BACKGROUND_CONTEXT)).messages;
	const result = messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
	assert.match(JSON.stringify(result), /n\\":1/);
	assert.equal(faux.state.callCount, 1, "saving the access question ends the turn");
	assert.deepEqual(await questions(session), [
		{
			question: "Allow read access to the prod database?",
			options: [{ label: "Allow read access to prod" }, { label: "Deny" }],
			databaseAccess: { id: "request-1", env: "prod", mode: "read" },
		},
	]);
	assert.equal((await settled(completions, 1))?.outcome, "question");
});

test("a caught nested DB rejection remains a failed call even when discovery, approval and the script succeed", {
	timeout: 20_000,
}, async (t) => {
	const calls: string[] = [];
	const failure =
		"Database connection failed (SQLSTATE 28000). PostgreSQL server authentication rules rejected the connection. The server reported an unencrypted connection; this alone does not establish a TLS requirement. Pilot access approval does not verify connectivity.";
	const { session, faux, completions, storageDir } = await open(t, "database-caught-failure", {
		databases: true,
		callDatabase: async (action, args): Promise<JsonValue> => {
			calls.push(action);
			if (action === "access") {
				assert.ok(!calls.includes("query"), "listing and approval happen before any connection attempt");
				return args.env
					? { status: "granted", env: "prod", mode: "read" }
					: { environments: [{ name: "prod", modes: { read: "allow" }, granted: [] }] };
			}
			throw Object.assign(new Error(failure), { code: "28000" });
		},
	});
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: `text(typeof tools.db);
text(await tools.db({action: "access"}));
text(await tools.db({action: "access", env: "prod"}));
try { await tools.db({action: "query", env: "prod", sql: "select 'private-query-marker'"}); }
catch (error) { text(String(error)); }
text("script finished, not connectivity success");`,
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The script finished, but the database query failed. No SQL results were returned."),
	]);
	await session.submit("query", "Run the offline DB failure fixture", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	const messages = (await session.conversation.context(BACKGROUND_CONTEXT)).messages;
	const outer = messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
	assert.ok(outer?.role === "toolResult");
	assert.equal(outer.isError, false);
	assert.match(JSON.stringify(outer.content), /SQLSTATE 28000.*does not establish a TLS requirement/);
	assert.match(JSON.stringify(outer.content), /script finished, not connectivity success/);
	assert.doesNotMatch(JSON.stringify(outer.content), /rowCount|columns/);
	assert.deepEqual(calls, ["access", "access", "query"], "no automatic retry after the caught rejection");
	assert.equal((await settled(completions, 1))?.outcome, "done", "run completion is separate from query outcome");
	await session.close();
	const activity = await readFile(join(storageDir, TOOL_ACTIVITY_FILE), "utf8");
	const finished = activity
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as ToolActivityRecord)
		.filter((record) => record.kind === "finished");
	assert.deepEqual(
		finished.map(({ category, nested, outcome }) => ({ category, nested, outcome })),
		[
			{ category: "orchestration", nested: true, outcome: "success" },
			{ category: "orchestration", nested: true, outcome: "success" },
			{ category: "orchestration", nested: true, outcome: "failure" },
			{ category: "codemode", nested: false, outcome: "success" },
		],
	);
	assert.equal(new Set(finished.map(({ ref }) => ref)).size, 4, "independently attributable calls");
	assert.doesNotMatch(activity, /private-query-marker|SQLSTATE|prod|authentication|postgres:\/\//);
});

test("without a database config, chats have no db tool", { timeout: 20_000 }, async (t) => {
	const { session, faux } = await open(t, "database-absent", { callDatabase: async () => assert.fail("no call") });
	let seen = "";
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code: "text(typeof tools.db);" }), { stopReason: "toolUse" }),
		(context) => {
			seen = JSON.stringify(context.messages.at(-1));
			return fauxAssistantMessage("Done.");
		},
	]);
	await session.submit("ask", "Hi", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.match(seen, /tools\.db does not exist/);
});

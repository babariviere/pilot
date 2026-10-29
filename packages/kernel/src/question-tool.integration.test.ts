import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	Type,
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SessionCompletion } from "@pilot/protocol";
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

test("a direct ask_user suspends until an explicit reply reaches its tool result", { timeout: 20_000 }, async (t) => {
	const { session, faux, completions, awaited } = await open(t, "direct-question");
	let seen = "";
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Where?" }), { stopReason: "toolUse" }),
		(view) => {
			const call = view.messages.findIndex(
				(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
			);
			assert.equal(
				view.messages[call + 1]?.role,
				"toolResult",
				"the visible reply must not split provider tool-call/result pairing",
			);
			seen = JSON.stringify(view.messages);
			return fauxAssistantMessage("Answered.");
		},
		fauxAssistantMessage("Automatic processed."),
	]);
	await session.submit("ask", "Add retries", "followUp");
	await questionPublished(session);
	const deadline = Date.now() + 5000;
	while (awaited.at(-1) !== "Where?" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(awaited, ["Where?"], "the live run reports the question it awaits");
	await session.submit("mission:send:auto", "Not an answer", "followUp");
	assert.deepEqual(awaited, ["Where?"], "automatic input is not an answer");
	assert.equal(faux.state.callCount, 1);
	assert.equal(completions.length, 0, "the caller has not finished");
	assert.ok(
		!(await session.conversation.context(BACKGROUND_CONTEXT)).entries.some((e) => e.kind === "pi.tool-result"),
	);
	await session.submit("reply", "Sync worker", "steer");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(awaited, ["Where?", undefined], "the reply clears it");
	assert.match(seen, /Sync worker/);
	const entries = (await session.conversation.context(BACKGROUND_CONTEXT)).entries;
	assert.match(JSON.stringify(entries.filter((e) => e.kind === "pi.tool-result")), /Sync worker/);
	assert.equal((await settled(completions, 1))?.outcome, "done");
});

test("codemode code after await ask_user runs only after reply and receives the answer", {
	timeout: 20_000,
}, async (t) => {
	const { session, faux, effects } = await open(t, "codemode-question");
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'await tools.question_effect({value:"before"}); const answer = await tools.ask_user({question:"Which checks?"}); await tools.question_effect({value: "after:" + answer}); text(answer);',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Answered."),
		fauxAssistantMessage("Notice handled."),
	]);
	await session.submit("ask", "Ask", "followUp");
	await questionPublished(session);
	await session.submit("native:jobs.result:auto", "Not an answer", "steer");
	assert.deepEqual(effects, ["before"]);
	assert.equal(faux.state.callCount, 1);
	await session.submit("reply", "Tests", "steer");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(effects, ["before", "after:Tests"]);
	await session.submit("reply", "Tests", "steer");
	assert.deepEqual(effects, ["before", "after:Tests"], "lost ACK must not repeat the script");
});

test("Stop cancels a suspended script without running its catch or subsequent effects", {
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
	await questionPublished(f.session);
	await f.session.submit("mission:send:auto", "Keep held", "followUp");
	await f.session.abort();
	assert.deepEqual(f.effects, ["before"]);
	await f.reopen();
	assert.deepEqual(f.effects, ["before"]);
	assert.equal(f.faux.state.callCount, 1);
});

test("Stop after an accepted reply retains its model context without replaying effects", {
	timeout: 20_000,
}, async (t) => {
	const f = await open(t, "accepted-then-stopped");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'await tools.ask_user({question:"Continue?"}); await tools.question_wait({}); await tools.question_effect({value:"after"});',
			}),
			{ stopReason: "toolUse" },
		),
	]);
	await f.session.submit("ask", "Ask", "followUp");
	await questionPublished(f.session);
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
	assert.equal(f.faux.state.callCount, 1);
});

test("two awaited questions in one script retain both replies at the model boundary", {
	timeout: 20_000,
}, async (t) => {
	const f = await open(t, "two-questions");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'const a = await tools.ask_user({question:"First?"}); const b = await tools.ask_user({question:"Second?"}); await tools.question_effect({value:a + "/" + b});',
			}),
			{ stopReason: "toolUse" },
		),
		(view) => {
			const users = view.messages.flatMap((message) => (message.role === "user" ? [message.content] : []));
			assert.ok(users.includes("one"));
			assert.ok(users.includes("two"));
			return fauxAssistantMessage("Done.");
		},
	]);
	await f.session.submit("ask", "Ask", "followUp");
	await questionPublished(f.session);
	await f.session.submit("first-answer", "one", "steer");
	await questionPublished(f.session, 2);
	await f.session.submit("first-answer", "one", "steer");
	assert.deepEqual(f.effects, []);
	await f.session.submit("second-answer", "two", "steer");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(f.effects, ["one/two"]);
	assert.equal(f.faux.state.callCount, 2);
});

test("kernel replacement keeps the question but never replays the suspended script", { timeout: 20_000 }, async (t) => {
	const f = await open(t, "recovered-question");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'await tools.question_effect({value:"before"}); await tools.ask_user({question:"Continue?"}); await tools.question_effect({value:"after"});',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Recovered answer handled."),
	]);
	await f.session.submit("ask", "Ask", "followUp");
	await questionPublished(f.session);
	await f.reopen();
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(f.effects, ["before"]);
	assert.equal(f.faux.state.callCount, 1);
	assert.equal((await questions(f.session)).length, 1);
	await f.session.submit("answer", "Continue", "steer");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(f.effects, ["before"]);
	assert.equal(f.faux.state.callCount, 2);
	await f.session.submit("answer", "Continue", "steer");
	assert.equal(f.faux.state.callCount, 2);
});

for (const answeredBeforeCrash of [false, true])
	test(answeredBeforeCrash
		? "hard crash after accepted reply keeps the answer without replaying the script"
		: "hard crash preserves the pending question without replaying earlier or later script effects", {
		timeout: 20_000,
	}, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pilot-question-crash-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("PILOT_") && key !== "NODE_OPTIONS"),
		);
		const child = spawn(
			process.execPath,
			["--max-old-space-size=1024", new URL("./testing/question-crash-worker.ts", import.meta.url).pathname, root],
			{ env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
		);
		t.after(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		});
		let diagnostics = "";
		child.stderr!.on("data", (data) => {
			diagnostics += data;
		});
		const message = await Promise.race([
			once(child, "message"),
			once(child, "exit").then(() => {
				throw new Error(diagnostics || "worker exited before question");
			}),
		]);
		assert.equal(message[0], "waiting");
		if (answeredBeforeCrash) {
			const seen = new Set<string>();
			const admitted = new Promise<void>((resolve) =>
				child.on("message", (message) => {
					if (typeof message === "string") seen.add(message);
					if (seen.has("accepted") && seen.has("resumed")) resolve();
				}),
			);
			child.send("answer");
			await admitted;
		}
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		assert.equal(await readFile(join(root, "effects"), "utf8"), "before\n");
		const f = await open(t, "crashed-question", { root });
		f.faux.setResponses([
			(view) => {
				assert.match(JSON.stringify(view.messages), /Continue/);
				return fauxAssistantMessage("Recovered answer handled.");
			},
		]);
		await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(f.faux.state.callCount, answeredBeforeCrash ? 1 : 0);
		assert.equal((await questions(f.session)).length, 1);
		await f.session.submit("answer", "Continue", "steer");
		await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		assert.deepEqual(f.effects, []);
		assert.equal(await readFile(join(root, "effects"), "utf8"), "before\n");
		assert.equal(f.faux.state.callCount, 1);
	});

test("script deadline cancels the await, leaves the question open, and cannot resume effects", {
	timeout: 20_000,
}, async (t) => {
	const f = await open(t, "deadline-question");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: '// @options: {"timeout_ms": 500}\nawait tools.question_effect({value:"before"}); await tools.ask_user({question:"Continue?"}); await tools.question_effect({value:"after"});',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Answer handled."),
	]);
	await f.session.submit("ask", "Ask", "followUp");
	await questionPublished(f.session);
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(f.faux.state.callCount, 1);
	assert.deepEqual(f.effects, ["before"]);
	await f.session.submit("answer", "Continue", "steer");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(f.faux.state.callCount, 2);
	assert.deepEqual(f.effects, ["before"]);
});

test("safe tool drain waits for an explicit answer, then commits the script before pausing", {
	timeout: 20_000,
}, async (t) => {
	const f = await open(t, "drained-question");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'const answer = await tools.ask_user({question:"Continue?"}); await tools.question_effect({value: answer});',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Finished."),
		fauxAssistantMessage("Automatic handled."),
	]);
	await f.session.submit("ask", "Ask", "followUp");
	await questionPublished(f.session);
	let drained = false;
	const drain = f.session.pauseForUpdate().then(() => {
		drained = true;
	});
	await f.session.submit("mission:send:auto", "Not an answer", "followUp");
	assert.equal(drained, false);
	assert.deepEqual(f.effects, []);
	await f.session.submit("answer", "Continue", "steer");
	await drain;
	assert.deepEqual(f.effects, ["Continue"]);
	assert.equal(f.faux.state.callCount, 1);
	await f.reopen();
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(f.effects, ["Continue"]);
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
	let seen = "";
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'const r = await tools.db({action:"query",env:"local",sql:"select 1 as n"}); text(JSON.stringify(r.rows)); await tools.db({action:"access",env:"prod"});',
			}),
			{ stopReason: "toolUse" },
		),
		(context) => {
			seen = JSON.stringify(context.messages.at(-1));
			return fauxAssistantMessage("Waiting for access.");
		},
	]);
	await session.submit("ask", "Count users", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(calls, [
		["query", { env: "local", sql: "select 1 as n" }],
		["access", { env: "prod" }],
	]);
	assert.match(seen, /n\\":1/);
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

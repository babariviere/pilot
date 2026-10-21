import assert from "node:assert/strict";
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
	databases: { databases?: boolean; callDatabase?: DatabaseCall } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "pilot-question-"));
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
	const options: Partial<NativeAdapterOptions> = {
		agentDir: join(root, "agent"),
		projectTrusted: false,
		settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "codemode"] }),
		sessionOptions: { modelRuntime, model: faux.getModel() },
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
			sessionOptions: { ...adapterOptions.sessionOptions, ...options.sessionOptions },
		}),
	);
	const completions: SessionCompletion[] = [];
	const session = await KernelSession.open(
		{
			sessionId: name,
			cwd: root,
			storageDir: join(root, "storage"),
			...(databases.databases ? { databases: true } : {}),
		},
		{
			...(databases.callDatabase ? { callDatabase: databases.callDatabase } : {}),
			onWorking: (working, completion) => {
				if (!working && completion && completion.outcomeAt !== completions.at(-1)?.outcomeAt)
					completions.push(completion);
			},
		},
	);
	cleanup.push(async () => {
		await Promise.all(refreshes);
		await session.close();
	});
	return { session, faux, completions, storageDir: join(root, "storage") };
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

test("a direct ask_user call records the question, ends the run and waits for the user", {
	timeout: 20_000,
}, async (t) => {
	const { session, faux, completions } = await open(t, "direct-question");
	let requests = 0;
	faux.setResponses([
		() => {
			requests++;
			return fauxAssistantMessage(
				fauxToolCall("ask_user", {
					question: "Where should retries live?",
					options: [{ label: "Shared client", suggested: true }, { label: "Sync worker" }],
				}),
				{ stopReason: "toolUse" },
			);
		},
		() => {
			requests++;
			return fauxAssistantMessage("Retries now live in the sync worker.");
		},
	]);
	await session.submit("ask", "Add retries", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(requests, 1);
	assert.deepEqual(await questions(session), [
		{
			question: "Where should retries live?",
			options: [{ label: "Shared client", suggested: true }, { label: "Sync worker" }],
		},
	]);
	const asked = await settled(completions, 1);
	assert.equal(asked?.outcome, "question");
	assert.equal(asked?.outcomeReason, "Where should retries live?");

	// The reply is an ordinary user message; its run settles as done.
	await session.submit("reply", "Sync worker", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	const answered = await settled(completions, 2);
	assert.equal(answered?.outcome, "done");
	assert.ok(answered!.outcomeAt > asked!.outcomeAt);
});

test("ask_user through codemode still records the question", { timeout: 20_000 }, async (t) => {
	const { session, faux, completions } = await open(t, "codemode-question");
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'text(await tools.ask_user({question:"Which checks?",options:[{label:"Typecheck"},{label:"Tests"}],multiSelect:true}));',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Waiting for your answer."),
	]);
	await session.submit("ask", "Open the PR", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(await questions(session), [
		{ question: "Which checks?", options: [{ label: "Typecheck" }, { label: "Tests" }], multiSelect: true },
	]);
	assert.equal((await settled(completions, 1))?.outcome, "question");
});
+test("db through codemode queries pilotd, and a pending grant asks the user", { timeout: 20_000 }, async (t) => {
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

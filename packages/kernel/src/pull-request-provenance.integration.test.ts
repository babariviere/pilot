import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
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
import type { JsonObject } from "@earendil-works/pi-durable";
import type { AgentEvent, GitHubAction } from "@pilot/protocol";
import { GitHubActionsDoc } from "./github-actions.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { PullRequestsDoc } from "./pull-request-provenance.ts";
import { KernelSession, type KernelSessionHooks } from "./session.ts";
import { readSessionSnapshot } from "./snapshot.ts";

const context = BACKGROUND_CONTEXT;
const url = (id: number) => `https://github.com/owner/repo/pull/${id}`;

test("GitHub audit records direct and discarded nested results, cold reads and replay without duplicates", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const observed: GitHubAction[] = [];
	let session = await f.open({ onGitHubAction: (action) => observed.push(action) });
	const updates: AgentEvent[] = [];
	await session.watch(
		"audit",
		(events) => {
			updates.push(...events);
		},
		false,
	);
	await f.run(session, "ready", "bash", { command: "gh pr ready 12" });
	await f.run(session, "failed", "bash", { command: "gh pr edit 12 --fail --body 'private body'" });
	await f.run(session, "nested", "codemode", {
		code: `
		// gh pr ready 99 is not an execution.
		await tools.bash({ command: "gh pr ready 13" });
		await tools.bash({ command: "gh api repos/owner/repo/pulls/13 -X PATCH -f body=private" });
		throw new Error("outer failed after writes");`,
	});
	assert.equal(observed.length, 4);
	assert.deepEqual(
		observed.map((action) => action.kind),
		["pr_ready", "pr_edited", "pr_ready", "github_updated"],
	);
	for (const action of observed) {
		assert.ok(action.afterEntryId);
		assert.equal(action.conversationId, String(session.conversation.id));
		assert.ok(action.toolCallId);
		assert.ok(
			(await session.conversation.context(context)).entries.some(
				(entry) => Number(entry.id) === action.afterEntryId,
			),
		);
	}
	assert.equal(observed[2]?.toolCallId, observed[3]?.toolCallId, "nested writes share the originating top-level call");
	assert.deepEqual(
		observed.map((a) => a.exitCode),
		[0, 1, 0, 0],
	);
	assert.deepEqual(
		observed.map((a) => a.target),
		["PR #12", "PR #12", "PR #13", "PR #13"],
	);
	assert.equal(JSON.stringify(observed).includes("private"), false);
	await f.run(session, "implicit-ready", "bash", { command: "gh pr ready --id 14" });
	await f.run(session, "implicit-create", "bash", { command: "gh pr create --id 15 --title 'Quiet chat events'" });
	assert.deepEqual(
		observed.slice(-2).map((action) => action.target),
		["PR #14", "PR #15"],
	);
	assert.equal(observed.at(-1)?.prNumber, 15);
	assert.equal(observed.at(-1)?.title, "Quiet chat events");
	await session.unwatch("audit");
	const frames = updates.filter((event) => event.type === "github_actions_update");
	assert.equal(frames[0]?.type === "github_actions_update" && frames[0].actions.length, 0);
	assert.equal(frames.at(-1)?.type === "github_actions_update" && frames.at(-1)!.actions.length, 6);
	const state = await session.harness.snapshot(GitHubActionsDoc, context);
	assert.deepEqual(
		state?.actions.map((a) => a.id),
		observed.map((a) => a.id),
	);
	await session.close();
	const cold = await readSessionSnapshot(join(f.root, "durable"), f.root, false);
	const audit = cold.events.find((event) => event.type === "github_actions_update");
	assert.equal(audit?.type === "github_actions_update" && audit.actions.length, 6);
	const replay: GitHubAction[] = [];
	session = await f.open({ onGitHubAction: (action) => replay.push(action) });
	assert.deepEqual(replay, observed);
	assert.equal(f.calls.length, 6, "reopen must not execute external mutations again");
});

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-pr-provenance-"));
	const sessions: KernelSession[] = [];
	t.after(async () => {
		for (const session of sessions.reverse()) await session.close();
		await rm(root, { recursive: true, force: true });
	});
	t.mock.method(globalThis, "fetch", () => assert.fail("PR provenance tests must stay offline"));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "pilot-pr-test", models: [{ id: "offline", contextWindow: 128_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const calls: string[] = [];
	const adapters: NativeAdapter[] = [];
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) => {
		const adapter = await openAdapter.call(NativeAdapter, {
			...options,
			projectTrusted: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["bash", "codemode", "lookup_pr"] }),
			sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
			bundledExtensions: false,
			loaderOptions: {
				cwd: root,
				agentDir: join(root, "agent"),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: "Offline PR provenance fixture.",
				extensionFactories: [
					createCodemodeExtension({ models: false, mode: "on" }),
					(pi) => {
						// Never invoke gh or a shell. The real SDK handles native and nested call/result events.
						pi.registerTool({
							name: "bash",
							label: "bash",
							description: "Offline gh stub",
							parameters: Type.Object({ command: Type.String() }),
							outputSchema: Type.Object({ output: Type.String(), exit_code: Type.Number() }),
							execute: async (_id, { command }) => {
								calls.push(command);
								const output = url(Number(command.match(/--id (\d+)/)?.[1] ?? 1));
								if (command.includes("--throw")) throw new Error(`failed ${output}`);
								return {
									content: [{ type: "text", text: "Structured output is authoritative" }],
									details: undefined,
									structuredContent: { output, exit_code: command.includes("--fail") ? 1 : 0 },
								};
							},
						});
						pi.registerTool({
							name: "lookup_pr",
							label: "lookup",
							description: "Read an existing PR",
							parameters: Type.Object({ command: Type.String() }),
							execute: async () => ({ content: [{ type: "text", text: url(99) }], details: undefined }),
						});
					},
				],
			},
		});
		adapters.push(adapter);
		return adapter;
	});
	const open = async (hooks: Partial<KernelSessionHooks> = {}, workspace = true) => {
		const session = await KernelSession.open(
			{
				sessionId: "offline-pr",
				cwd: root,
				agentDir: join(root, "agent"),
				storageDir: join(root, "durable"),
				model: "pilot-pr-test/offline",
				pilot: workspace ? { workspace: { source: root, base: "origin/main", jj: false } } : undefined,
			},
			{ onWorking: () => {}, ...hooks },
		);
		sessions.push(session);
		return session;
	};
	const run = async (session: KernelSession, name: string, tool: string, args: JsonObject, answer = "Done") => {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" }),
			fauxAssistantMessage(answer),
		]);
		await session.submit(name, "Execute the offline test", "followUp");
		await session.conversation.waitForIdle(context);
	};
	return { open, run, calls, adapters, faux, root };
}

test("agent PR provenance uses matching successful results, survives compaction and replays on open", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const created: string[] = [];
	let session: KernelSession;
	const committed: Promise<void>[] = [];
	session = await f.open({
		onPullRequestCreated: (value) => {
			created.push(value);
			committed.push(
				session.harness.snapshot(PullRequestsDoc, session.conversation.id, context).then((state) => {
					assert.ok(state?.urls.includes(value), "commit must precede notification");
				}),
			);
		},
	});
	await f.run(
		session,
		"direct",
		"bash",
		{ command: 'git push -u origin fix/pr && gh pr create --id 1 --body "A body\nwith multiple lines"' },
		"kept ".repeat(20_000),
	);
	await Promise.all(committed);
	assert.deepEqual(created, [url(1)]);
	const task = await session.conversation.compact("Summarize the previous work", context);
	f.faux.setResponses([fauxAssistantMessage("An agent created a PR; provenance is outside the transcript.")]);
	const outcome = await session.harness.waitForTask(task, context);
	assert.equal(outcome.state.status, "terminal");
	await session.conversation.waitForIdle(context);
	assert.ok((await session.conversation.context(context)).entries.some((entry) => entry.kind === "pi.compaction"));
	const compacted = await readSessionSnapshot(join(f.root, "durable"), f.root, false);
	const compactedSnapshot = compacted.events.find((event) => event.type === "snapshot");
	const marker =
		compactedSnapshot?.type === "snapshot"
			? compactedSnapshot.entries.find((entry) => entry.kind === "pi.compaction")
			: undefined;
	assert.ok(marker);
	assert.ok(
		(marker.data as { tokensBefore: number }).tokensBefore > (marker.data as { tokensAfter: number }).tokensAfter,
	);
	assert.deepEqual((await session.harness.snapshot(PullRequestsDoc, session.conversation.id, context))?.urls, [
		url(1),
	]);
	await session.close();
	const replayed: string[] = [];
	session = await f.open({ onPullRequestCreated: (value) => replayed.push(value) });
	assert.deepEqual(replayed, [url(1)]);
	assert.equal(f.calls.length, 1, "open must replay notification, not external tool execution");
	await f.run(session, "repeat", "bash", { command: "gh pr create --id 1" });
	assert.deepEqual(replayed, [url(1)], "same durable URL is notified once per open");
});

test("nested codemode correlates real bash results even if script discards output or fails later", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const created: string[] = [];
	const session = await f.open({ onPullRequestCreated: (value) => created.push(value) });
	await f.run(session, "unrelated", "codemode", {
		code: `
// gh pr create is only a comment, not an execution.
text(await tools.lookup_pr({command:"gh pr create"}));
text(await tools.bash({command:"gh pr view 99 --id 99"}));
text(${JSON.stringify(url(98))});`,
	});
	assert.deepEqual(created, []);
	await f.run(session, "failures", "codemode", {
		code: `
await tools.bash({command:"gh pr create --id 2 --fail"});
try { await tools.bash({command:"gh pr create --id 3 --throw"}); } catch {}
`,
	});
	assert.deepEqual(created, []);
	await f.run(session, "nested", "codemode", {
		code: `
await Promise.all([
 tools.bash({command:"jj commit -m 'feat: schema'; jj git push --bookmark fix/pr; gh pr create --id 4"}),
 tools.lookup_pr({command:"gh pr create"}),
 tools.bash({command:"gh pr view 99 --id 99"})
]);
throw new Error("The script failed after creation; the external effect still happened");`,
	});
	assert.deepEqual(created, [url(4)]);
	const adapter = f.adapters[0]!;
	adapter.session.setActiveToolsByName(["bash", "codemode"]);
	adapter.refreshTools();
	await f.run(session, "reinstalled", "bash", { command: "gh pr create --id 5" });
	assert.deepEqual(created, [url(4), url(5)], "dynamic extension replacement keeps provenance wrapping");
});

test("a lost creation notification is replayed from its durable commit without rerunning gh", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const session = await f.open({
		onPullRequestCreated: () => {
			throw new Error("notification lost before delivery");
		},
	});
	await f.run(session, "lost-notification", "bash", { command: "gh pr create --id 6" });
	await session.close();
	const replayed: string[] = [];
	await f.open({ onPullRequestCreated: (value) => replayed.push(value) });
	assert.deepEqual(replayed, [url(6)]);
	assert.equal(f.calls.length, 1);
});

test("non-workspace sessions never record or replay agent PR provenance", { timeout: 15_000 }, async (t) => {
	const f = await fixture(t);
	const created: string[] = [];
	const session = await f.open({ onPullRequestCreated: (value) => created.push(value) }, false);
	await f.run(session, "not-workspace", "bash", { command: "gh pr create --id 7" });
	await f.run(session, "not-workspace-nested", "codemode", {
		code: 'await tools.bash({command:"gh pr create --id 8"})',
	});
	assert.deepEqual(created, []);
	assert.equal(await session.harness.snapshot(PullRequestsDoc, session.conversation.id, context), undefined);
});

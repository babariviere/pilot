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
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentQuestion, InterviewAnswer, InterviewQuestion } from "@pilot/protocol";
import { Type } from "typebox";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { QUESTION_ENTRY } from "./question-entry.ts";
import { KernelSession } from "./session.ts";

const questions: InterviewQuestion[] = [
	{
		id: "storage",
		section: "constraints",
		prompt: "Where should drafts be saved?",
		context: "The choice controls whether drafts survive a restart.",
		options: [{ id: "sqlite", meaning: "Save drafts in SQLite" }],
		recommendedOptionId: "sqlite",
	},
	{
		id: "checks",
		section: "acceptance",
		prompt: "Which checks must pass?",
		options: [],
		recommendedOptionId: null,
	},
];

async function open(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-interview-"));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "pilot-interview-test", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	const effects: string[] = [];
	const awaited: (string | undefined)[] = [];
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
	t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, {
			...options,
			agentDir: join(root, "agent"),
			projectTrusted: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "codemode"] }),
			sessionOptions: {
				...options.sessionOptions,
				modelRuntime: runtime,
				model: faux.getModel(),
				customTools: [
					...(options.sessionOptions?.customTools ?? []),
					{
						name: "interview_effect",
						label: "Effect",
						description: "Synthetic dependent effect",
						parameters: Type.Object({ value: Type.String() }),
						execute: async (_id, args) => {
							effects.push((args as { value: string }).value);
							return { content: [], details: {} };
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
				systemPrompt: "Offline saved interview integration.",
				extensionFactories: [createCodemodeExtension({ models: false, mode: "on" })],
			},
		}),
	);
	const reopen = () =>
		KernelSession.open(
			{ sessionId: "standalone-interview", cwd: root, storageDir: join(root, "storage") },
			{ onWorking: () => {}, onQuestionAwaited: (question) => awaited.push(question) },
		);
	let session = await reopen();
	t.after(async () => {
		try {
			await Promise.all(refreshes);
			await session.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	return {
		get session() {
			return session;
		},
		faux,
		effects,
		awaited,
		async reopen() {
			await session.close();
			session = await reopen();
		},
	};
}

async function round(session: KernelSession) {
	const entries = (await session.conversation.context(BACKGROUND_CONTEXT)).entries;
	const entry = entries.find((entry) => entry.kind === QUESTION_ENTRY);
	assert.ok(entry, "the full round is saved before the turn ends");
	const data = entry.data as unknown as AgentQuestion;
	assert.ok(data.interview);
	assert.deepEqual(data.interview.questions, questions);
	assert.deepEqual(Object.keys(data.interview.questionDigests), ["storage", "checks"]);
	return { entryId: Number(entry.id), ...data.interview };
}

function answers(saved: Awaited<ReturnType<typeof round>>): InterviewAnswer[] {
	return [
		{
			questionId: "storage",
			questionDigest: saved.questionDigests.storage!,
			selectedOption: questions[0]!.options[0]!,
			text: "  exact\n detail  ",
		},
		{
			questionId: "checks",
			questionDigest: saved.questionDigests.checks!,
			selectedOption: null,
			text: "Restart and integration tests",
		},
	];
}

async function submit(session: KernelSession, saved: Awaited<ReturnType<typeof round>>, reply = answers(saved)) {
	return session.submit(
		"native-submit",
		"PLACEHOLDER_NOT_AN_ANSWER",
		"followUp",
		false,
		false,
		undefined,
		undefined,
		false,
		undefined,
		saved.entryId,
		false,
		{ roundId: saved.roundId, answers: reply },
	);
}

for (const codemode of [false, true]) {
	test(`${codemode ? "codemode" : "direct"} interview returns, ends generation and holds dependent tools until native submit`, {
		timeout: 20_000,
	}, async (t) => {
		const f = await open(t);
		const request = { action: "questions", request: { expected: null, questions } };
		const call = codemode
			? fauxToolCall("codemode", {
					code: `const saved = await tools.interview(${JSON.stringify(request)}); text(saved); await tools.interview_effect({value:"too-early"});`,
				})
			: fauxToolCall("interview", request);
		let submittedContext = "";
		f.faux.setResponses([
			fauxAssistantMessage(codemode ? call : [call, fauxToolCall("interview_effect", { value: "too-early" })], {
				stopReason: "toolUse",
			}),
			(view) => {
				submittedContext = JSON.stringify(view.messages);
				return fauxAssistantMessage(fauxToolCall("interview_effect", { value: "submitted" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(fauxToolCall("interview", { action: "read" }), { stopReason: "toolUse" }),
			(view) => {
				const result = view.messages.filter((message) => message.role === "toolResult").at(-1);
				assert.ok(result);
				const state = JSON.parse(
					result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
				);
				assert.equal(typeof state.expected, "string");
				assert.deepEqual(state.questions, questions);
				assert.equal(state.submission.operationId, "native-submit");
				assert.equal(state.submission.answers[1].text, "Restart and integration tests");
				return fauxAssistantMessage("Done.");
			},
		]);
		await f.session.submit("ask", "Clarify before proceeding", "followUp");
		await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		const saved = await round(f.session);
		if (!codemode) assert.equal(saved.roundId, call.id);
		assert.deepEqual(f.effects, []);
		assert.equal(f.faux.state.callCount, 1, "generation ends without awaiting a human or another model call");
		assert.ok(!f.awaited.some((question) => question !== undefined), "not a suspended ask_user invocation");
		const before = (await f.session.conversation.context(BACKGROUND_CONTEXT)).entries;
		assert.ok(
			before.some((entry) => entry.kind === "pi.tool-result"),
			"tool returns before human submission",
		);
		await assert.rejects(submit(f.session, saved, answers(saved).slice(0, 1)), /every question|complete|answer/i);
		await assert.rejects(f.session.submit("ordinary", "Use the recommendation", "followUp"), /interview|submit/i);
		assert.deepEqual(f.effects, []);
		await submit(f.session, saved);
		await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		assert.deepEqual(f.effects, ["submitted"]);
		assert.match(submittedContext, /Restart and integration tests/);
		assert.doesNotMatch(submittedContext, /PLACEHOLDER_NOT_AN_ANSWER/);
		const entries = (await f.session.conversation.context(BACKGROUND_CONTEXT)).entries;
		const submissions = entries.filter((entry) => entry.kind === "pilot.interview-submission");
		assert.equal(submissions.length, 1);
		assert.deepEqual((submissions[0]!.data as unknown as { answers: InterviewAnswer[] }).answers, answers(saved));
		await submit(f.session, saved);
		assert.deepEqual(f.effects, ["submitted"], "lost acknowledgement does not run the turn again");
	});
}

test("nested interview reads remain available but cannot replace an unanswered round", {
	timeout: 20_000,
}, async (t) => {
	const f = await open(t);
	const request = { action: "questions", request: { expected: null, questions } };
	const replacement = {
		action: "questions",
		request: { expected: "1", questions: [{ ...questions[0]!, prompt: "Replacement before submission?" }] },
	};
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: `await tools.interview(${JSON.stringify(request)}); text(await tools.interview({action:"read"})); text("READ_COMPLETED"); try { await tools.interview(${JSON.stringify(replacement)}); } catch (error) { text(String(error)); }`,
			}),
			{ stopReason: "toolUse" },
		),
	]);
	await f.session.submit("ask", "Ask before proceeding", "followUp");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	await round(f.session);
	const entries = (await f.session.conversation.context(BACKGROUND_CONTEXT)).entries;
	assert.equal(entries.filter((entry) => entry.kind === QUESTION_ENTRY).length, 1);
	const results = JSON.stringify(entries.filter((entry) => entry.kind === "pi.tool-result"));
	assert.match(results, /READ_COMPLETED/);
	assert.match(results, /Answer the saved question or interview|Answer the pending question/);
	assert.equal(f.faux.state.callCount, 1);
});

test("a standalone saved round remains held after close and reopen", { timeout: 20_000 }, async (t) => {
	const f = await open(t);
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("interview", { action: "questions", request: { expected: null, questions } }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Submitted after reopen."),
	]);
	await f.session.submit("ask", "Ask before proceeding", "followUp");
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	const saved = await round(f.session);
	await f.reopen();
	assert.deepEqual(await round(f.session), saved);
	assert.equal(f.faux.state.callCount, 1, "reopen does not regenerate or resume the round");
	await assert.rejects(f.session.submit("ordinary", "Continue", "followUp"), /interview|submit/i);
	await submit(f.session, saved);
	await f.session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(f.faux.state.callCount, 2);
	assert.equal(
		(await f.session.conversation.context(BACKGROUND_CONTEXT)).entries.filter(
			(entry) => entry.kind === "pilot.interview-submission",
		).length,
		1,
	);
});

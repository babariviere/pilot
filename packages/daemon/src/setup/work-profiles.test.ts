// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without launching a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { KernelCommand, KernelPacket, KernelUsage } from "@pilot/kernel";
import type { MissionPlan, SessionState, WorkProfile } from "@pilot/protocol";
import { readModelDefaults, STARTER_PROFILES, writeWorkProfiles } from "../models/model-controls-store.ts";
import { ProjectStore } from "../projects/projects.ts";
import { SessionManager } from "../sessions/sessions.ts";
import { type SessionWorker } from "../sessions/workers/kernel-worker.ts";
import { offlineSessionOptions } from "../testing/offline-session-options.ts";
import { requiredAuthRegistration } from "../testing/required-auth.ts";
import {
	allowedProfiles,
	isCyberBlock,
	type ModelState,
	pickProfileModel,
	sliceRoute,
	taskModelRoute,
} from "./work-profiles.ts";

const SOL = "openai-codex/gpt-6.2-sol";
const TERRA = "openai-codex/gpt-6.1-terra";
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const CYBER = "anthropic/claude-opus-5";
const [backend, ui, cyber] = STARTER_PROFILES as WorkProfile[];

function state(
	working: Record<string, number> = {},
	skip: { signedOut?: string[]; limited?: string[] } = {},
): ModelState {
	return {
		signedIn: (m) => !skip.signedOut?.includes(m),
		limited: (m) => !!skip.limited?.includes(m),
		working: (m) => working[m] ?? 0,
		name: (m) => ({ [SOL]: "Sol", [OPUS]: "Opus 5.5" })[m] ?? m,
	};
}

test("the least busy entry starts; a tie goes to the first in list order", () => {
	assert.deepEqual(pickProfileModel(backend!, "large", state()), {
		entry: { model: SOL, thinking: "medium" },
		route: { source: "profile", profile: { id: "backend", name: "Backend" }, size: "large" },
	});
	assert.equal(pickProfileModel(backend!, "large", state({ [SOL]: 1, [OPUS]: 1 })).entry?.model, SOL);
	const busier = pickProfileModel(ui!, "large", state({ [OPUS]: 2, [SOL]: 1 }));
	assert.equal(busier.entry?.model, SOL);
	assert.equal(busier.route.busier, OPUS, "the line says the preferred model was busier");
	assert.deepEqual(pickProfileModel(ui!, "small", state()).entry, { model: SONNET, thinking: "high" });
	assert.equal(pickProfileModel(backend!, "small", state()).entry?.model, TERRA);
});

test("models that are not signed in or at their limit are skipped; with none left the default starts and says why", () => {
	const limited = pickProfileModel(ui!, "large", state({}, { limited: [OPUS] }));
	assert.equal(limited.entry?.model, SOL);
	assert.equal(limited.route.reason, "Opus 5.5 is at its limit");
	assert.equal(limited.route.busier, undefined);
	const signedOut = pickProfileModel(ui!, "large", state({ [SOL]: 3 }, { signedOut: [OPUS] }));
	assert.equal(signedOut.entry?.model, SOL, "a busy usable model beats a skipped one");
	assert.equal(signedOut.route.reason, "Opus 5.5 is not signed in");
	assert.deepEqual(pickProfileModel(cyber!, "large", state({}, { signedOut: [CYBER] })).route, {
		source: "default",
		profile: { id: "cyber", name: "Cyber" },
		size: "large",
		reason: "no Cyber large model is signed in",
	});
	assert.equal(
		pickProfileModel(ui!, "large", state({}, { signedOut: [OPUS], limited: [SOL] })).route.reason,
		"every UI large model is signed out or at its limit",
	);
	assert.equal(pickProfileModel({ ...ui!, small: [] }, "small", state()).route.reason, "UI has no small models");
});

test("a never-edited project allows every profile but opt-in-only ones; an edited one keeps exactly its list", () => {
	const ids = (project: { profilesEdited?: true; allowedProfiles?: string[] }, extra: WorkProfile[] = []) =>
		allowedProfiles([...STARTER_PROFILES, ...extra], project).map((p) => p.id);
	const later = { ...backend!, id: "data", name: "Data" };
	assert.deepEqual(ids({}), ["backend", "ui"]);
	assert.deepEqual(ids({}, [later]), ["backend", "ui", "data"], "a never-edited project follows the default");
	assert.deepEqual(ids({ profilesEdited: true, allowedProfiles: ["backend", "cyber"] }, [later]), [
		"backend",
		"cyber",
	]);
	assert.deepEqual(ids({ profilesEdited: true, allowedProfiles: [] }), [], "an edited empty list allows none");
	assert.deepEqual(ids({ allowedProfiles: ["cyber"] }), ["backend", "ui"], "only the saved edit mark counts");
});

test("planner slices carry a profile and size; old plans count as large with no profile", () => {
	const plan = {
		slices: [
			{ id: "a", profile: "ui", size: "small" },
			{ id: "old", owners: ["sol-backend"] },
		],
		publication: {
			tasks: [
				{ sliceId: "a", taskId: "t-a" },
				{ sliceId: "old", taskId: "t-old" },
			],
		},
	} as unknown as MissionPlan;
	assert.deepEqual(sliceRoute(plan, "t-a"), { profile: "ui", size: "small" });
	assert.deepEqual(sliceRoute(plan, "t-old"), { size: "large" });
	assert.equal(sliceRoute(plan, "other"), undefined);
});

test("the task line: a chat's recorded route, else a model set on the task, else the next start", () => {
	const names = state();
	const next = () => ({ model: SOL, route: pickProfileModel(ui!, "large", state({ [OPUS]: 1 })).route });
	assert.deepEqual(taskModelRoute({ id: "t" }, undefined, next, names), {
		taskId: "t",
		model: SOL,
		modelName: "Sol",
		source: "profile",
		profile: { id: "ui", name: "UI" },
		size: "large",
		busier: OPUS,
		busierName: "Opus 5.5",
	});
	assert.equal(
		taskModelRoute({ id: "t", preferredModel: OPUS, preferredModelSetBy: "user" }, undefined, next, names)?.source,
		"user",
	);
	const retried = { model: CYBER, modelRoute: { source: "cyber" as const, profile: { id: "cyber", name: "Cyber" } } };
	assert.equal(taskModelRoute({ id: "t" }, retried, next, names)?.source, "cyber");
	assert.equal(taskModelRoute({ id: "t" }, { model: SOL }, next, names), undefined, "a chat with no route shows none");
	assert.equal(
		taskModelRoute({ id: "t" }, undefined, () => undefined, names),
		undefined,
	);
});

test("only the exact provider message counts as a cyber block", () => {
	assert.equal(
		isCyberBlock("Model request (anthropic/claude-opus-5-5): Cyber safeguards flagged this message as unsafe"),
		true,
	);
	assert.equal(isCyberBlock("Model request (anthropic/claude-opus-5-5): Overloaded"), false);
	assert.equal(isCyberBlock("cyber safeguards"), false);
	assert.equal(isCyberBlock(undefined), false);
});

type Command = Extract<KernelCommand, { requestId: string }>;
class FakeWorker implements SessionWorker {
	ready = Promise.resolve();
	state: SessionState = "idle";
	busy = false;
	usage: KernelUsage = { context: { tokens: 5, contextWindow: 100, percent: 5 } };
	readonly commands: Command[] = [];
	closed = false;
	readonly emit: (packet: KernelPacket) => void;
	constructor(emit: (packet: KernelPacket) => void) {
		this.emit = emit;
	}
	send(): void {}
	async request(command: Command): Promise<void> {
		this.commands.push(command);
		if (command.type === "changeModel")
			this.emit({
				type: "modelChanged",
				requestId: command.requestId,
				model: command.model,
				thinking: command.thinking ?? "high",
				usage: this.usage,
			});
		if (command.type === "rewind")
			this.emit({ type: "rewound", requestId: command.requestId, switched: true, content: "Write the scenario" });
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

type Model = Parameters<ModelRuntime["completeSimple"]>[0];
function model(ref: string, name: string): Model {
	const [provider, id] = ref.split("/") as [string, string];
	return {
		id,
		name,
		provider,
		api: "openai-completions",
		baseUrl: "http://unused",
		input: ["text"],
		reasoning: true,
		contextWindow: 32000,
		maxTokens: 4096,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	};
}

/** Every starting model is signed in. Claude Opus 5 is kept out of the chat model list, as the user keeps it. */
async function fixture(t: TestContext, usage: { anthropic?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pilot-work-profiles-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const models = [
		model(SOL, "Sol"),
		model(TERRA, "Terra"),
		model(OPUS, "Opus 5.5"),
		model(SONNET, "Sonnet 5.5"),
		model(CYBER, "Opus 5"),
	];
	t.mock.method(
		ModelRuntime,
		"create",
		async () =>
			({
				...requiredAuthRegistration,
				getAvailable: async () => models,
				getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			}) as unknown as ModelRuntime,
	);
	await writeFile(
		join(root, "settings.json"),
		JSON.stringify({
			defaultProvider: "openai-codex",
			defaultModel: "gpt-6.2-sol",
			enabledModels: [SOL, TERRA, OPUS, SONNET],
			pilotTaskPriceLimit: 100,
		}),
	);
	const projects = new ProjectStore(root);
	await projects.load();
	const project = await projects.create({ path: root, workspace: "direct" });
	const chatId = randomUUID();
	await mkdir(join(root, "sessions", chatId), { recursive: true });
	await writeFile(
		join(root, "sessions", chatId, "meta.json"),
		JSON.stringify({
			id: chatId,
			cwd: root,
			projectId: project.id,
			title: "Chat",
			createdAt: 1,
			updatedAt: 2,
			model: OPUS,
		}),
	);
	const workers: FakeWorker[] = [];
	const sessions = new SessionManager(
		root,
		projects,
		root,
		{
			worker: (spec, onPacket) => {
				const worker = new FakeWorker(onPacket);
				workers.push(worker);
				queueMicrotask(() =>
					onPacket({ type: "ready", model: spec.model ?? OPUS, working: false, usage: worker.usage }),
				);
				return worker;
			},
		},
		{},
		offlineSessionOptions({
			subscriptionUsage: () => ({
				get: (provider) =>
					provider === "anthropic" && usage.anthropic !== undefined
						? { fetchedAt: Date.now(), provider, windows: [{ label: "5h", usedPercent: usage.anthropic }] }
						: undefined,
				start: async () => {},
				close() {},
			}),
		}),
	);
	await sessions.load();
	t.after(async () => {
		await sessions.shutdown();
		await Promise.allSettled(sessions["saving"].values());
	});
	const working = (ref: string, count: number) => {
		for (let i = 0; i < count; i++)
			sessions["metas"].set(`busy-${ref}-${i}`, {
				...sessions["metas"].get(chatId)!,
				id: `busy-${ref}-${i}`,
				model: ref,
				working: true,
			});
	};
	const allow = (profile: string, on: boolean) =>
		projects.setAllowedProfile(
			project.id,
			profile,
			on,
			allowedProfiles(STARTER_PROFILES, projects.require(project.id)).map((p) => p.id),
		);
	return { root, projects, project, sessions, workers, chatId, working, allow };
}

test("start order: a set model, then the slice's allowed profile and size, then the default", async (t) => {
	const f = await fixture(t);
	const start = (choice?: Parameters<SessionManager["selectStartModel"]>[1]) =>
		f.sessions.selectStartModel(f.project.id, choice);
	assert.deepEqual(await start(), { model: SOL, thinking: "medium" }, "no profile: the default model");
	assert.deepEqual(await start({ profile: "ui", size: "small" }), {
		model: SONNET,
		thinking: "high",
		route: { source: "profile", profile: { id: "ui", name: "UI" }, size: "small" },
	});
	assert.deepEqual(await start({ model: TERRA, by: "user", profile: "ui" }), {
		model: TERRA,
		thinking: "medium",
		route: { source: "user" },
	});
	f.working(OPUS, 2);
	f.working(SOL, 1);
	const busier = await start({ profile: "ui", size: "large" });
	assert.equal(busier.model, SOL);
	assert.equal(busier.route?.busier, OPUS);
	assert.equal((await start({ profile: "removed" })).model, SOL, "an unknown profile starts the default");
});

test("an out-of-scope model starts only from an allowed profile", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		f.sessions.selectStartModel(f.project.id, { model: CYBER, by: "user" }),
		/not available in the project's scope/,
		"a model set by hand keeps the chat model list",
	);
	assert.deepEqual(
		await f.sessions.selectStartModel(f.project.id, { profile: "cyber" }),
		{
			model: SOL,
			thinking: "medium",
		},
		"Cyber is off until the project allows it",
	);
	await f.allow("cyber", true);
	const allowed = await f.sessions.selectStartModel(f.project.id, { profile: "cyber", size: "large" });
	assert.equal(allowed.model, CYBER);
	assert.equal(allowed.route?.source, "profile");
	await f.allow("ui", false);
	assert.equal((await f.sessions.selectStartModel(f.project.id, { profile: "ui" })).route, undefined);
});

test("the user may switch a chat to a model of a profile that its project allows", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.sessions.changeModel(f.chatId, CYBER), /not available in this session's scope/);
	await f.allow("cyber", true);
	const chat = await f.sessions.changeModel(f.chatId, CYBER);
	assert.equal(chat.model, CYBER);
	const change = f.workers.flatMap((w) => w.commands).find((c) => c.type === "changeModel");
	assert.deepEqual(change && { model: change.model, signedIn: change.signedIn }, { model: CYBER, signedIn: true });
});

test("a provider at its limit is skipped; with every entry skipped the default starts and says why", async (t) => {
	const f = await fixture(t, { anthropic: 100 });
	const ui = await f.sessions.selectStartModel(f.project.id, { profile: "ui", size: "large" });
	assert.equal(ui.model, SOL);
	assert.equal(ui.route?.reason, "Opus 5.5 is at its limit");
	await f.allow("cyber", true);
	const cyber = await f.sessions.selectStartModel(f.project.id, { profile: "cyber" });
	assert.equal(cyber.model, SOL);
	assert.deepEqual(cyber.route, {
		source: "default",
		profile: { id: "cyber", name: "Cyber" },
		size: "large",
		reason: "every Cyber large model is signed out or at its limit",
	});
});

async function block(f: Awaited<ReturnType<typeof fixture>>, entry: number, at: number) {
	f.workers.at(-1)!.emit({
		type: "working",
		working: false,
		completion: {
			outcome: "failed",
			outcomeAt: at,
			outcomeReason: `Model request (${f.sessions.get(f.chatId)!.model}): Cyber safeguards flagged this message`,
			entry,
		} as never,
	});
	for (let i = 0; i < 200 && (f.projects.require(f.project.id).cyberBlocks ?? 0) < entry; i++)
		await new Promise((resolve) => setTimeout(resolve, 5));
}

test("a cyber block in a project that allows Cyber is sent again once with a Cyber model, with a note", async (t) => {
	const f = await fixture(t);
	await f.allow("cyber", true);
	await f.sessions["ensureWorker"](f.chatId);
	await f.workers[0]!.ready;
	await block(f, 1, 1000);
	for (let i = 0; i < 200 && !f.workers[1]?.commands.some((c) => c.type === "activity"); i++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	const change = f.workers[0]!.commands.find((c) => c.type === "changeModel");
	assert.deepEqual(change && { model: change.model, signedIn: change.signedIn }, { model: CYBER, signedIn: true });
	const rewind = f.workers[0]!.commands.find((c) => c.type === "rewind");
	assert.deepEqual(rewind && [rewind.action, rewind.entryId], ["retry", 1]);
	const sent = f.workers[1]!.commands.filter((c) => c.type === "input" || c.type === "activity");
	assert.deepEqual(
		sent.map((c) => c.type),
		["input", "activity"],
	);
	const note = sent[1] as Extract<Command, { type: "activity" }>;
	assert.equal(note.text, "Opus 5.5 blocked this turn as cyber work. Pilot sent it again with Cyber (Opus 5).");
	assert.deepEqual(note.event, { kind: "cyber_retry", text: note.text });
	const chat = f.sessions.get(f.chatId)!;
	assert.equal(chat.model, CYBER, "the chat stays on the Cyber model");
	assert.deepEqual(f.sessions["metas"].get(f.chatId)!.modelRoute, {
		source: "cyber",
		profile: { id: "cyber", name: "Cyber" },
		size: "large",
	});
	// A block on the Cyber model is not sent again: the chat fails as before.
	const commands = f.workers.reduce((n, w) => n + w.commands.length, 0);
	await block(f, 2, 2000);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(
		f.workers.reduce((n, w) => n + w.commands.length, 0),
		commands,
	);
	assert.equal(f.sessions.get(f.chatId)!.outcome, "failed");
	assert.equal(f.projects.require(f.project.id).cyberBlocks, 2);
});

test("without Cyber allowed, a cyber block fails the chat as before and is counted for the project", async (t) => {
	const f = await fixture(t);
	await f.sessions["ensureWorker"](f.chatId);
	await f.workers[0]!.ready;
	await block(f, 1, 1000);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(f.workers[0]!.commands, []);
	assert.equal(f.sessions.get(f.chatId)!.outcome, "failed");
	assert.equal(f.projects.require(f.project.id).cyberBlocks, 1);
});

test("work profiles round trip under the model defaults hash; the starting set applies until a save", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-work-profiles-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "settings.json"), '{ "defaultModel": "a", "extensions": [ "kept" ] }');
	const before = await readModelDefaults(root);
	assert.deepEqual(before.profiles, STARTER_PROFILES);
	assert.deepEqual(
		before.profiles.map((p) => [p.id, p.optInOnly, p.large.map((e) => `${e.model} ${e.thinking}`)]),
		[
			["backend", false, [`${SOL} medium`, `${OPUS} high`]],
			["ui", false, [`${OPUS} high`, `${SOL} medium`]],
			["cyber", true, [`${CYBER} high`]],
		],
	);
	assert.deepEqual(
		before.profiles.map((p) => p.small.map((e) => e.model)),
		[[TERRA, SONNET], [SONNET, TERRA], [CYBER]],
	);
	const saved = [{ ...backend!, optInOnly: true, large: [{ model: CYBER, thinking: "low" }] }];
	await writeWorkProfiles(root, before.defaultsHash, saved);
	const after = await readModelDefaults(root);
	assert.deepEqual(after.profiles, saved);
	assert.notEqual(after.defaultsHash, before.defaultsHash);
	const text = await readFile(join(root, "settings.json"), "utf8");
	assert.match(text, /"extensions": \[ "kept" \]/);
	assert.equal(JSON.parse(text).enabledModels, undefined, "a profile model never joins the chat model list");
	await assert.rejects(writeWorkProfiles(root, before.defaultsHash, []), /changed/);
	await writeWorkProfiles(root, after.defaultsHash, []);
	assert.deepEqual((await readModelDefaults(root)).profiles, [], "an empty saved list means no profiles");
	const hash = async () => (await readModelDefaults(root)).defaultsHash;
	const tooMany = Array.from({ length: 13 }, (_, i) => ({ ...backend!, id: `p${i}` }));
	await assert.rejects(writeWorkProfiles(root, await hash(), tooMany), /at most 12 profiles and this save has 13/);
	await assert.rejects(
		writeWorkProfiles(root, await hash(), [backend!, backend!]),
		/Two work profiles use the ID backend/,
	);
	const long = { ...backend!, small: Array.from({ length: 9 }, () => ({ model: SOL, thinking: "low" })) };
	await assert.rejects(
		writeWorkProfiles(root, await hash(), [long]),
		/small list holds at most 8 models and backend has 9/,
	);
	await assert.rejects(
		writeWorkProfiles(root, await hash(), [{ ...backend!, large: [{ model: SOL, thinking: "huge" }] }]),
		/thinking level/,
	);
});

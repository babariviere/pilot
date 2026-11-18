/** An explorer chat's question stops needing the user once its plan settles it. The chat itself stays. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { dayMissionAgents } from "./day-mission-agents.ts";
import { explorerQuestionSettled } from "./explorer-questions.ts";
import { sessionNeedsYouReason } from "./needs-you-reason.ts";
import { buildProjectDashboard } from "./project-dashboard.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionMissionBridge } from "./sessions.ts";
import { offlineSessionOptions } from "./testing/offline-session-options.ts";

type Store = Parameters<typeof explorerQuestionSettled>[0];
const store = (options: { published?: boolean; resolved?: boolean; current?: string; role?: string }): Store =>
	({
		membership: (id: string) =>
			id.startsWith("chat")
				? { missionId: "m", active: true, coordinator: false, role: options.role ?? "explorer" }
				: undefined,
		planningWorkers: {
			get: () => ({
				research: { q: { sessionId: options.current ?? "chat-new", earlierSessionIds: ["chat-old"] } },
			}),
		},
		plans: {
			get: () => ({
				...(options.published ? { publication: {} } : {}),
				questions: [
					{
						id: "q",
						title: "Verify the event schema",
						...(options.resolved ? { resolution: { kind: "knowledge" } } : {}),
					},
				],
			}),
		},
	}) as unknown as Store;

test("a question is moot once its plan is published, its map question resolved, or a newer chat took over", () => {
	const ask = (s: Store, id: string, title = "Research: Verify the event schema") =>
		explorerQuestionSettled(s, { id, title });
	// The current chat of an open question still asks.
	assert.equal(ask(store({}), "chat-new"), false);
	assert.equal(ask(store({ resolved: true }), "chat-new"), true);
	assert.equal(ask(store({ published: true }), "chat-new"), true);
	// A newer chat took over: the earlier one, recorded or found by the title Pilot gave it, is moot.
	assert.equal(ask(store({}), "chat-old"), true);
	assert.equal(ask(store({}), "chat-unrecorded"), true);
	// A chat Pilot cannot tie to a map question, or that is no explorer, still asks.
	assert.equal(ask(store({ published: true }), "chat-thread", "Discuss the schema"), false);
	assert.equal(ask(store({ published: true, role: "builder" }), "chat-new"), false);
	assert.equal(ask(store({ published: true }), "other"), false);
});

test("a settled question leaves Needs you, Needs a look and the mission agent's waiting, and the chat stays", () => {
	const chat: SessionSummary = {
		id: "chat-old",
		title: "Research: Verify the event schema",
		cwd: "/w",
		projectId: "p",
		missionId: "m",
		createdAt: 1,
		updatedAt: 2,
		state: "idle",
		outcome: "question",
		outcomeAt: 2,
		outcomeReason: "Can you restore native read access to eventbus-schema/go@v0.32.0 for this research?",
	};
	const dashboard = (s: SessionSummary) =>
		buildProjectDashboard({ projectId: "p", sessions: [s], missions: [], progress: new Map(), isUnread: () => true });
	assert.equal(dashboard(chat).needsYou.total, 1, "an open question needs the user");
	assert.equal(sessionNeedsYouReason(chat).kind, "asks");
	assert.equal(dayMissionAgents("p", new Set(["m"]), [chat])[0]!.waitingForUser, true);
	const settled = { ...chat, questionSettled: true as const };
	assert.equal(dashboard(settled).needsYou.total, 0);
	assert.notEqual(sessionNeedsYouReason(settled).kind, "asks");
	const agent = dayMissionAgents("p", new Set(["m"]), [settled])[0]!;
	assert.equal(agent.waitingForUser, false);
	assert.equal(agent.sessionId, "chat-old", "the chat stays listed and can be opened");
});

test("a finished map explorer is never unread; its open question and failure still need the user until settled", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-explorer-unread-"));
	const ids = { done: randomUUID(), failed: randomUUID(), asks: randomUUID(), other: randomUUID() };
	const outcomes: Record<string, "done" | "failed" | "question"> = {
		[ids.done]: "done",
		[ids.failed]: "failed",
		[ids.asks]: "question",
		[ids.other]: "done",
	};
	for (const [id, outcome] of Object.entries(outcomes)) {
		const cwd = join(home, "sessions", id, "workspace");
		await mkdir(cwd, { recursive: true });
		await writeFile(
			join(home, "sessions", id, "meta.json"),
			JSON.stringify({
				id,
				title: `Research: ${outcome}`,
				cwd,
				projectId: "p",
				createdAt: 1,
				updatedAt: 2,
				working: false,
				outcome,
				outcomeAt: 10,
			}),
		);
	}
	const manager = new SessionManager(home, new ProjectStore(home), undefined, {}, undefined, offlineSessionOptions());
	try {
		await manager.load();
		let settled = false;
		manager.setMissionBridge({
			membership: (id: string) =>
				id === ids.other
					? { missionId: "m", active: true, coordinator: false, role: "builder" }
					: { missionId: "m", active: true, coordinator: false, role: "explorer" },
			context: () => undefined,
			explorerQuestion: () => ({ settled }),
		} as unknown as SessionMissionBridge);
		const read = () => {
			const sessions = Object.values(ids).map((id) => manager.get(id)!);
			const items = buildProjectDashboard({
				projectId: "p",
				sessions,
				missions: [],
				progress: new Map(),
				isUnread: () => true,
			}).needsYou.items;
			return { sessions, kinds: Object.fromEntries(items.map((i) => [i.sessionId, i.kind])) };
		};
		const open = read();
		assert.equal(open.sessions[0]!.mapExplorer, true);
		assert.equal(open.sessions[3]!.mapExplorer, undefined, "a builder is not a map explorer");
		// The finished explorer is the planner's; the question and the failure still need the user; a builder's
		// unread result stays.
		assert.deepEqual(open.kinds, { [ids.failed]: "failed", [ids.asks]: "question", [ids.other]: "unread" });
		settled = true;
		const done = read();
		assert.equal(done.sessions[1]!.questionSettled, true);
		assert.deepEqual(done.kinds, { [ids.other]: "unread" }, "the plan settled them: only the builder's result stays");
		assert.ok(manager.get(ids.done), "the chats stay");
	} finally {
		await manager.shutdown();
		await rm(home, { recursive: true, force: true });
	}
});

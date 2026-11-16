// The real ConnectedThreads and thread page over scripted native replies (no live service or provider), and the
// window's day.changed invalidation. Headless: not native appearance, focus, scrolling or IME.
import { expect, open, test } from "nsh/test";

type Entry = Record<string, unknown>;

test("a chat reply written after the thread opened shows on the next day.changed; a queued send is placed once", async () => {
	const at = new Date();
	at.setHours(9, 0, 0, 0);
	const t0 = at.getTime();
	const original = (id: number) => ({ kind: "history", sessionId: "s-chat", entryId: id });
	const history: Entry[] = [{ id: 1, kind: "pi.user", role: "you", text: "Can we export CSV first?" }];
	const conversation: Entry[] = [
		{
			id: 1,
			sessionId: "s-chat",
			role: "you",
			text: "Can we export CSV first?",
			shared: false,
			timestamp: t0,
			replyState: "awaiting",
			original: original(1),
		},
	];
	// Old exact words whose place Pilot cannot tell stay apart from the ones that wait to be placed.
	const unplaced = {
		operationId: "op-0",
		text: "Old carried words",
		timestamp: t0 - 3_600_000,
		replyState: "unknown",
	};
	let queued: Entry[] = [
		unplaced,
		{ operationId: "op-2", text: "And JSON after?", timestamp: t0 + 60_000, replyState: "pending" },
	];
	const calls: string[] = [];
	const topic = {
		id: "t1",
		title: "Which file types first?",
		revision: 4,
		disposition: "open",
		ownerSessionId: "s-coordinator",
		chatSessionId: "s-chat",
		references: [],
		inputs: ["op-1", "op-2"],
	};
	const app = await open("./ThreadBridgeFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 2000,
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": (name: string, envelope: { args: Record<string, unknown> }) => {
					calls.push(name);
					const args = envelope.args;
					if (name === "day.threads.read")
						return {
							version: 1,
							value: {
								snapshot: {
									version: 1,
									missionId: "search",
									source: "source-1",
									discussion: { available: true, reason: "" },
									topics: [topic],
									catalog: { known: false },
								},
								operations: [],
							},
						};
					if (name === "day.threads.history") {
						expect(args).toEqual({ missionId: "search", topicId: "t1", before: null });
						return {
							version: 1,
							value: {
								snapshot: {
									version: 1,
									missionId: "search",
									topicId: "t1",
									sessionId: "s-chat",
									scope: "thread-chat",
									entries: history,
									more: false,
									nextBefore: null,
									conversation: {
										entries: conversation,
										queuedMessages: queued,
										more: false,
										nextBefore: null,
										nextSessionId: null,
										earlierContext: "complete",
									},
								},
							},
						};
					}
					return { version: 1, error: "unavailable" };
				},
			},
		},
	});
	await app.press("id:mission-search");
	await app.press("id:thread-t1");
	await app.waitFor("Can we export CSV first?");
	expect(app.shows("Awaiting a reply")).toBe(true);
	expect(app.shows("And JSON after?")).toBe(true);
	expect(app.shows("Saved. Not placed in the conversation yet.")).toBe(true);
	expect(app.shows("id:thread-unplaced")).toBe(true);
	expect(app.shows("Saved. Where it was placed is unknown.")).toBe(true);
	expect(app.texts().filter((t) => t === "Reply status unknown")).toHaveLength(1);
	expect(app.texts().indexOf("Old carried words")).toBeLessThan(app.texts().indexOf("Can we export CSV first?"));
	// The chat answers and places the queued send. Neither changes the thread's revision.
	history.push({ id: 2, kind: "pi.assistant", role: "chat", text: "Yes, CSV first." });
	history.push({ id: 3, kind: "pi.user", role: "you", text: "And JSON after?" });
	conversation[0] = { ...conversation[0], replyState: "answered" };
	conversation.push(
		{
			id: 2,
			sessionId: "s-chat",
			role: "chat",
			text: "Yes, CSV first.",
			shared: false,
			timestamp: t0 + 30_000,
			replyState: "unknown",
			original: original(2),
		},
		{
			id: 3,
			operationId: "op-2",
			sessionId: "s-chat",
			role: "you",
			text: "And JSON after?",
			shared: false,
			timestamp: t0 + 60_000,
			replyState: "awaiting",
			original: original(3),
		},
	);
	queued = [unplaced];
	// Another window's change reads nothing here.
	const before = calls.length;
	await app.host.send("day.changed", { version: 1, window: "other" });
	expect(calls.length).toBe(before);
	await app.host.send("day.changed", { version: 1, window: "fixture" });
	await app.waitFor("Yes, CSV first.");
	await app.waitUntil(() => !app.shows("Saved. Not placed in the conversation yet."));
	expect(app.texts().filter((t) => t === "And JSON after?")).toHaveLength(1);
	expect(app.texts().filter((t) => t === "Old carried words")).toHaveLength(1);
	expect(app.shows("id:message-s-chat:3:op-2")).toBe(true);
	expect(app.texts().filter((t) => t === "Awaiting a reply")).toHaveLength(1);
	// Only passive reads: nothing was written or started.
	expect(calls.every((n) => n === "day.threads.read" || n === "day.threads.history")).toBe(true);
});

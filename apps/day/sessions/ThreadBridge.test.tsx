// The real ConnectedThreads and thread page over scripted native replies (no live service or provider), and the
// window's day.changed invalidation. Headless: not native appearance, focus or IME.
import { expect, open, test } from "nsh/test";

type Entry = Record<string, unknown>;

/** What the scripted root answers now: tests change it, then send day.changed. */
type World = { history: Entry[]; conversation: Entry[]; queued: Entry[]; calls: string[] };

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

const original = (id: number) => ({ kind: "history", sessionId: "s-chat", entryId: id });

/** The thread page over a root that answers from `world`, opened on thread t1. */
async function openThread(world: World, height: number) {
	const app = await open("../ThreadBridgeFixture.tsx", {
		platform: "macos",
		width: 1100,
		height,
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": (name: string, envelope: { args: Record<string, unknown> }) => {
					world.calls.push(name);
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
						expect(envelope.args).toEqual({ missionId: "search", topicId: "t1", before: null });
						return {
							version: 1,
							value: {
								snapshot: {
									version: 1,
									missionId: "search",
									topicId: "t1",
									sessionId: "s-chat",
									scope: "thread-chat",
									entries: world.history,
									more: false,
									nextBefore: null,
									conversation: {
										entries: world.conversation,
										queuedMessages: world.queued,
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
	await app.press("id:mission-section-discussions");
	await app.press("id:thread-t1");
	return app;
}

function nine(): number {
	const at = new Date();
	at.setHours(9, 0, 0, 0);
	return at.getTime();
}

test("a chat reply written after the thread opened shows on the next day.changed; a queued send is placed once", async () => {
	const t0 = nine();
	// Old exact words whose place Pilot cannot tell stay apart from the ones that wait to be placed.
	const unplaced = {
		operationId: "op-0",
		text: "Old carried words",
		timestamp: t0 - 3_600_000,
		replyState: "unknown",
	};
	const world: World = {
		history: [{ id: 1, kind: "pi.user", role: "you", text: "Can we export CSV first?" }],
		conversation: [
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
		],
		queued: [
			unplaced,
			{ operationId: "op-2", text: "And JSON after?", timestamp: t0 + 60_000, replyState: "pending" },
		],
		calls: [],
	};
	const app = await openThread(world, 2000);
	await app.waitFor("Can we export CSV first?");
	expect(app.shows("Awaiting a reply")).toBe(true);
	expect(app.shows("And JSON after?")).toBe(true);
	expect(app.shows("Saved. Not placed in the conversation yet.")).toBe(true);
	expect(app.shows("id:thread-unplaced")).toBe(true);
	expect(app.shows("Saved. Where it was placed is unknown.")).toBe(true);
	expect(app.texts().filter((t) => t === "Reply status unknown")).toHaveLength(1);
	expect(app.texts().indexOf("Old carried words")).toBeLessThan(app.texts().indexOf("Can we export CSV first?"));
	// The chat answers and places the queued send. Neither changes the thread's revision.
	world.history.push({ id: 2, kind: "pi.assistant", role: "chat", text: "Yes, CSV first." });
	world.history.push({ id: 3, kind: "pi.user", role: "you", text: "And JSON after?" });
	world.conversation[0] = { ...world.conversation[0], replyState: "answered" };
	world.conversation.push(
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
	world.queued = [unplaced];
	// Another window's change reads nothing here.
	const before = world.calls.length;
	await app.host.send("day.changed", { version: 1, window: "other" });
	expect(world.calls.length).toBe(before);
	await app.host.send("day.changed", { version: 1, window: "fixture" });
	await app.waitFor("Yes, CSV first.");
	await app.waitUntil(() => !app.shows("Saved. Not placed in the conversation yet."));
	expect(app.texts().filter((t) => t === "And JSON after?")).toHaveLength(1);
	expect(app.texts().filter((t) => t === "Old carried words")).toHaveLength(1);
	expect(app.shows("id:message-s-chat:3:op-2")).toBe(true);
	expect(app.texts().filter((t) => t === "Awaiting a reply")).toHaveLength(1);
	// Only passive reads: nothing was written or started.
	expect(world.calls.every((n) => n === "day.threads.read" || n === "day.threads.history")).toBe(true);
});

test("a live update that removes content above the screen keeps the message being read where it was", async () => {
	const t0 = nine();
	const words = (n: number) =>
		`Message ${n}. ${"Some words that make this message wrap over a few lines on the page. ".repeat(4)}`;
	const world: World = { history: [], conversation: [], queued: [], calls: [] };
	for (let n = 1; n <= 16; n++) {
		const you = n % 2 === 1;
		world.history.push({ id: n, kind: you ? "pi.user" : "pi.assistant", role: you ? "you" : "chat", text: words(n) });
		world.conversation.push({
			id: n,
			sessionId: "s-chat",
			role: you ? "you" : "chat",
			text: words(n),
			shared: false,
			timestamp: t0 + n * 60_000,
			// Not proved answered yet: each of yours says so, above the one being read too.
			replyState: "unknown",
			original: original(n),
		});
	}
	// Old saved words of unknown placement: a tall section above every message.
	world.queued = Array.from({ length: 6 }, (_, i) => ({
		operationId: `op-old-${i}`,
		text: `Old carried words ${i}. ${"These words were saved before Pilot kept their place. ".repeat(5)}`,
		timestamp: t0 - 3_600_000,
		replyState: "unknown",
	}));
	const app = await openThread(world, 900);
	await app.waitFor("id:thread-unplaced");
	// Read on, past the section, to the middle of the conversation. Headless shows() does not tell what is inside
	// the viewport, so the kept scroll offset says where the reader is.
	await app.scroll("id:thread", 1500);
	await app.wait(500);
	await app.press("Where");
	const at = (): number =>
		Number(
			app
				.texts()
				.find((t) => t.startsWith("Scroll: "))
				?.slice(8),
		);
	const before = at();
	expect(before).toBeGreaterThan(0);
	// Their places were learned in older history this page does not hold, and your messages were answered: the
	// section and the status lines above the screen go away together.
	world.queued = [];
	world.conversation = world.conversation.map((e) => ({
		...e,
		replyState: e.role === "you" ? "answered" : "unknown",
	}));
	await app.host.send("day.changed", { version: 1, window: "fixture" });
	await app.waitUntil(() => !app.texts().includes("Reply status unknown"));
	await app.wait(500);
	await app.press("Where");
	await app.waitUntil(() => at() !== before);
	// The page scrolled back by what went away above, instead of letting the reading place jump.
	expect(at()).toBeLessThan(before);
	expect(before - at()).toBeGreaterThan(300);
	expect(world.calls.every((n) => n === "day.threads.read" || n === "day.threads.history")).toBe(true);
});

test("a partially visible long message stays still when its own reply status disappears below the viewport", async () => {
	const t0 = nine();
	const text = "A long message the user is reading. ".repeat(400);
	const world: World = {
		history: [{ id: 1, kind: "pi.user", role: "you", text }],
		conversation: [
			{
				id: 1,
				sessionId: "s-chat",
				role: "you",
				text,
				shared: false,
				timestamp: t0,
				replyState: "unknown",
				original: original(1),
			},
		],
		queued: [],
		calls: [],
	};
	const app = await openThread(world, 900);
	await app.scroll("id:thread", 1000);
	await app.wait(500);
	const probe = async (n: number) => {
		await app.press("Where");
		await app.waitUntil(() => app.texts().some((t) => t.startsWith(`Anchor ${n}: `)));
		const [, key, y] =
			/^Anchor \d+: (\S+) (-?\d+)$/.exec(app.texts().find((t) => t.startsWith(`Anchor ${n}: `)) ?? "") ?? [];
		return { key, y: Number(y) };
	};
	const before = await probe(1);
	expect(before.key).toBe("s-chat:1");
	expect(before.y).toBeLessThan(0);
	world.conversation[0] = { ...world.conversation[0], replyState: "answered" };
	world.conversation.push({
		id: 2,
		sessionId: "s-chat",
		role: "chat",
		text: "Answer received later.",
		shared: false,
		timestamp: t0 + 60_000,
		replyState: "unknown",
		original: original(2),
	});
	world.history.push({ id: 2, kind: "pi.assistant", role: "chat", text: "Answer received later." });
	await app.host.send("day.changed", { version: 1, window: "fixture" });
	await app.waitFor("Answer received later.");
	await app.wait(500);
	const after = await probe(2);
	expect(after.key).toBe(before.key);
	expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
	expect(world.calls.every((n) => n === "day.threads.read" || n === "day.threads.history")).toBe(true);
});

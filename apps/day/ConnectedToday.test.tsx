// Today over the real TSX adapter (bridge.ts) with scripted root replies.
// Rust tries a refused send again by itself; TSX shows Sending meanwhile and
// then Rust's outcome. An Unknown answer is looked up by itself and never
// sent again; Check again is only the fallback after those looks.
import { expect, open, test } from "nsh/test";
import { TodayFeed } from "pilot-day/native";

const DECIDE = "id:decision >> role:button[Decide]";
const CHECK = "id:decision >> role:button[Check again]";
const QUESTION = "2 integration tests fail on Linux";

type Root = (name: string, args: Record<string, unknown>) => unknown;

async function openToday(lost: boolean, root: Root) {
	const app = await open("./ConnectedTodayFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 1400,
		clock: {},
		host: { params: { day: { version: 1, window: "fixture" }, lost } },
		modules: {
			nsh: {
				"host.call": (name: string, envelope: { args: Record<string, unknown> }) => root(name, envelope.args),
			},
		},
	});
	await app.waitFor(QUESTION);
	return app;
}

/** Today once the first decision's answer arrived: it no longer waits. */
function answered() {
	const today = new TodayFeed("trouble").snapshot();
	return { ...today, decisions: today.decisions.slice(1) };
}

const reply = (snapshot: unknown, outcome: unknown = null) => ({ version: 1, value: { snapshot, outcome } });

test("Decide shows Sending while Rust sends again by itself, then the answer is accepted", async () => {
	let replies = 0;
	const app = await openToday(false, (name) => {
		if (name !== "day.attention.reply") return { version: 1, error: "unavailable" };
		replies++;
		// Rust is still trying for a moment: its read moved, the decision did not.
		return new Promise((resolve) =>
			setTimeout(() => resolve(reply(answered(), { status: "accepted", revision: 1, message: "" })), 300),
		);
	});
	await app.press(DECIDE);
	await app.waitFor("Sending your answer…");
	expect(replies).toBe(1);
	expect(app.shows("This changed before Pilot could send it. Nothing was sent; your words stay. Look again.")).toBe(
		false,
	);
	await app.waitUntil(() => !app.shows(QUESTION));
	expect(app.shows("Sending your answer…")).toBe(false);
	expect(replies).toBe(1);
});

test("a changed decision or used-up tries keep the pick and say what happened", async () => {
	const said = [
		"This question changed before Pilot could send your answer. Nothing was sent; your answer stays. Read it again.",
		"Pilot tried 3 times, but the mission kept changing around this question. Nothing was sent; your answer stays. Try again in a moment.",
	];
	let replies = 0;
	const app = await openToday(false, (name) => {
		if (name !== "day.attention.reply") return { version: 1, error: "unavailable" };
		const message = said[replies++]!;
		return reply(new TodayFeed("trouble").snapshot(), { status: "stale", revision: 1, message });
	});
	for (const message of said) {
		await app.press(DECIDE);
		await app.waitFor(message);
		// Nothing was sent, so the same pick can go again.
		expect(app.shows(DECIDE)).toBe(true);
	}
	expect(replies).toBe(2);
});

test("an Unknown answer is checked by itself, quietly, and settles without a click", async () => {
	let checks = 0;
	let arrived = false;
	const app = await openToday(true, (name, args) => {
		if (name === "day.attention.reply") throw new Error("an Unknown answer is never sent again");
		if (name !== "day.attention.check") return { version: 1, error: "unavailable" };
		expect(args.action).toBe(false);
		// No receipt yet, until the answer arrives; the next look then finds it.
		checks++;
		return arrived ? reply(answered()) : { version: 1, error: "unknown" };
	});
	await app.waitFor("Checking that your answer arrived…");
	expect(app.shows(CHECK)).toBe(false);
	expect(app.shows(DECIDE)).toBe(false);
	arrived = true;
	await app.waitUntil(() => !app.shows(QUESTION), { timeout: 5_000 });
	expect(checks).toBeGreaterThan(1);
});

test("after its automatic checks, Check again is offered and still only reads", async () => {
	const first = new TodayFeed("trouble").snapshot().decisions[0]!.id;
	let checks = 0;
	const app = await openToday(true, (name, args) => {
		// Only this decision's looks; an unconfirmed push in the same world has its own.
		if (name === "day.attention.check" && args.id === first) checks++;
		if (name === "day.attention.reply") throw new Error("an Unknown answer is never sent again");
		return { version: 1, error: "unknown" };
	});
	await app.waitFor("Checking that your answer arrived…");
	await app.wait(120_000);
	await app.waitFor("Pilot could not confirm your answer yet. It will not send it again. Check again only reads.");
	expect(checks).toBe(6);
	await app.press(CHECK);
	await app.waitUntil(() => checks === 7);
});

test("after a reconnect, Pilot checks an Unknown answer by itself again", async () => {
	const first = new TodayFeed("trouble").snapshot();
	const lost = { ...first, decisions: first.decisions.map((d, n) => (n === 0 ? { ...d, delivery: "unknown" } : d)) };
	const at = (state: string) => ({ ...lost, freshness: { ...lost.freshness, state } });
	let checks = 0;
	let reads = 0;
	const app = await openToday(true, (name, args) => {
		if (name === "day.attention.check" && args.id === first.decisions[0]!.id) checks++;
		// The first read finds the service gone, the next one finds it back.
		if (name === "day.today.read") return reply(at(++reads === 1 ? "offline" : "live"));
		return { version: 1, error: "unknown" };
	});
	await app.wait(120_000);
	await app.waitFor(CHECK);
	expect(checks).toBe(6);
	await app.press("role:button[Read Today]");
	await app.press("role:button[Read Today]");
	await app.waitFor("Checking that your answer arrived…");
	await app.waitUntil(() => checks === 7);
});

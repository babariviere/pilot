// Planning over the real TSX adapter (bridge.ts) with scripted root replies:
// interview answers whose reply was lost are looked up by themselves and
// never sent again; Check again is only the fallback after those looks.
import { expect, open, test } from "nsh/test";
import { PlanFeed, type PlanPage } from "pilot-day/native";

async function page(submit: "unknown" | "submitted"): Promise<PlanPage> {
	const feed = new PlanFeed("interview");
	await feed.open("export");
	const read = feed.page("export");
	if (!read?.interview) throw new Error("the interview is open");
	return { ...read, interview: { ...read.interview, submit } };
}

async function openPlans(root: (name: string, args: Record<string, unknown>) => unknown) {
	return await open("./ConnectedPlansFixture.tsx", {
		platform: "macos",
		width: 600,
		height: 400,
		clock: {},
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: { "host.call": (name: string, envelope: { args: Record<string, unknown> }) => root(name, envelope.args) },
		},
	});
}

const reply = (snapshot: unknown) => ({ version: 1, value: { snapshot, outcome: null } });

test("lost interview answers are checked by themselves and settle without a click", async () => {
	const lost = await page("unknown");
	const done = await page("submitted");
	let checks = 0;
	const app = await openPlans((name, args) => {
		if (name === "day.plan.read") return reply(lost);
		if (name === "day.plan.submit" || name === "day.plan.save") throw new Error("never sent again");
		if (name !== "day.plan.check") return { version: 1, error: "unavailable" };
		expect(args.intent).toEqual({ interviewId: lost.interview!.id });
		return ++checks === 1 ? { version: 1, error: "unknown" } : reply(done);
	});
	await app.waitFor("text:submit: checking");
	await app.waitFor("text:submit: submitted");
	expect(checks).toBe(2);
});

test("after its automatic checks the answers show as unconfirmed, for Check again", async () => {
	const lost = await page("unknown");
	let checks = 0;
	const app = await openPlans((name) => {
		if (name === "day.plan.read") return reply(lost);
		if (name === "day.plan.check") checks++;
		return { version: 1, error: "unknown" };
	});
	await app.waitFor("text:submit: checking");
	await app.wait(120_000);
	await app.waitFor("text:submit: unknown");
	expect(checks).toBe(6);
});

test("when the service is back after a failed read, the automatic checks start over", async () => {
	const lost = await page("unknown");
	let checks = 0;
	let lists = 0;
	const app = await openPlans((name) => {
		if (name === "day.plan.read") return reply(lost);
		if (name === "day.plan.check") checks++;
		if (name === "day.plan.inventory")
			return ++lists === 1
				? { version: 1, error: "offline" }
				: reply({ availability: "live", reason: "", plans: [] });
		return { version: 1, error: "unknown" };
	});
	await app.wait(120_000);
	await app.waitFor("text:submit: unknown");
	expect(checks).toBe(6);
	await app.press("role:button[Read the list]");
	await app.press("role:button[Read the list]");
	await app.waitFor("text:submit: checking");
	await app.waitUntil(() => checks === 7);
});

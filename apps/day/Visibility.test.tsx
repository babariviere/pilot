import { expect, open, test } from "nsh/test";
import { stateMark } from "./words";

const desktop = { platform: "macos", width: 1100, height: 1800 } as const;

test("Today shows the cause, uncertain work, recommendation and diagnostic origin", async () => {
	const app = await open("./VisibilityFixture.tsx", desktop);
	await app.waitFor("Some work needs a look.");
	expect(app.shows("Unresolved work is shown above. Nothing is retried here.")).toBe(true);
	expect(app.shows("What needs you is not current. Read again before acting.")).toBe(false);
	expect(app.shows("Native checks failed. The coordinator needs your help.")).toBe(true);
	expect(app.shows("Saved work is not verified. Unfinished effects may be uncertain.")).toBe(true);
	expect(app.shows("Diagnostic chat: pilot://chat/fixture-worker")).toBe(true);
	expect(app.shows("Next: Inspect the failed check before choosing how to continue. Nothing is retried here.")).toBe(
		true,
	);
	await app.press("Stale read");
	await app.waitFor("Earlier read. These problems may have changed.");
	expect(app.shows("History work stopped")).toBe(true);
	await app.press("role:button[Open the mission for History work stopped]");
	await app.waitFor("Agent assessment, not verified progress or acceptance.");
	expect(app.shows("Agent assessment, not verified progress or acceptance.")).toBe(true);
	expect(app.texts().includes("https://github.com/mock/pilot/pull/431")).toBe(true);
});

test("missing attention never claims an empty inbox", async () => {
	const app = await open("./VisibilityFixture.tsx", desktop);
	await app.press("Resolve problems");
	await app.press("Missing attention");
	await app.waitFor("Pilot cannot read all unresolved problems. This is not the same as having none.");
	expect(app.shows("That is everything for now. Pilot will tell you if something needs you.")).toBe(false);
});

test("only stale reports get the folded document mark", () => {
	const report = {
		taskId: "t",
		currentness: "stale" as const,
		movement: "unknown" as const,
		byCoordinator: false,
		age: "yesterday",
		summary: "Claim",
		nextStep: "Check",
		evidence: [],
	};
	expect(stateMark({ state: "unreported", report })).toBe("oldReport");
	expect(stateMark({ state: "unreported", report: null })).toBe("unreported");
	expect(stateMark({ state: "unreported", report: { ...report, currentness: "unavailable" } })).toBe("unreported");
	expect(stateMark({ state: "stuck", report })).toBe("failed");
	expect(stateMark({ state: "unconfirmed", report })).toBe("unknown");
});

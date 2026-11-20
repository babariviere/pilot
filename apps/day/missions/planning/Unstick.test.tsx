// Unstick: reading explains and changes nothing; the fix applies once, on Apply. Mock data.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 900 } as const;

test("Unstick says why planning is stuck and what it checked; Apply sends the one fix once", async () => {
	const app = await open("../../UnstickFixture.tsx", desktop);
	expect(app.shows("id:unstick-card")).toBe(false);
	await app.press("id:unstick");
	await app.waitFor("id:unstick-card");
	expect(app.texts().some((t) => t.startsWith("Some saved answers belong to an earlier wording"))).toBe(true);
	expect(app.shows("• Questions: 13, saved answers: 7, 7 to an earlier wording")).toBe(true);
	expect(app.shows("Applied: 0")).toBe(true);
	await app.press("id:unstick-apply");
	await app.waitFor("Removed. Answer those questions again.");
	expect(app.shows("Applied: 1")).toBe(true);
	// Now it only waits: no fix to apply again.
	expect(app.shows("id:unstick-apply")).toBe(false);
	expect(app.shows("Pilot waits for your answers to this round.")).toBe(true);
});

test("Have an agent look starts one read-only agent; its fix shows with what it read, and Apply sends the edited note", async () => {
	const app = await open("../../UnstickFixture.tsx", desktop);
	await app.press("id:unstick");
	await app.waitFor("id:repair-start");
	expect(app.shows("Have an agent look")).toBe(true);
	await app.press("id:repair-start");
	await app.waitFor("id:repair-looking");
	expect(app.shows("text:Open planning repair chat")).toBe(true);
	expect(app.shows("id:repair-start")).toBe(false);
	await app.press("id:agent-done");
	await app.waitFor("id:repair-proposal");
	expect(app.shows("The map is full: Pilot refused a save with 42 questions.")).toBe(true);
	expect(app.shows("• plan-map refused: Invalid planning list")).toBe(true);
	await app.clear("id:repair-note");
	await app.type("id:repair-note", "Merge a and b, keep c.");
	await app.press("id:repair-apply");
	await app.waitFor("Sent. Pilot continues planning with this note.");
	expect(app.shows("Note: Merge a and b, keep c.")).toBe(true);
	expect(app.shows("Ask an agent again")).toBe(true);
	// Not now puts the agent's fix aside, and Unstick's own fix shows again.
	await app.press("id:repair-proposal >> Not now");
	await app.waitFor("id:unstick-apply");
	expect(app.shows("id:repair-proposal")).toBe(false);
});

test("a bug in Pilot itself goes to Feedback with the agent's findings, and nothing is sent", async () => {
	const app = await open("../../UnstickFixture.tsx", desktop);
	await app.press("id:unstick");
	await app.press("id:agent-bug");
	await app.waitFor("id:repair-report");
	expect(app.shows("id:repair-apply")).toBe(false);
	await app.press("id:repair-report");
	await app.waitFor("Feedback: Cause: Pilot refuses every save over 40 questions.");
});

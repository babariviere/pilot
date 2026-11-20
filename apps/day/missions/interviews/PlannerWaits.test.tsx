// A planning agent that ended its turn with a request in prose is never a
// dead end: its last words, a reply and Continue (PlannerWaitsFixture.tsx).
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;
const sent = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Sent:")) ?? "";

test("the plan page shows the planner's last words; Reply sends the user's words once as a note", async () => {
	const app = await open("../../PlannerWaitsFixture.tsx", desktop);
	await app.waitFor("id:planner-waits");
	expect(app.shows("Which database should the export use? Tell me and I will go on.")).toBe(true);
	expect(app.shows("id:planner-continue")).toBe(true);
	await app.type("id:planner-reply", "Postgres");
	// A background read of the same page keeps the field, its focus and its words.
	await app.keyboard.press("mod+shift+1");
	await app.keyboard.press("x");
	expect(app.value("id:planner-reply")).toBe("Postgresx");
	await app.press("id:planner-reply-send");
	await app.waitFor("Sent. Pilot continues planning with this note.");
	expect(sent(app)).toBe("Sent: note: Postgresx");
	expect(app.shows("id:planner-reply-send")).toBe(false);
});

test("Continue sends no reply", async () => {
	const app = await open("../../PlannerWaitsFixture.tsx", desktop);
	await app.waitFor("id:planner-continue");
	await app.press("id:planner-continue");
	await app.waitFor("Pilot continues planning.");
	expect(sent(app)).toBe("Sent: continue");
});

test("Today's planning row shows the planner's words and opens its planning to reply", async () => {
	const app = await open("../../PlannerWaitsFixture.tsx", desktop);
	await app.press("Show Today");
	await app.waitFor("id:plan-says-stuck-mission");
	expect(
		app.shows("id:plan-says-stuck-mission >> text:Which database should the export use? Tell me and I will go on."),
	).toBe(true);
	expect(app.shows("id:plan-reply-stuck-mission")).toBe(true);
});

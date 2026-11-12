// The window's one way around, as a user takes it: Pilot at the top left
// always goes to Today, the one Back goes up a single level, and Escape does
// the same. Moving around keeps drafts and sends nothing. Headless: this
// proves behavior, not the header's look, focus rings or native scrolling.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;
const narrow = { platform: "macos", width: 520, height: 1000 } as const;
const TODAY = "Three short things need you.";

type App = Awaited<ReturnType<typeof open>>;

/** Opens Faster search's interview and plan from its overview, as a user does. */
async function openSearchPlan(app: App) {
	await app.press("id:mission-search");
	await app.waitFor("id:mission-plan");
	await app.press("id:open-plan");
	await app.waitFor("This mission is not in planning.");
}

test("Today, mission, interview and plan: one Back goes up one level at a time", async () => {
	const app = await open("./App.tsx", desktop);
	await app.waitFor(TODAY);
	// Today is the top: Pilot is there, Back is not.
	expect(app.shows("id:home")).toBe(true);
	expect(app.shows("id:back")).toBe(false);

	await app.press("id:mission-search");
	await app.waitFor("id:mission-plan");
	expect(app.shows("role:button[Back to Today]")).toBe(true);

	await app.press("id:open-plan");
	await app.waitFor("This mission is not in planning.");
	// One Back, to the mission's overview; no second control to Today.
	expect(app.shows("role:button[Back to Mission overview]")).toBe(true);
	expect(app.shows("role:button[Back to Today]")).toBe(false);
	expect(app.shows("id:open-overview")).toBe(false);

	await app.press("role:button[Back to Mission overview]");
	await app.waitFor("id:mission-plan");
	expect(app.shows("Latest report")).toBe(true);
	await app.press("role:button[Back to Today]");
	await app.waitFor(TODAY);
	expect(app.shows("id:back")).toBe(false);
});

test("Escape goes up the same single level as Back", async () => {
	const app = await open("./App.tsx", desktop);
	await openSearchPlan(app);
	await app.keyboard.press("escape");
	await app.waitFor("id:mission-plan");
	expect(app.shows(TODAY)).toBe(false);
	await app.keyboard.press("escape");
	await app.waitFor(TODAY);
});

test("Pilot at the top left goes to Today from any depth", async () => {
	const app = await open("./App.tsx", desktop);
	await openSearchPlan(app);
	await app.press("id:home");
	await app.waitFor(TODAY);
	expect(app.shows("id:back")).toBe(false);

	await app.press("id:changes-open");
	await app.waitFor("id:back");
	expect(app.shows("role:button[Back to Today]")).toBe(true);
	await app.press("id:home");
	await app.waitFor(TODAY);
});

test("a mission in planning that Today does not list goes back to Today", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:plan-export");
	await app.waitFor("What should one export include?");
	expect(app.shows("role:button[Back to Today]")).toBe(true);
	expect(app.shows("role:button[Back to Mission overview]")).toBe(false);
	await app.keyboard.press("escape");
	await app.waitFor(TODAY);
});

test("the header's places open from a nested page, and their Back goes to Today", async () => {
	const app = await open("./App.tsx", desktop);
	await openSearchPlan(app);
	await app.press("id:new-open");
	await app.waitFor("What do you want done?");
	// New has no second New in the header, and goes back to Today.
	expect(app.shows("id:new-open")).toBe(false);
	expect(app.shows("role:button[Back to Today]")).toBe(true);
	await app.press("id:changes-open");
	await app.waitFor("id:back");
	expect(app.shows("What do you want done?")).toBe(false);
	expect(app.shows("id:changes-open")).toBe(false);
	await app.press("role:button[Back to Today]");
	await app.waitFor(TODAY);
});

test("going home and back keeps New's goal and an interview answer exactly, and sends nothing", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:new-open");
	await app.waitFor("id:goal");
	await app.type("id:goal", "  Keep this goal 日本語 ✓\n");
	await app.press("id:home");
	await app.waitFor(TODAY);
	await app.press("id:plan-export");
	await app.waitFor("id:question-what");
	if (!app.shows("id:answer-what")) await app.press("id:own-what");
	await app.type("id:answer-what", "Exact answer 日本語 ✓");
	await app.press("id:home");
	await app.waitFor(TODAY);
	await app.press("id:new-open");
	expect(app.value("id:goal")).toBe("  Keep this goal 日本語 ✓\n");
	// Leaving planned nothing: New still offers its first step.
	expect(app.enabled("role:button[Plan a mission]")).toBe(true);
	await app.press("id:home");
	await app.press("id:plan-export");
	await app.waitFor("id:question-what");
	if (!app.shows("id:answer-what")) await app.press("id:own-what");
	expect(app.value("id:answer-what")).toBe("Exact answer 日本語 ✓");
});

test("a restored window comes back to the nested page, still one level below its parent", async () => {
	const app = await open("./Update.tsx", desktop);
	await openSearchPlan(app);
	await app.press("role:button[Update ready]");
	await app.press("id:update-prepare");
	await app.waitFor("Update from 0.9.2 to 0.9.3?");
	await app.press("id:update-confirm");
	await app.waitFor("Updated to 0.9.3");
	await app.press("role:button[Back]");
	await app.waitFor("This mission is not in planning.");
	expect(app.shows("role:button[Back to Mission overview]")).toBe(true);
	await app.press("role:button[Back to Mission overview]");
	await app.waitFor("id:mission-plan");
	await app.press("id:home");
	await app.waitFor("Needs you");
});

test("a narrow window keeps Pilot, one Back and every place, with words for screen readers", async () => {
	const app = await open("./App.tsx", narrow);
	await app.waitFor(TODAY);
	for (const control of ["id:home", "role:button[New]", "id:changes-open"]) {
		expect(app.shows(control)).toBe(true);
	}
	await openSearchPlan(app);
	expect(app.shows("role:button[Back to Mission overview]")).toBe(true);
	await app.press("role:button[New]");
	await app.waitFor("What do you want done?");
});

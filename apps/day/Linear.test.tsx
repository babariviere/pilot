// The read-only Linear page as a user opens it from New on Today, on a
// scripted saved read (LinearFixture.tsx). No daemon, provider or Linear.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1200 } as const;

async function page(mode?: string) {
	const app = await open("./LinearFixture.tsx", desktop);
	await app.waitFor("id:incoming");
	if (mode) await app.press(`role:button[Mode ${mode}]`);
	await app.press("id:linear-open");
	await app.waitFor("id:linear");
	return app;
}

test("the page names its scope, the saved cycle and groups the user's issues by state", async () => {
	const app = await page();
	await app.waitFor("Your issues in cycle 42");
	expect(app.shows("Linear · read only")).toBe(true);
	expect(
		app.shows("Your own issues that Pilot saved for this project. Not your team's other issues or other cycles."),
	).toBe(true);
	expect(app.shows("Yours: 2 of 7 finished, 2 in progress, 3 not started.")).toBe(true);
	expect(app.shows("id:linear-saved")).toBe(true);
	for (const group of ["started", "todo", "done", "closed"]) expect(app.shows(`id:linear-group-${group}`)).toBe(true);
	expect(app.shows("id:linear-group-other")).toBe(false);
	expect(app.shows("All 7 saved issues are shown.")).toBe(true);
	expect(app.shows("id:linear-more")).toBe(false);
	expect(app.shows("Reads: 1")).toBe(true);
});

test("links come only from saved IDs, never from a matching title", async () => {
	const app = await page();
	await app.waitFor("id:linear-issue-ln-219");
	expect(app.shows("BIL-219 · In Faster search")).toBe(true);
	expect(app.shows("BIL-224 · In a chat")).toBe(true);
	expect(app.shows("BIL-231 · New on Today")).toBe(true);
	expect(app.shows("BIL-226 · Later on Today")).toBe(true);
	expect(app.shows("BIL-227 · In a mission")).toBe(true);
	// Titled like the mission on Today, but nothing links it there.
	expect(app.shows("BIL-240 · New on Today")).toBe(true);
	await app.press("id:linear-issue-ln-219");
	await app.waitFor("id:linear-detail-ln-219");
	expect(app.shows("Linked to the mission “Faster search”. A chat is linked to it too.")).toBe(true);
	expect(app.shows("Earlier it was also linked to 1 other mission.")).toBe(true);
	await app.press("id:linear-issue-ln-227");
	await app.waitFor("Linked to a mission that is not on Today.");
	expect(app.shows("id:linear-mission-ln-227")).toBe(false);
	await app.press("id:linear-issue-ln-230");
	await app.waitFor("Sub-issue of BIL-200 · Billing cleanup");
	expect(app.shows("Not linked to a chat or mission in Pilot.")).toBe(true);
});

test("an issue opens its mission, or its request in New; Escape goes back to Today", async () => {
	const app = await page();
	await app.press("id:linear-issue-ln-219");
	await app.press("id:linear-mission-ln-219");
	await app.waitFor("Show search results in under 200 ms for large workspaces.");
	expect(app.shows("id:linear")).toBe(false);
	await app.keyboard.press("escape");
	await app.press("id:linear-open");
	await app.press("id:linear-issue-ln-231");
	await app.press("id:linear-new-ln-231");
	await app.waitFor("id:request-detail-ln-231");
	expect(app.shows("id:linear")).toBe(false);
	await app.press("id:linear-open");
	await app.press("id:linear-issue-ln-231");
	await app.waitFor("id:linear-detail-ln-231");
	// Escape closes the open issue first, then the page.
	await app.keyboard.press("escape");
	expect(app.shows("id:linear-detail-ln-231")).toBe(false);
	await app.keyboard.press("escape");
	await app.waitFor("id:incoming");
	expect(app.shows("id:linear")).toBe(false);
});

test("an incomplete read says how many issues it does not show", async () => {
	const app = await page("overflow");
	await app.waitFor("id:linear-more");
	expect(app.shows("100 of 130 saved issues are shown. 30 more are not shown here: Pilot shows up to 100.")).toBe(
		true,
	);
	expect(app.shows("id:linear-complete")).toBe(false);
});

test("source trouble keeps the saved issues and says so; Read again only reads", async () => {
	const app = await page("trouble");
	await app.waitFor("Linear needs you to sign in again. These are the issues it saved before.");
	expect(app.shows("id:linear-issue-ln-219")).toBe(true);
	await app.press("id:linear-read");
	await app.waitFor("Reads: 2");
});

test("a checkpoint for other settings, or no Linear, shows no rows and is not the same as none", async () => {
	let app = await page("not current");
	await app.waitFor("Pilot has not saved issues for this project's current Linear settings yet.");
	expect(app.shows("Nothing is shown. This is not the same as having none.")).toBe(true);
	expect(app.shows("id:linear-issue-ln-219")).toBe(false);
	expect(app.shows("id:linear-saved")).toBe(false);
	expect(app.shows("Your Linear issues")).toBe(true);
	app = await page("unset");
	await app.waitFor("Linear is not set up for this project, so Pilot saved no issues.");
	expect(app.shows("id:linear-cycle")).toBe(false);
});

test("an unreadable first read shows nothing guessed; a later read keeps the last one", async () => {
	const app = await page("unreadable");
	await app.waitFor("Pilot cannot show your Linear issues here. Pilot could not reach its service.");
	expect(app.shows("This is not the same as having none.")).toBe(true);
	expect(app.shows("id:linear-issue-ln-219")).toBe(false);
	await app.press("role:button[Mode saved]");
	await app.press("id:linear-read");
	await app.waitFor("id:linear-issue-ln-219");
	expect(app.shows("id:linear-off")).toBe(false);
	await app.press("role:button[Mode unreadable]");
	await app.press("id:linear-read");
	await app.waitFor("Pilot could not reach its service. What shows is from Pilot's last read.");
	expect(app.shows("id:linear-issue-ln-219")).toBe(true);
});

test("without an active cycle, the page says Pilot saved the open issues", async () => {
	const app = await page("no cycle");
	await app.waitFor("Your open Linear issues");
	expect(app.shows("Cycles are disabled or no cycle is active. Showing your open issues.")).toBe(true);
	expect(app.shows("All 3 saved issues are shown.")).toBe(true);
});

test("the mock window offers the page with demo issues and points back to its example request", async () => {
	const app = await open("./App.tsx", desktop);
	await app.waitFor("id:incoming");
	await app.press("id:linear-open");
	await app.waitFor("Your issues in cycle 42");
	await app.press("id:linear-issue-ln-231");
	await app.press("id:linear-new-ln-231");
	await app.waitFor("id:request-detail-ln-231");
	expect(app.shows("id:linear")).toBe(false);
});

test("a close or an update keeps the page, its project and the open issue; showing it again only reads", async () => {
	const app = await page();
	await app.press("id:linear-issue-ln-224");
	await app.waitFor("id:linear-detail-ln-224");
	await app.press("Save and reopen");
	await app.waitFor("Kept: [mock-project/ln-224]");
	await app.waitFor("id:linear-detail-ln-224");
	expect(app.shows("id:linear")).toBe(true);
	expect(app.shows("Your issues in cycle 42")).toBe(true);
	expect(app.shows("id:linear-issue-gone")).toBe(false);
	// The restored issue has the keyboard focus, so Space closes it.
	await app.keyboard.press("space");
	expect(app.shows("id:linear-detail-ln-224")).toBe(false);
	// Without an open issue the page keeps only its project.
	await app.press("Save and reopen");
	await app.waitFor("Kept: [mock-project]");
	expect(app.shows("id:linear")).toBe(true);
	// Back on Today, nothing is kept for the page.
	await app.keyboard.press("escape");
	await app.waitFor("id:incoming");
	await app.press("Save and reopen");
	await app.waitFor("Kept: []");
	expect(app.shows("id:linear")).toBe(false);
	expect(app.shows("id:incoming")).toBe(true);
});

test("a restored page never shows another project's issues in its place", async () => {
	const app = await page();
	await app.press("id:linear-issue-ln-219");
	await app.press("Save and reopen");
	await app.waitFor("Kept: [mock-project/ln-219]");
	await app.press("role:button[Mode other project]");
	await app.press("id:linear-read");
	await app.waitFor("id:linear-other-project");
	expect(app.shows("Nothing is shown. This is not the same as having none.")).toBe(true);
	expect(app.shows("id:linear-issue-ln-219")).toBe(false);
	expect(app.shows("id:linear-saved")).toBe(false);
	expect(app.shows("Your Linear issues")).toBe(true);
	// It stays pinned: another save keeps the project it showed, not the new one.
	await app.press("Save and reopen");
	await app.waitFor("Kept: [mock-project/ln-219]");
	// Opening the page again from Today shows the project Pilot reads now.
	await app.press("role:button[Back to Today]");
	await app.waitFor("id:incoming");
	await app.press("id:linear-open");
	await app.waitFor("id:linear-issue-ln-219");
	expect(app.shows("id:linear-other-project")).toBe(false);
});

test("a restored issue that is no longer shown says so and opens nothing else", async () => {
	const app = await page();
	await app.press("id:linear-issue-ln-231");
	await app.press("Save and reopen");
	await app.waitFor("Kept: [mock-project/ln-231]");
	await app.press("role:button[Mode overflow]");
	await app.press("id:linear-read");
	await app.waitFor("The issue you had open is not among the issues shown here.");
	await app.press("role:button[Mode saved]");
	await app.press("id:linear-read");
	await app.waitFor("id:linear-detail-ln-231");
	expect(app.shows("id:linear-issue-gone")).toBe(false);
	await app.press("id:linear-issue-ln-226");
	await app.press("role:button[Mode no cycle]");
	await app.press("id:linear-read");
	await app.waitFor("The issue you had open is not in Pilot's saved copy now.");
});

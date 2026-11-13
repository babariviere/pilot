// The command palette as a user takes it: Command+K over any screen, a
// search, the arrow keys, Return and Escape. Choosing only goes somewhere.
// Headless: this proves behavior, not the palette's look, native focus
// rings, the dialog giving the focus back to a field, or an input method's
// composition.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;
const TODAY = "Three short things need you.";
const SEARCH = "label:Search places and missions";

type App = Awaited<ReturnType<typeof open>>;

async function openPalette(app: App) {
	await app.keyboard.press("mod+k");
	await app.waitFor(SEARCH);
}

function says(app: App, part: string): boolean {
	return app.texts().some((t) => t.includes(part));
}

test("Command+K finds a mission by name, and Return opens its overview", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor(TODAY);
	await openPalette(app);
	await app.type(SEARCH, "faster");
	expect(app.shows("role:option[Faster search]")).toBe(true);
	expect(app.shows("role:option[Settings]")).toBe(false);
	await app.keyboard.press("enter");
	await app.waitFor("id:mission-plan");
	expect(app.shows(SEARCH)).toBe(false);
	expect(app.shows("role:button[Back to Today]")).toBe(true);
});

test("Down moves through the places, and New opens with no project chosen", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor(TODAY);
	await openPalette(app);
	// Today, then the start of the day the mock morning offers, then New.
	await app.keyboard.press("down");
	await app.keyboard.press("down");
	await app.keyboard.press("enter");
	await app.waitFor("What do you want done?");
	expect(app.shows("Choose a project")).toBe(true);
	expect(app.enabled("role:button[Plan a mission]")).toBe(false);
});

test("Escape clears the search, then closes the palette and stays on the page", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.press("id:mission-search");
	await app.waitFor("id:mission-plan");
	await openPalette(app);
	await app.type(SEARCH, "zzz");
	await app.waitFor("id:palette-empty");
	expect(app.shows("Nothing matches “zzz”.")).toBe(true);
	await app.keyboard.press("escape");
	expect(app.value(SEARCH)).toBe("");
	expect(app.shows(SEARCH)).toBe(true);
	await app.keyboard.press("escape");
	expect(app.shows(SEARCH)).toBe(false);
	// The page under it did not go back.
	expect(app.shows("id:mission-plan")).toBe(true);
	expect(app.shows("role:button[Back to Today]")).toBe(true);
});

test("going through the palette keeps New's goal exactly and picks no project", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.press("id:new-open");
	await app.waitFor("id:goal");
	await app.type("id:goal", "  Keep this goal 日本語 ✓");
	await openPalette(app);
	await app.keyboard.press("escape");
	expect(app.shows(SEARCH)).toBe(false);
	expect(app.value("id:goal")).toBe("  Keep this goal 日本語 ✓");
	await openPalette(app);
	await app.type(SEARCH, "today");
	await app.keyboard.press("enter");
	await app.waitFor(TODAY);
	await openPalette(app);
	await app.type(SEARCH, "new");
	await app.keyboard.press("enter");
	await app.waitFor("id:goal");
	expect(app.value("id:goal")).toBe("  Keep this goal 日本語 ✓");
	expect(app.shows("Choose a project")).toBe(true);
});

test("the screen's commit key does nothing while the palette covers it, and works again after", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor("1 of 3");
	await app.keyboard.press("3");
	await openPalette(app);
	await app.keyboard.press("mod+enter");
	await app.keyboard.press("escape");
	expect(app.shows(SEARCH)).toBe(false);
	expect(says(app, "has your answer")).toBe(false);
	expect(app.shows("1 of 3")).toBe(true);
	// With the palette closed, the keyboard is Today's again: the same key commits.
	await app.keyboard.press("mod+enter");
	await app.waitUntil(() => says(app, "has your answer"));
});

test("Command+K again closes the palette, and Today's keys work after it", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor("1 of 3");
	await openPalette(app);
	await app.keyboard.press("mod+k");
	expect(app.shows(SEARCH)).toBe(false);
	await app.keyboard.press("j");
	await app.waitFor("2 of 3");
});

test("a shortcut that opens another place puts the palette away", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor(TODAY);
	await openPalette(app);
	await app.keyboard.press("mod+n");
	await app.waitFor("What do you want done?");
	expect(app.shows(SEARCH)).toBe(false);
});

test("places this window lacks and an unread planning list show as unavailable, not missing", async () => {
	const app = await open("./PlanOff.tsx", desktop);
	await openPalette(app);
	expect(app.shows("role:option[Changes]")).toBe(true);
	expect(app.enabled("role:option[Changes]")).toBe(false);
	expect(app.shows("Not available here")).toBe(true);
	expect(app.enabled("role:option[Missions in planning]")).toBe(false);
	expect(app.shows("Unavailable now")).toBe(true);
});

test("a Today read that failed says so instead of listing no missions", async () => {
	const app = await open("./Unreadable.tsx", desktop);
	await openPalette(app);
	expect(app.shows("role:option[Missions could not be read]")).toBe(true);
	expect(app.enabled("role:option[Missions could not be read]")).toBe(false);
});

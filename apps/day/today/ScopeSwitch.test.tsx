// Switching Today's project never shows the previous project's data: not
// from a late answer, and not while the new project's read fails. Headless,
// on ScopeSwitchFixture.tsx.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;
// Today's own read of pilot, and of website, by their headlines.
const PILOT = "text:/^Three things need you\\./";
const WEBSITE = "text:/^Two things need you\\./";

async function choose(app: Awaited<ReturnType<typeof open>>, name: string) {
	await app.press("label:Projects Today shows");
	await app.press(`text:${name}`);
}

test("a late answer for the previous project, after a switch, never shows", async () => {
	const app = await open("../ScopeSwitchFixture.tsx", desktop);
	await app.waitFor("pilot · this window");
	await app.press("Hold reads");
	await choose(app, "pilot");
	await choose(app, "website");
	// pilot's answer arrives after the switch to website: it is dropped.
	await app.press("Release older read");
	await app.waitFor("Reading website…");
	expect(app.shows(PILOT)).toBe(false);
	await app.press("Release newer read");
	// Today's own read is still pilot's: it does not show under website, and
	// website is never listed as another project.
	await app.waitFor("Others: [] in demo-website");
	expect(app.shows("Reading website…")).toBe(true);
	expect(app.shows(PILOT)).toBe(false);
	expect(app.shows("To check in other projects")).toBe(false);
	await app.press("Today moves to website");
	await app.waitFor(WEBSITE);
	expect(app.shows("Showing website.")).toBe(true);
	expect(app.shows(PILOT)).toBe(false);
});

test("the shown project is never among the other projects, whatever the scope", async () => {
	const app = await open("../ScopeSwitchFixture.tsx", desktop);
	await app.waitFor("pilot · this window");
	expect(app.texts().find((t) => t.startsWith("Others:"))).not.toContain("demo-pilot");
	await choose(app, "website");
	await app.waitFor("Others: [] in demo-website");
	expect(app.shows("pilot · this window")).toBe(false);
	await app.press("Today moves to website");
	await app.waitFor(WEBSITE);
	expect(app.shows("Others: [] in demo-website")).toBe(true);
	await choose(app, "All projects");
	await app.waitFor("website · this window");
	const others = app.texts().find((t) => t.startsWith("Others:")) ?? "";
	expect(others).not.toContain("demo-website");
	expect(others).toContain("demo-pilot");
});

test("when the new project's read times out, it reads quietly, then says so; the previous project's data never shows", async () => {
	const app = await open("../ScopeSwitchFixture.tsx", desktop);
	await app.waitFor("pilot · this window");
	await app.press("Reads time out");
	await choose(app, "website");
	await app.waitFor("Reading website…");
	expect(app.shows(PILOT)).toBe(false);
	// Three tries fail (2 s, then 4 s apart): only then does it say why.
	await app.waitFor("Pilot cannot show website here. Pilot could not reach its service.", { timeout: 15_000 });
	expect(app.shows(PILOT)).toBe(false);
	// Once Today's own read is website's, it shows.
	await app.press("Today moves to website");
	await app.waitFor(WEBSITE);
});

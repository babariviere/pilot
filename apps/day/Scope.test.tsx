// Today's project scope as a user takes it, on a scripted scope read
// (ScopeFixture.tsx). No daemon, provider or storage.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;

async function ready() {
	const app = await open("./ScopeFixture.tsx", desktop);
	await app.waitFor("Needs you");
	return app;
}

async function choose(app: Awaited<ReturnType<typeof ready>>, name: string) {
	await app.press("label:Projects Today shows");
	await app.press(`text:${name}`);
}

function sent(app: { texts(): string[] }): string {
	return app.texts().find((t) => t.startsWith("Reads:")) ?? "";
}

test("Today starts on All projects: other projects' rows name their project, and an unread one stays unknown", async () => {
	const app = await ready();
	await app.waitFor("pilot · this window");
	expect(app.shows("website · read only here")).toBe(true);
	expect(app.shows("id:scope-needs-demo-website")).toBe(true);
	expect(app.shows("Across your projects. Pilot could not read billing.")).toBe(true);
	expect(app.shows("text:billing: Pilot could not reach billing's coordinator.")).toBe(true);
	expect(app.shows("Landing page copy")).toBe(true);
	expect(app.shows("Read only here. Open this project's window to check its results.")).toBe(true);
	expect(sent(app)).toContain("Sent: 0");
});

test("one project shows only its rows, and counts what needs you elsewhere without hiding it", async () => {
	const app = await ready();
	await choose(app, "pilot");
	await app.waitFor("Showing pilot.");
	expect(app.shows("id:scope-needs-demo-website")).toBe(false);
	// billing cannot be read, so what needs you elsewhere is unknown, not zero.
	expect(app.shows("Pilot could not count what needs you in other projects.")).toBe(true);
	await app.press("Billing readable");
	await choose(app, "website");
	await app.waitFor("Showing website, read only here. Act on it from its own window.");
	expect(app.shows("pilot · this window")).toBe(false);
	await app.press("id:scope-all");
	await app.waitFor("pilot · this window");
	expect(sent(app)).toContain("Sent: 0");
});

test("without the scope read, Today says it shows this window's project only", async () => {
	const app = await ready();
	await app.press("Scope unavailable");
	await choose(app, "pilot");
	await choose(app, "All projects");
	await app.waitFor("Showing pilot only. This Pilot service cannot read your other projects here yet.");
	expect(app.shows("id:scope-needs-demo-website")).toBe(false);
});

test("an older read answering late never replaces the newer scope", async () => {
	const app = await ready();
	await app.waitFor("pilot · this window");
	await app.press("Hold reads");
	await choose(app, "website");
	await choose(app, "pilot");
	await app.press("Release newer read");
	await app.press("Release older read");
	await app.waitFor("Showing pilot.");
	expect(app.shows("Showing website, read only here. Act on it from its own window.")).toBe(false);
});

test("the window keeps its scope across save and reopen, and sends nothing", async () => {
	const app = await ready();
	await choose(app, "pilot");
	await app.waitFor("Showing pilot.");
	await app.press("Save and reopen");
	await app.waitFor("Showing pilot.");
	expect(sent(app)).toContain("Sent: 0");
});

test("a profile-only window filters every project's rows without selecting work", async () => {
	const app = await ready();
	await app.press("Global window");
	await app.waitFor("id:scope-needs-demo-pilot");
	expect(app.shows("pilot · this window")).toBe(false);
	expect(app.shows("id:scope-needs-demo-website")).toBe(true);
	await choose(app, "website");
	await app.waitFor("Showing website. Project actions are not connected in this dashboard yet.");
	expect(app.shows("id:scope-needs-demo-pilot")).toBe(false);
	expect(app.shows("Pilot could not count what needs you in other projects.")).toBe(true);
	await app.press("Save and reopen");
	await app.waitFor("Showing website. Project actions are not connected in this dashboard yet.");
	expect(sent(app)).toContain("Sent: 0");
});

// Today's project scope as a user takes it, on a scripted scope read
// (ScopeFixture.tsx). No daemon, provider or storage.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;

async function ready() {
	const app = await open("../ScopeFixture.tsx", desktop);
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
	expect(app.shows("text:website")).toBe(true);
	expect(app.shows("id:scope-needs-demo-website")).toBe(true);
	expect(app.shows("Across your projects. Pilot could not read billing.")).toBe(true);
	expect(app.shows("text:billing: Pilot could not reach billing's coordinator.")).toBe(true);
	expect(app.shows("Landing page copy")).toBe(true);
	expect(app.shows("Choose this project above to check its results here.")).toBe(true);
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
	await app.waitFor("Showing website.");
	expect(app.shows("pilot · this window")).toBe(false);
	await app.press("id:scope-all");
	await app.waitFor("pilot · this window");
	expect(sent(app)).toContain("Sent: 0");
});

test("All hides empty project groups but keeps unavailable and filtered empty projects", async () => {
	const app = await ready();
	await app.waitFor("id:scope-needs-demo-billing");
	expect(app.shows("id:scope-missions-demo-billing")).toBe(true);
	await app.press("Empty billing");
	await app.waitUntil(() => !app.shows("id:scope-needs-demo-billing"));
	expect(app.shows("id:scope-missions-demo-billing")).toBe(false);
	expect(app.shows("id:scope-needs-demo-website")).toBe(true);
	await choose(app, "billing");
	await app.waitFor("id:scope-needs-demo-billing");
	expect(app.shows("id:scope-missions-demo-billing")).toBe(true);
	expect(app.shows("Nothing needs you.")).toBe(true);
	expect(app.shows("No active missions.")).toBe(true);
	expect(sent(app)).toContain("Sent: 0");
});

test("a profile-only headline separates requests from attention in the selected project", async () => {
	const app = await ready();
	await app.press("Global window");
	await app.press("Website requests only");
	await choose(app, "website");
	await app.waitFor("Two incoming requests.");
	expect(app.shows("id:scope-needs-demo-website")).toBe(true);
	expect(app.shows("id:scope-missions-demo-website")).toBe(true);
	expect(sent(app)).toContain("Sent: 0");
});

test("stopped chats in another project are counted alongside this window's attention", async () => {
	const app = await ready();
	await app.press("Empty billing");
	await app.press("Two stopped website chats");
	await app.waitFor("Two stopped chats. Three other items need you. Two incoming requests.");
	await app.press("Global window");
	await choose(app, "website");
	await app.waitFor("Two stopped chats. Two incoming requests.");
	expect(app.shows("Some work needs a look. Two incoming requests.")).toBe(false);
	expect(sent(app)).toContain("Sent: 0");
});

test("unknown attention stays unknown while incoming requests remain counted", async () => {
	const app = await ready();
	await app.waitFor("text:/What needs you is not fully known\\. Two incoming requests\\.$/");
	await app.press("Global window");
	await app.waitFor("text:/What needs you is not fully known\\. Two incoming requests\\.$/");
	expect(app.shows("id:scope-needs-demo-billing")).toBe(true);
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
	expect(app.shows("Showing website.")).toBe(false);
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
	await app.waitFor("Showing website.");
	expect(app.shows("id:scope-needs-demo-pilot")).toBe(false);
	expect(app.shows("Pilot could not count what needs you in other projects.")).toBe(true);
	await app.press("Save and reopen");
	await app.waitFor("Showing website.");
	expect(sent(app)).toContain("Sent: 0");
});

test("the project the root names as the window's own shows as its own sections", async () => {
	const app = await ready();
	await app.waitFor("pilot · this window");
	await app.press("Focus website");
	await app.waitFor("website · this window");
	expect(app.shows("id:scope-needs-demo-website")).toBe(false);
	expect(app.shows("id:scope-needs-demo-pilot")).toBe(true);
	expect(app.shows("pilot · this window")).toBe(false);
	expect(sent(app)).toContain("Sent: 0");
});

test("pressing another project's mission opens it, and sends nothing", async () => {
	const app = await ready();
	await app.waitFor("id:scope-missions-demo-website");
	expect(app.shows("Latest report")).toBe(false);
	await app.press("label:Faster search in website, Moving. Open the mission.");
	await app.waitFor("Latest report");
	expect(app.shows("id:scope-missions-demo-website")).toBe(false);
	expect(sent(app)).toContain("Sent: 0");
});

test("pressing another project's request switches Today to that project, and sends nothing", async () => {
	const app = await ready();
	// Another project's Slack request waits among its Needs you rows.
	await app.waitFor("id:scope-needs-demo-website >> Slack request · #client-northwind · 20 min ago");
	await app.press(
		"label:Northwind can't export invoices to CSV in website. Open it to start work, put it off or discard it.",
	);
	// Today now shows website only. In the connected window the root then makes
	// website the window's own project, so its request comes forward as a card in Needs you.
	await app.waitFor("Showing website.");
	expect(app.shows("Northwind can't export invoices to CSV")).toBe(true);
	expect(sent(app)).toContain("Sent: 0");
});

test("an unchanged scope read does not change the view", async () => {
	const app = await ready();
	await app.waitFor("pilot · this window");
	const before = app.texts().find((t) => t.startsWith("Scope views:"));
	const reads = sent(app);
	await app.press("Read scope again");
	await app.waitFor(`text:${reads.replace(/Reads: (\d+)/, (_, n) => `Reads: ${Number(n) + 1}`)}`);
	expect(app.texts().find((t) => t.startsWith("Scope views:"))).toBe(before);
	// A changed read does change it.
	await app.press("Focus website");
	await app.waitFor("website · this window");
	expect(app.texts().find((t) => t.startsWith("Scope views:"))).not.toBe(before);
});

test("a read refused because things changed keeps the earlier rows without a message", async () => {
	const app = await ready();
	await app.waitFor("id:scope-needs-demo-website");
	await app.press("Changed meanwhile");
	await app.press("Read scope again");
	expect(app.shows("id:scope-needs-demo-website")).toBe(true);
	expect(app.shows("Landing page copy")).toBe(true);
	expect(app.shows("id:scope-read")).toBe(false);
	expect(app.texts().some((t) => t.includes("Pilot's last read"))).toBe(false);
});

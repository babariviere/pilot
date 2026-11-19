import { expect, open, test } from "nsh/test";

test("finding references survive goal edits; leaving restores the other draft", async () => {
	const app = await open("./InsightsWorkFixture.tsx", { platform: "macos", width: 900, height: 700 });
	await app.press("Open finding draft");
	expect(app.value("id:insights-work-goal")).toBe("Remember check results");
	await app.clear("id:insights-work-goal");
	await app.type("id:insights-work-goal", "Keep confirmed checks on reopen");
	await app.press("Prepare work request");
	expect(
		app.shows(
			"Keep confirmed checks on reopen\n\nInsights finding: repeated-checks (revision 3).\n\nSource chat: pilot://chat/source-fixture",
		),
	).toBe(true);
	expect(app.shows("Private fixture excerpt")).toBe(false);
	await app.press("Discard finding draft");
	expect(app.value("id:insights-work-goal")).toBe("Keep my unrelated draft");
});

test("a passive refresh preserves the typed allowance", async () => {
	const app = await open("./InsightsFixture.tsx", { platform: "macos", width: 900, height: 1050 });
	await app.press("id:insights-settings");
	await app.clear("id:insights-report-limit");
	await app.type("id:insights-report-limit", "2.75");
	await app.press("Refresh fixture");
	expect(app.value("id:insights-report-limit")).toBe("2.75");
	expect(app.shows("Writes: 0")).toBe(true);
});

test("Pause can stop execution during a lost acknowledgement without replaying it", async () => {
	const app = await open("./InsightsFixture.tsx", { platform: "macos", width: 900, height: 1050 });
	await app.press("Simulate uncertain change");
	expect(app.enabled("id:insights-run")).toBe(false);
	await app.press("id:insights-settings");
	expect(app.enabled("id:insights-review")).toBe(false);
	await app.press("Pause Insights…");
	expect(app.shows("Writes: 0")).toBe(true);
	await app.press("id:insights-confirm");
	await app.waitFor("Writes: 1");
	expect(app.shows("This action is unconfirmed. Nothing is sent again.")).toBe(true);
});

test("opening reports and reviewing paused settings sends nothing until Apply", async () => {
	const app = await open("./InsightsFixture.tsx", { platform: "macos", width: 900, height: 1050 });
	expect(app.shows("Partial coverage")).toBe(true);
	expect(app.shows("Two chats could not be read.")).toBe(true);
	expect(app.enabled("id:insights-run")).toBe(false);
	await app.press("id:insights-settings");
	await app.press("id:insights-review");
	expect(app.shows("Applying settings will not resume Insights.")).toBe(true);
	expect(app.shows("Writes: 0")).toBe(true);
	await app.press("id:insights-confirm");
	await app.waitFor("Writes: 1");
	await app.press("id:insights-reports");
	expect(app.enabled("id:insights-run")).toBe(false);
});

test("opening a finding separates work and benefit verification", async () => {
	const app = await open("./InsightsFixture.tsx", { platform: "macos", width: 900, height: 1050 });
	await app.press("id:insights-findings");
	await app.press("id:insights-item-checks");
	await app.waitFor("Reopen three releases.");
	await app.press("Start a fix…");
	await app.waitFor("Fix draft, no work started");
	expect(app.shows("Writes: 0")).toBe(true);
	await app.press("Mark benefit verified…");
	expect(app.shows("Writes: 0")).toBe(true);
	await app.press("id:insights-confirm");
	await app.waitFor("Writes: 1");
});

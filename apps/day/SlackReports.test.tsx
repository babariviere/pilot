import { expect, open, test } from "nsh/test";
const desktop = { platform: "macos", width: 1100, height: 1600 } as const;

test("report fields keep author and evidenced reporter distinct; tackled is an explicit action", async () => {
	const app = await open("./SlackReportsFixture.tsx", desktop);
	await app.press("id:slack-report-report");
	for (const value of [
		"Client organization",
		"Northwind",
		"Slack author",
		"Maya Chen",
		"Original reporter",
		"Alex Morgan",
		"Issue",
	])
		expect(app.shows(value)).toBe(true);
	expect(app.shows("Sends: 0")).toBe(true);
	await app.press("id:slack-tackle-report");
	await app.press("Show tackled");
	await app.waitFor("Tackled by you");
	expect(app.shows("Sends: 1")).toBe(true);
	await app.press("id:slack-report-unknown");
	await app.waitFor("No original reporter identified in the saved evidence.");
	expect(app.shows("Not identified")).toBe(true);
});

test("unsent corrections survive reopen; stale drafts and unknown writes cannot send", async () => {
	const app = await open("./SlackReportsFixture.tsx", desktop);
	await app.press("id:slack-report-report");
	await app.press("Correct details…");
	await app.type("id:slack-edit-client", " updated");
	const value = app.value("id:slack-edit-client");
	await app.press("Save and reopen");
	expect(app.value("id:slack-edit-client")).toBe(value);
	expect(app.shows("Sends: 0")).toBe(true);
	await app.press("External edit");
	expect(app.enabled("id:slack-corrections-save")).toBe(false);
	await app.press("Cancel");
	await app.press("Lose reply");
	expect(app.enabled("id:slack-tackle-report")).toBe(false);
	await app.press("Check status");
	await app.waitFor("Receipt is still unknown. Nothing was resent.");
	expect(app.shows("Sends: 0")).toBe(true);
});

test("manual group rename stays separate from report status", async () => {
	const app = await open("./SlackReportsFixture.tsx", desktop);
	await app.press("Edit group…");
	await app.clear("id:slack-group-name");
	await app.type("id:slack-group-name", "Export download failures");
	await app.press("id:slack-group-save");
	await app.waitFor("Export download failures");
	expect(app.shows("Tackled by you")).toBe(false);
	expect(app.shows("Sends: 1")).toBe(true);
});

test("clearing both detail fields saves Not identified; invalid long drafts survive reopen", async () => {
	const app = await open("./SlackReportsFixture.tsx", desktop);
	await app.press("id:slack-report-report");
	await app.press("Correct details…");
	await app.clear("id:slack-edit-client");
	await app.type("id:slack-edit-client", "x".repeat(241));
	expect(app.enabled("id:slack-corrections-save")).toBe(false);
	await app.press("Save and reopen");
	expect(app.value("id:slack-edit-client")).toBe("x".repeat(241));
	await app.clear("id:slack-edit-client");
	await app.clear("id:slack-evidence-client");
	expect(app.enabled("id:slack-corrections-save")).toBe(true);
	await app.press("id:slack-corrections-save");
	await app.waitFor("No organization identified in the saved evidence.");
	expect(app.shows("Not identified")).toBe(true);
});

test("opening Start work sends nothing; explicit Start does not mark tackled", async () => {
	const app = await open("./SlackReportsFixture.tsx", desktop);
	await app.press("id:slack-report-report");
	await app.press("id:start-report");
	expect(app.shows("Starts: 0")).toBe(true);
	await app.press("id:confirm-start-report");
	await app.waitFor("Work started");
	expect(app.shows("Starts: 1")).toBe(true);
	expect(app.shows("Tackled by you")).toBe(false);
	expect(app.shows("Sends: 0")).toBe(true);
});

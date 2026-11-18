import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1800 } as const;
const link = "https://example.slack.com/archives/COTHER/p1794843000000001";

test("Slack settings disclose gaps, catch-up and delays; opening only reads", async () => {
	const app = await open("./SlackSettingsFixture.tsx", desktop);
	await app.waitFor("id:slack-settings");
	expect(app.shows("Catching up. More messages remain.")).toBe(true);
	expect(app.texts().some((t) => t.includes("Mentions found only in replies are not discovered automatically"))).toBe(
		true,
	);
	await app.press("Toggle Settings");
	await app.press("Toggle Settings");
	expect(app.shows("Sends: 0, reads: 2, checks: 0, imports: 0")).toBe(true);
	await app.press("Rate limit");
	expect(app.shows("Delayed. Slack rate limit")).toBe(true);
	expect(app.texts().some((t) => t.includes("Next read no earlier than"))).toBe(true);
	await app.press("Unavailable");
	expect(app.shows("Slack settings are unavailable. Pilot keeps trying; nothing has been changed.")).toBe(true);
});
test("imports remain available when tracking stops and do not add channels", async () => {
	const app = await open("./SlackSettingsFixture.tsx", desktop);
	await app.clear("id:slack-channels");
	await app.press("id:slack-save");
	await app.waitFor("Tracking off. Saved and imported messages stay available.");
	await app.type("id:slack-url", link);
	await app.press("id:slack-import");
	await app.waitFor("Message saved to Today. No channel was added.");
	expect(app.value("id:slack-channels")).toBe("");
	expect(app.value("id:slack-url")).toBe("");
	expect(app.shows("Sends: 2, reads: 1, checks: 0, imports: 1")).toBe(true);
});
test("drafts survive close and restore; stale project edits need fresh confirmation", async () => {
	const app = await open("./SlackSettingsFixture.tsx", desktop);
	await app.type("id:slack-url", link);
	await app.press("Restore draft");
	await app.press("Toggle Settings");
	await app.press("Toggle Settings");
	expect(app.value("id:slack-url")).toBe(link);
	await app.press("External change");
	expect(app.enabled("id:slack-import")).toBe(false);
	await app.press("Fixture read");
	await app.press("Keep my draft");
	await app.press("Other project");
	expect(app.shows("Your draft belongs to another project. It has not moved.")).toBe(true);
	expect(app.shows("Sends: 0, reads: 3, checks: 0, imports: 0")).toBe(true);
});
test("uncertain imports permit lookup only and preserve the unsent link", async () => {
	const app = await open("./SlackSettingsFixture.tsx", desktop);
	await app.type("id:slack-url", link);
	await app.press("Lose reply");
	await app.press("id:slack-import");
	await app.waitFor("id:slack-receipt");
	expect(app.enabled("id:slack-import")).toBe(false);
	expect(app.enabled("id:slack-save")).toBe(false);
	expect(app.value("id:slack-url")).toBe(link);
	await app.press("id:slack-receipt");
	expect(app.shows("Sends: 1, reads: 1, checks: 1, imports: 0")).toBe(true);
	await app.press("id:slack-set-aside");
	expect(app.shows("Sends: 1, reads: 1, checks: 2, imports: 0")).toBe(true);
	expect(app.enabled("id:slack-save")).toBe(true);
	expect(app.value("id:slack-url")).toBe(link);
});
test("delayed acknowledgements preserve later edits; unsafe links never enter saved drafts", async () => {
	const app = await open("./SlackSettingsFixture.tsx", desktop);
	await app.type("id:slack-url", `${link}?token=secret`);
	expect(app.enabled("id:slack-import")).toBe(false);
	await app.press("Restore draft");
	expect(app.value("id:slack-url")).toBe("");
	await app.press("Delay write");
	await app.press("id:slack-save");
	expect(app.enabled("id:slack-save")).toBe(false);
	await app.clear("id:slack-channels");
	await app.type("id:slack-channels", "CNEW");
	await app.press("Finish write");
	expect(app.value("id:slack-channels")).toBe("CNEW");
	expect(app.enabled("id:slack-save")).toBe(false);
});

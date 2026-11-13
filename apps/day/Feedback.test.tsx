// The feedback page on a scripted source (FeedbackFixture.tsx). No daemon,
// provider or storage. Headless: not native appearance, focus or IME.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1600 } as const;

async function feedback() {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-text");
	return app;
}

const counts = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Sends:"));

test("the header opens Feedback about Pilot in general; opening sends nothing and Send waits for words", async () => {
	const app = await feedback();
	expect(app.shows("Pilot in general")).toBe(true);
	expect(app.shows("id:feedback-empty")).toBe(true);
	expect(app.enabled("id:feedback-send")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await app.keyboard.press("escape");
	await app.waitFor("id:feedback-open");
	expect(app.shows("id:feedback")).toBe(false);
});

test("Send saves the words once and lists them; only the accepted receipt clears the draft", async () => {
	const app = await feedback();
	await app.type("id:feedback-text", "The plan page hides who is working 日本語 ✓");
	await app.waitUntil(() => app.enabled("id:feedback-send"));
	await app.press("id:feedback-send");
	await app.waitFor("Saved. Thank you.");
	expect(app.value("id:feedback-text")).toBe("");
	expect(app.shows("The plan page hides who is working 日本語 ✓")).toBe(true);
	expect(app.texts().some((t) => t.startsWith("Saved · ") && t.endsWith("Pilot in general"))).toBe(true);
	expect(app.shows("id:feedback-empty")).toBe(false);
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("a refused Send keeps the words; a lost one stays Unknown until Check reads it, never resent", async () => {
	const app = await feedback();
	await app.press("Next reject");
	await app.type("id:feedback-text", "Search is slow");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-message");
	expect(app.value("id:feedback-text")).toBe("Search is slow");
	await app.press("Next unknown");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-unknown");
	expect(app.value("id:feedback-text")).toBe("Search is slow");
	expect(app.enabled("id:feedback-send")).toBe(false);
	expect(app.shows("Check your earlier feedback first. Your text stays.")).toBe(true);
	await app.press("id:feedback-check");
	await app.waitFor("Your feedback was saved.");
	expect(app.shows("id:feedback-unknown")).toBe(false);
	expect(app.value("id:feedback-text")).toBe("");
	expect(counts(app)).toBe("Sends: 2 · Checks: 1");
});

test("from a mission the feedback names it; words keep their own context, and Back returns to the mission", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:mission-search");
	await app.waitFor("id:mission-feedback");
	await app.press("id:mission-feedback");
	await app.waitFor("id:feedback-text");
	expect(app.shows("“Faster search”")).toBe(true);
	await app.type("id:feedback-text", "Reports here are hard to scan");
	await app.press("id:back");
	await app.waitFor("id:mission-feedback");
	// Opening from the header does not move words about a mission to Pilot in general.
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-offer");
	expect(app.shows("“Faster search”")).toBe(true);
	await app.press("id:feedback-offer-keep");
	await app.waitUntil(() => !app.shows("id:feedback-offer"));
	await app.press("id:feedback-send");
	await app.waitFor("Saved. Thank you.");
	expect(app.texts().some((t) => t.endsWith("About “Mission search”"))).toBe(true);
	await app.press("id:feedback-general");
	await app.waitFor("Pilot in general");
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("unsent words and their mission come back after a close or update, sending nothing", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:mission-search");
	await app.press("id:mission-feedback");
	await app.waitFor("id:feedback-text");
	await app.type("id:feedback-text", "Kept 👩🏽‍💻\nsecond line");
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-text");
	expect(app.value("id:feedback-text")).toBe("Kept 👩🏽‍💻\nsecond line");
	expect(app.shows("“Faster search”")).toBe(true);
	expect(app.shows("Kept: [mission/search\nKept 👩🏽‍💻\nsecond line]")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("an unreadable list is not shown as empty; older feedback reads a page at a time", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("Many saved");
	await app.press("id:feedback-open");
	await app.waitFor("Older note 5");
	expect(app.shows("Older note 3")).toBe(false);
	await app.press("id:feedback-more");
	await app.waitFor("Older note 3");
	await app.press("id:back");
	await app.press("Unreadable");
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-off");
	expect(app.shows("This is not the same as having none.")).toBe(true);
	expect(app.shows("id:feedback-empty")).toBe(false);
});

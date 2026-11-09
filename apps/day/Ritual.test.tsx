// The start and end of the day and the standup notes, as a user takes
// them: first use, a returning day, a skipped ritual, a read that is not
// live, and days with nothing waiting. Rituals only read Today: skipping,
// leaving or closing one answers, approves and sends nothing.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 900 } as const;

test("first use: nothing to catch up on, and the day starts from Today", async () => {
	const app = await open("./FirstUse.tsx", desktop);
	await app.waitFor("id:start-day");
	await app.press("id:start-day");
	await app.waitFor("This is your first look, so there is nothing to catch up on yet.");
	expect(app.shows("Step 1 of 3 · Since you looked")).toBe(true);
	expect(app.shows("Welcome to Pilot.")).toBe(true);
	expect(app.shows("id:results")).toBe(false);
	expect(app.shows("id:left-off")).toBe(false);
	await app.press("role:button[Next]");
	await app.waitFor("Nothing needs you.");
	expect(app.shows("role:button[Decide now]")).toBe(false);
	await app.press("role:button[Next]");
	await app.waitFor("Step 3 of 3 · Coming up today");
	expect(app.shows("No report yet. One chat working.")).toBe(true);
	expect(app.shows("Scheduled")).toBe(false);
	await app.press("role:button[Start the day]");
	await app.waitFor("id:standup");
	expect(app.shows("id:start-day")).toBe(false);
	expect(app.shows("Nothing needs you. Pilot keeps going on its own.")).toBe(true);
});

test("a returning day catches up, keeps where the user left off and what each result rests on", async () => {
	const app = await open("./Quiet.tsx", desktop);
	await app.press("id:start-day");
	await app.waitFor("Good morning.");
	for (const text of [
		"Here is what happened since you looked yesterday at 19:05.",
		"You were reading the history slice in Native desktop app.",
		"Tidy shell setup · Accepted",
		"Native desktop app · Landed",
		"Faster search · Agent report",
		"Agent reports are the agents' own words. Pilot has not checked them.",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	await app.keyboard.press("mod+enter");
	await app.waitFor("Nothing needs you.");
	await app.keyboard.press("mod+enter");
	await app.waitFor("Step 3 of 3 · Coming up today");
	for (const text of [
		"Next: Compare light and dark captures.",
		"Agent report · 6 min ago",
		"Report unavailable",
		"Report could not be checked",
		"Re-run the search benchmark",
		"Nightly 02:00",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	await app.keyboard.press("mod+enter");
	await app.waitFor("Nothing needs you. Pilot keeps going on its own.");
	expect(app.shows("id:start-day")).toBe(false);
});

test("a skipped start of day leaves every decision waiting and is not offered again", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:start-day");
	await app.press("role:button[Next]");
	await app.waitFor("Three things need you.");
	for (const text of [
		"How should finished work reach you?",
		"Open a test copy of Pilot on your Mac?",
		"Review: History slice",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	await app.press("role:button[Skip for today]");
	await app.waitFor("Three short things need you.");
	expect(app.shows("1 of 3")).toBe(true);
	expect(app.shows("has your answer")).toBe(false);
	expect(app.shows("id:start-day")).toBe(false);
	expect(app.shows("id:standup")).toBe(true);
});

test("Escape leaves a ritual unmarked, and Decide now only brings the first decision forward", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:start-day");
	await app.waitFor("Good morning.");
	await app.keyboard.press("escape");
	await app.waitFor("Three short things need you.");
	expect(app.shows("id:start-day")).toBe(true);
	await app.press("id:start-day");
	await app.keyboard.press("mod+enter");
	await app.waitFor("Three things need you.");
	await app.press("role:button[Decide now]");
	await app.waitFor("1 of 3");
	expect(app.shows("id:decision")).toBe(true);
	expect(app.shows("Sending your answer…")).toBe(false);
	expect(app.shows("has your answer")).toBe(false);
	expect(app.shows("id:start-day")).toBe(false);
});

test("a read that is not live says so in the ritual and in the standup notes", async () => {
	const app = await open("./Offline.tsx", desktop);
	const offline = "Offline. Pilot's service is not answering. Showing what Pilot read 6 min ago.";
	await app.press("id:start-day");
	await app.waitFor(offline);
	await app.keyboard.press("escape");
	await app.press("id:standup");
	await app.waitFor("id:standup-notes");
	expect(app.shows(offline)).toBe(true);
	await app.keyboard.press("escape");
	await app.waitFor("Three short things need you.");
});

test("the end of the day keeps unconfirmed and old reports as they are, and tomorrow starts where it waits", async () => {
	const app = await open("./Trouble.tsx", desktop);
	await app.press("id:end-day");
	await app.waitFor("Wrapping up.");
	for (const text of [
		"Two results since you looked at 13:30. Two things still wait for you.",
		"They stay on Today until you answer them.",
		"2 integration tests fail on Linux",
		"Image zoom and pan finished. Its push is not confirmed yet.",
		"Old coordinator report · yesterday",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	await app.press("role:button[Close the day]");
	await app.waitFor("Done for today.");
	expect(app.shows("Tomorrow starts with: 2 integration tests fail on Linux.")).toBe(true);
	await app.press("id:closed-today");
	await app.waitFor("One check failed. One push is unconfirmed.");
	expect(app.shows("id:end-day")).toBe(false);
	expect(app.shows("1 of 2")).toBe(true);
});

test("an evening with nothing waiting closes calmly with where the user left off", async () => {
	const app = await open("./Evening.tsx", desktop);
	expect(app.shows("id:start-day")).toBe(false);
	await app.press("id:end-day");
	await app.waitFor("Three results since you looked at 13:30. Nothing waits for you.");
	expect(app.shows("Still waiting")).toBe(false);
	expect(app.shows("Keeps moving")).toBe(true);
	await app.keyboard.press("mod+enter");
	await app.waitFor("Done for today.");
	expect(app.shows("Where you left off: You were reading the search benchmark in Faster search.")).toBe(true);
	await app.keyboard.press("mod+enter");
	await app.waitFor("Nothing needs you. Pilot keeps going on its own.");
	expect(app.shows("id:end-day")).toBe(false);
});

test("standup notes say what is done, next and waiting, each with its source", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:standup");
	await app.waitFor("id:standup-notes");
	for (const text of [
		"- Tidy shell setup finished. Shell starts in 84 ms, was 310 ms. (accepted, Tidy shell setup)",
		"- Older messages now load while a reply streams. (landed, Native desktop app)",
		"- Search index rebuilds 4x faster. Median search is 150 ms. (agent report, Faster search)",
		"- Faster search: Fix anything that fails, then open the release pull request. (agent report, 12 min ago)",
		"- Quieter notifications: How should finished work reach you? (needs my decision)",
		"- Docs refresh: no report yet",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	await app.press("role:button[Back to Today]");
	await app.waitFor("Three short things need you.");
});

test("a first look has nothing done yet in the standup notes", async () => {
	const app = await open("./FirstUse.tsx", desktop);
	await app.press("id:standup");
	await app.waitFor("id:standup-notes");
	expect(app.shows("- Nothing")).toBe(true);
	expect(app.shows("- Native desktop app: no report yet")).toBe(true);
});

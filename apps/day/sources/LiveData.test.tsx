// Live data: a background read never moves the user's place, focus or words,
// and the one old-data rule (freshness.ts). Headless, on LiveDataFixture.tsx.
import { expect, open, test } from "nsh/test";
import { retryDelay, STALE_AFTER_MS, staleWarning } from "./freshness";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;
const NOTES = [
	"Reading mission changes. Showing the earlier read.",
	"Reading changes. Showing the earlier attention read.",
	"What needs you is not current. Pilot must read it again.",
	"Attention read is not current.",
	"Attention read is up to date.",
	"Mission read is up to date.",
];
const warned = (app: { texts(): string[] }) => app.texts().some((t) => t.startsWith("Not updated since"));

test("the old-data rule needs both: older than 5 minutes and 3 failed tries", () => {
	const at = 1_000_000;
	expect(staleWarning({ readAt: at, failures: 3 }, at + STALE_AFTER_MS)).toBe(false);
	expect(staleWarning({ readAt: at, failures: 2 }, at + STALE_AFTER_MS + 60_000)).toBe(false);
	expect(staleWarning({ readAt: at, failures: 3 }, at + STALE_AFTER_MS + 1)).toBe(true);
	// Never read is unavailable, not old.
	expect(staleWarning({ readAt: null, failures: 9 }, at * 2)).toBe(false);
	expect([retryDelay(0), retryDelay(1), retryDelay(2), retryDelay(30)]).toEqual([2000, 4000, 8000, 60_000]);
});

// Headless keys cannot move the caret or select (NSH 0.5), so the caret is checked at the end of the text only.
test("a refresh of the same question, and one with unrelated changes, keep the card, the field's focus and text, with no note", async () => {
	const app = await open("../LiveDataFixture.tsx", desktop);
	await app.waitFor("id:reply");
	await app.press("Mark card");
	await app.type("id:reply", "abc");
	// Reads arrive by shortcut, so nothing takes the focus to deliver them.
	await app.keyboard.press("mod+shift+1");
	await app.keyboard.press("mod+shift+2");
	// The same field still has the focus, with the caret where it was: a field built again would have neither.
	await app.keyboard.press("x");
	expect(app.value("id:reply")).toBe("abcx");
	// The question in front stays in front; the new arrival waits behind it.
	expect(app.shows("id:decision >> text:Which package should go to the store?")).toBe(true);
	expect(app.shows("id:decision >> text:A new question arrived")).toBe(false);
	for (const note of NOTES) expect(app.shows(note)).toBe(false);
	expect(app.shows("id:freshness")).toBe(false);
	await app.press("Check card");
	await app.waitFor("Card kept");
});

test("old data alone, or failed tries alone, never warn; both do, and a good read clears it", async () => {
	const app = await open("../LiveDataFixture.tsx", desktop);
	await app.waitFor("id:reply");
	// Older than 5 minutes, but no try failed.
	await app.press("Six minutes pass");
	expect(app.shows("id:freshness")).toBe(false);
	// Two failed tries: still no warning.
	await app.press("Automatic try");
	await app.press("Automatic try");
	expect(app.shows("id:freshness")).toBe(false);
	// The third: the data is old and 3 tries failed.
	await app.press("Automatic try");
	await app.waitFor("id:freshness");
	expect(warned(app)).toBe(true);
	// The question stays, answerable, under the warning.
	expect(app.shows("id:reply")).toBe(true);
	await app.press("Reads work");
	await app.press("id:freshness-try");
	await app.waitUntil(() => !app.shows("id:freshness"));
	expect(warned(app)).toBe(false);
});

test("three failed tries on fresh data warn only once the data is 5 minutes old", async () => {
	const app = await open("../LiveDataFixture.tsx", desktop);
	await app.waitFor("id:reply");
	await app.press("Automatic try");
	await app.press("Automatic try");
	await app.press("Automatic try");
	expect(app.shows("id:freshness")).toBe(false);
	await app.press("Six minutes pass");
	await app.waitFor("id:freshness");
	expect(warned(app)).toBe(true);
});

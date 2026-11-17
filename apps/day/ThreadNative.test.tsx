// Captures and real input for a thread's conversation: run with
// `apps/day/nsh.sh test ThreadNative.test.tsx --target macos`. Headless runs draw nothing, so the captures only
// mean something on a target. No input method composes here: IME stays a manual check.
import { expect, open, test } from "nsh/test";

const counts = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Writes:"));

async function thread() {
	const app = await open("./ThreadFixture.tsx", { platform: "macos", width: 1100, height: 1000 });
	await app.press("id:mission-search");
	await app.press("id:mission-section-discussions");
	await app.press("id:thread-search-scope");
	await app.waitFor("id:message-s-coordinator:11");
	return app;
}

test("earlier messages keep the message read before in view; hiding the activity keeps its button; captured", async () => {
	const app = await thread();
	await app.screenshot("output/thread-1-before-earlier.png");
	await app.press("Where");
	await app.waitFor("Scroll: 0");
	await app.press("id:thread-earlier-messages");
	await app.waitUntil(() => !app.shows("Reading…"));
	await app.wait(300);
	await app.screenshot("output/thread-2-after-earlier.png");
	await app.press("Where");
	await app.waitUntil(() => app.texts().some((t) => /^Scroll: [1-9]/.test(t)));
	expect(app.shows("id:message-s-coordinator:11")).toBe(true);
	await app.type("id:thread-reply", "Keep me");
	await app.press("id:thread-activity-toggle");
	await app.waitFor("id:thread-history");
	await app.press("id:thread-earlier");
	await app.wait(300);
	await app.scroll("id:thread", 4000);
	await app.screenshot("output/thread-3-activity-scrolled.png");
	await app.press("label:Hide the activity below this conversation. Your words stay.");
	await app.waitUntil(() => !app.shows("id:thread-history"));
	await app.wait(300);
	await app.screenshot("output/thread-4-after-hide.png");
	expect(app.shows("id:thread-activity-toggle")).toBe(true);
	expect(app.value("id:thread-reply")).toBe("Keep me");
});

test("a live update that removes old words above the screen keeps the message being read in place; captured", async () => {
	const app = await thread();
	await app.press("Old words unplaced");
	await app.waitFor("id:thread-unplaced");
	// Read on past the section to the middle, away from the end where the scroll view would clamp anyway; the
	// kept scroll offset says where the reader is.
	await app.scroll("id:thread", 1000);
	await app.wait(500);
	await app.press("Where");
	const at = (): number =>
		Number(
			app
				.texts()
				.find((t) => t.startsWith("Scroll: "))
				?.slice(8),
		);
	await app.waitUntil(() => at() > 0);
	const before = at();
	const point = (n: number) => {
		const text = app.texts().find((t) => t.startsWith(`Anchor ${n}: `)) ?? "";
		const [, key, y] = /^Anchor \d+: (\S+) (-?\d+)$/.exec(text) ?? [];
		return { key, y: Number(y) };
	};
	await app.waitUntil(() => point(1).key !== undefined);
	const beforePoint = point(1);
	expect(beforePoint.key).toBe("s-coordinator:15");
	expect(beforePoint.y).toBeLessThan(0);
	await app.screenshot("output/thread-7-before-live-removal.png");
	await app.press("Old words placed");
	await app.press("Reply links learned");
	await app.waitUntil(() => !app.shows("id:thread-unplaced"));
	await app.wait(500);
	await app.screenshot("output/thread-8-after-live-removal.png");
	await app.press("Where");
	await app.waitUntil(() => at() !== before);
	await app.waitUntil(() => point(2).key !== undefined);
	expect(point(2).key).toBe(beforePoint.key);
	expect(Math.abs(point(2).y - beforePoint.y)).toBeLessThanOrEqual(1);
	// Scrolled back by what went away above, so the message read before stays where it was.
	expect(before - at()).toBeGreaterThan(300);
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("keyboard: Tab reaches Send, Return and ⌘↩ each send once, Escape keeps words; captured", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "Sent by keyboard");
	await app.keyboard.press("tab");
	await app.wait(200);
	await app.screenshot("output/thread-5-tab-focus.png");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
	await app.keyboard.press("enter");
	await app.waitFor("Sent. The thread chat has your message; its answer shows here when it writes one.");
	expect(app.value("id:thread-reply")).toBe("");
	expect(counts(app)).toBe("Writes: 1 · Sends: 1 · Checks: 0");
	await app.type("id:thread-reply", "Sent with shortcut");
	await app.keyboard.press("mod+enter");
	await app.waitUntil(() => counts(app) === "Writes: 2 · Sends: 2 · Checks: 0");
	await app.type("id:thread-reply", "Kept words");
	await app.keyboard.press("escape");
	await app.waitFor("id:mission-threads");
	await app.press("id:thread-search-scope");
	await app.waitFor("id:thread-reply");
	expect(app.value("id:thread-reply")).toBe("Kept words");
	await app.screenshot("output/thread-6-back-kept.png");
	expect(counts(app)).toBe("Writes: 2 · Sends: 2 · Checks: 0");
});

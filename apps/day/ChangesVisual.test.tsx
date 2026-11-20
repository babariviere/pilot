// Mock data, native visual evidence only: Changes, Review code and a chat's Live changes on the new parts
// (ui/README.md), in light and dark, wide and narrow. Run with `nsh test ChangesVisual.test.tsx --target macos`;
// headless runs draw nothing.
import { open, test } from "nsh/test";

// Dark captures fit the screen: a taller window leaves its lower part unpainted.
const SIZES = [
	["light", 1100],
	["dark", 1100],
	["light", 480],
	["dark", 480],
] as const;

const HISTORY_SLICE = "role:button[Review: History slice, Waiting for your review. Reopen the kept change.]";

test("Changes: the list and one kept snapshot, in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("./Changes.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("id:changes-panel");
		await app.wait(500);
		await app.screenshot(`output/changes-parts-list-${colorScheme}-${width}.png`);
		await app.press(HISTORY_SLICE);
		await app.waitFor("id:diff");
		await app.wait(500);
		await app.screenshot(`output/changes-parts-change-${colorScheme}-${width}.png`);
	}
});

test("Changes: a kept snapshot's history", async () => {
	const app = await open("./Changes.tsx", { platform: "macos", width: 1100, height: 900, colorScheme: "light" });
	await app.press(HISTORY_SLICE);
	await app.waitFor("id:diff");
	await app.press("role:tab[History]");
	await app.press("role:button[Snapshot details]");
	await app.wait(500);
	await app.screenshot("output/changes-parts-history-light-1100.png");
});

test("Review code, in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("./ResultReviewFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("id:review-code");
		await app.wait(300);
		await app.screenshot(`output/code-review-parts-row-${colorScheme}-${width}.png`);
		await app.press("id:review-code");
		await app.waitFor("modified · 1 of 3 · J K next file");
		await app.wait(500);
		await app.screenshot(`output/code-review-parts-${colorScheme}-${width}.png`);
	}
});

test("a chat's Live changes, in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("./LiveChangesFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.press("id:chat-live-changes-toggle");
		await app.press("Finish clipped");
		await app.waitFor("id:chat-live-changes-diff");
		await app.wait(500);
		await app.screenshot(`output/live-changes-parts-${colorScheme}-${width}.png`);
	}
});

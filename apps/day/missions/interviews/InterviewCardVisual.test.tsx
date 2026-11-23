// Mock data, native visual evidence only. Run with --target macos.
import { open, test } from "nsh/test";

test("standalone interview mock in light and dark", async () => {
	for (const colorScheme of ["light", "dark"] as const) {
		const app = await open("../../InterviewCardFixture.tsx", {
			platform: "macos",
			width: 1000,
			height: 1200,
			colorScheme,
		});
		await app.waitFor("id:interview-card");
		await app.wait(300);
		await app.screenshot(`output/interview-round-${colorScheme}.png`);
		await app.press("id:choice-outcome-drafts");
		await app.press("id:next");
		await app.press("id:own-authority");
		await app.type("id:answer-authority", "I approve after reviewing the changes.");
		await app.keyboard.press("mod+enter");
		await app.wait(300);
		await app.screenshot(`output/interview-review-${colorScheme}.png`);
	}
});

test("other project interview draft conflict", async () => {
	for (const [colorScheme, width] of [
		["light", 1100],
		["dark", 1100],
		["light", 480],
		["dark", 480],
	] as const) {
		const app = await open("../../InterviewCardFixture.tsx", { platform: "macos", width, height: 850, colorScheme });
		await app.press("Save in another window on next edit");
		await app.press("id:own-outcome");
		await app.type("id:answer-outcome", "Keep my edits while I check the saved answers.");
		await app.waitFor("Not saved. Another window saved this draft. Your edits are kept here.");
		await app.screenshot(`output/interview-draft-conflict-${colorScheme}-${width}.png`);
	}
});

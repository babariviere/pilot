// Real NSH input and captures of the shipped screen, with fixture data.
import { expect, open, test } from "nsh/test";

test("Slack reports native fields and corrections captured", async () => {
	const app = await open("../../SlackReportsFixture.tsx", { platform: "macos", width: 1000, height: 760 });
	await app.press("id:slack-report-report");
	await app.waitFor("Original reporter");
	await app.scroll("id:slack-report-list", 90);
	await app.screenshot("output/slack-reports-fields.png");
	await app.press("Correct details…");
	await app.type("id:slack-edit-client", " corrected");
	await app.scroll("id:slack-report-list", -10000);
	await app.scroll("id:slack-report-list", 400);
	await app.screenshot("output/slack-reports-corrections.png");
	await app.scroll("id:slack-report-list", 320);
	await app.screenshot("output/slack-reports-corrections-evidence.png");
	await app.keyboard.press("escape");
	expect(app.shows("Save corrections")).toBe(false);
	await app.press("id:slack-tackle-report");
	await app.press("Show tackled");
	await app.waitFor("Tackled by you");
});

const LOOKS = [
	["light", 1100],
	["dark", 1100],
	["light", 480],
	["dark", 480],
] as const;

test("Slack reports on the parts in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of LOOKS) {
		// Dark captures fit the screen: a taller window leaves its lower part unpainted.
		const app = await open("../../SlackReportsFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.press("id:slack-report-report");
		await app.waitFor("Original reporter");
		await app.wait(500);
		await app.screenshot(`output/feeds-slack-${colorScheme}-${width}.png`);
	}
});

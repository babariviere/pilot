import { open, test } from "nsh/test";

test("capture the native Insights workspace", async () => {
	const app = await open("../InsightsCaptureFixture.tsx", { platform: "macos", width: 960, height: 1050 });
	await app.waitFor("Partial coverage");
	await app.screenshot("output/insights-reports.png");
	await app.press("id:insights-findings");
	await app.press("id:insights-item-checks");
	await app.waitFor("Reopen three releases.");
	await app.screenshot("output/insights-findings.png");
	await app.press("id:insights-settings");
	await app.press("id:insights-review");
	await app.waitFor("Applying settings will not resume Insights.");
	await app.screenshot("output/insights-settings.png");
});

const LOOKS = [
	["light", 1100],
	["dark", 1100],
	["light", 480],
	["dark", 480],
] as const;

test("Insights on the parts in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of LOOKS) {
		// Dark captures fit the screen: a taller window leaves its lower part unpainted.
		const app = await open("../InsightsCaptureFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("Partial coverage");
		await app.wait(500);
		await app.screenshot(`output/feeds-insights-${colorScheme}-${width}.png`);
		await app.press("id:insights-settings");
		await app.wait(300);
		await app.screenshot(`output/feeds-insights-settings-${colorScheme}-${width}.png`);
	}
});

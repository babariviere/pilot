import { open, test } from "nsh/test";

test("capture the native Insights workspace", async () => {
	const app = await open("./InsightsCaptureFixture.tsx", { platform: "macos", width: 960, height: 1050 });
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

// Real native renderer/input, synthetic data. Also used by before-after.sh.
import { expect, open, test } from "nsh/test";

test("capture recovery and its blocked final archive", async () => {
	const app = await open("./RecoveryFixture.tsx", { platform: "macos", width: 1000, height: 900 });
	await app.waitFor("Fix invoice export");
	await app.screenshot("output/chat-recovery.png");
	// The same fixture renders the old, passive failed chat for Before.
	if (!app.shows("id:chat-retry")) {
		await app.screenshot("output/chat-correction.png");
		return;
	}
	await app.press("id:chat-correct");
	await app.type("id:chat-recovery-note", "Keep the original files. Fix only CSV export.");
	await app.screenshot("output/chat-correction.png");
	await app.press("id:chat-recovery-send");
	await app.waitFor("Working.");
	expect(app.shows("Sends: 1 / Checks: 0")).toBe(true);
});

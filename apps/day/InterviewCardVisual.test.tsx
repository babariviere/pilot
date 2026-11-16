// Mock data, native visual evidence only. Run with --target macos.
import { open, test } from "nsh/test";

test("standalone interview mock in light and dark", async () => {
	for (const colorScheme of ["light", "dark"] as const) {
		const app = await open("./InterviewCardFixture.tsx", {
			platform: "macos",
			width: 1000,
			height: 1200,
			colorScheme,
		});
		await app.waitFor("id:interview-card");
		await app.wait(300);
		await app.screenshot(`output/interview-round-${colorScheme}.png`);
		await app.press("id:interview-option-outcome-drafts");
		await app.type("id:interview-text-authority", "I approve after reviewing the changes.");
		await app.press("id:interview-review");
		await app.wait(300);
		await app.screenshot(`output/interview-review-${colorScheme}.png`);
	}
});

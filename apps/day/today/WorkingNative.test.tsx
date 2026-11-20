// Real platform inputs and captures of production views over isolated fixture data.
// Run with --target macos (and later --target linux on physical KDE Wayland).

import { platform } from "nsh";
import { expect, open, test } from "nsh/test";

const nativePlatform = platform.os === "linux" ? "linux" : "macos";

for (const colorScheme of ["light", "dark"] as const) {
	test(`working Today pair ${colorScheme}`, async () => {
		const app = await open("../WorkingFixture.tsx", {
			platform: nativePlatform,
			width: 1100,
			height: 900,
			colorScheme,
		});
		await app.waitFor("Release newer");
		await app.press("Release newer");
		await app.waitFor("id:decision");
		await app.scroll("id:decision", 1200);
		await app.wait(300);
		await app.screenshot(`output/working-today-${colorScheme}.png`);
		await app.press("id:working-open-mission-agent");
		await app.waitFor("Exact chat mission-agent");
		await app.keyboard.press("escape");
		await app.waitFor("id:working-open-mission-agent");
		// Back puts focus on the exact opener, and Return opens that same chat again.
		await app.keyboard.press("enter");
		await app.waitFor("Exact chat mission-agent");
	});
}

test("working activity does not steal native input focus", async () => {
	const app = await open("../WorkingFixture.tsx", { platform: nativePlatform, width: 1100, height: 900 });
	await app.press("Release newer");
	await app.waitFor("id:working-mission-agent");
	await app.press("Ask a question");
	await app.type("id:question", "Native draft");
	await app.keyboard.press("mod+shift+u");
	await app.waitFor("pilot · Daily work · Updated task");
	await app.keyboard.press("x");
	expect(app.value("id:question")).toBe("Native draftx");
	expect(app.shows("label:Open chat “Native activity” in pilot")).toBe(true);
});

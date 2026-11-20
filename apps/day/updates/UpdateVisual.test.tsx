// Mock data, native visual evidence only: the update page on the parts, in light and dark, wide and narrow, with an
// update ready and while one runs. Run with `nsh test UpdateVisual.test.tsx --target macos`; headless runs draw
// nothing.
import { open, test } from "nsh/test";

const LOOKS = [
	["light", 1100],
	["dark", 1100],
	["light", 480],
	["dark", 480],
] as const;

test("the update page in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of LOOKS) {
		// Dark captures fit the screen: a taller window leaves its lower part unpainted.
		const app = await open("../Update.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("role:button[Update ready]");
		await app.press("role:button[Update ready]");
		await app.waitFor("Pilot 0.9.3 is ready for this app and Pilot's service");
		await app.wait(500);
		await app.screenshot(`output/feeds-update-${colorScheme}-${width}.png`);
		await app.press("id:update-prepare");
		await app.waitFor("id:update-confirm");
		await app.wait(300);
		await app.screenshot(`output/feeds-update-confirm-${colorScheme}-${width}.png`);
	}
});

test("the service status without update packages", async () => {
	const app = await open("../UpdateServiceStatusFixture.tsx", { platform: "macos", width: 1100, height: 900 });
	await app.waitFor("Pilot's service is running");
	await app.wait(500);
	await app.screenshot("output/feeds-update-status-light-1100.png");
});

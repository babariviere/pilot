// Mock data, native visual evidence only: Today on the new parts (ui/README.md), in light and dark, wide and
// narrow, on a quiet day and offline. Run with `nsh test TodayVisual.test.tsx --target macos`; headless runs draw
// nothing.
import { open, test } from "nsh/test";

test("Today in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of [
		["light", 1100],
		["dark", 1100],
		["light", 480],
		["dark", 480],
	] as const) {
		// Dark captures fit the screen: a taller window leaves its lower part unpainted.
		const app = await open("./MockApp.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("id:today-panel");
		await app.wait(500);
		await app.screenshot(`output/today-parts-${colorScheme}-${width}.png`);
	}
});

test("Today's tabs filter the panel", async () => {
	const app = await open("./MockApp.tsx", { platform: "macos", width: 1100, height: 900, colorScheme: "light" });
	await app.waitFor("id:today-panel");
	for (const tab of ["needs", "new", "working", "missions"]) {
		await app.press(`id:today-tab-${tab}`);
		await app.wait(300);
		await app.screenshot(`output/today-parts-tab-${tab}-light-1100.png`);
	}
});

test("Today on a quiet day and offline", async () => {
	for (const colorScheme of ["light", "dark"] as const) {
		const quiet = await open("./Quiet.tsx", { platform: "macos", width: 1100, height: 900, colorScheme });
		await quiet.waitFor("Pilot keeps going on its own.");
		await quiet.wait(500);
		await quiet.screenshot(`output/today-parts-quiet-${colorScheme}-1100.png`);
	}
	const offline = await open("./Offline.tsx", { platform: "macos", width: 1100, height: 900, colorScheme: "light" });
	await offline.waitFor("id:today-panel");
	await offline.wait(500);
	await offline.screenshot("output/today-parts-offline-light-1100.png");
});

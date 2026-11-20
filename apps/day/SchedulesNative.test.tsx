// Real Day views with fixture data. Run only with an explicitly selected native target.
import { open, test } from "nsh/test";

test("scheduled work captures, Today and Settings", async () => {
	const today = await open("./MockApp.tsx", { platform: "macos", width: 1100, height: 1100 });
	await today.waitFor("id:settings-open");
	await today.wait(400);
	await today.screenshot("output/schedule-today.png");
	const settings = await open("./PreferencesFixture.tsx", { platform: "macos", width: 1100, height: 1100 });
	await settings.press("id:settings-open");
	await settings.waitFor("id:preference-p-small");
	await settings.wait(400);
	await settings.screenshot("output/schedule-settings.png");
});
test("scheduled work captures, new Schedules view and its history", async () => {
	const app = await open("./SchedulesFixture.tsx", { platform: "macos", width: 1100, height: 1100 });
	await app.press("id:schedule-details-row");
	await app.waitFor("Repair stopped: agent made no progress");
	await app.wait(400);
	await app.screenshot("output/schedules-history.png");
	await app.press("role:button[Edit…]");
	await app.waitFor("Edit schedule");
	await app.wait(400);
	await app.screenshot("output/schedules-editor.png");
});

const LOOKS = [
	["light", 1100],
	["dark", 1100],
	["light", 480],
	["dark", 480],
] as const;

test("Schedules on the parts in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of LOOKS) {
		// Dark captures fit the screen: a taller window leaves its lower part unpainted.
		const app = await open("./SchedulesFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.press("id:schedule-details-row");
		await app.waitFor("Repair stopped: agent made no progress");
		await app.wait(500);
		await app.screenshot(`output/feeds-schedules-${colorScheme}-${width}.png`);
		await app.press("role:button[Edit…]");
		await app.waitFor("Edit schedule");
		await app.wait(300);
		await app.screenshot(`output/feeds-schedules-editor-${colorScheme}-${width}.png`);
	}
});

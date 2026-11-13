// Captures and input on a real platform: run with
// `nsh test Native.test.tsx --target macos`. Headless runs draw nothing, so
// the captures only mean something on a target.
import { expect, open, test } from "nsh/test";

const DECIDE = "id:decision >> role:button[Decide]";

test("Today renders natively and takes pointer, keyboard and text input", async () => {
	const app = await open("./MockApp.tsx", { platform: "macos", width: 1100, height: 900 });
	await app.waitFor("Three short things need you.");
	await app.screenshot("output/today-light-1100.png");
	await app.press("Say it simpler");
	await app.press("Ask a question");
	await app.type("id:question", "What happens after 18:00? (日本語 ✓)");
	expect(app.value("id:question")).toBe("What happens after 18:00? (日本語 ✓)");
	await app.press("role:button[Ask]");
	await app.waitFor("What happens after 18:00? (日本語 ✓)");
	await app.press("Only failures and questions");
	await app.screenshot("output/today-help-1100.png");
	await app.press(DECIDE);
	await app.waitFor("Quieter notifications has your answer: Only failures and questions.");
	await app.screenshot("output/today-answered-1100.png");
});

test("Today in dark appearance", async () => {
	const app = await open("./MockApp.tsx", { platform: "macos", width: 1100, height: 900, colorScheme: "dark" });
	await app.waitFor("Three short things need you.");
	await app.screenshot("output/today-dark-1100.png");
});

test("keyboard triage on a real platform: focus, picks, help and a question draft", async () => {
	const app = await open("./MockApp.tsx", { platform: "macos", width: 1100, height: 900 });
	await app.waitFor("1 of 3");
	await app.keyboard.press("j");
	await app.waitFor("2 of 3");
	await app.keyboard.press("down");
	await app.screenshot("output/today-keys-focus-1100.png");
	await app.keyboard.press("k");
	await app.keyboard.press("v");
	await app.waitFor("id:visual");
	await app.keyboard.press("q");
	await app.keyboard.press("j");
	expect(app.value("id:question")).toBe("j");
	await app.keyboard.press("escape");
	await app.keyboard.press("j");
	await app.waitFor("2 of 3");
	await app.keyboard.press("k");
	expect(app.value("id:question")).toBe("j");
	await app.screenshot("output/today-keys-help-1100.png");
});

test("an action card in light, dark and a narrow window", async () => {
	for (const [colorScheme, width] of [
		["light", 1100],
		["dark", 1100],
		["light", 480],
	] as const) {
		const app = await open("./Actions.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.keyboard.press("j");
		await app.waitFor("id:action");
		await app.screenshot(`output/action-${colorScheme}-${width}.png`);
	}
});

test("Today in a narrow window", async () => {
	const app = await open("./Trouble.tsx", { platform: "macos", width: 480, height: 900 });
	await app.waitFor("2 integration tests fail on Linux");
	await app.screenshot("output/trouble-light-480.png");
});

test("Mission overview in light, dark and a narrow window", async () => {
	for (const [colorScheme, width] of [
		["light", 1100],
		["dark", 1100],
		["light", 480],
	] as const) {
		const app = await open("./Trouble.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("Paused. Nothing in it runs until you resume it.");
		await app.screenshot(`output/missions-${colorScheme}-${width}.png`);
		await app.press("id:mission-native");
		await app.press("role:button[Pause mission]");
		await app.press("id:pause >> role:button[Pause]");
		await app.waitFor("Pausing did not finish everywhere. Some work needs a look.");
		await app.screenshot(`output/mission-pausing-${colorScheme}-${width}.png`);
	}
});

test("Today offline and unreadable", async () => {
	const offline = await open("./Offline.tsx", { platform: "macos", width: 1100, height: 900 });
	await offline.waitFor("Offline. Pilot's service is not answering. Showing what Pilot read 6 min ago.");
	await offline.screenshot("output/today-offline-1100.png");
	const unreadable = await open("./Unreadable.tsx", {
		platform: "macos",
		width: 480,
		height: 900,
		colorScheme: "dark",
	});
	await unreadable.waitFor("Today could not be read.");
	await unreadable.screenshot("output/today-unreadable-dark-480.png");
});

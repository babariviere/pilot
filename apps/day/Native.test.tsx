// Captures and input on a real platform: run with
// `nsh test Native.test.tsx --target macos`. Headless runs draw nothing, so
// the captures only mean something on a target.
import { expect, open, test } from "nsh/test";

const DECIDE = "id:decision >> role:button[Decide]";

test("question help: background, an answered question and waiting notes, captured", async () => {
	const app = await open("./QuestionHelpFixture.tsx", { platform: "macos", width: 1100, height: 1300 });
	await app.press("id:help-first >> More context");
	await app.press("id:help-first >> Ask a question");
	await app.type("id:ask-text-first", "Why these two?");
	await app.press("id:ask-send-first");
	await app.waitFor("GNOME and KDE cover most Linux users.");
	await app.press("id:help-first >> Say it simpler");
	await app.wait(400);
	await app.screenshot("output/question-help-light.png");
});

test("the prototype a topic round asks about, opened as its saved source, captured", async () => {
	const app = await open("./RoundPrototypeFixture.tsx", { platform: "macos", width: 900, height: 700 });
	await app.press("id:artifact-card-/chat-proto/variants/3");
	await app.waitFor("id:artifact-viewer");
	await app.wait(400);
	await app.screenshot("output/round-prototype-light.png");
});

test("the prototype in the full window, captured", async () => {
	const app = await open("./RoundPrototypeFixture.tsx", { platform: "macos", width: 1100, height: 760 });
	await app.press("id:artifact-card-/chat-proto/variants/3");
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	await app.wait(400);
	await app.screenshot("output/artifact-full-light.png");
});

// Run with `--filter 'artifact fullscreen'`. Only a real platform shows this: the headless Tab order walks every
// shown view from the root, so it cannot tell a dialog's focus scope from the page under it.
test("artifact fullscreen keeps keyboard inside its dialog", async () => {
	const app = await open("./ArtifactsFixture.tsx", { platform: "macos", width: 1100, height: 850 });
	const reads = () => app.texts().find((t) => t.startsWith("Reads:")) ?? "";
	const HTML = "1b2c3d4e-0000-4000-8000-000000000002";
	await app.waitFor("Timeline");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor("<p>Saved page</p>");
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	// The exit icon starts with the focus; Return closes, and Return on the restored opener opens it again.
	await app.keyboard.press("enter");
	await app.waitUntil(() => !app.shows("id:artifact-full"));
	await app.keyboard.press("enter");
	await app.waitFor("id:artifact-full");
	// Tab and Return stay in the dialog: nothing underneath closes, compares or reads.
	for (let n = 0; n < 4; n++) await app.keyboard.press("tab");
	await app.keyboard.press("enter");
	if (app.shows("Export source…")) {
		await app.keyboard.press("escape");
		await app.waitUntil(() => !app.shows("Export source…"));
	}
	if (app.shows("id:artifact-full")) await app.keyboard.press("escape");
	await app.waitUntil(() => !app.shows("id:artifact-full"));
	expect(app.shows("id:artifact-viewer")).toBe(true);
	expect(app.shows("id:artifact-tab-before")).toBe(false);
	expect(reads()).toBe(`Reads: [${HTML}@4]`);
});

test("Unstick with the repair agent's proposed note, captured", async () => {
	const app = await open("./UnstickFixture.tsx", { platform: "macos", width: 900, height: 900 });
	await app.press("id:unstick");
	await app.press("id:repair-start");
	await app.press("id:agent-done");
	await app.waitFor("id:repair-proposal");
	await app.wait(400);
	await app.screenshot("output/unstick-repair-light.png");
});

test("a large expedition chart, still, with a selected place and full window: captures only, no input", async () => {
	const size = { platform: "macos", width: 1100, height: 1400 } as const;
	for (const [entry, file, colorScheme] of [
		["./ExpeditionLargeFixture.tsx", "chart-large-light", "light"],
		["./ExpeditionLargeSelectedFixture.tsx", "chart-large-selected-light", "light"],
		["./ExpeditionLargeFullFixture.tsx", "chart-large-full-light", "light"],
		["./ExpeditionLargeFixture.tsx", "chart-large-dark", "dark"],
		["./ExpeditionLargeFullFixture.tsx", "chart-large-full-dark", "dark"],
	] as const) {
		// Dark captures fit the screen: a taller headless window leaves its lower part unpainted.
		const app = await open(entry, { ...size, colorScheme, ...(colorScheme === "dark" ? { height: 900 } : {}) });
		await app.waitFor("id:place-features");
		await app.wait(600);
		await app.screenshot(`output/${file}.png`);
	}
});

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

// Run with `--filter 'delivery screens'`. The first runs on older revisions too, for a Before.
test("delivery screens: a worker's result page, captured", async () => {
	const app = await open("./DeliveryFixture.tsx", { platform: "macos", width: 1100, height: 1200 });
	await app.waitFor("id:to-check");
	await app.press("id:check-task.mock-project.native.native-5");
	await app.waitFor("id:your-check");
	await app.wait(600);
	await app.screenshot("output/delivery-screens-page.png");
});

test("delivery screens: the first screen's Before, captured", async () => {
	const app = await open("./DeliveryFixture.tsx", { platform: "macos", width: 1100, height: 1200 });
	await app.waitFor("id:to-check");
	await app.press("id:check-task.mock-project.native.native-5");
	await app.waitFor("id:screens-comparison");
	await app.press("id:screens-tab-before");
	await app.wait(600);
	await app.screenshot("output/delivery-screens-before-tab.png");
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

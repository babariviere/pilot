// Mock data, native visual evidence only: the planning page, New and the day's rituals on the new parts
// (ui/README.md), in light and dark, wide and narrow. Run with
// `nsh test PlanningVisual.test.tsx --target macos`; headless runs draw nothing.
import { open, test } from "nsh/test";

const SIZES = [
	["light", 1100],
	["dark", 1100],
	["light", 480],
	["dark", 480],
] as const;

test("the planning page in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		// Dark captures fit the screen: a taller window leaves its lower part unpainted.
		const app = await open("../../MockApp.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.press("id:plan-export");
		await app.waitFor("id:plan-panel");
		await app.wait(500);
		await app.screenshot(`output/plan-parts-${colorScheme}-${width}.png`);
	}
});

test("the planning page's Plan and Activity tabs, the map and Revisit", async () => {
	const size = { platform: "macos", width: 1100, height: 900, colorScheme: "light" } as const;
	const review = await open("../../Review.tsx", size);
	await review.press("id:plan-export");
	await review.waitFor("id:proposal");
	await review.wait(300);
	await review.screenshot("output/plan-parts-tab-plan-light-1100.png");
	const working = await open("../../PlanWorking.tsx", size);
	await working.press("id:plan-working");
	await working.waitFor("id:plan-activity");
	await working.wait(300);
	await working.screenshot("output/plan-parts-working-light-1100.png");
	await working.press("id:plan-tab-activity");
	await working.waitFor("id:plan-chat");
	await working.wait(300);
	await working.screenshot("output/plan-parts-tab-activity-light-1100.png");
	const map = await open("../../Wayfinder.tsx", size);
	await map.press("id:plan-linux");
	await map.waitFor("id:map");
	await map.scroll("id:map", 900);
	await map.wait(300);
	await map.screenshot("output/plan-parts-map-light-1100.png");
	const revisit = await open("../../Revisit.tsx", size);
	await revisit.press("id:plan-notify");
	await revisit.waitFor("id:ask-revisit");
	await revisit.wait(300);
	await revisit.screenshot("output/plan-parts-revisit-light-1100.png");
});

test("New in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("../../MockApp.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("id:today-panel");
		await app.keyboard.press("mod+n");
		await app.waitFor("id:goal");
		await app.wait(500);
		await app.screenshot(`output/new-parts-${colorScheme}-${width}.png`);
	}
	const confirm = await open("../../NewMission.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
		colorScheme: "light",
	});
	await confirm.keyboard.press("mod+n");
	await confirm.type("id:goal", "Fix the flaky upload test");
	await confirm.press("label:Project for a new chat");
	await confirm.press("text:pilot");
	await confirm.waitFor("/Users/you/src/pilot");
	await confirm.press("role:button[Start as one chat]");
	await confirm.waitFor("Start one chat with exactly these words?");
	await confirm.wait(300);
	await confirm.screenshot("output/new-parts-confirm-light-1100.png");
});

test("the start of the day in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("../../Quiet.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.press("id:start-day");
		await app.waitFor("id:start-of-day");
		await app.wait(500);
		await app.screenshot(`output/ritual-parts-start-${colorScheme}-${width}.png`);
	}
});

test("the start of the day's second step, the end of the day and the standup notes", async () => {
	const size = { platform: "macos", width: 1100, height: 900, colorScheme: "light" } as const;
	const needs = await open("../../MockApp.tsx", size);
	await needs.press("id:start-day");
	await needs.press("role:button[Next]");
	await needs.waitFor("Three things need you.");
	await needs.wait(300);
	await needs.screenshot("output/ritual-parts-needs-light-1100.png");
	const end = await open("../../Trouble.tsx", size);
	await end.press("id:end-day");
	await end.waitFor("Wrapping up.");
	await end.wait(300);
	await end.screenshot("output/ritual-parts-end-light-1100.png");
	const notes = await open("../../MockApp.tsx", size);
	await notes.press("id:standup");
	await notes.waitFor("id:standup-notes");
	await notes.wait(300);
	await notes.screenshot("output/ritual-parts-standup-light-1100.png");
});

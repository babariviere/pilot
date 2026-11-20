// Mock data, native visual evidence only: Settings on the new parts (ui/README.md), in light and dark, wide and
// narrow, and each tab's section fixture. Run with `nsh test SettingsVisual.test.tsx --target macos`; headless runs
// draw nothing.
import { open, test } from "nsh/test";

test("Settings in light and dark, wide and narrow, on the AI and Project tabs", async () => {
	for (const [colorScheme, width] of [
		["light", 1100],
		["dark", 1100],
		["light", 480],
		["dark", 480],
	] as const) {
		// Dark captures fit the screen: a taller window leaves its lower part unpainted.
		const app = await open("../SettingsTargetFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.press("id:settings-open");
		await app.waitFor("id:settings-panel");
		await app.wait(500);
		await app.screenshot(`output/settings-parts-ai-${colorScheme}-${width}.png`);
		await app.press("id:settings-tab-project");
		await app.waitFor("id:preferences");
		await app.wait(400);
		await app.screenshot(`output/settings-parts-project-${colorScheme}-${width}.png`);
	}
});

test("Settings' Allowances tab", async () => {
	const app = await open("../SettingsTargetFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
		colorScheme: "light",
	});
	await app.press("id:settings-open");
	await app.waitFor("id:settings-panel");
	await app.press("id:settings-tab-allowances");
	await app.waitFor("id:funding-settings");
	await app.wait(400);
	await app.screenshot("output/settings-parts-allowances-light-1100.png");
});

// The other tabs need native controls the mock Day does not have: their section fixtures draw them on the same panel.
for (const [fixture, ready, name] of [
	["../ConnectionSettingsFixture.tsx", "id:connection-settings", "connections"],
	["../SlackSettingsFixture.tsx", "id:slack-settings", "slack"],
	["../DiagnosisFixture.tsx", "id:diagnosis-settings", "diagnosis"],
	["../ProjectsFixture.tsx", "id:project-setup", "projects"],
] as const) {
	test(`Settings' ${name} section in light and dark`, async () => {
		for (const colorScheme of ["light", "dark"] as const) {
			const app = await open(fixture, { platform: "macos", width: 1100, height: 900, colorScheme });
			await app.waitFor(ready);
			await app.wait(400);
			await app.screenshot(`output/settings-parts-${name}-${colorScheme}-1100.png`);
		}
	});
}

test("Settings' Knowledge library in light and dark, wide and narrow", async () => {
	for (const colorScheme of ["light", "dark"] as const) {
		for (const width of [1100, 480]) {
			const app = await open("../KnowledgeFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
			await app.press("id:knowledge-open");
			await app.press("id:knowledge-entry-k");
			await app.waitFor("id:knowledge-detail");
			await app.wait(400);
			await app.screenshot(`output/settings-parts-knowledge-${colorScheme}-${width}.png`);
		}
	}
});

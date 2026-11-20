// Mock data, native visual evidence only: the mission page and the controls around it on the new parts
// (ui/README.md), in light and dark, wide and narrow. Run with
// `nsh test MissionVisual.test.tsx --target macos`; headless runs draw nothing.
import { open, test } from "nsh/test";

test("the mission page in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of [
		["light", 1100],
		["dark", 1100],
		["light", 480],
		["dark", 480],
	] as const) {
		// Dark captures fit the screen: a taller window leaves its lower part unpainted.
		const app = await open("./MockApp.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.press("id:mission-search");
		await app.waitFor("id:mission-panel");
		await app.wait(500);
		await app.screenshot(`output/mission-parts-${colorScheme}-${width}.png`);
	}
});

test("the mission page paused, with its tasks open, and asking to archive", async () => {
	const app = await open("./MissionOverviewFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
		colorScheme: "light",
	});
	await app.waitFor("id:now-search-3");
	await app.press("id:situation-paused");
	await app.waitFor("id:mission-held");
	await app.wait(300);
	await app.screenshot("output/mission-parts-paused-light-1100.png");
	await app.press("id:situation-running");
	await app.press("id:next-search-4");
	await app.press("id:mission-section-tasks");
	await app.scroll("id:mission-page", 700);
	await app.wait(300);
	await app.screenshot("output/mission-parts-tasks-light-1100.png");
	await app.scroll("id:mission-page", -5000);
	await app.press("id:mission-archive");
	await app.waitFor("id:mission-archive-confirm");
	await app.wait(300);
	await app.screenshot("output/mission-parts-archive-light-1100.png");
});

test("the chart's full window, Unstick, migration and work profiles", async () => {
	for (const colorScheme of ["light", "dark"] as const) {
		const chart = await open("./ExpeditionFullFixture.tsx", {
			platform: "macos",
			width: 1100,
			height: 900,
			colorScheme,
		});
		await chart.waitFor("id:chart-full-frame");
		await chart.press("id:place-wayland");
		await chart.waitFor("id:field-notes");
		await chart.wait(500);
		await chart.screenshot(`output/mission-parts-chart-${colorScheme}-1100.png`);
	}
	// The log and the key under the chart on the planning page.
	const plan = await open("./ExpeditionFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
		colorScheme: "light",
	});
	await plan.waitFor("id:expedition-log");
	await plan.scroll("id:chart", 1400);
	await plan.wait(300);
	await plan.screenshot("output/mission-parts-chart-log-light-1100.png");
	const unstick = await open("./UnstickFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
		colorScheme: "light",
	});
	await unstick.press("id:unstick");
	await unstick.press("id:repair-start");
	await unstick.press("id:agent-done");
	await unstick.waitFor("id:repair-proposal");
	await unstick.wait(300);
	await unstick.screenshot("output/mission-parts-unstick-light-1100.png");
	const migration = await open("./MigrationFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
		colorScheme: "light",
	});
	await migration.press("id:migration-review");
	await migration.waitFor("id:migration-finish");
	await migration.press("id:previous-mission");
	await migration.waitFor("id:previous-mission-history");
	await migration.wait(300);
	await migration.screenshot("output/mission-parts-migration-light-1100.png");
	const profiles = await open("./ModelSettingsFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
		colorScheme: "light",
	});
	await profiles.waitFor("id:profile-backend");
	await profiles.press("id:profile-backend");
	await profiles.waitFor("id:profile-entry-backend-large-fixture/reasoner");
	await profiles.scroll("id:work-profiles", 520);
	await profiles.wait(300);
	await profiles.screenshot("output/mission-parts-profiles-light-1100.png");
});

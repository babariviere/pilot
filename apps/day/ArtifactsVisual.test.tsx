// Mock data, native visual evidence only: the Artifacts page, an open artifact and a mission's artifacts on the new
// parts (ui/README.md), in light and dark, wide and narrow. Run with
// `nsh test ArtifactsVisual.test.tsx --target macos`; headless runs draw nothing.
import { open, test } from "nsh/test";

const HTML = "1b2c3d4e-0000-4000-8000-000000000002";

// Dark captures fit the screen: a taller window leaves its lower part unpainted.
const SIZES = [
	["light", 1100],
	["dark", 1100],
	["light", 480],
	["dark", 480],
] as const;

test("Artifacts: the shelf and one open artifact, in light and dark, wide and narrow", async () => {
	for (const [colorScheme, width] of SIZES) {
		const app = await open("./ArtifactsFixture.tsx", { platform: "macos", width, height: 900, colorScheme });
		await app.waitFor("Timeline");
		await app.wait(500);
		await app.screenshot(`output/artifacts-parts-${colorScheme}-${width}.png`);
		await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
		await app.waitFor("<p>Saved page</p>");
		await app.press("id:artifact-compare");
		await app.waitFor("id:artifact-tab-before");
		await app.wait(500);
		await app.screenshot(`output/artifacts-parts-open-${colorScheme}-${width}.png`);
	}
});

test("Artifacts: the full window and a mission's artifacts", async () => {
	const app = await open("./ArtifactsFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
		colorScheme: "light",
	});
	await app.waitFor("Timeline");
	await app.press(`id:artifact-card-/chat-b/${HTML}/4`);
	await app.waitFor("<p>Saved page</p>");
	await app.press("id:artifact-viewer-full");
	await app.waitFor("id:artifact-full");
	await app.wait(500);
	await app.screenshot("output/artifacts-parts-full-light-1100.png");
	const mission = await open("./ArtifactsFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 900,
		colorScheme: "light",
	});
	await mission.waitFor("Timeline");
	await mission.press("Mission page");
	await mission.waitFor("Write the report");
	await mission.wait(500);
	await mission.screenshot("output/artifacts-parts-mission-light-1100.png");
});

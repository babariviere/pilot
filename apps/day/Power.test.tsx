// The header's pause for sleep, as a user meets it. Mock data only: these
// prove the header and the controls' rules, not the service's power routes
// (packages/daemon/src/power.fast.test.ts covers those).
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 900 } as const;

test("a pause for sleep shows in the header until Resume work is confirmed", async () => {
	const app = await open("./PowerFixture.tsx", desktop);
	await app.waitFor("id:power-paused");
	expect(app.shows("Work paused for sleep")).toBe(true);
	await app.press("id:power-resume");
	await app.waitFor("Pilot could not confirm it resumed work. Try again.");
	expect(app.shows("id:power-paused")).toBe(true);
	await app.press("id:power-resume");
	await app.waitUntil(() => !app.shows("id:power-paused"));
});

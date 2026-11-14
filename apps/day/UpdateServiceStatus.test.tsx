import { expect, open, test } from "nsh/test";

test("running service remains visible without official update packages", async () => {
	const app = await open("./UpdateServiceStatusFixture.tsx", { platform: "macos", width: 1100, height: 700 });
	await app.waitFor("Pilot's service is running");
	expect(app.shows("This app 20261114.204 · Service 1.125.0")).toBe(true);
	expect(app.shows("Pilot cannot tell whether its service is registered")).toBe(false);
	expect(app.shows("Pilot is up to date.")).toBe(false);
	expect(
		app.shows("Automatic updates are not set up for this install. Install new versions with the Pilot installer."),
	).toBe(true);
	expect(app.shows("id:update-prepare")).toBe(false);
	expect(app.shows("id:update-force-prepare")).toBe(false);
});

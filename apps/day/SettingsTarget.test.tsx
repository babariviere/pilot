// Settings opened from a task line's Change (SettingsTargetFixture.tsx). Headless: no native look or focus ring.
import { expect, open, test } from "nsh/test";

const small = { platform: "macos", width: 1000, height: 700 } as const;

test("Change opens Settings at the task's work profile: open, scrolled to and focused", async () => {
	const app = await open("./SettingsTargetFixture.tsx", small);
	await app.press("Change on a Cyber task");
	await app.waitFor("id:profile-delete-cyber");
	expect(app.shows("id:profile-delete-backend")).toBe(false);
	// The Cyber row has the keyboard focus, so Space closes it.
	await app.keyboard.press("space");
	await app.waitUntil(() => !app.shows("id:profile-delete-cyber"));
	await app.press("Where");
	await app.waitFor("Scrolled: yes");
});

test("Change on a task without a profile opens the first work profile", async () => {
	const app = await open("./SettingsTargetFixture.tsx", small);
	await app.press("Change on a task set by you");
	await app.waitFor("id:profile-delete-backend");
	expect(app.shows("id:profile-delete-cyber")).toBe(false);
});

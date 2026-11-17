import { open, test } from "nsh/test";

test("database screens capture", async () => {
	const app = await open("./DatabaseSettingsFixture.tsx", { platform: "macos", width: 1000, height: 1800 });
	await app.waitFor("id:database-settings");
	await app.screenshot("output/database-settings.png");
});

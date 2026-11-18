import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1000, height: 1800 } as const;

test("Today hides its empty state until database approval is settled", async () => {
	const app = await open("./DatabaseSettingsFixture.tsx", desktop);
	await app.press("Show Today");
	await app.waitFor("id:database-approval");
	expect(app.shows("Nothing needs you. Pilot keeps going on its own.")).toBe(false);
	await app.press("Allow read-only");
	await app.waitFor("Nothing needs you. Pilot keeps going on its own.");
	expect(app.shows("id:database-approval")).toBe(false);
});

test("ineligible agents keep revocation without new approval", async () => {
	const app = await open("./DatabaseSettingsFixture.tsx", desktop);
	await app.press("Make agent ineligible");
	await app.press("Lose next reply");
	await app.press("Test read connection");
	expect(app.enabled("Allow read-only")).toBe(false);
	expect(app.enabled("Revoke access")).toBe(true);
	await app.press("Revoke access");
	expect(app.shows("Allow database access?")).toBe(false);
});

test("database setup reads without connecting and discloses exact approval scope", async () => {
	const app = await open("./DatabaseSettingsFixture.tsx", desktop);
	await app.waitFor("id:database-settings");
	expect(app.shows("Sends: 0, reads: 1, checks: 0")).toBe(true);
	expect(app.shows("Destination: reader@db.example:5432/atlas")).toBe(true);
	expect(app.shows("Model provider: Anthropic")).toBe(true);
	await app.press("Test read connection");
	expect(app.shows("Connection authenticated. No SQL was run.")).toBe(true);
	await app.press("Allow read-only");
	expect(app.shows("Allow database access?")).toBe(false);
});
test("database draft survives navigation and stale settings cannot save it", async () => {
	const app = await open("./DatabaseSettingsFixture.tsx", desktop);
	await app.press("id:database-add");
	await app.type("id:database-environment", "local");
	await app.type("id:database-host", "localhost:5432");
	await app.press("Save and restore draft");
	await app.press("Toggle Settings");
	await app.press("Toggle Settings");
	expect(app.value("id:database-environment")).toBe("local");
	await app.press("External change");
	expect(app.enabled("id:database-save")).toBe(false);
});
test("a lost database test reply is lookup only", async () => {
	const app = await open("./DatabaseSettingsFixture.tsx", desktop);
	await app.press("Lose next reply");
	await app.press("Test read connection");
	expect(app.enabled("Test read connection")).toBe(false);
	await app.press("Check status");
	expect(app.shows("Sends: 1, reads: 1, checks: 1")).toBe(true);
});

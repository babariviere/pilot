import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1000, height: 1800 } as const;

test("Settings shows unsupported connections and cached status; only Check connection probes", async () => {
	const app = await open("../../ConnectionSettingsFixture.tsx", desktop);
	await app.waitFor("id:connection-settings");
	expect(app.shows("Connected · 4 tools")).toBe(true);
	expect(app.shows("Needs sign-in")).toBe(true);
	expect(app.shows("Not checked")).toBe(true);
	expect(app.texts().some((t) => t.includes("Advanced settings stay unchanged"))).toBe(true);
	expect(app.shows("Command not found on this host. Pilot does not install it.")).toBe(true);
	await app.press("Toggle Settings");
	await app.press("Toggle Settings");
	expect(app.shows("Sends: 0, checks: 0, probes: 0, reads: 2")).toBe(true);
	await app.press("Check connection");
	expect(app.shows("Sends: 0, checks: 0, probes: 1, reads: 2")).toBe(true);
	await app.press("Read again");
	expect(app.shows("Sends: 0, checks: 0, probes: 1, reads: 3")).toBe(true);
});
test("add draft survives closing Settings and stale save; uncertain sign-in is lookup only", async () => {
	const app = await open("../../ConnectionSettingsFixture.tsx", desktop);
	await app.press("id:connection-add");
	await app.type("id:connection-name", "new");
	await app.type("id:connection-target", "https://new.example/mcp");
	await app.press("Save and restore draft");
	await app.press("Toggle Settings");
	await app.press("Toggle Settings");
	expect(app.value("id:connection-name")).toBe("new");
	expect(app.value("id:connection-target")).toBe("https://new.example/mcp");
	await app.press("External change");
	await app.press("id:connection-save");
	expect(app.value("id:connection-name")).toBe("new");
	expect(app.shows("Connections changed. Read again; your draft stays.")).toBe(true);
	await app.press("Cancel");
	await app.press("Lose next reply");
	await app.press("Sign in");
	await app.waitFor("id:connections-receipt");
	expect(app.enabled("Sign in")).toBe(false);
	await app.press("Check status");
	expect(app.shows("Sends: 1, checks: 1, probes: 0, reads: 2")).toBe(true);
});
test("browser waiting has explicit cancellation and unavailable is not empty", async () => {
	const app = await open("../../ConnectionSettingsFixture.tsx", desktop);
	await app.press("Sign in");
	expect(app.shows("Waiting for browser sign-in")).toBe(true);
	await app.press("Cancel sign-in");
	expect(app.shows("Sends: 2, checks: 0, probes: 0, reads: 1")).toBe(true);
	await app.press("Unavailable");
	expect(app.shows("Connections could not be read. Read again to see setup and status.")).toBe(true);
	expect(app.shows("No tool connections configured.")).toBe(false);
});

test("setup never saves credentials hidden in URLs or command syntax", async () => {
	const app = await open("../../ConnectionSettingsFixture.tsx", desktop);
	await app.press("id:connection-add");
	await app.type("id:connection-name", "new");
	await app.type("id:connection-target", "https://example.test/mcp/private-key/sse");
	expect(app.enabled("id:connection-save")).toBe(false);
	await app.press("Save and restore draft");
	expect(app.value("id:connection-target")).toBe("");
	expect(app.texts().some((t) => t.includes("private-key"))).toBe(false);
	expect(app.shows("Sends: 0, checks: 0, probes: 0, reads: 1")).toBe(true);
});

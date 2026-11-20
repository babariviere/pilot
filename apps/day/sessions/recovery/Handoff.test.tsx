import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1000, height: 1100 } as const;
test("handoff keeps the note through refresh and starts only on explicit press", async () => {
	const app = await open("../../RecoveryFixture.tsx", desktop);
	await app.waitFor("Offer handoff");
	await app.press("Offer handoff");
	await app.press("id:chat-handoff-prepare");
	await app.type("id:chat-handoff-note", "Keep the original evidence. Finish CSV export.");
	await app.host.send("fixture.refresh-chat");
	expect(app.value("id:chat-handoff-note")).toBe("Keep the original evidence. Finish CSV export.");
	await app.keyboard.press("backspace");
	expect(app.value("id:chat-handoff-note")).toBe("Keep the original evidence. Finish CSV export");
	expect(app.shows("Sends: 0 / Checks: 0")).toBe(true);
	expect(app.shows("Fix only CSV export. Evidence: pilot://artifact/original")).toBe(true);
	await app.press("id:chat-handoff-start");
	await app.waitFor("id:chat-successor");
	expect(app.shows("Sends: 1 / Checks: 0")).toBe(true);
});

test("uncertain handoff automatically checks the exact operation and never starts twice", async () => {
	const app = await open("../../RecoveryFixture.tsx", desktop);
	await app.waitFor("Offer handoff");
	await app.press("Offer handoff");
	await app.press("Lose next answer");
	await app.press("id:chat-handoff-prepare");
	await app.type("id:chat-handoff-note", "Keep my note");
	await app.press("id:chat-handoff-start");
	await app.waitFor("id:chat-handoff-check");
	expect(app.shows("Sends: 1 / Checks: 3")).toBe(true);
	expect(app.shows("id:chat-handoff-start")).toBe(false);
	await app.press("id:chat-handoff-check");
	expect(app.shows("Sends: 1 / Checks: 4")).toBe(true);
});

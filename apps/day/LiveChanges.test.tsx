import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 900, height: 950 } as const;
const toggle = "id:chat-live-changes-toggle";

test("chat changes only read on demand and stay separate from saved results", async () => {
	const app = await open("./LiveChangesFixture.tsx", desktop);
	await app.waitFor("Live changes (unpublished)");
	expect(app.shows("Reads: none")).toBe(true);
	expect(app.shows("id:chat-live-changes-diff")).toBe(false);
	await app.press(toggle);
	await app.waitFor("Reads: test-chat/first");
	await app.waitFor("Reading changes…");
	await app.press("Finish clipped");
	await app.waitFor("Changes in 2 files.");
	await app.waitFor("This diff is too large to show in full.");
	expect(app.shows("id:chat-live-changes-diff")).toBe(true);
	await app.press(toggle);
	expect(app.shows("id:chat-live-changes-diff")).toBe(false);
	expect(app.shows("Reads: test-chat/first")).toBe(true);
});

test("a replaced workspace drops the old answer and does not read automatically", async () => {
	const app = await open("./LiveChangesFixture.tsx", desktop);
	await app.waitFor(toggle);
	await app.press(toggle);
	await app.press("Replace workspace");
	await app.press("Finish clipped");
	expect(app.shows("Reading changes…")).toBe(false);
	expect(app.shows("Changes in 2 files.")).toBe(false);
	expect(app.shows("Reads: test-chat/first")).toBe(true);
	await app.press(toggle);
	await app.waitFor("Reads: test-chat/first, test-chat/second");
	await app.press("Finish empty");
	await app.waitFor("No changes in this working copy.");
	await app.press("Workspace lost");
	expect(app.shows(toggle)).toBe(false);
	expect(app.shows("No changes in this working copy.")).toBe(false);
});

test("stale and unavailable reads do not look like an empty working copy", async () => {
	const app = await open("./LiveChangesFixture.tsx", desktop);
	await app.waitFor(toggle);
	await app.press(toggle);
	await app.press("Finish stale");
	await app.waitFor("The working copy changed before Pilot could show it.");
	expect(app.shows("No changes in this working copy.")).toBe(false);
	await app.press("id:chat-live-changes-retry");
	await app.press("Finish unavailable");
	await app.waitFor("Pilot could not read this working copy.");
	expect(app.shows("No changes in this working copy.")).toBe(false);
});

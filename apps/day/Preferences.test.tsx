// Settings' project preferences on scripted preferences (PreferencesFixture.tsx).
// No daemon, provider or storage. Headless: not native appearance, focus or IME.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;

async function settings() {
	const app = await open("./PreferencesFixture.tsx", desktop);
	await app.press("id:settings-open");
	await app.waitFor("id:preference-p-small");
	return app;
}

const counts = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Saves:"));

test("Settings names the project and shows each preference with its source; opening sends nothing", async () => {
	const app = await settings();
	expect(app.shows("id:preferences-project")).toBe(true);
	expect(app.shows("Pilot")).toBe(true);
	expect(app.value("id:preference-p-small")).toBe("Keep pull requests small: one change each.");
	expect(app.texts().some((t) => t.startsWith("Recorded by a mission coordinator from your note"))).toBe(true);
	expect(app.shows("Your words: “just run the tests the change touches, CI does the rest”")).toBe(true);
	expect(app.texts().some((t) => t.startsWith("Last changed by you"))).toBe(true);
	expect(app.shows("id:preferences-unsaved")).toBe(false);
	expect(counts(app)).toBe("Saves: 0 · Checks: 0");
	await app.keyboard.press("escape");
	await app.waitFor("id:settings-open");
	expect(app.shows("id:settings")).toBe(false);
});

test("an edit shows Save and Revert; Revert keeps the saved list, Save sends it once", async () => {
	const app = await settings();
	await app.type("id:preference-p-names", " Always.");
	await app.waitFor("id:preferences-unsaved");
	expect(app.shows("Edited · not saved")).toBe(true);
	await app.press("id:preferences-revert");
	await app.waitUntil(() => !app.shows("id:preferences-unsaved"));
	expect(app.value("id:preference-p-names")).toBe("Use plain names in code and docs.");
	await app.press("id:preference-add");
	await app.waitFor("New · not saved");
	expect(app.enabled("id:preferences-save")).toBe(false);
	expect(app.shows("Write something in each preference, or remove the empty one.")).toBe(true);
	await app.type("text:Write one short preference", "No releases on Fridays 🐦");
	await app.waitUntil(() => app.enabled("id:preferences-save"));
	await app.press("id:preference-remove-p-small");
	await app.press("id:preferences-save");
	await app.waitFor("id:preferences-message");
	expect(app.shows("Saved.")).toBe(true);
	expect(app.shows("id:preferences-unsaved")).toBe(false);
	expect(app.shows("id:preference-p-small")).toBe(false);
	expect(app.value("id:preference-p-new-1")).toBe("No releases on Fridays 🐦");
	expect(counts(app)).toBe("Saves: 1 · Checks: 0");
});

test("a newer list never replaces typed text: the user picks which version to keep", async () => {
	const app = await settings();
	await app.press("Next stale");
	await app.type("id:preference-p-names", " Always.");
	await app.press("id:preferences-save");
	await app.waitFor("id:preferences-conflict");
	expect(app.value("id:preference-p-names")).toBe("Use plain names in code and docs. Always.");
	expect(app.shows("• No releases on Fridays.")).toBe(true);
	expect(app.enabled("id:preferences-save")).toBe(false);
	await app.press("id:preferences-keep-mine");
	await app.waitUntil(() => app.enabled("id:preferences-save"));
	await app.press("id:preferences-save");
	await app.waitFor("Saved.");
	expect(app.value("id:preference-p-names")).toBe("Use plain names in code and docs. Always.");
	expect(counts(app)).toBe("Saves: 2 · Checks: 0");
});

test("a lost answer stays Unknown; Check only reads and nothing is sent again", async () => {
	const app = await settings();
	await app.press("Next unknown");
	await app.type("id:preference-p-names", " Always.");
	await app.press("id:preferences-save");
	await app.waitFor("id:preferences-unknown");
	expect(app.shows("Pilot does not know if your last change was saved.")).toBe(true);
	expect(app.enabled("id:preferences-save")).toBe(false);
	expect(app.value("id:preference-p-names")).toBe("Use plain names in code and docs. Always.");
	await app.press("id:preferences-check");
	await app.waitFor("Your change was saved.");
	expect(app.shows("id:preferences-unknown")).toBe(false);
	expect(app.shows("id:preferences-unsaved")).toBe(false);
	expect(counts(app)).toBe("Saves: 1 · Checks: 1");
});

test("unsaved text and its project come back after Back, and after a close or update", async () => {
	const app = await settings();
	await app.type("id:preference-p-names", " Kept 日本語 ✓");
	await app.press("id:back");
	await app.waitFor("id:settings-open");
	await app.press("id:settings-open");
	await app.waitFor("id:preferences-unsaved");
	expect(app.value("id:preference-p-names")).toBe("Use plain names in code and docs. Kept 日本語 ✓");
	await app.press("Save and reopen");
	await app.waitFor("id:preferences-unsaved");
	expect(app.shows("id:settings")).toBe(true);
	expect(app.value("id:preference-p-names")).toBe("Use plain names in code and docs. Kept 日本語 ✓");
	expect(app.texts().some((t) => t.startsWith("Kept: [mock-project\n3 |"))).toBe(true);
	expect(counts(app)).toBe("Saves: 0 · Checks: 0");
});

test("a draft for another project is kept, never saved here, and discarded only on request", async () => {
	const app = await settings();
	await app.press("Draft elsewhere");
	await app.waitFor("id:preferences-elsewhere");
	expect(app.enabled("id:preference-p-small")).toBe(false);
	expect(app.shows("id:preferences-save")).toBe(false);
	await app.press("id:preferences-elsewhere-discard");
	await app.press("id:preferences-elsewhere-keep");
	expect(app.shows("id:preferences-elsewhere")).toBe(true);
	await app.press("id:preferences-elsewhere-discard");
	await app.press("id:preferences-elsewhere-confirm");
	await app.waitUntil(() => !app.shows("id:preferences-elsewhere"));
	expect(app.enabled("id:preference-p-small")).toBe(true);
	expect(counts(app)).toBe("Saves: 0 · Checks: 0");
});

test("an unreadable list is not shown as empty, and an empty project says so", async () => {
	const app = await open("./PreferencesFixture.tsx", desktop);
	await app.press("Unreadable");
	await app.press("id:settings-open");
	await app.waitFor("id:preferences-off");
	expect(app.shows("This is not the same as having none.")).toBe(true);
	expect(app.shows("id:preferences-empty")).toBe(false);
	await app.press("Empty project");
	await app.press("id:preferences-read");
	await app.waitFor("id:preferences-empty");
	expect(app.shows("id:preferences-off")).toBe(false);
});

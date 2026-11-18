import { expect, open, test } from "nsh/test";

test("migration reviews before sending and only checks after a lost answer", async () => {
	const app = await open("./MigrationFixture.tsx");
	expect(app.shows("Finish migration")).toBe(false);
	await app.press("id:migration-review");
	await app.waitFor("Finish replacing “Old export” with “Export safely”?");
	expect(app.shows("Published replacement: brief revision 3, plan aaaaaaaaaaaa.")).toBe(true);
	expect(app.shows("Keep chat “Importer work”: unpublished work reported.")).toBe(true);
	await app.press("id:migration-finish");
	await app.waitFor("id:migration-check");
	expect(app.shows("Finish migration")).toBe(false);
	await app.press("id:migration-check");
	await app.waitFor("Migration finished. History and chats kept. No work started.");
	expect(app.shows("Finish sends: 1 · Checks: 1")).toBe(true);
});

test("a proven pre-send stale migration offers a fresh review", async () => {
	const app = await open("./MigrationFixture.tsx");
	await app.press("Make preview stale");
	await app.press("id:migration-review");
	await app.press("id:migration-finish");
	await app.waitFor("Review again");
	expect(app.shows("id:migration-check")).toBe(false);
	expect(app.shows("Finish sends: 0 · Checks: 0")).toBe(true);
	await app.press("Review again");
	await app.waitFor("id:migration-finish");
});

test("finished replacement history is readable without execution", async () => {
	const app = await open("./MigrationFixture.tsx");
	await app.press("id:previous-mission");
	await app.waitFor("id:previous-mission-history");
	expect(app.shows("Keep original importer history.")).toBe(true);
	expect(app.shows("D1: Preserve exact bytes")).toBe(true);
	expect(app.shows("#1 Unfinished import tests (blocked)")).toBe(true);
	expect(app.shows("id:previous-chat-old-task >> text:Open saved chat")).toBe(true);
	expect(app.shows("label:Open saved chat for #1 Unfinished import tests, read only. This starts nothing.")).toBe(
		true,
	);
	expect(app.shows("Finish sends: 0 · Checks: 0")).toBe(true);
});

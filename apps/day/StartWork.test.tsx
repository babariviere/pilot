import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 800 } as const;

test("opening, previewing and cancelling start nothing; explicit confirmation sends the exact plan once", async () => {
	const app = await open("./StartWorkFixture.tsx", desktop);
	await app.waitFor("Start work");
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
	await app.press("Start work");
	await app.waitFor("Start “Check importer” as one background Build task?");
	expect(
		app.shows("Offline fixture · faux/faux-1 · off. Access: build. Existing limits apply. Other tasks do not start."),
	).toBe(true);
	await app.press("Cancel");
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
	await app.press("Start work");
	await app.press("Start task");
	await app.waitFor("One background task admitted.");
	expect(app.shows("Sends: 1 · Checks: 0")).toBe(true);
	expect(app.shows("Start work")).toBe(false);
});

test("a changed plan closes admission and lost acknowledgement offers Check only", async () => {
	const stale = await open("./StartWorkFixture.tsx", desktop);
	await stale.press("Start work");
	await stale.press("Change plan");
	expect(stale.enabled("Start task")).toBe(false);
	expect(stale.shows("Sends: 0 · Checks: 0")).toBe(true);
	const app = await open("./StartWorkFixture.tsx", desktop);
	await app.press("Lose acknowledgement");
	await app.press("Start work");
	await app.press("Start task");
	await app.waitFor("Start is not confirmed.");
	expect(app.shows("Start work")).toBe(false);
	await app.press("Check Start");
	await app.waitFor("Exact receipt found. Nothing resent.");
	expect(app.shows("Sends: 1 · Checks: 1")).toBe(true);
});

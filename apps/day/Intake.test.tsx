// The New section's writes as a user takes them, on a scripted source with
// the connected rules (IntakeFixture.tsx). No daemon, provider or storage.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1000 } as const;
const NORTHWIND = "Northwind can't export invoices to CSV";
const STRIPE = "Update the Stripe SDK to v15";

async function ready() {
	const app = await open("./IntakeFixture.tsx", desktop);
	await app.waitFor("id:incoming");
	await app.waitFor(NORTHWIND);
	return app;
}

test("opening a request and choosing where work goes sends nothing", async () => {
	const app = await ready();
	expect(app.shows("From Slack and Linear")).toBe(true);
	await app.press("id:request-northwind");
	await app.waitFor("id:request-detail-northwind");
	expect(app.shows("Where should the work go?")).toBe(true);
	await app.press("id:start-northwind");
	await app.waitFor(`Start one Build chat for “${NORTHWIND}” as standalone work?`);
	await app.press("role:button[Cancel]");
	expect(app.shows("id:confirm-northwind")).toBe(false);
	// Cancel gives the keyboard focus back to Start work…; Space asks again.
	await app.keyboard.press("space");
	await app.waitFor("id:confirm-northwind");
	await app.press("role:button[Cancel]");
	await app.press("id:request-northwind");
	expect(app.shows("id:request-detail-northwind")).toBe(false);
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
	expect(app.shows(NORTHWIND)).toBe(true);
});

test("Later and Bring back, Discard and Undo each send once and move the row", async () => {
	const app = await ready();
	await app.press("id:request-northwind");
	await app.press("id:later-northwind");
	await app.waitFor("id:intake-later");
	expect(app.shows("Sends: 1 · Checks: 0")).toBe(true);
	expect(app.shows("id:request-northwind")).toBe(false);
	// The next row took the keyboard focus: Space opens it.
	await app.keyboard.press("space");
	await app.waitFor("id:request-detail-stripe");
	await app.press("role:button[Show later requests]");
	await app.press("id:bring-back-northwind");
	await app.waitFor("id:request-northwind");
	expect(app.shows("id:intake-later")).toBe(false);
	await app.press("id:discard-stripe");
	await app.waitFor(`Discarded “${STRIPE}”.`);
	expect(app.shows("id:request-stripe")).toBe(false);
	await app.press("id:undo-last");
	await app.waitFor("id:request-stripe");
	expect(app.shows("id:incoming-undo")).toBe(false);
	expect(app.shows("Sends: 4 · Checks: 0")).toBe(true);
});

test("Start sends the exact request and place once; a changed request closes it", async () => {
	const app = await ready();
	await app.press("id:request-northwind");
	await app.press("id:start-northwind");
	await app.press("Change first request");
	await app.waitFor("This changed since you chose to start it. Cancel and look again.");
	expect(app.enabled("id:confirm-start-northwind")).toBe(false);
	await app.press("role:button[Cancel]");
	await app.press("id:start-northwind");
	await app.press("id:confirm-start-northwind");
	await app.waitFor(
		`Started “${NORTHWIND}” as standalone work: one Build chat was created. That is not progress or a result yet.`,
	);
	expect(app.shows("id:request-northwind")).toBe(false);
	expect(app.shows("Sends: 1 · Checks: 0")).toBe(true);
});

test("a request that changed on its way is stale, sends nothing and keeps the row", async () => {
	const app = await ready();
	await app.press("Change on send");
	await app.press("id:request-northwind");
	await app.press("id:later-northwind");
	await app.waitFor("This request changed since Pilot read it. Nothing was sent. Look again first.");
	expect(app.shows("id:request-northwind")).toBe(true);
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
	// The newer revision is the one sent next.
	await app.press("id:later-northwind");
	await app.waitFor("id:intake-later");
	expect(app.shows("Sends: 1 · Checks: 0")).toBe(true);
});

test("a lost Start stays not confirmed; Check reads it once and nothing is sent again", async () => {
	const app = await ready();
	await app.press("Lose next answer");
	await app.press("id:request-northwind");
	await app.press("id:start-northwind");
	await app.press("id:confirm-start-northwind");
	await app.waitFor(`Starting work on “${NORTHWIND}” is not confirmed.`);
	expect(app.shows("Pilot will not send it again. Check only reads its saved answer.")).toBe(true);
	expect(app.shows("id:request-northwind")).toBe(false);
	await app.press("role:button[Check whether it happened. This reads Pilot's saved answer and sends nothing.]");
	await app.waitFor(
		`Started “${NORTHWIND}” as standalone work: one Build chat was created. That is not progress or a result yet.`,
	);
	expect(app.shows("is not confirmed")).toBe(false);
	expect(app.shows("Sends: 1 · Checks: 1")).toBe(true);
});

test("rapid presses while an answer is on its way send once", async () => {
	const app = await ready();
	await app.press("Hold answers");
	await app.press("id:request-northwind");
	await app.press("id:later-northwind");
	await app.waitFor("Waiting for Pilot's answer about this request.");
	expect(app.enabled("id:later-northwind")).toBe(false);
	expect(app.enabled("id:discard-northwind")).toBe(false);
	expect(app.enabled("id:start-northwind")).toBe(false);
	await app.press("Release answer");
	await app.waitFor("id:intake-later");
	expect(app.shows("Sends: 1 · Checks: 0")).toBe(true);
});

test("source trouble and an incomplete page say so; unreadable shows no rows", async () => {
	const app = await ready();
	await app.press("Source trouble");
	await app.waitFor("Slack needs you to sign in again. These are the requests Pilot read before.");
	expect(
		app.shows("40 more Slack messages are not shown here. Pilot reads up to 100 requests from each source."),
	).toBe(true);
	await app.press("Unreadable");
	await app.waitFor("Pilot cannot show new requests here. Pilot could not reach its service.");
	expect(app.shows("This is not the same as having none.")).toBe(true);
	expect(app.shows(NORTHWIND)).toBe(false);
	await app.press("id:incoming-read");
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
	await app.press("Readable");
	await app.waitFor(NORTHWIND);
});

test("a project change closes a Start before it is sent", async () => {
	const app = await ready();
	await app.press("id:request-stripe");
	await app.press("id:start-stripe");
	await app.press("Change project");
	await app.waitFor("This changed since you chose to start it. Cancel and look again.");
	expect(app.enabled("id:confirm-start-stripe")).toBe(false);
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
});

// New Slack requests as Needs you's cards, as a user takes them, on a
// scripted source with the connected rules (IntakeFixture.tsx,
// intakeDemo.ts). No daemon, provider or storage.
import { expect, open, test } from "nsh/test";
import { intakeReason } from "./intakeFeed";

const desktop = { platform: "macos", width: 1100, height: 1300 } as const;
const NORTHWIND = "Northwind can't export invoices to CSV";
const STRIPE = "Update the Stripe SDK to v15";
const CARD = "id:request";

test("intake read failures distinguish denied access from generic unavailability", () => {
	expect(intakeReason("denied")).toBe("Pilot does not have access to read new requests here.");
	expect(intakeReason("unavailable")).toBe("Pilot could not read new requests right now.");
});

async function ready() {
	const app = await open("../../IntakeFixture.tsx", desktop);
	await app.waitFor(CARD);
	await app.waitFor(`${CARD} >> ${NORTHWIND}`);
	return app;
}

for (const [control, reason] of [
	["Access denied", "Pilot does not have access to read new requests here."],
	["Service unavailable", "Pilot could not read new requests right now."],
]) {
	test(`${control} is not empty; Read again only reads`, async () => {
		const app = await ready();
		await app.press(control);
		await app.waitFor(`Pilot cannot show new requests here. ${reason}`);
		expect(app.shows("This is not the same as having none.")).toBe(true);
		expect(app.shows(NORTHWIND)).toBe(false);
		await app.waitFor("Reads: 1");
		await app.press("role:button[Read new requests again. This sends nothing.]");
		await app.waitFor("Reads: 2");
		expect(app.shows(`Pilot cannot show new requests here. ${reason}`)).toBe(true);
		expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
		await app.press("Readable");
		await app.waitFor(NORTHWIND);
		expect(app.shows("id:incoming-off")).toBe(false);
	});
}

test("a Slack request is a card: where it came from, its own words and facts; Linear's is not", async () => {
	const app = await ready();
	expect(app.shows(`${CARD} >> Slack request`)).toBe(true);
	expect(app.shows(`${CARD} >> · #client-northwind · Jane Doe · 20 min ago`)).toBe(true);
	expect(app.shows(`${CARD} >> 1 of 2`)).toBe(true);
	expect(
		app.shows("“Since this morning the Export button on the invoices page spins forever and no file comes out.”"),
	).toBe(true);
	for (const fact of ["Kind", "Bug, high", "Client", "Northwind", "Reported by"]) {
		expect(app.shows(`${CARD} >> ${fact}`)).toBe(true);
	}
	expect(app.shows("Starts as standalone work.")).toBe(true);
	expect(app.shows(`Up next, Slack request: ${STRIPE}`)).toBe(true);
	// Linear's requests wait on the Linear page, not in Needs you.
	expect(app.shows("CSV export times out for large accounts")).toBe(false);
	expect(app.shows("id:today-no-attention")).toBe(false);
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
});

test("Change shows where the work goes; choosing and Cancel send nothing", async () => {
	const app = await ready();
	await app.press("id:route-change-northwind");
	await app.waitFor("Where should the work go?");
	await app.press("id:route-northwind-native");
	await app.waitFor("Starts as a chat in Native desktop app.");
	await app.press("id:route-change-northwind");
	expect(app.shows("Where should the work go?")).toBe(false);
	await app.press("id:start-northwind");
	await app.waitFor(`Start one Build chat for “${NORTHWIND}” in Native desktop app?`);
	await app.press("role:button[Cancel]");
	expect(app.shows("id:confirm-northwind")).toBe(false);
	// Cancel gives the keyboard focus back to Start work; Space asks again.
	await app.keyboard.press("space");
	await app.waitFor("id:confirm-northwind");
	await app.press("role:button[Cancel]");
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
});

test("Plan a mission opens New with the request's words; a linked draft keeps New", async () => {
	const app = await ready();
	await app.press("Hold a linked draft");
	await app.press("id:route-change-northwind");
	await app.press("id:plan-northwind");
	await app.waitFor("You already have a mission draft. Open New to finish or clear it before prefilling another.");
	expect(app.shows("New: closed · Linked words · request none@0")).toBe(true);
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
});

test("Start work asks once more; Command-Return sends it once and the next card comes forward", async () => {
	const app = await ready();
	await app.press("id:start-northwind");
	await app.press("Change first request");
	await app.waitFor("This changed since you chose to start it. Cancel and look again.");
	expect(app.enabled("id:confirm-start-northwind")).toBe(false);
	await app.press("role:button[Cancel]");
	await app.keyboard.press("mod+enter");
	await app.waitFor("id:confirm-northwind");
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
	await app.keyboard.press("mod+enter");
	await app.waitFor(
		`Started “${NORTHWIND}” as standalone work: one Build chat was created. That is not progress or a result yet.`,
	);
	await app.waitFor(`${CARD} >> ${STRIPE}`);
	expect(app.shows("Sends: 1 · Checks: 0")).toBe(true);
});

test("Later and Bring back, Discard and Undo each send once and move the card", async () => {
	const app = await ready();
	await app.press("id:later-northwind");
	await app.waitFor("id:intake-later");
	await app.waitFor(`${CARD} >> ${STRIPE}`);
	expect(app.shows("Sends: 1 · Checks: 0")).toBe(true);
	expect(app.shows("Requests for later · 1")).toBe(true);
	await app.press("role:button[Show later requests]");
	await app.press("id:bring-back-northwind");
	await app.waitFor(`${CARD} >> ${NORTHWIND}`);
	expect(app.shows("id:intake-later")).toBe(false);
	await app.press("id:discard-northwind");
	await app.waitFor(`Discarded “${NORTHWIND}”.`);
	await app.press("id:undo-last");
	await app.waitFor(`${CARD} >> ${NORTHWIND}`);
	expect(app.shows("id:incoming-undo")).toBe(false);
	expect(app.shows("Sends: 4 · Checks: 0")).toBe(true);
});

test("L puts the request in front off with its saved Later; J and K move between cards", async () => {
	const app = await ready();
	await app.keyboard.press("j");
	await app.waitFor(`${CARD} >> ${STRIPE}`);
	await app.keyboard.press("k");
	await app.waitFor(`${CARD} >> ${NORTHWIND}`);
	await app.keyboard.press("l");
	await app.waitFor("id:intake-later");
	await app.waitFor(`${CARD} >> ${STRIPE}`);
	expect(app.shows("Sends: 1 · Checks: 0")).toBe(true);
});

test("a request that changed on its way is stale, sends nothing and keeps the card", async () => {
	const app = await ready();
	await app.press("Change on send");
	await app.press("id:later-northwind");
	await app.waitFor("This request changed since Pilot read it. Nothing was sent. Look again first.");
	expect(app.shows(`${CARD} >> ${NORTHWIND}`)).toBe(true);
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
	// The newer revision is the one sent next.
	await app.press("id:later-northwind");
	await app.waitFor("id:intake-later");
	expect(app.shows("Sends: 1 · Checks: 0")).toBe(true);
});

test("a lost Start stays not confirmed; Check reads it once and nothing is sent again", async () => {
	const app = await ready();
	await app.press("Lose next answer");
	await app.press("id:start-northwind");
	await app.press("id:confirm-start-northwind");
	await app.waitFor(`Starting work on “${NORTHWIND}” is not confirmed.`);
	expect(app.shows("Pilot will not send it again. Check only reads its saved answer.")).toBe(true);
	expect(app.shows(`${CARD} >> ${NORTHWIND}`)).toBe(false);
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
	await app.press("id:later-northwind");
	await app.waitFor("Waiting for Pilot's answer about this request.");
	expect(app.enabled("id:later-northwind")).toBe(false);
	expect(app.enabled("id:discard-northwind")).toBe(false);
	expect(app.enabled("id:start-northwind")).toBe(false);
	await app.keyboard.press("l");
	await app.press("Release answer");
	await app.waitFor("id:intake-later");
	expect(app.shows("Sends: 1 · Checks: 0")).toBe(true);
});

test("source trouble and an incomplete page say so; unreadable shows no cards", async () => {
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
	await app.press("id:start-northwind");
	await app.press("Change project");
	await app.waitFor("This changed since you chose to start it. Cancel and look again.");
	expect(app.enabled("id:confirm-start-northwind")).toBe(false);
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
});

test("the headline separates incoming requests from attention", async () => {
	const app = await ready();
	// New requests have not started work. They do not become attention merely by arriving.
	await app.waitFor("Two incoming requests.");
	expect(app.shows("Nothing needs you today.")).toBe(false);
	expect(app.shows("text:/ Two Slack requests wait for you\\.$/")).toBe(true);
	await app.press("id:later-northwind");
	await app.waitFor("One incoming request.");
	expect(app.shows("text:/ One Slack request waits for you\\.$/")).toBe(true);
	await app.press("id:later-stripe");
	await app.waitFor("Nothing needs you today.");
	expect(app.shows("text:/Slack request/")).toBe(false);
});

test("Open in Slack shows the request's saved message once; a request without a link offers none", async () => {
	const app = await ready();
	await app.press("id:open-slack-northwind");
	await app.waitFor("Opened: [https://example.slack.com/archives/C0MOCK/p1791892800000100]");
	expect(app.shows("Sends: 0 · Checks: 0")).toBe(true);
	await app.keyboard.press("j");
	await app.waitFor(`${CARD} >> ${STRIPE}`);
	expect(app.shows("id:open-slack-stripe")).toBe(false);
	expect(app.shows("Open in Slack")).toBe(false);
});

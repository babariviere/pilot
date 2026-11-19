// Results to check as Needs you's cards, behind questions and actions. Mock data; nothing is sent.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1200 } as const;
const CARD = "id:result";
const TITLES = [
	"#4 History slice",
	"#2 Chat view",
	"Explain CSV exports in the guide",
	"Is the phishing password entry a true positive?",
	"#5 Open a real Today",
];

function front(app: { shows(selector: string): boolean }): string {
	return TITLES.find((t) => app.shows(`${CARD} >> ${t}`)) ?? "";
}

test("with nothing to decide, a result to check is the card in front", async () => {
	const app = await open("./NeedsYouResults.tsx", desktop);
	await app.waitFor(CARD);
	expect(app.shows(`${CARD} >> role:button[Check the result]`)).toBe(true);
	expect(app.shows("Pilot does not count an agent's report or a merged pull request as your check.")).toBe(true);
	expect(app.shows("text:/^Up next, result to check: /")).toBe(true);
	// The results are cards now: the old list heading is gone.
	expect(app.shows("text:/^To check · \\d+$/")).toBe(false);
	expect(app.shows("Nothing needs you. Pilot keeps going on its own.")).toBe(false);
});

test("Later puts the result in front after the others; J brings the next one; ⌘↩ opens it", async () => {
	const app = await open("./NeedsYouResults.tsx", desktop);
	await app.waitFor(CARD);
	const header = () => app.texts().find((t) => /^\d+ of \d+$/.test(t)) ?? "";
	expect(header()).toBe(`1 of ${header().split(" of ")[1]}`);
	const first = front(app);
	expect(first).not.toBe("");
	await app.press(`${CARD} >> role:button[Later]`);
	await app.waitUntil(() => front(app) !== first);
	expect(header().startsWith("1 of ")).toBe(true);
	// The result put off waits last: K from the front goes around to it.
	await app.keyboard.press("k");
	await app.waitUntil(() => front(app) === first);
	await app.keyboard.press("j");
	await app.keyboard.press("j");
	await app.waitUntil(() => header().startsWith("2 of "));
	await app.keyboard.press("mod+enter");
	await app.waitFor("id:delivery");
	await app.keyboard.press("escape");
	await app.waitFor(CARD);
});

test("questions come first; results wait behind them as Up next", async () => {
	const app = await open("./NeedsYouResultsBehind.tsx", desktop);
	await app.waitFor("id:decision");
	expect(app.shows(CARD)).toBe(false);
	expect(app.shows("text:/^Up next, result to check: /")).toBe(true);
});

test("Slack requests wait behind the results; Start, Later and Discard work from their card", async () => {
	const app = await open("./NeedsYouRequests.tsx", desktop);
	await app.waitFor(CARD);
	const request = "id:request";
	const northwind = "Northwind can't export invoices to CSV";
	const stripe = "Update the Stripe SDK to v15";
	// A result is in front; the requests queue after every result.
	expect(app.shows(request)).toBe(false);
	// The headline counts every card Needs you holds: five results and two Slack requests.
	expect(app.shows("Seven things need you.")).toBe(true);
	expect(app.shows("text:/ Five results to check and two Slack requests wait for you\\.$/")).toBe(true);
	expect(app.shows(`Up next, Slack request: ${northwind}`)).toBe(true);
	const texts = app.texts();
	const lastResult = Math.max(...texts.map((t, i) => (t.startsWith("Up next, result to check: ") ? i : -1)));
	expect(lastResult).toBeGreaterThan(-1);
	expect(texts.indexOf(`Up next, Slack request: ${northwind}`)).toBeGreaterThan(lastResult);
	// K from the front goes around to the last card.
	await app.keyboard.press("k");
	await app.waitFor(`${request} >> ${stripe}`);
	await app.keyboard.press("k");
	await app.waitFor(`${request} >> ${northwind}`);
	await app.press(`${request} >> role:button[Start work]`);
	await app.waitFor(`Start one Build chat for “${northwind}” as standalone work?`);
	await app.press("id:confirm-start-northwind");
	await app.waitFor(
		`Started “${northwind}” as standalone work: one Build chat was created. That is not progress or a result yet.`,
	);
	await app.waitFor(CARD);
	expect(app.shows(`Up next, Slack request: ${northwind}`)).toBe(false);
	await app.keyboard.press("k");
	await app.waitFor(`${request} >> ${stripe}`);
	await app.press(`${request} >> role:button[Later]`);
	await app.waitFor("Requests for later  1");
	await app.waitFor(CARD);
	await app.press("role:button[Show later requests]");
	await app.press("id:bring-back-stripe");
	await app.waitFor(`Up next, Slack request: ${stripe}`);
	await app.keyboard.press("k");
	await app.waitFor(`${request} >> ${stripe}`);
	await app.press(`${request} >> role:button[Discard]`);
	await app.waitFor(`Discarded “${stripe}”.`);
	expect(app.shows(request)).toBe(false);
	expect(app.shows("text:/^Up next, Slack request: /")).toBe(false);
});

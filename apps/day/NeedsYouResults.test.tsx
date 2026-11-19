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

// Decision and action cards shaped like the native attention feed: an
// agent's question that takes the user's own words, help Pilot cannot
// write here, drafts kept for the exact revision shown, and links that
// report nothing. The native host and its saved drafts are checked in
// Rust (native/tests/attention_feed.rs); these are headless mock checks.
import { expect, open, test } from "nsh/test";
import { TodayFeed } from "pilot-day/native";

const desktop = { platform: "macos", width: 1100, height: 900 } as const;
const HELP = "Simpler words, charts and questions are not available here yet.";

test("help Pilot cannot write is said once and its keys ask nothing", async () => {
	const app = await open("./Asks.tsx", desktop);
	await app.waitFor("Which package should go to the store?");
	expect(app.shows(HELP)).toBe(true);
	expect(app.shows("Say it simpler")).toBe(false);
	expect(app.shows("Ask a question")).toBe(false);
	expect(app.shows("Suggested")).toBe(true);
	await app.keyboard.press("s");
	await app.keyboard.press("q");
	await app.keyboard.press("v");
	expect(app.shows("Ask about this decision")).toBe(false);
	expect(app.shows("Sending your answer…")).toBe(false);
});

test("a suggestion is not an answer until picked, and 0 opens the user's own words", async () => {
	const app = await open("./Asks.tsx", desktop);
	await app.waitFor("Which package should go to the store?");
	// Nothing is preselected, so Command-Return sends nothing.
	await app.keyboard.press("mod+enter");
	expect(app.shows("has your answer")).toBe(false);
	await app.keyboard.press("0");
	await app.keyboard.press("j");
	await app.keyboard.press("k");
	expect(app.value("id:reply")).toBe("jk");
	await app.keyboard.press("escape");
	await app.keyboard.press("2");
	// Own words go only through the service; the mock sends nothing and keeps them.
	await app.keyboard.press("mod+enter");
	await app.waitFor("Mock data: answers in your own words need Pilot's service. Nothing was sent.");
	expect(app.value("id:reply")).toBe("jk");
	await app.clear("id:reply");
	await app.keyboard.press("escape");
	await app.keyboard.press("1");
	await app.keyboard.press("mod+enter");
	await app.waitFor("Native desktop app has your answer: Reviewed package.");
});

test("drafts name the revision shown, come back on the item and are typed", async () => {
	const feed = new TodayFeed("asks");
	const saved = feed.saveDraft({
		itemId: "ask1",
		revision: 1,
		pick: "option-2",
		picks: [],
		text: "  exact\n💬  ",
		question: "",
		later: false,
	});
	expect(saved.status).toBe("accepted");
	const draft = feed.snapshot().decisions[0].draft;
	expect(draft.pick).toBe("option-2");
	expect(draft.text).toBe("  exact\n💬  ");
	const stale = feed.saveDraft({
		itemId: "ask1",
		revision: 4,
		pick: null,
		picks: [],
		text: "old",
		question: "",
		later: false,
	});
	expect(stale.status).toBe("stale");
	expect(feed.snapshot().decisions[0].draft.text).toBe("  exact\n💬  ");
	let forged = "";
	try {
		feed.saveDraft({
			itemId: "ask1",
			revision: 1,
			pick: null,
			picks: [],
			text: "",
			question: "",
			later: false,
			send: true,
		} as never);
	} catch (error) {
		forged = String(error);
	}
	expect(forged).toContain("TypeError");
	// Saving never answers.
	expect(feed.snapshot().decisions[0].delivery).toBe("idle");
	expect(feed.snapshot().notes).toEqual([]);
	feed.dispose();
});

test("a question that takes several keeps every pick, and picking one again unpicks it", async () => {
	const app = await open("./Asks.tsx", desktop);
	await app.waitFor("Which package should go to the store?");
	await app.keyboard.press("j");
	await app.waitFor("Pick any that apply.");
	// Suggestions are marked but not picked.
	expect(app.shows("Suggested")).toBe(true);
	await app.keyboard.press("1");
	await app.keyboard.press("3");
	await app.waitFor("2 picked");
	await app.keyboard.press("1");
	await app.waitFor("1 picked");
	await app.keyboard.press("2");
	await app.waitFor("2 picked");
	// The mock cannot send several picks: nothing is sent and the picks stay.
	await app.keyboard.press("mod+enter");
	await app.waitFor("Mock data: answers with several picks need Pilot's service. Nothing was sent.");
	expect(app.shows("2 picked")).toBe(true);
	expect(app.shows("has your answer")).toBe(false);
});

test("several picks and a Later are kept with the draft, and a save without Later keeps it", async () => {
	const feed = new TodayFeed("asks");
	const several = feed.snapshot().decisions.find((d) => d.id === "ask2");
	expect(several?.multiple).toBe(true);
	expect(several?.draft.picks).toEqual([]);
	const save = (picks: string[], later: boolean) =>
		feed.saveDraft({ itemId: "ask2", revision: 1, pick: null, picks, text: " why 💬 ", question: "", later });
	expect(save(["option-1", "option-3"], false).status).toBe("accepted");
	expect(feed.snapshot().decisions.find((d) => d.id === "ask2")?.draft.picks).toEqual(["option-1", "option-3"]);
	// Later moves the question after the others and answers nothing.
	expect(feed.later({ decisionId: "ask1", revision: 1 }).status).toBe("accepted");
	expect(feed.snapshot().decisions.map((d) => d.id)).toEqual(["ask2", "ask1"]);
	expect(save(["option-3"], true).status).toBe("accepted");
	expect(save(["option-3"], false).status).toBe("accepted");
	const draft = feed.snapshot().decisions.find((d) => d.id === "ask2")?.draft;
	expect(draft?.picks).toEqual(["option-3"]);
	expect(draft?.later).toBe(true);
	expect(draft?.text).toBe(" why 💬 ");
	expect(feed.snapshot().decisions.every((d) => d.delivery === "idle")).toBe(true);
	expect(feed.snapshot().notes).toEqual([]);
	feed.dispose();
});

test("Later puts a question after the others and says the chat still waits", async () => {
	const app = await open("./Asks.tsx", desktop);
	await app.waitFor("Which package should go to the store?");
	expect(app.shows("id:put-off")).toBe(false);
	await app.keyboard.press("l");
	await app.waitFor("Pick any that apply.");
	await app.keyboard.press("j");
	await app.waitFor("Put off. The chat still waits.");
	expect(app.shows("Sending your answer…")).toBe(false);
});

test("a link Pilot cannot open stays text, and opening reports nothing", async () => {
	const feed = new TodayFeed("actions");
	const action = feed.snapshot().actions[0];
	expect(action.canOpen).toBe(false);
	const opened = await feed.openLink({ actionId: action.id, revision: action.revision });
	expect(opened.status).toBe("rejected");
	expect(feed.snapshot().actions[0].delivery).toBe("idle");
	expect(feed.snapshot().notes).toEqual([]);
	feed.dispose();
	const app = await open("./Actions.tsx", desktop);
	await app.waitFor("1 of 2");
	await app.keyboard.press("j");
	await app.waitFor("Action for you");
	expect(app.shows("text:https://chrome.google.com/webstore/devconsole")).toBe(true);
	expect(app.shows("Open link")).toBe(false);
});

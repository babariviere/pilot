// The Today flows as a user takes them, the typed boundary as TSX sees it,
// and the sandbox that keeps TSX away from the daemon.
import { expect, open, test } from "nsh/test";
import { TodayFeed } from "pilot-day/native";

const desktop = { platform: "macos", width: 1100, height: 900 } as const;
/** The decision card's own commit, not a mission row's link to it. */
const DECIDE = "id:decision >> role:button[Decide]";
/** The confirmation's Pause, not the "Pause mission" that opens it. */
const PAUSE = "id:pause >> role:button[Pause]";
const RUNNING =
	"Running. Pause stops every agent, schedule and job in this mission at a safe point. You can resume it later.";

test("Today shows decisions first, then moving and waiting missions", async () => {
	const app = await open("./App.tsx", desktop);
	await app.waitFor("Three short things need you.");
	for (const text of [
		"How should finished work reach you?",
		"1 of 3",
		"Up next: Open a test copy of Pilot on your Mac?",
		"Moving  1",
		"Not moving  2",
		"Waiting for you",
		"Done since you looked",
		"Coming up",
		"Mock data",
	]) {
		expect(app.shows(text)).toBe(true);
	}
});

test("deciding sends the recommended option and moves the mission", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press(DECIDE);
	await app.waitFor("Quieter notifications has your answer: One summary at 18:00.");
	await app.waitFor("Two things left.");
	expect(app.shows("Open a test copy of Pilot on your Mac?")).toBe(true);
	expect(app.shows("Moving  2")).toBe(true);
});

test("a picked option is the one sent", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("Only failures and questions");
	await app.press(DECIDE);
	await app.waitFor("Quieter notifications has your answer: Only failures and questions.");
});

test("later moves a decision back without answering it", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("role:button[Later]");
	await app.waitFor("role:button[Confirm]");
	expect(app.shows("Up next: How should finished work reach you?")).toBe(true);
	expect(app.shows("has your answer")).toBe(false);
});

test("help: simpler words, more context, and a question answered in the card", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("Say it simpler");
	await app.waitFor("Pilot sends too many notifications. Choose when it should tell you about finished work.");
	await app.press("More context");
	await app.waitFor("Questions and failures still notify you right away with every option.");
	await app.press("Ask a question");
	await app.type("id:question", "What happens after 18:00?");
	await app.press("role:button[Ask]");
	await app.waitFor(
		"Anything that finishes after 18:00 waits for the next day's summary. Questions and failures still reach you right away.",
	);
	expect(app.shows("What happens after 18:00?")).toBe(true);
	expect(app.value("id:question")).toBe("");
});

test("a lost confirmation stays unknown and is only checked, never resent", async () => {
	const app = await open("./Trouble.tsx", desktop);
	await app.waitFor("2 integration tests fail on Linux");
	await app.press(DECIDE);
	await app.waitFor("Pilot sent your answer but heard nothing back. It will not send it again until it checks.");
	expect(app.shows(DECIDE)).toBe(false);
	await app.press("role:button[Check again]");
	await app.waitFor("Checked Faster search: Your answer arrived.");
	await app.waitFor("Push not confirmed");
});

test("nothing waiting is said calmly", async () => {
	const app = await open("./Quiet.tsx", desktop);
	await app.waitFor("No decisions waiting. Pilot keeps going on its own.");
	expect(app.shows("You were reading the history slice in Native desktop app.")).toBe(true);
});

test("a large world keeps Today limited", async () => {
	const app = await open("./Large.tsx", desktop);
	await app.waitFor("103 earlier results are not shown here.");
});

test("the update workload reaches the screen", async () => {
	const app = await open("./Pulse.tsx", desktop);
	await app.waitFor("Working on update 4.");
	await app.waitFor("Update 4 landed with its checks.");
	await app.waitFor("104 earlier results are not shown here.");
});

test("a mission without a current report is not counted as not moving", async () => {
	const app = await open("./App.tsx", desktop);
	await app.waitFor("No current report  1");
	expect(app.shows("Not moving  2")).toBe(true);
	expect(app.shows("No report yet")).toBe(true);
	expect(app.shows("No report yet. One chat working.")).toBe(true);
	expect(app.shows("Agent report · 12 min ago · Verify")).toBe(true);
});

test("a mission opens with its report, tasks and working chats, and Escape goes back", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:mission-search");
	await app.waitFor("Show search results in under 200 ms for large workspaces.");
	for (const text of [
		"Latest report",
		"Next: Fix anything that fails, then open the release pull request.",
		"Agent report · 12 min ago · references not checked by Pilot",
		"Integration tests on Linux",
		"In progress",
		"Working now",
		"since 34 min ago",
		RUNNING,
	]) {
		expect(app.shows(text)).toBe(true);
	}
	expect(app.shows("Three short things need you.")).toBe(false);
	await app.keyboard.press("escape");
	await app.waitFor("Three short things need you.");
	await app.press("id:mission-docs");
	await app.waitFor("The task list is not available here yet.");
	await app.press("role:button[Back to Today]");
	await app.waitFor("Three short things need you.");
});

test("pause asks first, stays Pausing until its receipt, and resume brings it back", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:mission-search");
	await app.press("role:button[Pause mission]");
	await app.waitFor("Pause all work in Faster search?");
	await app.press("role:button[Cancel]");
	expect(app.shows("Pause all work in Faster search?")).toBe(false);
	await app.press("role:button[Pause mission]");
	await app.press(PAUSE);
	await app.waitFor("Stopping work at safe points. Not paused yet.");
	expect(app.shows("role:button[Resume]")).toBe(false);
	await app.waitFor("Paused. Nothing in it runs until you resume it.");
	expect(app.shows("#3 Integration tests on Linux")).toBe(true);
	expect(app.shows("role:button[Pause mission]")).toBe(false);
	await app.press("role:button[Resume]");
	await app.waitFor("Starting the paused work again.");
	await app.waitFor(RUNNING);
	await app.keyboard.press("escape");
	await app.waitFor("Moving  1");
});

test("a paused mission stays Not moving, and resumed without a current report it is unreported", async () => {
	const app = await open("./Trouble.tsx", desktop);
	await app.waitFor("Paused. Nothing in it runs until you resume it.");
	expect(app.shows("Old coordinator report · yesterday")).toBe(true);
	await app.press("id:mission-notify");
	await app.press("role:button[Resume]");
	await app.waitFor(RUNNING);
	await app.keyboard.press("escape");
	await app.waitFor("No current report  1");
	expect(app.shows("Old report")).toBe(true);
});

test("a lost pause answer stays unknown and is only checked, never resent", async () => {
	const app = await open("./Trouble.tsx", desktop);
	await app.press("id:mission-release");
	await app.press("role:button[Pause mission]");
	await app.press(PAUSE);
	await app.waitFor("Pilot asked to pause but heard nothing back. It will not ask again until it checks.");
	expect(app.shows("role:button[Pause mission]")).toBe(false);
	await app.press("role:button[Check again]");
	await app.waitFor("Paused. Nothing in it runs until you resume it.");
});

test("a pause that does not finish everywhere stays Pausing and names what needs a look", async () => {
	const app = await open("./Trouble.tsx", desktop);
	await app.press("id:mission-native");
	await app.press("role:button[Pause mission]");
	await app.press(PAUSE);
	await app.waitFor("Pausing did not finish everywhere. Some work needs a look.");
	expect(app.shows("Did not confirm")).toBe(true);
	expect(app.shows("The chat did not confirm its checkpoint.")).toBe(true);
	expect(app.shows("role:button[Pause mission]")).toBe(false);
	expect(app.shows("role:button[Resume]")).toBe(false);
});

test("offline keeps the last read visible and turns controls off", async () => {
	const app = await open("./Offline.tsx", desktop);
	await app.waitFor("Offline. Pilot's service is not answering. Showing what Pilot read 6 min ago.");
	expect(app.shows("Moving  1")).toBe(true);
	await app.press("id:mission-search");
	await app.waitFor("Pause and Resume need a fresh read.");
	expect(app.shows("role:button[Pause mission]")).toBe(false);
});

test("nothing readable is said plainly, with nothing guessed", async () => {
	const app = await open("./Unreadable.tsx", desktop);
	await app.waitFor("Today could not be read.");
	expect(app.shows("No decisions waiting. Pilot keeps going on its own.")).toBe(false);
	expect(app.shows("Missions")).toBe(false);
});

test("intents are typed: unknown keys and wrong types are refused in the call", async () => {
	const feed = new TodayFeed("decisions");
	let thrown = "";
	try {
		feed.later({ decisionId: "q1", revision: 1.5 });
	} catch (error) {
		thrown = String(error);
	}
	expect(thrown).toContain("TypeError");
	const extra = { decisionId: "q1", revision: 1, optionId: "a", daemonUrl: "http://127.0.0.1" };
	let rejected = "";
	await feed.decide(extra).catch((error: unknown) => {
		rejected = String(error);
	});
	expect(rejected).toContain("TypeError");
	expect(feed.snapshot().decisions[0].delivery).toBe("idle");
	const stale = feed.later({ decisionId: "q1", revision: 9 });
	expect(stale.status).toBe("stale");
	// A Pause names the mission and the revision shown; Rust adds the home,
	// project, coordinator and operation. TSX cannot supply them.
	const forged = { missionId: "search", revision: 0, coordinatorSessionId: "c-other" };
	let refused = "";
	await feed.pause(forged).catch((error: unknown) => {
		refused = String(error);
	});
	expect(refused).toContain("TypeError");
	const old = await feed.pause({ missionId: "search", revision: 5 });
	expect(old.status).toBe("stale");
	expect(feed.mission("search")?.row.control.delivery).toBe("idle");
	feed.dispose();
});

test("the screen's sandbox refuses network, sockets, files and processes", async () => {
	const app = await open("./BoundaryProbe.tsx", desktop);
	await app.waitFor("done");
	for (const line of [
		"fetch: ERR_ACCESS_DENIED",
		"socket: ERR_ACCESS_DENIED",
		"file: ERR_ACCESS_DENIED",
		"process: ERR_ACCESS_DENIED",
	]) {
		expect(app.shows(`text:${line}`)).toBe(true);
	}
});

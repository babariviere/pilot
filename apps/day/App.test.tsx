// The Today flows as a user takes them, the typed boundary as TSX sees it,
// and the sandbox that keeps TSX away from the daemon.
import { expect, open, test } from "nsh/test";
import { TodayFeed } from "pilot-day/native";

const desktop = { platform: "macos", width: 1100, height: 900 } as const;
/** The decision card's own commit, not a mission row's link to it. */
const DECIDE = "id:decision >> role:button[Decide]";
/** The confirmation's Pause, not the "Pause mission" that opens it. */
const PAUSE = "id:pause >> role:button[Pause]";
/** A mission that runs normally offers Pause at its top and shows no control panel. */
const RUNNING = "role:button[Pause mission]";

test("Today shows decisions first, then moving and waiting missions", async () => {
	const app = await open("./MockApp.tsx", desktop);
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
	const app = await open("./MockApp.tsx", desktop);
	await app.press(DECIDE);
	await app.waitFor("Quieter notifications has your answer: One summary at 18:00.");
	await app.waitFor("Two things left.");
	expect(app.shows("Open a test copy of Pilot on your Mac?")).toBe(true);
	expect(app.shows("Moving  2")).toBe(true);
});

test("a picked option is the one sent", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.press("Only failures and questions");
	await app.press(DECIDE);
	await app.waitFor("Quieter notifications has your answer: Only failures and questions.");
});

test("later moves a decision back without answering it", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.press("role:button[Later]");
	await app.waitFor("role:button[Confirm]");
	expect(app.shows("Up next: How should finished work reach you?")).toBe(true);
	expect(app.shows("has your answer")).toBe(false);
});

test("help: simpler words, more context, and a question answered in the card", async () => {
	const app = await open("./MockApp.tsx", desktop);
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

test("keys bring the next item forward and the focus lands on its choice", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor("1 of 3");
	await app.keyboard.press("j");
	await app.waitFor("2 of 3");
	expect(app.shows("Up next: How should finished work reach you?")).toBe(true);
	await app.keyboard.press("k");
	await app.waitFor("1 of 3");
	await app.keyboard.press("j");
	await app.waitFor("2 of 3");
	// The keyboard focus is on the chosen option, so Down picks the next one.
	await app.keyboard.press("down");
	await app.keyboard.press("mod+enter");
	await app.waitFor("Native desktop app has your answer: Skip it.");
	await app.waitFor("Two things left.");
});

test("keys pick an option and open help, and help sends nothing", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor("1 of 3");
	await app.keyboard.press("3");
	await app.keyboard.press("s");
	await app.waitFor("Pilot sends too many notifications. Choose when it should tell you about finished work.");
	await app.keyboard.press("c");
	await app.waitFor("Questions and failures still notify you right away with every option.");
	await app.keyboard.press("v");
	await app.waitFor("Last week, 35 of 41 notifications were finished work. Only 6 needed you.");
	expect(app.shows("From Notification chart, revision 2. It explains; it does not answer for you.")).toBe(true);
	expect(app.shows("Finished work")).toBe(true);
	expect(app.shows("Sending your answer…")).toBe(false);
	expect(app.shows("has your answer")).toBe(false);
	expect(app.shows("1 of 3")).toBe(true);
	await app.keyboard.press("l");
	await app.waitFor("Up next: How should finished work reach you?");
	expect(app.shows("has your answer")).toBe(false);
	await app.keyboard.press("k");
	await app.waitFor("3 of 3");
	// The pick survives Later; Command-Return sends exactly that.
	await app.keyboard.press("mod+enter");
	await app.waitFor("Quieter notifications has your answer: Only failures and questions.");
});

test("letters type into a question, Escape leaves it and its draft stays", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor("1 of 3");
	await app.keyboard.press("q");
	await app.keyboard.press("j");
	await app.keyboard.press("k");
	expect(app.value("id:question")).toBe("jk");
	expect(app.shows("1 of 3")).toBe(true);
	// Command-Return in the question does not decide.
	await app.keyboard.press("mod+enter");
	expect(app.shows("Sending your answer…")).toBe(false);
	await app.keyboard.press("escape");
	await app.keyboard.press("j");
	await app.waitFor("2 of 3");
	await app.keyboard.press("k");
	await app.waitFor("1 of 3");
	expect(app.value("id:question")).toBe("jk");
	expect(app.shows("has your answer")).toBe(false);
});

test("a lost answer to a question stays unknown and is only checked", async () => {
	const app = await open("./Trouble.tsx", desktop);
	await app.waitFor("1 of 2");
	await app.keyboard.press("j");
	await app.waitFor("2 of 2");
	await app.keyboard.press("q");
	await app.type("id:question", "What if it did not land?");
	await app.press("role:button[Ask]");
	await app.waitFor("No answer came back. Pilot will not ask again until it checks.");
	expect(app.value("id:question")).toBe("");
	await app.press("id:check-answer");
	await app.waitFor(
		"If it did not land, Pilot pushes once more, then tells you. It never pushes twice without checking.",
	);
	expect(app.shows("No answer came back. Pilot will not ask again until it checks.")).toBe(false);
});

test("an action shows what to do, the exact file, where it goes and who asked", async () => {
	const app = await open("./Actions.tsx", desktop);
	await app.waitFor("Two things need you.");
	expect(app.shows("Up next, action for you: Upload Pilot Helper 1.4.2 to the Chrome Web Store")).toBe(true);
	await app.keyboard.press("j");
	await app.waitFor("id:action");
	for (const text of [
		"Action for you",
		"pilot-helper-1.4.2.zip · version 1.4.2 · sha256 9f3c…a1d0",
		"Pilot Helper, package 1.4.2 on the Chrome Web Store",
		"text:https://chrome.google.com/webstore/devconsole",
		"“Ship the browser helper” · pilot://chat/db252a71-781a-458d-815f-41d42856d27d",
		"Uploading needs your Chrome Web Store developer account. Pilot cannot sign in to it.",
		"Opening the link or the file does not count. Only your report does.",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	expect(app.shows("Approve")).toBe(false);
	expect(app.enabled("role:button[Mark done]")).toBe(false);
	// Command-Return without a report asks for one and reports nothing.
	await app.keyboard.press("mod+enter");
	await app.waitFor("Say what you did first. Pilot needs it to go on.");
	await app.keyboard.press("escape");
	await app.type("id:report", "Downloaded the zip");
	await app.press("role:button[Save progress]");
	await app.waitFor("Progress saved. This is not done yet.");
	expect(app.shows("Saved progress: Downloaded the zip")).toBe(true);
	expect(app.shows("You reported done")).toBe(false);
	await app.press("role:button[Later]");
	await app.waitFor("Up next, action for you: Upload Pilot Helper 1.4.2 to the Chrome Web Store");
	await app.keyboard.press("j");
	await app.waitFor("Action for you · put off");
	expect(app.shows("Saved progress: Downloaded the zip")).toBe(true);
});

test("a replaced file refuses the old report, and a lost answer is only checked", async () => {
	const app = await open("./Actions.tsx", desktop);
	await app.keyboard.press("j");
	await app.type("id:report", "Uploaded 1.4.2");
	await app.press("role:button[Mark done]");
	await app.waitFor("Nothing was saved: this action changed before your request arrived. Read it again.");
	expect(app.shows("Pilot replaced this request with a new file: pilot-helper-1.4.3.zip (version 1.4.3).")).toBe(true);
	expect(app.shows("pilot-helper-1.4.3.zip · version 1.4.3 · sha256 41be…07c2")).toBe(true);
	// The draft stays, so the user corrects it rather than typing it again.
	expect(app.value("id:report")).toBe("Uploaded 1.4.2");
	await app.clear("id:report");
	await app.type("id:report", "Uploaded 1.4.3; the dashboard shows 1.4.3");
	await app.press("role:button[Mark done]");
	await app.waitFor("Pilot sent your report but heard nothing back. It will not send it again until it checks.");
	expect(app.shows("role:button[Mark done]")).toBe(false);
	await app.press("role:button[Check again]");
	await app.waitFor(
		"You reported done: Upload Pilot Helper 1.4.3 to the Chrome Web Store. Pilot has not checked the Chrome Web Store itself.",
	);
	await app.waitFor("One thing left.");
	expect(app.shows("id:action")).toBe(false);
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
	await app.waitFor("Nothing needs you. Pilot keeps going on its own.");
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
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor("No current report  1");
	expect(app.shows("Not moving  2")).toBe(true);
	expect(app.shows("No report yet")).toBe(true);
	expect(app.shows("No report yet. One chat working.")).toBe(true);
	expect(app.shows("Agent report · 12 min ago · Verify")).toBe(true);
});

test("a mission opens with its report, tasks and working chats, and Escape goes back", async () => {
	const app = await open("./MockApp.tsx", desktop);
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

test("a mission's overview leads to its interview and plan, which says when there is none", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.press("id:mission-search");
	await app.waitFor("id:mission-plan");
	expect(app.shows("Interview and plan")).toBe(true);
	await app.press("id:open-plan");
	await app.waitFor("This mission is not in planning.");
	// The mission is on Today, so its overview is the one step back.
	await app.press("role:button[Back to Mission overview]");
	await app.waitFor("id:mission-plan");
	await app.keyboard.press("escape");
	await app.waitFor("Three short things need you.");
});

test("the default and connected entries without a service say so and show no mock data", async () => {
	for (const entry of ["./App.tsx", "./Connected.tsx"]) {
		const app = await open(entry, desktop);
		await app.waitFor("id:not-connected");
		expect(
			app.shows("This window was not opened for a Pilot service, so it shows nothing rather than examples."),
		).toBe(true);
		for (const text of ["Mock data", "Needs you", "Three short things need you."]) {
			expect(app.shows(text)).toBe(false);
		}
	}
});

test("pause asks first, stays Pausing until its receipt, and resume brings it back", async () => {
	const app = await open("./MockApp.tsx", desktop);
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
	expect(app.shows("Nothing needs you. Pilot keeps going on its own.")).toBe(false);
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
	// Help and actions name the revision shown, too.
	const oldAsk = await feed.ask({ decisionId: "q1", revision: 9, question: "Why?" });
	expect(oldAsk.status).toBe("stale");
	expect(feed.snapshot().decisions[0].answers).toEqual([]);
	let forgedAsk = "";
	await feed.ask({ decisionId: "q1", question: "Why?" } as never).catch((error: unknown) => {
		forgedAsk = String(error);
	});
	expect(forgedAsk).toContain("TypeError");
	const old = await feed.pause({ missionId: "search", revision: 5 });
	expect(old.status).toBe("stale");
	expect(feed.mission("search")?.row.control.delivery).toBe("idle");
	feed.dispose();
});

test("action reports name the revision shown and cannot carry extra authority", async () => {
	const feed = new TodayFeed("actions");
	const action = feed.snapshot().actions[0];
	const stale = await feed.complete({ actionId: action.id, revision: action.revision + 3, report: "Uploaded" });
	expect(stale.status).toBe("stale");
	let forged = "";
	await feed
		.complete({ actionId: action.id, revision: action.revision, report: "Uploaded", source: "agent" } as never)
		.catch((error: unknown) => {
			forged = String(error);
		});
	expect(forged).toContain("TypeError");
	const nothing = await feed.checkAction({ actionId: action.id });
	expect(nothing.status).toBe("rejected");
	expect(feed.snapshot().actions[0].delivery).toBe("idle");
	expect(feed.snapshot().notes).toEqual([]);
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

test("New lists requests nobody started, newest first, and counts what it does not show", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor("id:incoming");
	for (const text of [
		"From Slack and Linear",
		"Northwind can't export invoices to CSV",
		"Slack · #client-northwind · 20 min ago",
		"Update the Stripe SDK to v15",
		"CSV export times out for large accounts",
		"Linear · BIL-231 · 3 h ago",
		"1 more Slack message is not shown here.",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	// A request someone already started is not new.
	expect(app.shows("Invoice PDF footer overlaps totals")).toBe(false);
});

test("a request opens in place, says where it came from and sends nothing", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.waitFor("id:incoming");
	expect(app.shows("id:request-detail-sl-northwind")).toBe(false);
	await app.press("id:request-sl-northwind");
	await app.waitFor("id:request-detail-sl-northwind");
	expect(app.shows("Bug, high")).toBe(true);
	expect(app.shows("text:https://example.slack.com/archives/C0MOCK/psl-northwind")).toBe(true);
	expect(app.shows("This window shows examples, so nothing here can start, put off or discard a request.")).toBe(true);
	expect(app.shows("role:button[Start]")).toBe(false);
	// One open at a time; the keyboard focus stays on the pressed row, so Space closes it.
	await app.press("id:request-sl-stripe");
	await app.waitFor("id:request-detail-sl-stripe");
	expect(app.shows("id:request-detail-sl-northwind")).toBe(false);
	await app.keyboard.press("space");
	expect(app.shows("id:request-detail-sl-stripe")).toBe(false);
	// Opening a request answered, started and recorded nothing.
	expect(app.shows("Three short things need you.")).toBe(true);
	expect(app.shows("1 of 3")).toBe(true);
	expect(app.shows("Northwind can't export invoices to CSV")).toBe(true);
});

test("a request source that needs sign-in says so and keeps what Pilot read before", async () => {
	const app = await open("./Trouble.tsx", desktop);
	await app.waitFor("id:incoming");
	expect(app.shows("Slack needs you to sign in again. These are the requests Pilot read before.")).toBe(true);
	expect(app.shows("Northwind can't export invoices to CSV")).toBe(true);
});

test("without a request source Today shows no New section", async () => {
	const app = await open("./Quiet.tsx", desktop);
	await app.waitFor("Coming up");
	expect(app.shows("id:incoming")).toBe(false);
});

test("a mission's tasks show what their agents linked, and merged is not released", async () => {
	const app = await open("./MockApp.tsx", desktop);
	await app.press("id:mission-native");
	await app.waitFor("id:outputs-native-4");
	for (const text of [
		"PR #431 · Load older messages while streaming",
		"Open, not merged. state last checked 5 min ago. Checks not observed.",
		"Scroll position, 12 capture runs",
		"Artifact, revision 2",
		"PR #412 · Native chat view",
		"Merged yesterday. state last checked 5 min ago. Checks not observed.",
		"Merged is not released. Pilot does not track releases.",
	]) {
		expect(app.shows(text)).toBe(true);
	}
});

// New, mission interviews, Wayfinder maps and plan review as a user takes
// them, and the typed planning boundary as TSX sees it. Mock data only:
// these prove the screens and the mock rules, not the daemon's services
// (native/tests/plan_host.rs maps the real host's reads and writes).
import { expect, open, test } from "nsh/test";
import { PlanFeed, type PlanPage, type PlanRow } from "pilot-day/native";
import { olderThanList } from "./planCurrent";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;
const SUBMIT = "id:submit";

type App = Awaited<ReturnType<typeof open>>;

/** Writes in question `id`'s text field, opening it first the way a user does (0, or the row). */
async function write(app: App, id: string, text: string) {
	if (!app.shows(`id:answer-${id}`)) await app.press(`id:own-${id}`);
	await app.type(`id:answer-${id}`, text);
}

/** Goes to question `id` through the answers page, as a user would without the keyboard. */
async function goTo(app: App, id: string) {
	if (app.shows("id:goto-review")) await app.press("id:goto-review");
	await app.press(`id:review-${id}`);
	await app.waitFor(`id:question-${id}`);
}

test("Today shows New and a mission whose questions wait", async () => {
	const app = await open("./App.tsx", desktop);
	await app.waitFor("Planning");
	for (const text of ["Export a chat as Markdown", "Questions for you", "3 of 7 answered", "role:button[New]"]) {
		expect(app.shows(text)).toBe(true);
	}
	expect(app.shows("Three short things need you.")).toBe(true);
});

test("one question at a time, starting at the first without an answer; a recommendation is not an answer", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:plan-export");
	await app.waitFor("id:interview");
	expect(app.shows("Question 2 of 7 · 3 answered")).toBe(true);
	expect(app.shows("What should one export include?")).toBe(true);
	expect(app.shows("Who is the export for?")).toBe(false);
	expect(app.shows("Recommended")).toBe(true);
	expect(app.shows("id:own-what")).toBe(true);
	expect(app.shows("role:button[Skip for now]")).toBe(true);
	expect(app.shows(SUBMIT)).toBe(false);
	// Earlier answers are there, exactly, when the user goes back.
	await goTo(app, "size");
	await app.waitFor("How large can one export be?");
	expect(app.value("id:answer-size")).toBe("Warn above 5 MB; never stop.");
	await app.press("role:button[‹ Back]");
	await app.waitFor("Where may Pilot write the file?");
});

test("skipped questions stay unanswered and block the one Submit until every question is answered", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:plan-export");
	await app.waitFor("Question 2 of 7 · 3 answered");
	await app.press("role:button[Skip for now]");
	await app.waitFor("Question 3 of 7 · 3 answered");
	await goTo(app, "pr");
	await app.press("Yes, open it and wait for my review");
	await app.waitFor("Question 7 of 7 · 4 answered");
	await goTo(app, "check");
	await write(app, "check", "A long chat opens in Obsidian");
	await app.waitFor("Question 6 of 7 · 5 answered");
	await app.keyboard.press("mod+enter");
	await app.waitFor("Question 7 of 7 · 5 answered");
	await app.press("role:button[Check answers]");
	await app.waitFor("Check your answers");
	expect(app.count("text:Not answered")).toBe(2);
	expect(app.shows("A long chat opens in Obsidian")).toBe(true);
	expect(app.shows("2 questions left. Pilot continues only after you submit.")).toBe(true);
	expect(app.enabled(SUBMIT)).toBe(false);
	// Nothing continued from saving or moving around.
	expect(app.shows("Pilot continues planning: Not yet")).toBe(true);
	await app.press("role:button[Next unanswered]");
	await app.waitFor("What should one export include?");
	await app.press("Messages and tool results");
	await goTo(app, "where");
	await app.press("Ask every time, with a save panel");
	await write(app, "where", "Remember the last folder");
	await app.waitFor("Question 4 of 7 · 7 answered");
	await app.press("id:goto-review");
	await app.waitFor("Submitting sends every answer at once. Nothing starts building.");
	expect(app.shows("What it should achieve · 2 of 2")).toBe(true);
	await app.press(SUBMIT);
	await app.waitFor("Pilot continues planning: Done");
	// Only the answer about tool results raises a new round, with new questions only.
	await app.waitFor("Questions, round 2");
	expect(app.shows("Your answer about tool results raised two more questions.")).toBe(true);
	expect(app.shows("New questions only. Earlier answers stay as they were, under Earlier interview rounds.")).toBe(
		true,
	);
	expect(app.shows("Question 1 of 2 · 0 answered")).toBe(true);
	expect(app.shows("Tool results can hold secrets. What should an export do with them?")).toBe(true);
	expect(app.shows("7 answers, submitted")).toBe(true);
	expect(app.shows("Who is the export for?")).toBe(false);
	// Round 1 is history to read, not rows to answer again.
	await app.press("id:round-export-1");
	await app.waitFor("id:round-answers-export-1");
	expect(app.shows("Who is the export for?")).toBe(true);
	expect(app.shows("id:answer-who")).toBe(false);
});

test("See all shows every question to answer freely; it answers and submits nothing by itself", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:plan-export");
	await app.waitFor("id:interview");
	await app.press("id:see-all");
	await app.waitFor("id:all-questions");
	for (const text of [
		"Who is the export for?",
		"What should one export include?",
		"Should other formats wait?",
		"Where may Pilot write the file?",
		"How large can one export be?",
		"How will you know it works?",
		"May Pilot open a pull request when it is done?",
		"Question 7 of 7",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	expect(app.shows("3 of 7 answered")).toBe(true);
	expect(app.enabled(SUBMIT)).toBe(false);
	expect(app.shows("Pilot continues planning: Not yet")).toBe(true);
	await app.press("id:question-pr >> No, keep it local until I say");
	await write(app, "check", "Opens in Obsidian");
	await app.waitFor("5 of 7 answered");
	await app.press("id:see-all");
	// Back to one at a time, at the question last answered.
	await app.waitFor("Question 6 of 7 · 5 answered");
	expect(app.shows("id:all-questions")).toBe(false);
});

test("switching suggestions keeps the text, and drafts come back after leaving", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:plan-export");
	await app.waitFor("What should one export include?");
	await app.press("Messages only");
	await write(app, "what", "Skip images");
	await app.press("Messages, tool results and artifacts");
	expect(app.value("id:answer-what")).toBe("Skip images");
	// Pressing the chosen suggestion again clears it; the text becomes the answer.
	await app.press("Messages, tool results and artifacts");
	expect(app.value("id:answer-what")).toBe("Skip images");
	await app.waitFor("Question 2 of 7 · 4 answered");
	await app.press("role:button[Back to Today]");
	await app.waitFor("4 of 7 answered");
	await app.press("id:plan-export");
	await goTo(app, "what");
	await app.waitFor("What should one export include?");
	expect(app.value("id:answer-what")).toBe("Skip images");
});

test("typing keeps its focus and text while answers save", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:plan-export");
	await goTo(app, "check");
	await write(app, "check", "Opens");
	await app.waitFor("Question 6 of 7 · 4 answered");
	for (const key of ["f", "a", "s", "t"]) await app.keyboard.press(key);
	expect(app.value("id:answer-check")).toBe("Opensfast");
	await app.waitFor("Saved");
	expect(app.value("id:answer-check")).toBe("Opensfast");
});

test("a changed question keeps the earlier answer but needs a new one; a lost submission is only checked", async () => {
	const app = await open("./PlanTrouble.tsx", desktop);
	await app.press("id:plan-export");
	await app.waitFor("Question 4 of 7 · 5 answered");
	expect(app.shows("This question changed after you answered. Answer it again.")).toBe(true);
	expect(app.shows("Your earlier answer: Always the Downloads folder")).toBe(true);
	await app.press("The folder you picked last time");
	await goTo(app, "check");
	expect(app.shows("Your earlier answer: Any chat exports without errors. Including chats with images.")).toBe(true);
	expect(app.value("id:answer-check")).toBe("Including chats with images.");
	await app.press("A 2,000-message chat exports in under 2 seconds");
	await app.waitFor("Question 6 of 7 · 7 answered");
	await app.press("id:goto-review");
	await app.press(SUBMIT);
	await app.waitFor("Pilot sent your answers but heard nothing back. It will not send them again until it checks.");
	expect(app.shows("Not confirmed")).toBe(true);
	expect(app.shows(SUBMIT)).toBe(false);
	await app.press("role:button[Check again]");
	await app.waitFor("Pilot continues planning: Done");
	await app.waitFor("Questions, round 2");
});

test("a topic interview whose map changed keeps answers but cannot be submitted", async () => {
	const app = await open("./PlanTrouble.tsx", desktop);
	await app.press("id:plan-linux");
	await app.waitFor("Questions about “Which desktops count”");
	await app.press("GNOME and KDE");
	await goTo(app, "working");
	await app.press("Today, New and chats work; no tray icon");
	await goTo(app, "packages");
	await app.press("No. One portable package");
	await app.waitFor("Question 3 of 3 · 3 answered");
	await app.press("id:goto-review");
	await app.waitFor(
		"The plan changed since these questions were asked. Your answers are kept, but they cannot be submitted. Pilot will ask again.",
	);
	expect(app.enabled(SUBMIT)).toBe(false);
});

test("a plan that changes during review closes the review; the earlier choice does not count", async () => {
	const app = await open("./PlanTrouble.tsx", desktop);
	await app.press("id:plan-search");
	await app.waitFor("id:proposal");
	expect(app.count("id:slice-index")).toBe(1);
	await app.press("Yes. Publish it as tasks; start nothing yet");
	await app.waitFor(
		"Pilot changed the plan while you were reviewing it. Your earlier choice does not count. Read the plan again.",
	);
	await app.waitFor("Rebuild after branch switch");
	expect(app.shows("Question 1 of 1 · 0 answered")).toBe(true);
	expect(app.shows("Closed: the plan changed, so this review does not count")).toBe(true);
});

test("a review shows the whole plan; approval, publication and work are separate", async () => {
	const app = await open("./Review.tsx", desktop);
	await app.press("id:plan-export");
	await app.waitFor("id:proposal");
	for (const text of [
		"Chats cannot leave Pilot. People copy messages by hand and lose tool results.",
		"How it is tested",
		"• A headless test of the menu command and a cancelled save panel",
		"Tasks it would become · 3",
		"UI (Opus) · Backend (Sol)",
		"After: Markdown writer · Stories: s1, s2",
		"• How exports should look on phones. Not explored yet.",
		"Should Pilot publish this plan as tasks?",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	await app.press("Yes. Publish it as tasks; start nothing yet");
	await app.press("role:button[Check answers]");
	await app.waitFor("1 of 1 answered");
	await app.press("role:button[Send review]");
	await app.waitFor("Plan approved: Done");
	expect(app.shows("Work started: Not here")).toBe(true);
	await app.waitFor("Published as tasks: Done");
	expect(app.shows("Published as 3 tasks. No work started.")).toBe(true);
});

test("when Pilot cannot continue, the submitted answers are kept and every later step says so", async () => {
	const app = await open("./Held.tsx", desktop);
	await app.press("id:plan-export");
	await app.press("id:see-all");
	await app.press("id:question-what >> Messages only");
	await app.press("id:question-where >> Ask every time, with a save panel");
	await app.press("id:question-check >> A 2,000-message chat exports in under 2 seconds");
	await app.press("id:question-pr >> Yes, open it and wait for my review");
	await app.waitFor("7 of 7 answered");
	await app.press(SUBMIT);
	await app.waitFor("Pilot continues planning: Not here");
	expect(app.shows("Not connected here yet. Your submitted answers are kept.")).toBe(true);
	expect(app.shows("Submitted, waiting to continue")).toBe(true);
	await app.wait(1200);
	expect(app.shows("id:proposal")).toBe(false);
});

test("a 40-question interview shows one at a time, and all of them on See all", async () => {
	const app = await open("./Long.tsx", desktop);
	await app.press("id:plan-long");
	await app.waitFor("Question 1 of 40 · 5 answered");
	await goTo(app, "q40");
	await app.waitFor("Question 40: which way should setting group 40 go?");
	expect(app.shows("Question 40 of 40 · 5 answered")).toBe(true);
	await app.press("id:see-all");
	await app.waitFor("id:all-questions");
	expect(app.shows("Question 1: which way should setting group 1 go?")).toBe(true);
	expect(app.shows("Question 40: which way should setting group 40 go?")).toBe(true);
	expect(app.enabled(SUBMIT)).toBe(false);
});

test("a Wayfinder map shows what is open, waiting, settled and in fog, each with its record", async () => {
	const app = await open("./Wayfinder.tsx", desktop);
	await app.press("id:plan-linux");
	await app.waitFor("id:map");
	for (const text of [
		"Where it should end up: Pilot Day runs on Linux with the same Today and planning as on macOS.",
		"Revision 6",
		"3 settled · 4 open now · 1 waiting · 2 in fog",
		"Open now  4",
		"Waiting  1",
		"Running · A research chat, started 12 min ago",
		"Waits for: Packaging formats",
		"Needs a prototype",
		"Prototypes are not available yet. Pilot does not make or guess one.",
		"1 question cites a record that changed. Pilot updates the map from it; nothing here needs you.",
		"Settled · 3",
		"Fog of war · 2",
		"Questions about “Which desktops count”",
	]) {
		expect(app.shows(text)).toBe(true);
	}
	// Settled questions stay closed until asked for, and each opens to what settled it.
	expect(app.shows("Wayland or X11")).toBe(false);
	await app.press("id:settled-toggle");
	await app.waitFor("Wayland or X11");
	expect(app.shows("Settled by Decision 4. It changed since.")).toBe(true);
	expect(app.shows("Decision 4 changed after Pilot cited it.")).toBe(true);
	await app.press("id:explore-scope");
	await app.waitFor("id:settled-round-scope");
	expect(app.shows("Round 1 · your answers, as submitted")).toBe(true);
	await app.press("id:explore-keyring");
	await app.waitFor("From Knowledge: Linux keyring access, revision 3 · Was fog: Where credentials live");
	// A prototype's finding is evidence, shown with what it left open; it answers nothing.
	await app.press("id:explore-status-line");
	await app.waitFor("Finding: supported. It matches this map.");
	expect(app.shows("• Is a status line enough for you, or do you also want a notification?")).toBe(true);
	expect(app.shows("A status line instead of a tray")).toBe(true);
	expect(app.shows("Accessibility on Linux")).toBe(false);
	await app.press("id:fog-toggle");
	await app.waitFor("Accessibility on Linux");
	expect(app.shows("Ready when: Once the desktops are chosen.")).toBe(true);
	expect(app.shows("Became: Keyring access")).toBe(true);
	await app.press("id:see-all");
	await app.press("id:question-first >> GNOME and KDE");
	await app.press("id:question-working >> Today, New and chats work; no tray icon");
	await app.press("id:question-packages >> No. One portable package");
	await app.waitFor("3 of 3 answered");
	await app.press(SUBMIT);
	await app.waitFor("Answered in interview round 2");
	expect(app.shows("Revision 7")).toBe(true);
	expect(app.shows("4 settled · 3 open now · 1 waiting · 2 in fog")).toBe(true);
	expect(app.shows("Ready when: Ready to explore: the desktops are chosen.")).toBe(true);
});

test("New plans a mission from the user's words, or starts one chat after a confirmation", async () => {
	const app = await open("./NewMission.tsx", desktop);
	await app.keyboard.press("mod+n");
	await app.waitFor("What do you want done?");
	expect(app.enabled("role:button[Plan a mission]")).toBe(false);
	await app.type("id:goal", "Fix the flaky upload test");
	await app.press("role:button[Start as one chat]");
	await app.waitFor("Start one chat with exactly these words?");
	expect(app.shows("pilot · Default model · Build: edits files in its own workspace")).toBe(true);
	await app.keyboard.press("escape");
	expect(app.shows("Start one chat with exactly these words?")).toBe(false);
	await app.press("role:button[Start as one chat]");
	await app.press("role:button[Start chat]");
	await app.waitFor("Started a new Build chat with your words.");
	expect(app.shows("Started. It works on its own and is not part of a mission.")).toBe(true);
	expect(app.shows("Missions in planning")).toBe(false);
	await app.type("id:goal", "Let people export a chat as Markdown");
	await app.press("role:button[Plan a mission]");
	await app.waitFor("id:interview");
	expect(app.shows("You asked: Let people export a chat as Markdown")).toBe(true);
	expect(app.shows("Question 1 of 5 · 0 answered")).toBe(true);
	expect(app.shows("Pilot continues planning: Not yet")).toBe(true);
});

test("without planning, New says why and sends nothing", async () => {
	const app = await open("./PlanOff.tsx", desktop);
	// Today says the list cannot be read, apart from having none, and shows no rows.
	await app.waitFor("id:planning-off");
	expect(app.shows("Pilot cannot show missions in planning here.")).toBe(true);
	expect(app.shows("Planning is not connected in this build.")).toBe(true);
	expect(app.shows("This is not the same as having none.")).toBe(true);
	// The mock feed cannot read again, so it offers no Read again.
	expect(app.shows("Read again")).toBe(false);
	await app.press("role:button[New]");
	await app.waitFor("id:planning-off");
	expect(app.shows("Planning is not connected in this build. Nothing can be sent from here.")).toBe(true);
	expect(app.enabled("role:button[Plan a mission]")).toBe(false);
	expect(app.enabled("role:button[Start as one chat]")).toBe(false);
});

test("Today hides Planning when none is in planning, and each row opens its own interview", async () => {
	const none = await open("./NewMission.tsx", desktop);
	await none.waitFor("role:button[New]");
	expect(none.shows("id:planning")).toBe(false);
	expect(none.shows("id:planning-off")).toBe(false);
	const some = await open("./Wayfinder.tsx", desktop);
	await some.waitFor("id:planning");
	expect(some.shows("id:planning-off")).toBe(false);
	expect(some.shows("id:plan-export")).toBe(true);
	expect(some.shows("id:plan-linux")).toBe(true);
	// The row opens that mission's own interview, and Escape comes back to Today
	// with the focus on that row: Space opens it again.
	await some.press("id:plan-export");
	await some.waitFor("id:interview");
	expect(some.shows("Export a chat as Markdown")).toBe(true);
	expect(some.shows("id:planning")).toBe(false);
	await some.keyboard.press("escape");
	await some.waitFor("id:planning");
	await some.keyboard.press("space");
	await some.waitFor("id:interview");
	expect(some.shows("Export a chat as Markdown")).toBe(true);
});

test("a planning page is older only when a later list names a newer interview", async () => {
	const feed = new PlanFeed("interview");
	await feed.open("export");
	const read = feed.page("export");
	if (!read?.interview) throw new Error("the interview is open");
	const page: PlanPage = {
		...read,
		interview: { ...read.interview, id: "enrollment-2", questionSet: 2, revision: 4 },
	};
	const row = (interviewId: string, interviewRevision: number, needsYou = true): PlanRow => ({
		missionId: "export",
		title: "Export a chat as Markdown",
		stage: needsYou ? "questions" : "planning",
		line: "",
		needsYou,
		identity: { interviewId, interviewRevision, planRevision: null },
	});
	// The same interview: only a newer revision ages the page; one that lags does not.
	expect(olderThanList(page, row("enrollment-2", 4))).toBe(false);
	expect(olderThanList(page, row("enrollment-2", 5))).toBe(true);
	expect(olderThanList(page, row("enrollment-2", 3))).toBe(false);
	// Another round of the same enrollment: a later round ages it, an earlier one lags.
	expect(olderThanList(page, row("enrollment-3", 1))).toBe(true);
	expect(olderThanList(page, row("enrollment-1", 9))).toBe(false);
	// Another enrollment, or a name that is not "<enrollment>-<round>", is never taken as current.
	expect(olderThanList(page, row("other-2", 4))).toBe(true);
	expect(olderThanList(page, row("nodash", 4))).toBe(true);
	expect(olderThanList(page, row("enrollment-x", 4))).toBe(true);
	// A mission no longer listed, or a row with no identity, says nothing about the page.
	expect(olderThanList(page, undefined)).toBe(false);
	expect(olderThanList(page, { ...row("enrollment-2", 9), identity: null })).toBe(false);
	// Questions wait but the page shows none: older. Nothing waits: not older.
	const empty: PlanPage = { ...read, interview: null };
	expect(olderThanList(empty, row("enrollment-2", 4))).toBe(true);
	expect(olderThanList(empty, row("enrollment-2", 4, false))).toBe(false);
	// A page that cannot be shown is never aged.
	expect(olderThanList({ ...page, available: false }, row("enrollment-9", 9))).toBe(false);
});

test("planning intents are typed, name what was shown, need every answer and never submit twice", async () => {
	const feed = new PlanFeed("wayfinder");
	expect((await feed.open("linux")).status).toBe("accepted");
	const topic = feed.page("linux")?.interview;
	const other = feed.page("export")?.interview;
	if (!topic || !other) throw new Error("both interviews are open");
	const q = other.questions[0];
	// A topic interview answers only its own topic.
	const crossed = await feed.saveAnswer({
		interviewId: topic.id,
		questionSet: topic.questionSet,
		questionId: q.id,
		digest: q.digest,
		choiceId: q.choices[0].id,
		text: "",
	});
	expect(crossed.status).toBe("rejected");
	let forged = "";
	await feed
		.saveAnswer({
			interviewId: other.id,
			questionSet: other.questionSet,
			questionId: q.id,
			digest: q.digest,
			choiceId: null,
			text: "",
			coordinator: "c-1",
		} as never)
		.catch((error: unknown) => {
			forged = String(error);
		});
	expect(forged).toContain("TypeError");
	const stale = await feed.saveAnswer({
		interviewId: other.id,
		questionSet: other.questionSet,
		questionId: q.id,
		digest: "earlier",
		choiceId: q.choices[0].id,
		text: "",
	});
	expect(stale.status).toBe("stale");
	expect(feed.page("export")?.interview?.revision).toBe(other.revision);
	// Every question needs an answer: two of three is refused.
	for (const question of topic.questions.slice(0, 2)) {
		const saved = await feed.saveAnswer({
			interviewId: topic.id,
			questionSet: topic.questionSet,
			questionId: question.id,
			digest: question.digest,
			choiceId: question.choices[0].id,
			text: "",
		});
		expect(saved.status).toBe("accepted");
	}
	const partial = feed.page("linux")?.interview;
	if (!partial) throw new Error("still open");
	const early = await feed.submit({ interviewId: partial.id, revision: partial.revision, proposal: "" });
	expect(early.status).toBe("rejected");
	expect(early.message).toBe("Answer every question first. One is left.");
	const last = topic.questions[2];
	await feed.saveAnswer({
		interviewId: topic.id,
		questionSet: topic.questionSet,
		questionId: last.id,
		digest: last.digest,
		choiceId: null,
		text: "Any distribution with Flatpak",
	});
	const now = feed.page("linux")?.interview;
	if (!now) throw new Error("still open");
	const first = feed.submit({ interviewId: now.id, revision: now.revision, proposal: "" });
	const second = await feed.submit({ interviewId: now.id, revision: now.revision, proposal: "" });
	expect(second.status).toBe("rejected");
	expect((await first).status).toBe("accepted");
	const steps = feed.page("linux")?.steps ?? [];
	expect(steps.find((s) => s.label === "Work started")?.state).toBe("unavailable");
	feed.dispose();
});

test("keys answer fast: digits pick, 0 opens the text field, Return moves on and Escape comes back", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:plan-export");
	await app.waitFor("Question 2 of 7 · 3 answered");
	for (const hint of ["1–3", "pick", "write", "next"]) expect(app.shows(hint)).toBe(true);
	await app.keyboard.press("3");
	await app.waitFor("Question 2 of 7 · 4 answered");
	await app.keyboard.press("enter");
	await app.waitFor("Question 3 of 7 · 4 answered");
	await app.keyboard.press("enter");
	await app.waitFor("Where may Pilot write the file?");
	await app.keyboard.press("0");
	// The keyboard is in the field now: letters and digits type.
	for (const key of ["a", "s", "k", "1"]) await app.keyboard.press(key);
	expect(app.value("id:answer-where")).toBe("ask1");
	await app.waitFor("Question 4 of 7 · 5 answered");
	await app.keyboard.press("escape");
	await app.keyboard.press("1");
	await app.waitFor("Saved");
	expect(app.value("id:answer-where")).toBe("ask1");
	await app.keyboard.press("k");
	await app.waitFor("Should other formats wait?");
});

test("earlier rounds are history with their answers, apart from the plan's approval", async () => {
	const app = await open("./Review.tsx", desktop);
	await app.press("id:plan-export");
	await app.waitFor("id:rounds");
	expect(app.shows("Earlier interview rounds")).toBe(true);
	expect(
		app.shows("Submitting a round completes that round. It is not agreement to the plan or approval to build."),
	).toBe(true);
	expect(app.shows("Plan approved: Not yet")).toBe(true);
	expect(app.shows("Yes, open it and wait for my review. Mark it as a draft first.")).toBe(false);
	await app.press("id:round-export-1");
	await app.waitFor("Yes, open it and wait for my review. Mark it as a draft first.");
	expect(app.shows("id:round-answers-export-1")).toBe(true);
	// A review that closed because the plan changed does not count.
	const trouble = await open("./PlanTrouble.tsx", desktop);
	await trouble.press("id:plan-search");
	await trouble.press("Yes. Publish it as tasks; start nothing yet");
	await trouble.waitFor("Closed: the plan changed, so this review does not count");
	expect(trouble.shows("Plan approved: Not yet")).toBe(true);
});

test("pressing the chosen suggestion again clears it, by click or by its key", async () => {
	const app = await open("./App.tsx", desktop);
	await app.press("id:plan-export");
	await app.waitFor("Question 2 of 7 · 3 answered");
	await app.press("Messages only");
	await app.waitFor("Question 2 of 7 · 4 answered");
	await app.press("Messages only");
	await app.waitFor("Question 2 of 7 · 3 answered");
	expect(app.shows("role:button[Skip for now]")).toBe(true);
	await app.keyboard.press("2");
	await app.waitFor("Question 2 of 7 · 4 answered");
	await app.keyboard.press("2");
	await app.waitFor("Question 2 of 7 · 3 answered");
	// Own words stay the answer when the suggestion is cleared.
	await app.keyboard.press("1");
	await write(app, "what", "Skip images");
	await app.keyboard.press("escape");
	await app.keyboard.press("1");
	await app.wait(1200);
	expect(app.shows("Question 2 of 7 · 4 answered")).toBe(true);
	expect(app.value("id:answer-what")).toBe("Skip images");
});

// The feedback page on a scripted source (FeedbackFixture.tsx). No daemon,
// provider or storage. Headless: not native appearance, focus or IME.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1600 } as const;

test("pasted screenshots retry the same upload, survive reopening, and clear only with the exact Send receipt", async () => {
	const png =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
	const reference = { uploadId: "00000000-0000-4000-8000-000000000001", sha256: "a".repeat(64), bytes: 70 };
	const uploads: unknown[] = [];
	let reservations = 0;
	const app = await open("./FeedbackFixture.tsx", {
		...desktop,
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"Clipboard.readImage": { url: png, size: { width: 1, height: 1 } },
				"host.call": async (_name: string, envelope: { args: { uploadId?: string } }) => {
					if (!envelope.args.uploadId) {
						reservations++;
						return { version: 1, value: { uploadId: reference.uploadId } };
					}
					uploads.push(envelope.args);
					return uploads.length === 1
						? { version: 1, error: "offline" }
						: { version: 1, value: { image: reference } };
				},
			},
		},
	});
	await app.press("id:feedback-open");
	await app.type("id:feedback-text", "This popup blocks my work");
	await app.press("id:feedback-image-paste");
	await app.waitFor("id:feedback-image-retry");
	expect(app.enabled("id:feedback-send")).toBe(false);
	await app.press("id:feedback-image-retry");
	await app.waitFor("Image 1 attached");
	expect(reservations).toBe(1);
	expect(uploads).toEqual([
		{ uploadId: reference.uploadId, data: png },
		{ uploadId: reference.uploadId, data: png },
	]);
	await app.press("Save and reopen");
	await app.waitFor("Image 1 attached");
	await app.press("Next unknown");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-unknown");
	expect(app.shows("Image 1 attached")).toBe(true);
	await app.press("id:feedback-check");
	await app.waitFor("Your feedback was saved.");
	expect(app.shows("Image 1 attached")).toBe(false);
	expect(app.shows("1 image attached · available to the agent")).toBe(true);
});

async function feedback() {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-text");
	return app;
}

const counts = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Sends:"));
const steps = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Steps:"));

test("finished triage joins New; opening and saved Later start nothing", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Show feedback in Today");
	await app.press("Triage fix");
	await app.waitFor("id:feedback-proposal-f1");
	await app.keyboard.press("escape");
	await app.waitFor("id:feedback-new-f1");
	await app.press("id:feedback-new-f1");
	await app.waitFor("id:feedback-proposal-f1");
	expect(steps(app)).toBe("Steps: [triage]");
	await app.press("id:feedback-later-f1");
	await app.waitUntil(() => !app.shows("id:feedback-new-f1"));
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-later-show");
	expect(app.shows("id:feedback-new-f1")).toBe(false);
	await app.press("id:feedback-later-show");
	await app.press("id:feedback-bring-back-f1");
	await app.waitFor("id:feedback-new-f1");
	expect(steps(app)).toBe("Steps: [triage]");
});

test("a triage question joins New and a later proposal returns after deferral", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Which plan shows people?");
	await app.keyboard.press("escape");
	expect(app.shows("id:feedback-new-f1")).toBe(false);
	await app.press("Triage asks");
	await app.waitFor("id:feedback-new-f1");
	await app.press("id:feedback-new-f1");
	await app.waitFor("id:feedback-question-f1");
	expect(steps(app)).toBe("Steps: [triage]");
	await app.press("id:feedback-later-f1");
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-later-show");
	expect(app.shows("id:feedback-new-f1")).toBe(false);
	await app.press("Triage fix");
	await app.waitFor("id:feedback-new-f1");
	expect(steps(app)).toBe("Steps: [triage]");
});

async function chooseProject(app: Awaited<ReturnType<typeof feedback>>) {
	await app.press("label:Project where agents triage and fix your feedback");
	await app.press("text:Pilot code");
	await app.waitFor("id:feedback-project-none");
}

async function sendWords(app: Awaited<ReturnType<typeof feedback>>, words: string) {
	await app.type("id:feedback-text", words);
	await app.waitUntil(() => app.enabled("id:feedback-send"));
	await app.press("id:feedback-send");
	await app.waitFor("Saved. Thank you.");
}

test("the header opens Feedback about Pilot in general; opening sends nothing and Send waits for words", async () => {
	const app = await feedback();
	expect(app.shows("Pilot in general")).toBe(true);
	expect(app.shows("id:feedback-empty")).toBe(true);
	expect(app.enabled("id:feedback-send")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await app.keyboard.press("escape");
	await app.waitFor("id:feedback-open");
	expect(app.shows("id:feedback")).toBe(false);
});

test("Send saves the words once and lists them; only the accepted receipt clears the draft", async () => {
	const app = await feedback();
	await app.type("id:feedback-text", "The plan page hides who is working 日本語 ✓");
	await app.waitUntil(() => app.enabled("id:feedback-send"));
	await app.press("id:feedback-send");
	await app.waitFor("Saved. Thank you.");
	expect(app.value("id:feedback-text")).toBe("");
	expect(app.shows("The plan page hides who is working 日本語 ✓")).toBe(true);
	expect(app.texts().some((t) => t.startsWith("Saved · ") && t.endsWith("Pilot in general"))).toBe(true);
	expect(app.shows("id:feedback-empty")).toBe(false);
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("a refused Send keeps the words; a lost one stays Unknown until Check reads it, never resent", async () => {
	const app = await feedback();
	await app.press("Next reject");
	await app.type("id:feedback-text", "Search is slow");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-message");
	expect(app.value("id:feedback-text")).toBe("Search is slow");
	await app.press("Next unknown");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-unknown");
	expect(app.value("id:feedback-text")).toBe("Search is slow");
	expect(app.enabled("id:feedback-send")).toBe(false);
	expect(app.shows("Check your earlier feedback first. Your text stays.")).toBe(true);
	await app.press("id:feedback-check");
	await app.waitFor("Your feedback was saved.");
	expect(app.shows("id:feedback-unknown")).toBe(false);
	expect(app.value("id:feedback-text")).toBe("");
	expect(counts(app)).toBe("Sends: 2 · Checks: 1");
});

test("from a mission the feedback names it; words keep their own context, and Back returns to the mission", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:mission-search");
	await app.waitFor("id:mission-feedback");
	await app.press("id:mission-feedback");
	await app.waitFor("id:feedback-text");
	expect(app.shows("“Faster search”")).toBe(true);
	await app.type("id:feedback-text", "Reports here are hard to scan");
	await app.press("id:back");
	await app.waitFor("id:mission-feedback");
	// Opening from the header does not move words about a mission to Pilot in general.
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-offer");
	expect(app.shows("“Faster search”")).toBe(true);
	await app.press("id:feedback-offer-keep");
	await app.waitUntil(() => !app.shows("id:feedback-offer"));
	await app.press("id:feedback-send");
	await app.waitFor("Saved. Thank you.");
	expect(app.texts().some((t) => t.endsWith("About “Mission search”"))).toBe(true);
	await app.press("id:feedback-general");
	await app.waitFor("Pilot in general");
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("unsent words and their mission come back after a close or update, sending nothing", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:mission-search");
	await app.press("id:mission-feedback");
	await app.waitFor("id:feedback-text");
	await app.type("id:feedback-text", "Kept 👩🏽‍💻\nsecond line");
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-text");
	expect(app.value("id:feedback-text")).toBe("Kept 👩🏽‍💻\nsecond line");
	expect(app.shows("“Faster search”")).toBe(true);
	expect(app.shows("Kept: [mission/search\nKept 👩🏽‍💻\nsecond line]")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("an unreadable list is not shown as empty; older feedback reads a page at a time", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("Many saved");
	await app.press("id:feedback-open");
	await app.waitFor("Older note 5");
	expect(app.shows("Older note 3")).toBe(false);
	await app.press("id:feedback-more");
	await app.waitFor("Older note 3");
	await app.press("id:back");
	await app.press("Unreadable");
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-off");
	expect(app.shows("This is not the same as having none.")).toBe(true);
	expect(app.shows("id:feedback-empty")).toBe(false);
});

test("with a chosen project a saved Send starts one triage; Start fix is a separate step on the exact proposal", async () => {
	const app = await feedback();
	expect(app.shows("Choose the project with Pilot's code to have an agent triage what you send.")).toBe(true);
	await chooseProject(app);
	await sendWords(app, "The plan page hides who is working");
	await app.waitFor("id:feedback-triage-f1");
	expect(app.shows("An agent is triaging this. It reads and proposes; it changes nothing.")).toBe(true);
	expect(steps(app)).toBe("Steps: [triage]");
	expect(app.shows("id:feedback-resolve-f1")).toBe(false);
	await app.press("Triage fix");
	await app.waitFor("id:feedback-proposal-f1");
	expect(app.shows("Proposed: a small fix")).toBe(true);
	expect(app.shows("Show the assignee on each plan row and check it in Plan.test.tsx.")).toBe(true);
	// The proposal itself starts nothing.
	expect(steps(app)).toBe("Steps: [triage]");
	await app.press("id:feedback-fix-f1");
	await app.waitFor("id:feedback-fixing-f1");
	expect(app.shows("A fix is in progress.")).toBe(true);
	expect(app.shows("id:feedback-fix-f1")).toBe(false);
	// A running fix does not resolve the feedback.
	expect(app.shows("id:feedback-resolve-f1")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,fix]");
});

test("resolving hides the saved fix proposal and its action; reopening restores them without starting work", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "The plan page hides who is working");
	await app.waitFor("id:feedback-triage-f1");
	await app.press("Triage fix");
	await app.waitFor("id:feedback-proposal-f1");
	expect(app.shows("id:feedback-fix-f1")).toBe(true);
	await app.press("id:feedback-resolve-f1");
	await app.waitFor("id:feedback-resolved-f1");
	expect(app.shows("id:feedback-proposal-f1")).toBe(false);
	expect(app.shows("Show the assignee on each plan row and check it in Plan.test.tsx.")).toBe(false);
	expect(app.shows("id:feedback-fix-f1")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,resolve]");
	await app.press("id:feedback-reopen-f1");
	await app.waitFor("id:feedback-proposal-f1");
	expect(app.shows("id:feedback-resolved-f1")).toBe(false);
	expect(app.shows("Show the assignee on each plan row and check it in Plan.test.tsx.")).toBe(true);
	expect(app.enabled("id:feedback-fix-f1")).toBe(true);
	expect(app.shows("id:feedback-fixing-f1")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,resolve,reopen]");
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("without a project nothing triages; a lost step stays Unknown and Check reads it once", async () => {
	const app = await feedback();
	await sendWords(app, "Search is slow");
	expect(steps(app)).toBe("Steps: []");
	expect(app.enabled("id:feedback-triage-start-f1")).toBe(false);
	await chooseProject(app);
	await app.waitUntil(() => app.enabled("id:feedback-triage-start-f1"));
	await app.press("Next step unknown");
	await app.press("id:feedback-triage-start-f1");
	await app.waitFor("id:feedback-step-unknown-f1");
	expect(app.enabled("id:feedback-triage-start-f1")).toBe(false);
	await app.press("id:feedback-step-check-f1");
	await app.waitFor("Pilot did it.");
	expect(app.shows("id:feedback-step-unknown-f1")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage]");
	expect(counts(app)).toBe("Sends: 1 · Checks: 1");
});

test("a new-mission proposal opens New with its goal; linking a mission and resolving are the user's own steps", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Plans never say who works on them");
	await app.waitFor("id:feedback-triage-f1");
	await app.press("Triage new mission");
	await app.waitFor("Proposed: plan a new mission");
	// It can also be done as one chat, tied to no mission.
	expect(app.shows("id:feedback-fix-f1")).toBe(true);
	await app.press("label:Mission to link this feedback to");
	await app.press("text:Faster search");
	await app.waitFor("id:feedback-mission-f1");
	expect(app.shows("Linked to “Mission search” · 1 of 4 tasks done")).toBe(true);
	await app.press("id:feedback-resolve-f1");
	await app.waitFor("id:feedback-resolved-f1");
	expect(steps(app)).toBe("Steps: [triage,link,resolve]");
	expect(app.shows("id:feedback-proposal-f1")).toBe(false);
	expect(app.shows("id:feedback-plan-f1")).toBe(false);
	expect(app.shows("id:feedback-fix-f1")).toBe(false);
	expect(app.shows("id:feedback-link-f1")).toBe(false);
	await app.press("id:feedback-reopen-f1");
	await app.waitFor("id:feedback-proposal-f1");
	expect(app.shows("id:feedback-fix-f1")).toBe(true);
	expect(app.shows("id:feedback-link-f1")).toBe(true);
	expect(steps(app)).toBe("Steps: [triage,link,resolve,reopen]");
	await app.press("id:feedback-plan-f1");
	// New gets the goal as an editable draft; nothing is created or sent.
	await app.waitFor("New goal: [Make plans show their people]");
	expect(app.shows("id:feedback")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,link,resolve,reopen]");
});

test("a triage question is answered here: its exact words, a kept draft and one explicit Send answer that starts nothing else", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "The plan page hides who is working");
	await app.waitFor("id:feedback-triage-f1");
	await app.press("Triage asks");
	await app.waitFor("id:feedback-question-f1");
	expect(app.shows("Which page do you mean?")).toBe(true);
	expect(app.shows("Plans and missions both list tasks.")).toBe(true);
	expect(app.shows("The triage needs your answer before it can propose a next step.")).toBe(true);
	expect(app.enabled("id:feedback-answer-send-f1")).toBe(false);
	await app.press("id:feedback-option-f1-2");
	await app.type("id:feedback-answer-f1", "The one with the task rows 日本語");
	await app.waitUntil(() => app.enabled("id:feedback-answer-send-f1"));
	// Picking and typing send nothing.
	expect(steps(app)).toBe("Steps: [triage]");
	// The unsent answer, its pick and the chosen project come back after a close or update.
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-question-f1");
	expect(app.value("id:feedback-answer-f1")).toBe("The one with the task rows 日本語");
	await app.waitFor("id:feedback-project-none");
	expect(steps(app)).toBe("Steps: [triage]");
	await app.press("id:feedback-answer-send-f1");
	await app.waitFor("id:feedback-answered-f1");
	expect(app.shows("Answer: [Mission overview\n\nThe one with the task rows 日本語]")).toBe(true);
	expect(app.shows("id:feedback-question-f1")).toBe(false);
	// It only clarifies: no fix, link or mark follows.
	expect(steps(app)).toBe("Steps: [triage,answer]");
	expect(app.shows("id:feedback-fix-f1")).toBe(false);
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("a lost answer stays Unknown with its words kept; Check reads it once and nothing is sent again", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Search is slow");
	await app.waitFor("id:feedback-triage-f1");
	await app.press("Triage asks");
	await app.waitFor("id:feedback-question-f1");
	await app.type("id:feedback-answer-f1", "Only on large projects");
	await app.waitUntil(() => app.enabled("id:feedback-answer-send-f1"));
	await app.press("Next step unknown");
	await app.press("id:feedback-answer-send-f1");
	await app.waitFor("id:feedback-step-unknown-f1");
	expect(app.value("id:feedback-answer-f1")).toBe("Only on large projects");
	expect(app.enabled("id:feedback-answer-send-f1")).toBe(false);
	await app.press("id:feedback-step-check-f1");
	await app.waitFor("Pilot did it.");
	expect(app.shows("id:feedback-question-f1")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,answer]");
	expect(counts(app)).toBe("Sends: 1 · Checks: 1");
});

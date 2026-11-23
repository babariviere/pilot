// Standalone attention uses the mission interview's actual form and selectors.
// Native tests cover exact round validation and structured submission payloads.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1000, height: 1350 } as const;

test("one question at a time, recommendations unanswered, explicit review and Submit", async () => {
	const app = await open("../../InterviewCardFixture.tsx", desktop);
	await app.waitFor("id:interview");
	expect(app.shows("Question 1 of 2 · 0 answered")).toBe(true);
	expect(app.shows("id:own-outcome")).toBe(true);
	expect(app.shows("id:answer-outcome")).toBe(false);
	expect(app.shows("id:question-authority")).toBe(false);
	expect(app.shows("id:reply")).toBe(false);
	expect(app.shows("id:submit")).toBe(false);
	await app.press("id:choice-outcome-drafts");
	await app.waitFor("Question 1 of 2 · 1 answered");
	await app.press("id:next");
	await app.waitFor("id:question-authority");
	expect(app.shows("What Pilot may do · 0 of 1")).toBe(true);
	await app.press("id:own-authority");
	await app.type("id:answer-authority", "I approve after review.");
	expect(app.shows("Submissions: 0")).toBe(true);
	await app.keyboard.press("mod+enter");
	await app.waitFor("id:answers");
	expect(app.shows("I approve after review.")).toBe(true);
	expect(app.shows("Keep answers when the window closes")).toBe(true);
	expect(app.shows("Submitting sends every answer at once and resumes the chat within its current permissions.")).toBe(
		true,
	);
	expect(app.shows("Nothing starts building.")).toBe(false);
	expect(app.shows("Submissions: 0")).toBe(true);
	await app.press("id:submit");
	await app.waitFor("Submissions: 1");
	await app.waitFor("Check again");
	expect(app.shows("id:submit")).toBe(false);
	await app.press("Check again");
	await app.waitFor("Receipt checks: 1");
	expect(app.shows("Submissions: 1")).toBe(true);
});

test("drafts and fields survive reopening but never answer a new round", async () => {
	const app = await open("../../InterviewCardFixture.tsx", desktop);
	await app.press("id:see-all");
	await app.type("id:answer-outcome", "My own outcome");
	await app.type("id:answer-authority", "My team");
	await app.press("Close card");
	await app.press("Reopen card");
	await app.waitFor("id:answer-outcome");
	expect(app.value("id:answer-outcome")).toBe("My own outcome");
	expect(app.value("id:answer-authority")).toBe("My team");
	expect(app.shows("Submissions: 0")).toBe(true);
	await app.press("New round");
	await app.waitFor("Question 1 of 2 · 0 answered");
	expect(app.shows("id:answer-outcome")).toBe(false);
	await app.press("id:goto-review");
	expect(app.enabled("id:submit")).toBe(false);
	expect(app.count("Not answered")).toBe(2);
});

test("scoped round keeps a draft and checks without submitting again", async () => {
	const app = await open("../../InterviewCardFixture.tsx", desktop);
	await app.press("Open other project's round");
	await app.waitFor("id:choice-outcome-drafts");
	await app.press("id:choice-outcome-drafts");
	await app.press("id:next");
	await app.waitFor("id:own-authority");
	await app.press("id:own-authority");
	await app.type("id:answer-authority", "My team");
	await app.press("Close card");
	await app.press("Reopen card");
	await app.waitFor("id:answer-authority");
	expect(app.value("id:answer-authority")).toBe("My team");
	expect(app.shows("Submissions: 0")).toBe(true);
	await app.press("id:next");
	await app.press("id:submit");
	await app.waitFor("Check again");
	expect(app.shows("id:submit")).toBe(false);
	await app.press("Check again");
	await app.waitFor("Receipt checks: 1");
	expect(app.shows("Submissions: 1")).toBe(true);
});

test("all forty questions use the same See all and bounded scroll", async () => {
	// A drag moves 10 points a display frame: on the system clock 16,000 points take about 27 s
	// of real time. The manual clock runs those frames at once; rendering is not the cost.
	const app = await open("../../InterviewCardFixture.tsx", { ...desktop, width: 620, height: 800, clock: {} });
	await app.press("Large round");
	await app.waitFor("Question 1 of 40 · 0 answered");
	expect(app.shows("id:question-q39")).toBe(false);
	await app.press("id:see-all");
	await app.scroll("id:interview-scroll", 16000);
	await app.waitFor("id:question-q39");
	expect(app.shows("Question 40: What must stay unchanged?")).toBe(true);
	expect(app.enabled("id:submit")).toBe(false);
	expect(app.shows("Submissions: 0")).toBe(true);
});

test("other project interview saves without submitting and reopens the saved answers", async () => {
	const app = await open("../../InterviewCardFixture.tsx", desktop);
	await app.press("Open shared draft");
	await app.press("id:own-outcome");
	await app.type("id:answer-outcome", "Keep the fast path unchanged.");
	await app.waitFor("Saved edits: 1");
	await app.press("Leave interview");
	expect(app.shows("Submissions: 0")).toBe(true);
	await app.press("Open Today's draft");
	await app.waitFor("id:answer-outcome");
	expect(app.shows("Other project")).toBe(false);
	expect(app.value("id:answer-outcome")).toBe("Keep the fast path unchanged.");
	await app.press("id:next");
	await app.press("id:own-authority");
	await app.type("id:answer-authority", "I approve after review.");
	await app.press("id:next");
	await app.press("id:submit");
	await app.waitFor("Submissions: 1");
});

test("another window's save leaves this editor's focus and text intact", async () => {
	const app = await open("../../InterviewCardFixture.tsx", desktop);
	await app.press("Save in another window on next edit");
	await app.press("id:own-outcome");
	await app.type("id:answer-outcome", "My unsaved words.");
	await app.waitFor("Not saved. Another window saved this draft. Your edits are kept here.");
	expect(app.value("id:answer-outcome")).toBe("My unsaved words.");
	await app.keyboard.press("backspace");
	expect(app.value("id:answer-outcome")).toBe("My unsaved words");
	await app.press("Leave interview");
	await app.waitFor("Submissions: 0");
	expect(app.shows("Saved edits: 0")).toBe(true);
	await app.press("Open shared draft");
	await app.waitFor("id:answer-outcome");
	expect(app.value("id:answer-outcome")).toBe("My unsaved words");
});

test("digits toggle a choice, zero opens own words, and navigation never submits", async () => {
	const app = await open("../../InterviewCardFixture.tsx", desktop);
	await app.keyboard.press("1");
	await app.waitFor("Question 1 of 2 · 1 answered");
	await app.keyboard.press("1");
	await app.waitFor("Question 1 of 2 · 0 answered");
	await app.keyboard.press("0");
	await app.waitFor("id:answer-outcome");
	expect(app.value("id:answer-outcome")).toBe("");
	expect(app.shows("Question 1 of 2 · 0 answered")).toBe(true);
	await app.type("id:answer-outcome", "My answer");
	await app.keyboard.press("mod+enter");
	await app.waitFor("Question 2 of 2 · 1 answered");
	await app.press("id:next");
	expect(app.enabled("id:submit")).toBe(false);
	expect(app.shows("Submissions: 0")).toBe(true);
});

test("mission and standalone render the same navigation and answer controls", async () => {
	for (const [entry, question, choice] of [
		["../../QuestionHelpFixture.tsx", "first", "gnome"],
		["../../InterviewCardFixture.tsx", "outcome", "drafts"],
	] as const) {
		const app = await open(entry, desktop);
		await app.waitFor("id:interview");
		expect(app.shows(`id:question-${question}`)).toBe(true);
		expect(app.shows(`id:choice-${question}-${choice}`)).toBe(true);
		expect(app.shows("id:next")).toBe(true);
		await app.press("id:goto-review");
		expect(app.shows("id:answers")).toBe(true);
		expect(app.shows(`id:review-${question}`)).toBe(true);
		expect(app.enabled("id:submit")).toBe(false);
	}
});

test("only the front round takes keys, even with an unrelated stale read", async () => {
	const app = await open("../../InterviewCardFixture.tsx", { ...desktop, height: 2000 });
	await app.press("Show second round");
	await app.press("Stale global read");
	expect(app.enabled("id:choice-outcome-drafts")).toBe(true);
	await app.keyboard.press("1");
	await app.waitFor("Question 1 of 2 · 1 answered");
	expect(app.shows("id:secondary-round >> text:Question 1 of 2 · 0 answered")).toBe(true);
	await app.keyboard.press("enter");
	await app.waitFor("id:question-authority");
	expect(app.shows("id:secondary-round >> id:question-other-outcome")).toBe(true);
	expect(app.shows("Submissions: 0")).toBe(true);
});

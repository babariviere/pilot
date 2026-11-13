// Revisit as a user takes it: an older mission offers it, asking changes
// nothing, new questions only for gaps, one submission that completes its
// round only, and an explicit confirmation of the exact revision shown.
// Mock data only: these prove the screens and the mock rules, not the
// daemon's revision routes (native/tests/revisit.rs covers the rules).
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1600 } as const;
const SUBMIT = "id:submit";
const CONFIRMED =
	"Revision confirmed. The agreement and open tasks changed as shown. No work started or resumed, and no permission changed.";

test("an older mission offers Revisit; asking opens new questions only and changes nothing", async () => {
	const app = await open("./Revisit.tsx", desktop);
	await app.press("id:mission-notify");
	await app.waitFor("id:mission-revisit");
	await app.press("id:mission-revisit");
	await app.waitFor("Revisit questions");
	expect(app.shows("Question 1 of 3 · 0 answered")).toBe(true);
	expect(
		app.shows(
			"New questions about gaps only. Your agreement and earlier answers stay as they are until you confirm a revision.",
		),
	).toBe(true);
	expect(app.shows("id:ask-revisit")).toBe(false);
	// Earlier answers are history, not questions to answer again.
	expect(app.shows("Which notifications matter most?")).toBe(false);
	await app.press("id:round-notify-1");
	await app.waitFor("Which notifications matter most?");
	expect(app.shows("id:answer-which")).toBe(false);
	// The agreement is unchanged, and readable on request.
	await app.press("id:fold-now");
	await app.waitFor("id:agreement-now");
	expect(app.shows("text:/Quiet hours are 22:00 to 07:00\\./")).toBe(true);
	expect(app.shows("5 open tasks · 3 finished · 3 active decisions")).toBe(true);
	// Moving away keeps an answer; nothing submits until every question is answered.
	await app.press("Only direct mentions of me");
	await app.waitFor("Question 1 of 3 · 1 answered");
	await app.press("role:button[Back to Mission overview]");
	await app.waitFor("id:open-plan");
	await app.press("id:open-plan");
	await app.waitFor("Question 1 of 3 · 1 answered");
	await app.press("id:goto-review");
	await app.waitFor("Check your answers");
	expect(app.enabled(SUBMIT)).toBe(false);
	expect(app.shows("2 questions left. Pilot continues only after you submit.")).toBe(true);
});

test("submitting completes the round only; the revision applies only when confirmed exactly", async () => {
	const app = await open("./Revisit.tsx", desktop);
	await app.press("id:plan-notify");
	await app.waitFor("id:ask-revisit");
	await app.press("id:ask-revisit");
	await app.waitFor("Revisit questions");
	await app.press("Only direct mentions of me");
	await app.waitFor("Question 1 of 3 · 1 answered");
	await app.press("id:next");
	await app.press("Drop the email digest");
	await app.waitFor("Question 2 of 3 · 2 answered");
	await app.press("id:next");
	await app.press("Follow macOS Focus");
	await app.waitFor("Question 3 of 3 · 3 answered");
	await app.press("id:next");
	await app.waitFor("Submitting completes this round. Nothing changes until you confirm a revision.");
	await app.press(SUBMIT);
	await app.waitFor("id:revision");
	// Submission is not the revision: the plan's own steps did not move, and nothing started.
	expect(app.shows("Revisit, round 2")).toBe(true);
	expect(app.shows("Work started: Not here")).toBe(true);
	expect(app.shows("text:/Nothing has changed yet\\./")).toBe(true);
	// What stays, changes and drops, across goal, agreement, open tasks and decisions.
	expect(app.shows("id:revision-goal >> Stays")).toBe(true);
	expect(app.shows("id:revision-plan >> Changes")).toBe(true);
	expect(app.shows("id:revision-task-notify-5 >> Changes")).toBe(true);
	expect(app.shows("text:Title: Add quiet hours → Follow macOS Focus for quiet hours")).toBe(true);
	expect(app.shows("id:revision-task-notify-7 >> Drops")).toBe(true);
	expect(app.shows("id:revision-task-notify-4 >> Stays")).toBe(true);
	expect(app.shows("3 finished tasks stay as they are, with their history.")).toBe(true);
	expect(app.shows("id:revision-decision-d3 >> Replaced")).toBe(true);
	expect(app.shows("text:Why: Your Revisit answer: follow macOS Focus.")).toBe(true);
	// Instructions and permissions are listed apart and never applied.
	expect(app.shows("text:/Confirming applies neither/")).toBe(true);
	expect(app.shows("Let Pilot read whether macOS Focus is on.")).toBe(true);
	// The first press only asks; Cancel changes nothing.
	await app.press("id:confirm-revision");
	await app.waitFor("Apply exactly this revision?");
	expect(app.shows("text:/It starts, resumes and permits nothing\\./")).toBe(true);
	await app.press("role:button[Cancel]");
	await app.waitFor("id:confirm-revision");
	expect(app.shows("id:revision")).toBe(true);
	await app.press("id:confirm-revision");
	await app.press("id:confirm-revision-now");
	await app.waitFor(CONFIRMED);
	expect(app.shows("id:revision")).toBe(false);
	// The earlier agreement and replaced decision stay as history, on request.
	await app.press("id:fold-history");
	await app.waitFor("History, not guidance. Pilot works from the agreement now.");
	expect(app.shows("text:/D3 “Quiet hours are 22:00 to 07:00\\.” replaced by D4/")).toBe(true);
	await app.press("id:fold-now");
	await app.waitFor("4 open tasks · 3 finished · 3 active decisions");
});

test("a changed mission, working chats and a lost answer never apply a revision twice", async () => {
	const app = await open("./RevisitTrouble.tsx", desktop);
	// Changed while the user confirmed: stale, then only a new revision can follow.
	await app.press("id:plan-notify");
	await app.waitFor("id:revision");
	await app.press("id:confirm-revision");
	await app.press("id:confirm-revision-now");
	await app.waitFor("The mission changed while you confirmed. Nothing was changed; ask for a new revision.");
	expect(app.shows("The mission changed after Pilot proposed this revision. It cannot be confirmed.")).toBe(true);
	expect(app.enabled("id:confirm-revision")).toBe(false);
	await app.press("id:ask-again");
	await app.waitFor("Pilot proposes a revision. Nothing changed.");
	await app.waitFor("id:confirm-revision");
	expect(app.enabled("id:confirm-revision")).toBe(true);
	await app.press("role:button[Back to Mission overview]");
	await app.press("role:button[Back to Today]");

	// Chats still work: Confirm stays off, with the reason.
	await app.press("id:plan-digest");
	await app.waitFor("id:revision");
	expect(app.shows("text:/Pause it on its overview first/")).toBe(true);
	expect(app.enabled("id:confirm-revision")).toBe(false);
	await app.press("role:button[Back to Today]");

	// The answer is lost: Unknown, and Check only reads.
	await app.press("id:plan-alerts");
	await app.waitFor("id:revision");
	expect(app.shows("text:/The mission's work is paused\\. Confirming keeps it paused/")).toBe(true);
	await app.press("id:confirm-revision");
	await app.press("id:confirm-revision-now");
	await app.waitFor("Pilot sent your confirmation but heard nothing back. It will not send it again until it checks.");
	expect(app.shows("id:confirm-revision")).toBe(false);
	expect(app.shows("id:confirm-revision-now")).toBe(false);
	await app.press("id:check-revision");
	await app.waitFor("Your confirmation applied. Nothing was sent again.");
	expect(app.shows(CONFIRMED)).toBe(true);
});

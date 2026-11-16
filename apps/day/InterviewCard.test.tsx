// Mock round only. Native validation is covered by attention_interview tests.
import { expect, open, test } from "nsh/test";
import { customAnswerSelected } from "./InterviewCard";

const window = { platform: "macos", width: 1000, height: 1350 } as const;

test("blank custom choices are unselected until explicitly picked or written", () => {
	expect(customAnswerSelected({ selectedOptionId: null, text: "" })).toBe(false);
	expect(customAnswerSelected({ selectedOptionId: null, text: " \n " })).toBe(false);
	expect(customAnswerSelected({ selectedOptionId: null, text: "" }, true)).toBe(true);
	expect(customAnswerSelected({ selectedOptionId: null, text: "My answer" })).toBe(true);
	expect(customAnswerSelected({ selectedOptionId: "picked", text: "Extra detail" }, true)).toBe(false);
});

test("the whole round waits for explicit review and Submit", async () => {
	const app = await open("./InterviewCardFixture.tsx", window);
	await app.waitFor("id:interview-card");
	expect(app.shows("What it should achieve")).toBe(true);
	expect(app.shows("What Pilot may do")).toBe(true);
	expect(app.shows("id:reply")).toBe(false);
	expect(app.shows("id:interview-submit")).toBe(false);
	expect(app.enabled("id:interview-review")).toBe(false);
	expect(app.shows("id:interview-submit")).toBe(false);
	await app.press("id:interview-option-outcome-drafts");
	await app.type("id:interview-text-authority", "I approve after review.");
	await app.waitUntil(() => app.enabled("id:interview-review"));
	expect(app.shows("Submissions: 0")).toBe(true);
	await app.keyboard.press("mod+enter");
	expect(app.shows("Submissions: 0")).toBe(true);
	await app.press("id:interview-review");
	await app.waitFor("id:interview-submit");
	expect(app.shows("Keep answers when the window closes")).toBe(true);
	expect(app.shows("I approve after review.")).toBe(true);
	expect(app.shows("Submissions: 0")).toBe(true);
	await app.press("id:interview-submit");
	await app.waitFor("Submissions: 1");
	await app.waitFor("Check again");
	expect(app.shows("id:interview-submit")).toBe(false);
	await app.press("Check again");
	await app.waitFor("Receipt checks: 1");
	expect(app.shows("Submissions: 1")).toBe(true);
});

test("drafts survive reopening but never answer a new round", async () => {
	const app = await open("./InterviewCardFixture.tsx", window);
	await app.type("id:interview-text-outcome", "My own outcome");
	await app.type("id:interview-text-authority", "My team");
	await app.press("Close card");
	await app.press("Reopen card");
	await app.waitFor("id:interview-text-outcome");
	expect(app.value("id:interview-text-outcome")).toBe("My own outcome");
	expect(app.value("id:interview-text-authority")).toBe("My team");
	expect(app.shows("Submissions: 0")).toBe(true);
	await app.press("New round");
	await app.waitFor("id:interview-text-outcome");
	expect(app.value("id:interview-text-outcome")).toBe("");
	expect(app.value("id:interview-text-authority")).toBe("");
	expect(app.enabled("id:interview-review")).toBe(false);
	expect(app.shows("id:interview-submit")).toBe(false);
});

test("all forty questions remain in one scrollable round", async () => {
	const app = await open("./InterviewCardFixture.tsx", { ...window, width: 620, height: 800 });
	await app.scroll("id:interview-scroll", 4000);
	await app.press("Large round");
	await app.scroll("id:interview-scroll", 100000);
	await app.waitFor("id:interview-question-q39");
	expect(app.shows("Question 40: What must stay unchanged?")).toBe(true);
	expect(app.enabled("id:interview-review")).toBe(false);
	expect(app.shows("Submissions: 0")).toBe(true);
});

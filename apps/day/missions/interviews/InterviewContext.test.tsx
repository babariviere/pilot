import { expect, open, test } from "nsh/test";

test("the context pill opens and closes without answering the question", async () => {
	const app = await open("../../InterviewCardFixture.tsx", { platform: "macos", width: 1000, height: 1200 });
	await app.waitFor("id:question-outcome");
	expect(app.shows("id:context-outcome")).toBe(false);
	await app.press("More context");
	await app.waitFor("id:context-outcome");
	expect(app.shows("Question 1 of 2 · 0 answered")).toBe(true);
	expect(app.shows("Submissions: 0")).toBe(true);
	await app.press("More context");
	expect(app.shows("id:context-outcome")).toBe(false);
	expect(app.shows("Question 1 of 2 · 0 answered")).toBe(true);
});

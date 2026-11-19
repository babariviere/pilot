import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1000 } as const;
const card = (mission: string) => `id:planner-interview-${mission}`;
const answer = "label:Answer interview for Export a chat as Markdown in Pilot project";

test("one card per mission in scope; drafts and uncertain submits wait for a confirmed submission", async () => {
	const app = await open("./PlannerInterviewsFixture.tsx", desktop);
	await app.waitFor("Three things need you.");
	expect(app.count("text:Planner needs your answers")).toBe(3);
	expect(app.shows(`${card("search")} >> text:/1 question pending/`)).toBe(true);
	expect(app.shows(card("review"))).toBe(false);
	await app.keyboard.press("mod+shift+1");
	expect(app.count(card("export"))).toBe(1);
	await app.keyboard.press("mod+shift+2");
	await app.waitFor("text:/3 questions pending/");
	expect(app.shows(answer)).toBe(true);
	await app.keyboard.press("mod+shift+3");
	await app.waitFor("text:/Answers saved. Submit to finish/");
	expect(app.count(card("export"))).toBe(1);
	await app.keyboard.press("mod+shift+6");
	await app.keyboard.press("mod+shift+4");
	await app.waitUntil(() => !app.shows(card("export")));
	await app.keyboard.press("mod+shift+7");
	await app.waitFor("One thing needs you.");
	expect(app.shows(card("export"))).toBe(false);
	await app.keyboard.press("mod+shift+5");
	await app.waitFor(`${card("export")} >> text:/2 questions pending/`);
	expect(app.shows(card("search"))).toBe(false);
	expect(app.count("text:Planner needs your answers")).toBe(1);
});

test("a disconnected last empty read never claims nothing needs you", async () => {
	const app = await open("./PlannerInterviewsFixture.tsx", desktop);
	await app.waitFor(card("export"));
	await app.keyboard.press("mod+shift+9");
	await app.waitFor("Nothing needs you today.");
	await app.keyboard.press("mod+shift+8");
	await app.waitFor("What needs you is not fully known.");
	expect(app.shows("Nothing needs you. Pilot keeps going on its own.")).toBe(false);
});

test("Answer interview opens the exact mission; Back returns to the same scope with the draft kept", async () => {
	const app = await open("./PlannerInterviewsFixture.tsx", desktop);
	await app.waitFor(answer);
	await app.press("label:Projects Today shows");
	await app.press("text:Pilot project");
	await app.waitFor("Showing Pilot project.");
	expect(app.shows(card("search"))).toBe(false);
	await app.press(answer);
	await app.waitFor("What should one export include?");
	expect(app.shows("Pilot continues planning: Not yet")).toBe(true);
	await app.press("id:own-what");
	await app.type("id:answer-what", "Keep the existing Markdown layout");
	await app.waitFor("Question 2 of 7 · 4 answered");
	await app.press("label:Back to Today");
	await app.waitFor("Showing Pilot project.");
	await app.press(answer);
	await app.waitFor("id:interview");
	expect(app.value("id:answer-what")).toBe("Keep the existing Markdown layout");
	expect(app.shows("Pilot continues planning: Not yet")).toBe(true);
});

test("revoked project inventory cannot reappear from a cached scope", async () => {
	const app = await open("./PlannerInterviewsFixture.tsx", desktop);
	await app.waitFor(card("search"));
	await app.press("label:Projects Today shows");
	await app.press("text:Pilot project");
	await app.waitFor("Showing Pilot project.");
	await app.keyboard.press("mod+shift+d");
	// Hold the All projects response so this checks what can restore from cache.
	await app.press("label:Projects Today shows");
	await app.press("text:All projects");
	await app.waitFor("Reading your projects…");
	expect(app.shows(card("search"))).toBe(false);
});

test("the open interview also hides when its mission no longer qualifies", async () => {
	const app = await open("./PlannerInterviewsFixture.tsx", desktop);
	await app.waitFor(answer);
	await app.press(answer);
	await app.waitFor("What should one export include?");
	await app.keyboard.press("mod+shift+9");
	await app.waitFor("Pilot cannot show this interview here. Your drafts are kept.");
	expect(app.shows("What should one export include?")).toBe(false);
	await app.press("label:Back to Today");
	expect(app.shows(answer)).toBe(false);
});

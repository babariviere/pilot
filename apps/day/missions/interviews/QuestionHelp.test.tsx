// Help on interview questions: background, a question to a chat, and notes sent together. Mock data.
import { expect, open, test } from "nsh/test";
import { questionNotes, restoreQuestionHelp, roundNotes, savedQuestionHelp } from "./QuestionHelp";

// Tall enough that every question and the round's notes show at once.
const desktop = { platform: "macos", width: 1100, height: 3200 } as const;

test("unsent question help survives a closed window, word for word, and sends nothing", () => {
	restoreQuestionHelp([
		"note\ni1\nq1\n1\nToo technical.\nUse my words.",
		"round\ni1\n\n0\nAll of these are too long.",
		"ask\ni1/q1\n\n0\nWhat is NSH?",
	]);
	expect(questionNotes().i1?.q1).toEqual({ simpler: true, text: "Too technical.\nUse my words." });
	expect(roundNotes().i1).toBe("All of these are too long.");
	expect(savedQuestionHelp()).toEqual([
		"note\ni1\nq1\n1\nToo technical.\nUse my words.",
		"round\ni1\n\n0\nAll of these are too long.",
		"ask\ni1/q1\n\n0\nWhat is NSH?",
	]);
	restoreQuestionHelp([]);
	expect(savedQuestionHelp()).toEqual([]);
});

test("keys toggle help on the question shown: M more context, S say it simpler", async () => {
	const app = await open("../../QuestionHelpFixture.tsx", desktop);
	await app.keyboard.press("s");
	await app.waitFor("id:simpler-first");
	await app.keyboard.press("m");
	await app.waitFor("id:context-first");
	await app.keyboard.press("s");
	expect(app.shows("id:simpler-first")).toBe(false);
});

test("notes on questions wait, then go to Pilot together, word for word, and answer nothing", async () => {
	const app = await open("../../QuestionHelpFixture.tsx", desktop);
	await app.press("id:see-all");
	expect(app.shows("id:notes-send")).toBe(false);
	await app.press("id:help-first >> Say it simpler");
	await app.waitFor("id:simpler-first");
	await app.waitFor("Send 1 note to Pilot");
	await app.press("id:help-working >> Reword this");
	await app.type("id:reword-working", "Two questions in one.");
	await app.press("id:round-note-open");
	await app.type("id:round-note", "Too technical overall.");
	await app.waitFor("Send 3 notes to Pilot");
	expect(app.texts().some((t) => t.startsWith("Sent: []"))).toBe(true);
	await app.press("id:notes-send");
	await app.waitFor("Sent. Pilot redoes these questions with your feedback.");
	const sent = app.texts().find((t) => t.startsWith("Sent: ")) ?? "";
	const [feedback] = JSON.parse(sent.slice("Sent: ".length)) as string[];
	expect(feedback).toContain("Question first “Which desktops must work on the first day?”: Say it in simpler words.");
	expect(feedback).toContain("Question working “What counts as working?”: Two questions in one.");
	expect(feedback).toContain("The whole round: Too technical overall.");
	expect(app.shows("id:notes-send")).toBe(false);
	expect(app.shows("0 of 3 answered")).toBe(true);
});

test("a question about a question shows its answer under it; background shows on request", async () => {
	const app = await open("../../QuestionHelpFixture.tsx", desktop);
	expect(app.shows("id:context-first")).toBe(false);
	expect(app.shows("id:round-notes")).toBe(true);
	await app.press("id:help-first >> More context");
	await app.waitFor("id:context-first");
	expect(app.texts().some((t) => t.startsWith("Most Linux users run GNOME or KDE."))).toBe(true);
	await app.press("id:help-first >> Ask a question");
	await app.type("id:ask-text-first", "Why these two?");
	await app.press("id:ask-send-first");
	await app.waitFor("GNOME and KDE cover most Linux users.");
	expect(app.shows("id:ask-first >> Why these two?")).toBe(true);
	expect(app.shows("Sent: []")).toBe(true);
});

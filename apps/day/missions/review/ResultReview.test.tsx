// The result page's Code changes row and its Review code page, over a scripted result and private review
// (ResultReviewFixture.tsx). Headless: this proves behavior, not the native look, focus rings or the diff's drawing.
import { expect, open, test } from "nsh/test";

const SIZE = { platform: "macos", width: 1200, height: 1100 } as const;
const OLD_LINE_3 = "id:review-diff >> text:3 >> nth=0";

async function reviewPage() {
	const app = await open("../../ResultReviewFixture.tsx", SIZE);
	await app.waitFor("id:review-code");
	await app.press("id:review-code");
	await app.waitFor("id:code-review");
	await app.waitFor("modified · 1 of 3 · J K next file");
	return app;
}

async function comment(app: Awaited<ReturnType<typeof reviewPage>>, words: string) {
	await app.press(OLD_LINE_3);
	await app.waitFor("id:review-body");
	await app.type("id:review-body", words);
	await app.press("id:comment-save");
	await app.waitFor(words);
}

test("the result page shows one Code changes row, and Review code opens its own page", async () => {
	const app = await open("../../ResultReviewFixture.tsx", SIZE);
	await app.waitFor("3 files · +5 −3 · 0 comments");
	expect(app.texts()).toContain("PR #431 · 8ac2d10 → c94fa21 · saved copy, not your working copy");
	for (const old of ["Prepare revision request", "General comment…", "Comment on changes…", "Use in revision request"])
		expect(app.shows(`role:button[${old}]`)).toBe(false);
	expect(app.shows("id:add-note")).toBe(true);
	expect(app.shows("id:my-notes")).toBe(true);
	await app.keyboard.press("mod+r");
	await app.waitFor("id:code-review");
	expect(app.texts()).toContain("Review code");
	expect(app.texts()).toContain("No comments yet. Select lines to comment; comments are never posted to GitHub.");
	expect(app.enabled("id:review-send-back")).toBe(false);
});

test("Back and Command+[ return to the result with the focus on Review code", async () => {
	const app = await reviewPage();
	await app.press("id:code-review-back");
	await app.waitFor("id:review-code");
	expect(app.shows("id:code-review")).toBe(false);
	// The focus is back on Review code: Space opens it again.
	await app.keyboard.press("space");
	await app.waitFor("id:code-review");
	await app.keyboard.press("mod+[");
	await app.waitFor("id:review-code");
	await app.keyboard.press("space");
	await app.waitFor("id:code-review");
	await app.keyboard.press("escape");
	await app.waitFor("id:review-code");
});

test("J and K go to the next and previous file; a press on a file shows it", async () => {
	const app = await reviewPage();
	await app.keyboard.press("j");
	await app.waitFor("modified · 2 of 3 · J K next file");
	expect(app.texts()).toContain("src/history/loader.ts");
	await app.keyboard.press("j");
	await app.waitFor("modified · 3 of 3 · J K next file");
	await app.keyboard.press("j");
	await app.waitFor("modified · 3 of 3 · J K next file");
	await app.keyboard.press("k");
	await app.waitFor("modified · 2 of 3 · J K next file");
	await app.press("id:review-file-src/export.ts");
	await app.waitFor("modified · 1 of 3 · J K next file");
});

test("the comment field shows only for selected lines and saves a private comment under them", async () => {
	const app = await reviewPage();
	expect(app.shows("id:review-body")).toBe(false);
	await app.press(OLD_LINE_3);
	await app.waitFor("id:review-body");
	await app.type("id:review-body", "Why clear before export?");
	expect(app.texts()).toContain("Saves: 0");
	await app.press("id:comment-save");
	await app.waitFor("Your comment · old line 3");
	expect(app.texts()).toContain("Why clear before export?");
	expect(app.shows("id:review-body")).toBe(false);
	expect(app.texts()).toContain("1 comment · kept with this result, never posted to GitHub");
	expect(app.texts()).toContain("Saves: 1");
	await app.press("id:code-review-back");
	await app.waitFor("3 files · +5 −3 · 1 comment");
});

test("a refresh of the same result keeps the comment field, its focus and its words", async () => {
	const app = await reviewPage();
	await app.press(OLD_LINE_3);
	await app.type("id:review-body", "Typed before");
	await app.keyboard.press("mod+shift+u");
	await app.wait(100);
	// The focus stayed in the field: a key types into it.
	await app.keyboard.press("x");
	expect(app.value("id:review-body")).toBe("Typed beforex");
	expect(app.texts()).toContain("modified · 1 of 3 · J K next file");
});

test("Escape keeps the comment's words, Discard removes them, and Escape then goes back", async () => {
	const app = await reviewPage();
	await app.press(OLD_LINE_3);
	await app.type("id:review-body", "Kept words");
	await app.keyboard.press("escape");
	// The unsent words stay under their lines.
	expect(app.value("id:review-body")).toBe("Kept words");
	await app.press("id:comment-discard");
	expect(app.shows("id:review-body")).toBe(false);
	expect(app.shows("id:code-review")).toBe(true);
	await app.keyboard.press("escape");
	await app.waitFor("id:review-code");
});

test("Send back sends every saved comment of this version once", async () => {
	const app = await reviewPage();
	await comment(app, "Check keyboard cancel");
	await app.keyboard.press("j");
	await app.waitFor("modified · 2 of 3 · J K next file");
	await comment(app, "Name the cursor");
	await app.waitFor("2 comments · kept with this result, never posted to GitHub");
	await app.press("role:button[Send back with 2 comments]");
	await app.waitFor("You sent this back. The agent has your note; its next result shows on Today to check.");
	expect(app.texts()).toContain("Sends: 1");
	const sent = app.texts().find((t) => t.startsWith("Note sent:")) ?? "";
	expect(sent.includes("Check keyboard cancel")).toBe(true);
	expect(sent.includes("Name the cursor")).toBe(true);
	expect(sent.includes("src/export.ts · old lines 3–3")).toBe(true);
});

test("a lost save reply shows Check, which reads once and never resends", async () => {
	const app = await reviewPage();
	await app.press(OLD_LINE_3);
	await app.type("id:review-body", "Check keyboard cancel");
	await app.press("role:button[Lose next save reply]");
	await app.press("id:comment-save");
	await app.waitFor("Private save not confirmed");
	expect(app.texts()).toContain("Saves: 1");
	await app.press("role:button[Reopen review]");
	await app.waitFor("Private save not confirmed");
	await app.press("role:button[Check saved comment]");
	await app.waitFor("Saved. Nothing was resent.");
	expect(app.texts()).toContain("Saves: 1");
	expect(app.texts()).toContain("Check keyboard cancel");
});

test("Add a note saves a general comment that counts and goes with Send back; My notes stay out", async () => {
	const app = await reviewPage();
	await comment(app, "A real comment");
	await app.press("id:code-review-back");
	await app.press("id:add-note");
	await app.type("id:review-body", "Also check the Linux dialog");
	await app.press("role:button[Save and restore drafts]");
	await app.waitFor("id:review-body");
	expect(app.value("id:review-body")).toBe("Also check the Linux dialog");
	await app.press("id:note-save");
	await app.waitFor("Your note · goes with Send back");
	await app.waitFor("3 files · +5 −3 · 2 comments");
	await app.press("id:my-notes");
	await app.type("id:review-body", "Only for me");
	await app.press("id:note-save");
	await app.waitFor("My notes · only for you");
	expect(app.texts()).toContain("3 files · +5 −3 · 2 comments");
	await app.press("id:review-code");
	await app.press("role:button[Send back with 2 comments]");
	await app.waitFor("You sent this back. The agent has your note; its next result shows on Today to check.");
	const sent = app.texts().find((t) => t.startsWith("Note sent:")) ?? "";
	expect(sent.includes("A real comment")).toBe(true);
	expect(sent.includes("General comment")).toBe(true);
	expect(sent.includes("Also check the Linux dialog")).toBe(true);
	expect(sent.includes("Only for me")).toBe(false);
});

test("reopening My notes keeps unsaved edits instead of the saved notes", async () => {
	const app = await open("../../ResultReviewFixture.tsx", SIZE);
	await app.waitFor("id:my-notes");
	await app.press("id:my-notes");
	await app.type("id:review-body", "Saved note");
	await app.press("id:note-save");
	await app.waitFor("My notes · only for you");
	await app.press("id:my-notes");
	expect(app.value("id:review-body")).toBe("Saved note");
	await app.type("id:review-body", " with unsaved edits");
	await app.press("id:note-cancel");
	await app.press("id:my-notes");
	expect(app.value("id:review-body")).toBe("Saved note with unsaved edits");
});

test("the Comment control shows only on the selected lines", async () => {
	const app = await reviewPage();
	expect(app.shows("label:Comment on these code lines")).toBe(false);
	await app.press(OLD_LINE_3);
	await app.waitFor("label:Comment on these code lines");
	expect(app.count("label:Comment on these code lines")).toBe(1);
});

test("a rejected private save keeps its words and permits a fresh save", async () => {
	const app = await reviewPage();
	await app.press(OLD_LINE_3);
	await app.type("id:review-body", "Kept after refusal");
	await app.press("role:button[Refuse next save]");
	await app.press("id:comment-save");
	await app.waitFor(
		"Not saved. The review changed or this save was refused. Your words stay; refresh before trying again.",
	);
	expect(app.value("id:review-body")).toBe("Kept after refusal");
	await app.press("id:comment-save");
	await app.waitFor("Your comment · old line 3");
	expect(app.texts()).toContain("Saves: 2");
});

test("a disposed save reply cannot erase the reopened field's newer words", async () => {
	const app = await reviewPage();
	await app.press(OLD_LINE_3);
	await app.type("id:review-body", "Original");
	await app.press("role:button[Delay next save reply]");
	await app.press("id:comment-save");
	await app.press("role:button[Reopen review]");
	await app.waitFor("id:review-body");
	await app.type("id:review-body", " newer draft");
	await app.press("role:button[Release saved reply]");
	expect(app.value("id:review-body")).toBe("Original newer draft");
});

test("Keep for later saves Later once and leaves the result; a lost reply returns only after Check", async () => {
	const app = await reviewPage();
	await app.press("role:button[Lose next save reply]");
	await app.press("id:review-later");
	await app.waitFor("Private save not confirmed");
	await app.press("role:button[Check saved comment]");
	await app.waitFor("Result closed");
	expect(app.texts()).toContain("Saves: 1");
});

test("a newer result keeps earlier comments as an earlier version and its unsent words read-only", async () => {
	const app = await reviewPage();
	await comment(app, "On the first version");
	await app.press("role:button[New result version]");
	await app.waitFor("Earlier result version · old line 3");
	expect(app.texts()).toContain("No comments yet. Select lines to comment; comments are never posted to GitHub.");
	expect(app.texts()).toContain("Saves: 1");
});

test("earlier-version unsent words stay readable without moving or sending them", async () => {
	const app = await reviewPage();
	await app.press(OLD_LINE_3);
	await app.type("id:review-body", "Words for the original version");
	await app.press("role:button[New result version]");
	await app.waitFor("Earlier unsent drafts (1)");
	await app.press("id:review-earlier-drafts");
	await app.waitFor("Words for the original version");
	expect(app.texts().some((t) => t.startsWith("Unsent · original result 111111111111 · src/export.ts"))).toBe(true);
	expect(app.texts()).toContain("Saves: 0");
});

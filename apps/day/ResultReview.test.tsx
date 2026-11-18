import { expect, open, test } from "nsh/test";

test("a code comment keeps the selected old-side line and its visible source", async () => {
	const app = await open("./ResultReviewFixture.tsx", { width: 1100, height: 1400 });
	await app.waitFor("src/export.ts");
	await app.press("id:review-diff >> text:3 >> nth=0");
	await app.press("role:button[Comment on selected lines…]");
	await app.waitFor("src/export.ts · old lines 3–3");
	await app.type("id:review-body", "Why clear before export?");
	await app.press("role:button[Save privately]");
	await app.waitFor("Why clear before export?");
	await app.press("role:button[New result version]");
	await app.waitFor("Earlier result version. Location uncertain in this version; the original anchor is kept.");
	await app.press("role:button[Open original code context]");
	await app.waitFor("src/export.ts");
});

test("private comments survive reopen and uncertain save checks never resend", async () => {
	const app = await open("./ResultReviewFixture.tsx", { width: 1100, height: 1400 });
	await app.waitFor("src/export.ts");
	await app.press("role:button[General comment…]");
	await app.type("id:review-body", "Check keyboard cancel");
	await app.press("role:button[Lose next save reply]");
	await app.press("role:button[Save privately]");
	await app.waitFor("Private save not confirmed");
	expect(app.texts()).toContain("Saves: 1");
	await app.press("role:button[Reopen review]");
	await app.waitFor("Private save not confirmed");
	await app.scroll("id:review-scroll", 800);
	await app.press("role:button[Check saved comment]");
	await app.waitFor("Saved. Nothing was resent.");
	expect(app.texts()).toContain("Saves: 1");
	expect(app.texts()).toContain("Check keyboard cancel");
	await app.press("role:button[Prepare revision request]");
	expect(app.texts().some((t) => t.includes("Saved comment") && t.includes("Check keyboard cancel"))).toBe(true);
	await app.press("role:button[New result version]");
	await app.waitFor("Earlier result version. Location uncertain in this version; the original anchor is kept.");
});

test("personal notes stay out of revision requests; unsent drafts survive restored view", async () => {
	const app = await open("./ResultReviewFixture.tsx", { width: 1100, height: 1400 });
	await app.waitFor("src/export.ts");
	await app.press("role:button[My notes…]");
	await app.type("id:review-body", "Only for me");
	await app.press("role:button[Save and restore drafts]");
	await app.waitFor("id:review-body");
	await app.press("role:button[Save privately]");
	await app.waitFor("My saved note · only for me");
	await app.press("role:button[Prepare revision request]");
	expect(app.texts()).toContain("No revision request");
});

test("a rejected private save keeps text and permits a fresh save", async () => {
	const app = await open("./ResultReviewFixture.tsx", { width: 1100, height: 1600 });
	await app.waitFor("src/export.ts");
	await app.press("role:button[General comment…]");
	await app.type("id:review-body", "Kept after refusal");
	await app.press("role:button[Refuse next save]");
	await app.press("role:button[Save privately]");
	await app.waitFor(
		"Not saved. The review changed or this save was refused. Your words stay; refresh before trying again.",
	);
	expect(app.value("id:review-body")).toBe("Kept after refusal");
	await app.press("role:button[Save privately]");
	await app.waitFor("Kept after refusal");
	expect(app.texts()).toContain("Saves: 2");
});

test("a disposed save reply cannot erase the reopened editor's newer words", async () => {
	const app = await open("./ResultReviewFixture.tsx", { width: 1100, height: 1600 });
	await app.waitFor("src/export.ts");
	await app.press("role:button[General comment…]");
	await app.type("id:review-body", "Original");
	await app.press("role:button[Delay next save reply]");
	await app.press("role:button[Save privately]");
	await app.press("role:button[Reopen review]");
	await app.waitFor("id:review-body");
	await app.type("id:review-body", " newer draft");
	await app.press("role:button[Release saved reply]");
	expect(app.value("id:review-body")).toBe("Original newer draft");
});

test("checking a lost Later receipt returns it without resending", async () => {
	const app = await open("./ResultReviewFixture.tsx", { width: 1100, height: 1600 });
	await app.waitFor("src/export.ts");
	await app.press("role:button[Lose next save reply]");
	await app.press("role:button[Later]");
	await app.waitFor("Private save not confirmed");
	await app.press("role:button[Check saved comment]");
	await app.waitFor("Later returns: 1");
	expect(app.texts()).toContain("Saves: 1");
});

test("reopening My notes keeps unsaved edits instead of replacing them with the saved note", async () => {
	const app = await open("./ResultReviewFixture.tsx", { width: 1100, height: 1600 });
	await app.waitFor("src/export.ts");
	await app.press("role:button[My notes…]");
	await app.type("id:review-body", "Saved note");
	await app.press("role:button[Save privately]");
	await app.waitFor("My saved note · only for me");
	await app.press("role:button[My notes…]");
	await app.type("id:review-body", " with unsaved edits");
	await app.press("role:button[Close editor]");
	await app.press("role:button[My notes…]");
	expect(app.value("id:review-body")).toBe("Saved note with unsaved edits");
});

test("earlier-version unsent words remain readable without moving or sending them", async () => {
	const app = await open("./ResultReviewFixture.tsx", { width: 1100, height: 1600 });
	await app.waitFor("src/export.ts");
	await app.press("role:button[General comment…]");
	await app.type("id:review-body", "Words for the original version");
	await app.press("role:button[New result version]");
	await app.waitFor("Earlier unsent drafts (1)");
	await app.press("id:review-earlier-drafts");
	await app.waitFor("Words for the original version");
	expect(app.texts()).toContain("Unsent · original result aaaaaaaaaaaa · General comment");
	expect(app.texts()).toContain("Saves: 0");
});

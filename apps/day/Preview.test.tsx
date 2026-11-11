// Headless behavior only. This does not launch or capture a visible Mac window.
import { expect, open, test } from "nsh/test";
import { parsePreviewDrafts } from "./previewState";

test("preview uses real screens with an explicit offline demo/source label", async () => {
	const app = await open("./Preview.tsx", { width: 1100, height: 1000 });
	await app.waitFor("Three short things need you.");
	expect(app.shows("Pilot Preview. Demo data, not your missions.")).toBe(true);
	expect(app.shows("text:/No daemon or accounts connected/")).toBe(true);
	await app.press("role:button[New]");
	await app.waitFor("id:goal");
	await app.type("id:goal", "Keep my draft 日本語 ✓");
	expect(app.value("id:goal")).toBe("Keep my draft 日本語 ✓");
	await app.press("role:button[Back to Today]");
	await app.press("role:button[New]");
	expect(app.value("id:goal")).toBe("Keep my draft 日本語 ✓");
});

test("saved preview drafts keep exact text and reject unsupported formats", () => {
	const saved = { version: 1, goal: "  日本語\n", questions: {}, replies: {}, reports: {}, answers: {} };
	expect(parsePreviewDrafts(JSON.stringify(saved)).goal).toBe(saved.goal);
	for (const value of [
		{ ...saved, version: 2 },
		{ ...saved, goal: 4 },
		{ ...saved, answers: { q: {} } },
	]) {
		let refused = false;
		try {
			parsePreviewDrafts(JSON.stringify(value));
		} catch {
			refused = true;
		}
		expect(refused).toBe(true);
	}
});

test("a fresh demo engine keeps goal and interview drafts without submitting them", async () => {
	const app = await open("./Preview.tsx", { width: 1100, height: 1200 });
	await app.waitFor("Three short things need you.");
	await app.press("role:button[New]");
	await app.type("id:goal", "  My unsent goal 日本語 ✓\n");
	await app.press("role:button[Back to Today]");
	await app.press("id:plan-export");
	await app.waitFor("id:question-what");
	await app.press("id:own-what");
	await app.type("id:answer-what", "Exact answer text 日本語 ✓");
	await app.waitUntil(() =>
		Object.values(parsePreviewDrafts(app.storage()["preview-drafts-v1"]).answers).some(
			(answer) => answer.text === "Exact answer text 日本語 ✓",
		),
	);
	const storage = app.storage();
	const reopened = await open("./Preview.tsx", { width: 1100, height: 1200, storage });
	await reopened.waitFor("Three short things need you.");
	await reopened.press("role:button[New]");
	expect(reopened.value("id:goal")).toBe("  My unsent goal 日本語 ✓\n");
	await reopened.press("role:button[Back to Today]");
	await reopened.press("id:plan-export");
	await reopened.waitFor("id:question-what");
	if (!reopened.shows("id:answer-what")) await reopened.press("id:own-what");
	expect(reopened.value("id:answer-what")).toBe("Exact answer text 日本語 ✓");
	expect(reopened.shows("Pilot continues planning: Not yet")).toBe(true);
});

test("unsupported saved drafts stay untouched rather than being replaced", async () => {
	const raw = JSON.stringify({ version: 99, futureText: "keep this exact value" });
	const app = await open("./Preview.tsx", { storage: { "preview-drafts-v1": raw } });
	await app.waitFor("text:/Preview drafts could not be read/");
	await app.waitFor("Three short things need you.");
	await app.press("role:button[New]");
	await app.type("id:goal", "new text must not replace the old copy");
	expect(app.storage()["preview-drafts-v1"]).toBe(raw);
});

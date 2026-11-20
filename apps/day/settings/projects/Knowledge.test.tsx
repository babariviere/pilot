// Scripted UI behavior, not native visual, IME or packaged-app acceptance.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 2000 } as const;
async function library() {
	const app = await open("../../KnowledgeFixture.tsx", desktop);
	await app.press("id:knowledge-open");
	await app.waitFor("id:knowledge-entry-k");
	return app;
}

test("search and exact historical sources are passive and not policy", async () => {
	const app = await library();
	await app.press("id:knowledge-entry-k");
	await app.waitFor("id:knowledge-detail");
	expect(app.shows("Needs checking before reliance. Reading does not check or accept it.")).toBe(true);
	expect(app.texts().some((t) => t.includes('"path":"src/store.ts"'))).toBe(true);
	await app.press("Revision history");
	await app.waitFor("Revision 1: Original finding");
	await app.press("Revision 1: Original finding");
	await app.waitFor("Historical finding");
	expect(app.enabled("id:knowledge-edit")).toBe(false);
	expect(app.shows("Saves: 0. Checks: 0.")).toBe(true);
	await app.type("id:knowledge-query", "absent");
	await app.press("id:knowledge-search");
	await app.waitFor("No matching Knowledge in this project.");
});

test("unknown save checks its receipt without resending or losing words", async () => {
	const app = await library();
	await app.press("id:knowledge-entry-k");
	await app.waitFor("id:knowledge-edit");
	await app.press("id:knowledge-edit");
	await app.type("id:knowledge-reason", "Clarify scope");
	await app.press("Lose next reply");
	await app.press("id:knowledge-save");
	await app.waitFor("id:knowledge-check");
	expect(app.enabled("id:knowledge-save")).toBe(false);
	expect(app.value("id:knowledge-reason")).toBe("Clarify scope");
	await app.press("id:knowledge-check");
	await app.waitFor("Saved a new revision. Sources are not checked or accepted by saving.");
	expect(app.shows("Saves: 1. Checks: 1.")).toBe(true);
	expect(app.shows("id:knowledge-draft")).toBe(false);
});

test("restored drafts send nothing and never move to another project", async () => {
	const app = await library();
	await app.press("id:knowledge-entry-k");
	await app.waitFor("id:knowledge-edit");
	await app.press("id:knowledge-edit");
	await app.type("id:knowledge-reason", "Exact 💬 draft");
	await app.press("Save window");
	await app.press("Restore window");
	await app.waitFor("id:knowledge-draft");
	expect(app.value("id:knowledge-reason")).toBe("Exact 💬 draft");
	expect(app.shows("Saves: 0. Checks: 0.")).toBe(true);
	await app.press("Other project");
	await app.waitFor("An unsaved Knowledge draft belongs to another project. Return to that project to edit it.");
	expect(app.shows("id:knowledge-draft")).toBe(false);
});

test("the library does not show the retired memory archive", async () => {
	const app = await library();
	await app.waitFor("id:knowledge-entry-k");
	expect(app.shows("Historical memory")).toBe(false);
});

test("cold-restored unknown saves reconcile before another save is offered", async () => {
	const app = await library();
	await app.press("id:knowledge-entry-k");
	await app.waitFor("id:knowledge-edit");
	await app.press("id:knowledge-edit");
	await app.type("id:knowledge-reason", "Keep exact operation");
	await app.press("Lose next reply");
	await app.press("id:knowledge-save");
	await app.waitFor("id:knowledge-check");
	await app.press("Save window");
	await app.press("Restore window");
	await app.waitFor("id:knowledge-check");
	expect(app.enabled("id:knowledge-save")).toBe(false);
	await app.press("id:knowledge-check");
	await app.waitUntil(() => !app.shows("id:knowledge-draft"));
	expect(app.shows("Saves: 1. Checks: 1.")).toBe(true);
});

test("project switches clear cached Knowledge", async () => {
	const app = await library();
	await app.press("id:knowledge-entry-k");
	await app.waitFor("id:knowledge-detail");
	await app.press("Other project");
	await app.waitUntil(() => !app.shows("id:knowledge-detail"));
	await app.press("id:knowledge-search");
	await app.waitFor("id:knowledge-entry-k");
	expect(app.shows("id:knowledge-detail")).toBe(false);
});

test("typing during Save keeps newer words on the confirmed base revision", async () => {
	const app = await library();
	await app.press("id:knowledge-entry-k");
	await app.waitFor("id:knowledge-edit");
	await app.press("id:knowledge-edit");
	await app.type("id:knowledge-reason", "First correction");
	await app.press("Hold next save");
	await app.press("id:knowledge-save");
	await app.type("id:knowledge-reason", " and a second");
	await app.press("Release reply");
	await app.waitFor("Unsaved edit of k, revision 3");
	expect(app.value("id:knowledge-reason")).toBe("First correction and a second");
	await app.press("id:knowledge-save");
	await app.waitFor("Saves: 2. Checks: 0.");
});

test("a save reply for the previous project cannot update the new view", async () => {
	const app = await library();
	await app.press("id:knowledge-entry-k");
	await app.waitFor("id:knowledge-edit");
	await app.press("id:knowledge-edit");
	await app.type("id:knowledge-reason", "Keep source scope");
	await app.press("Hold next save");
	await app.press("id:knowledge-save");
	await app.press("Other project");
	await app.press("Release reply");
	await app.waitFor("An unsaved Knowledge draft belongs to another project. Return to that project to edit it.");
	expect(app.shows("Saved a new revision. Sources are not checked or accepted by saving.")).toBe(false);
});

test("an older saved operation never clears different restored words", async () => {
	const app = await library();
	await app.press("id:knowledge-entry-k");
	await app.waitFor("id:knowledge-edit");
	await app.press("id:knowledge-edit");
	await app.type("id:knowledge-reason", "Correction A");
	await app.press("Save window");
	await app.press("Restore window");
	await app.waitUntil(() => app.enabled("id:knowledge-save"));
	await app.press("id:knowledge-save");
	await app.waitUntil(() => !app.shows("id:knowledge-draft"));
	await app.press("Restore window");
	await app.type("id:knowledge-reason", " with new words B");
	await app.press("Lose preflight reply");
	await app.press("id:knowledge-save");
	await app.waitFor("id:knowledge-message");
	await app.press("id:knowledge-search");
	await app.waitFor("id:knowledge-check");
	await app.press("id:knowledge-check");
	await app.waitFor(
		"This receipt saved earlier words, not this draft. Your words stay unsaved. Read the current revision to reconcile them.",
	);
	expect(app.value("id:knowledge-reason")).toBe("Correction A with new words B");
	expect(app.shows("Unsaved edit of k, revision 2")).toBe(true);
	expect(app.shows("Saves: 1. Checks: 1.")).toBe(true);
});

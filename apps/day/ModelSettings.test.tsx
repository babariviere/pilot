import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1800 } as const;

test("AI settings show effective action-specific thinking and the actual reference ceiling without writes", async () => {
	const app = await open("./ModelSettingsFixture.tsx", desktop);
	await app.waitFor("id:models-effective-task");
	expect(app.texts().some((t) => t.includes("Mission/task start: Reasoner") && t.includes("thinking low"))).toBe(true);
	expect(app.texts().some((t) => t.includes("Fresh Build: Reasoner") && t.includes("thinking high"))).toBe(true);
	expect(app.shows("Task-start ceiling: $30/M input + output (reference).")).toBe(true);
	expect(app.shows("Sends: 0, checks: 0")).toBe(true);
	await app.press("Unavailable");
	expect(app.texts().some((t) => t.includes("fixture/missing is unavailable"))).toBe(true);
	expect(app.texts().some((t) => t.includes("Fresh Build: fixture/missing is unavailable"))).toBe(true);
	expect(app.shows("Reasoner (fixture/reasoner)")).toBe(true);
	await app.press("No reference");
	expect(app.shows("Reference prices unavailable. New task starts are held until you set a replacement limit.")).toBe(
		true,
	);
	expect(app.shows("Sends: 0, checks: 0")).toBe(true);
});

test("AI settings keep stale edits and uncertain saves never resend", async () => {
	const app = await open("./ModelSettingsFixture.tsx", desktop);
	await app.press("id:models-edit-defaults");
	await app.type("id:models-limit", "24");
	await app.press("Save and restore draft");
	expect(app.value("id:models-limit")).toBe("24");
	await app.press("External edit");
	await app.press("id:models-save");
	expect(app.shows("These settings changed. Read again; your edits stay here.")).toBe(true);
	expect(app.value("id:models-limit")).toBe("24");
	await app.press("Keep my edits");
	await app.press("id:models-save");
	expect(app.shows("Saved.")).toBe(true);
	await app.press("id:models-edit-defaults");
	await app.press("Next unknown");
	await app.press("id:models-save");
	await app.waitFor("id:models-check");
	expect(app.enabled("id:models-save")).toBe(false);
	await app.press("id:models-check");
	expect(app.shows("Sends: 3, checks: 1")).toBe(true);
});

test("Fresh Build metadata names Pi's resolved fallback and does not invent an in-scope startup", async () => {
	const app = await open("./ModelSettingsFixture.tsx", desktop);
	await app.press("SDK fallback");
	expect(
		app.texts().some((t) => t.includes("Fresh Build: Plain") && t.includes("instead of configured fixture/missing")),
	).toBe(true);
	await app.press("SDK outside scope");
	expect(
		app.texts().some((t) => t.includes("Fresh Build: Pi selects at start") && t.includes("fixture/unlisted")),
	).toBe(true);
	expect(app.shows("Sends: 0, checks: 0")).toBe(true);
	await app.press("Shared settings only");
	expect(app.shows("id:models-effective-task")).toBe(false);
	expect(app.texts().some((t) => t.startsWith("Choose a project in Today"))).toBe(true);
});

test("sign-in response stays out of saved configuration and clears after sending", async () => {
	const app = await open("./ModelSettingsFixture.tsx", desktop);
	await app.press("Sign in with browser code");
	await app.press("Check sign-in");
	await app.waitFor("id:models-answer");
	await app.type("id:models-answer", "private-code#state");
	await app.press("Save and restore draft");
	expect(app.texts().some((t) => t.includes("private-code"))).toBe(false);
	await app.press("Send sign-in response");
	expect(app.shows("id:models-answer")).toBe(false);
	expect(app.texts().some((t) => t.includes("private-code"))).toBe(false);
});

test("an uncertain sign-in start still permits explicit cancellation and sign out", async () => {
	const app = await open("./ModelSettingsFixture.tsx", desktop);
	await app.press("Next unknown");
	await app.press("Sign in with browser code");
	await app.waitFor("id:models-check");
	expect(app.enabled("Cancel sign-in")).toBe(true);
	expect(app.enabled("Sign out")).toBe(true);
	await app.press("Cancel sign-in");
	expect(app.shows("Sends: 2, checks: 0")).toBe(true);
	expect(app.shows("id:models-check")).toBe(true);
});

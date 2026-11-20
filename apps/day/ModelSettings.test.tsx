import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1800 } as const;

test("allowances show uncertain catalog value, preserve drafts, and never resend an unknown approval", async () => {
	const app = await open("./ModelSettingsFixture.tsx", desktop);
	expect(app.texts().some((t) => t.includes("$0.30 uncertain") && t.includes("$0.50 left"))).toBe(true);
	// Each allowance is a row now: the work is its title, the amounts its meta line.
	expect(app.shows("Mission Improve the parser")).toBe(true);
	expect(app.texts().some((t) => t.includes("$7.00 left of"))).toBe(true);
	await app.press("id:funding-edit");
	await app.clear("id:funding-daily");
	await app.type("id:funding-daily", "2.50");
	await app.press("Save and restore draft");
	expect(app.value("id:funding-daily")).toBe("2.50");
	await app.press("Next unknown");
	await app.press("id:funding-save");
	expect(app.enabled("id:funding-save")).toBe(false);
	await app.press("id:models-check");
	expect(app.shows("Sends: 1, checks: 1")).toBe(true);
});

test("turning spending limits off hides allowance edits; turning them on shows them again", async () => {
	const app = await open("./ModelSettingsFixture.tsx", desktop);
	expect(app.shows("Change allowances")).toBe(true);
	await app.press("id:funding-limits");
	await app.waitFor("id:funding-off");
	expect(app.shows("Spending limits are off. Pilot does not stop work for cost.")).toBe(true);
	expect(app.shows("Change allowances")).toBe(false);
	expect(app.shows("Continue anyway")).toBe(true);
	await app.press("id:funding-limits");
	await app.waitFor("id:funding-edit");
	expect(app.shows("Spending limits are off. Pilot does not stop work for cost.")).toBe(false);
});

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

test("work profiles start collapsed with a summary; opening one edits its lists, and each change sends once", async () => {
	const app = await open("./ModelSettingsFixture.tsx", desktop);
	await app.waitFor("id:profile-backend");
	expect(app.shows("Services, APIs and jobs.")).toBe(true);
	expect(app.shows("Large: Reasoner, Plain · Small: Plain")).toBe(true);
	expect(app.shows("Large: fixture/unlisted · Small: fixture/unlisted · Off until a project allows it")).toBe(true);
	expect(app.shows("id:profile-entry-backend-large-fixture/reasoner")).toBe(false);
	expect(app.shows("id:profile-backend >> text:Edit models")).toBe(true);
	await app.press("label:Edit models for Backend");
	await app.waitFor("id:profile-entry-backend-large-fixture/reasoner");
	expect(app.shows("Sends: 0, checks: 0")).toBe(true);
	expect(app.shows("First is preferred when both are equally busy.")).toBe(true);
	expect(app.shows("id:profile-up-backend-large-fixture/reasoner")).toBe(false);
	await app.press("id:profile-down-backend-large-fixture/reasoner");
	await app.waitFor("Large: Plain, Reasoner · Small: Plain");
	expect(app.shows("Sends: 1, checks: 0")).toBe(true);
	await app.press("id:profile-remove-backend-small-fixture/plain");
	await app.waitFor("Large: Plain, Reasoner · Small: none");
	await app.press("Add a model");
	await app.press("Reasoner");
	await app.waitFor("Large: Plain, Reasoner · Small: Reasoner");
	expect(app.shows("Sends: 3, checks: 0")).toBe(true);
	expect(app.shows("id:profile-opt-in-tick-backend")).toBe(false);
	await app.press("id:profile-opt-in-backend");
	await app.waitFor("Large: Plain, Reasoner · Small: Reasoner · Off until a project allows it");
	expect(app.shows("id:profile-opt-in-tick-backend")).toBe(true);
	expect(app.shows("Sends: 4, checks: 0")).toBe(true);
	await app.press("id:profile-add");
	await app.type("id:profile-name", "Data science");
	await app.type("id:profile-covers", "Pipelines and their checks.");
	await app.press("id:profile-save");
	await app.waitFor("id:profile-data-science-large");
	expect(app.shows("id:profile-form")).toBe(false);
	expect(app.shows("Sends: 5, checks: 0")).toBe(true);
	await app.press("id:profile-cyber");
	await app.waitFor("id:profile-delete-cyber");
	expect(app.shows("Not signed in")).toBe(true);
	await app.press("id:profile-delete-cyber");
	await app.waitUntil(() => !app.shows("id:profile-cyber"));
	expect(app.shows("Sends: 6, checks: 0")).toBe(true);
});

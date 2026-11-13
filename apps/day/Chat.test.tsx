// New's project choice and standalone chat as a user takes them, on a
// scripted source with the connected rules (ChatFixture.tsx). No daemon,
// provider or storage.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1200 } as const;
const COUNTS = (s: number, n: number, c: number) => `Selects: ${s} · Sends: ${n} · Checks: ${c}`;

async function ready() {
	const app = await open("./ChatFixture.tsx", desktop);
	await app.waitFor("What do you want done?");
	await app.waitFor("No project is chosen for you.");
	return app;
}

/** The fixture's line that starts with `prefix`. */
function line(app: { texts(): string[] }, prefix: string): string {
	return app.texts().find((t) => t.startsWith(prefix)) ?? "";
}

function counts(app: { texts(): string[] }): string {
	return line(app, "Selects:");
}

function started(app: { texts(): string[] }): string {
	return line(app, "Started:");
}

async function choose(app: Awaited<ReturnType<typeof ready>>, name: string) {
	await app.press("label:Project for a new chat");
	await app.press(`text:${name}`);
}

test("New starts with no project: both starts wait for the user's choice, and choosing sends nothing", async () => {
	const app = await ready();
	expect(counts(app)).toContain(COUNTS(0, 0, 0));
	await app.type("id:goal", "Fix the flaky upload test 👩🏽‍💻");
	expect(app.shows("Choose a project")).toBe(true);
	expect(app.shows("Plan a mission and Start as one chat wait for a project.")).toBe(true);
	expect(app.enabled("role:button[Plan a mission]")).toBe(false);
	expect(app.enabled("role:button[Start as one chat]")).toBe(false);
	await choose(app, "website");
	await app.waitFor("/Users/you/src/website");
	expect(app.value("id:goal")).toBe("Fix the flaky upload test 👩🏽‍💻");
	expect(counts(app)).toContain(COUNTS(1, 0, 0));
	expect(app.enabled("role:button[Start as one chat]")).toBe(true);
	// Missions still start in this window's project: Plan a mission says so.
	expect(app.enabled("role:button[Plan a mission]")).toBe(false);
	expect(app.shows("Missions start in pilot here. Choose pilot to plan one, or start this as one chat.")).toBe(true);
	await choose(app, "pilot");
	await app.waitFor("/Users/you/src/pilot");
	expect(app.enabled("role:button[Plan a mission]")).toBe(true);
	expect(counts(app)).toContain("Sends: 0");
});

test("a profile-only window plans in an explicit project, never a launch default", async () => {
	const app = await ready();
	await app.press("role:button[Profile-only window]");
	await app.type("id:goal", "Clarify the website mission");
	expect(app.enabled("role:button[Plan a mission]")).toBe(false);
	await choose(app, "website");
	await app.waitFor("/Users/you/src/website");
	expect(app.enabled("role:button[Plan a mission]")).toBe(true);
	expect(app.enabled("role:button[Start as one chat]")).toBe(true);
	expect(counts(app)).toContain(COUNTS(1, 0, 0));
	await app.press("role:button[Save and reopen]");
	await app.waitFor("/Users/you/src/website");
	expect(app.value("id:goal")).toBe("Clarify the website mission");
	expect(counts(app)).toContain("Sends: 0");
});

test("a chat starts once in the chosen project, with the access chosen and the exact words, and uses its choice up", async () => {
	const app = await ready();
	await app.type("id:goal", "  Exact words\nkept  ");
	await choose(app, "website");
	await app.press("role:button[Start as one chat]");
	await app.waitFor("Start one chat with exactly these words?");
	await app.waitFor("website · Default model · medium thinking");
	await app.press("id:mode-ask");
	await app.waitFor("website · Default model · medium thinking");
	expect(counts(app)).toContain("Sends: 0");
	await app.press("role:button[Start chat]");
	await app.waitFor(
		"Started one Ask chat in website with your words. It works on its own; that is not progress or a result yet.",
	);
	expect(started(app)).toBe("Started: demo-website ask [  Exact words\nkept  ]");
	expect(counts(app)).toContain("Sends: 1");
	expect(app.value("id:goal")).toBe("");
	expect(app.shows("A chat in website")).toBe(true);
	// The next words need a project of their own: New does not reuse the last one.
	await app.waitFor("No project is chosen for you.");
	await app.type("id:goal", "Next ask");
	expect(app.enabled("role:button[Start as one chat]")).toBe(false);
	expect(app.enabled("role:button[Plan a mission]")).toBe(false);
});

test("answers to older choices are dropped: the newest choice is the one sent", async () => {
	const app = await ready();
	await app.type("id:goal", "Out of order");
	await app.press("Hold selections");
	await choose(app, "website");
	await choose(app, "pilot");
	await app.press("Release newer selection");
	await app.press("Release older selection");
	await app.waitFor("/Users/you/src/pilot");
	await app.press("role:button[Start as one chat]");
	await app.waitFor("pilot · Default model · medium thinking");
	await app.press("role:button[Start chat]");
	await app.waitFor(
		"Started one Build chat in pilot with your words. It works on its own; that is not progress or a result yet.",
	);
	expect(started(app)).toBe("Started: demo-pilot build [Out of order]");
	expect(counts(app)).toContain("Sends: 1");
});

test("a project setup that changed after it was shown is not sent; its setup is read again", async () => {
	const app = await ready();
	await app.type("id:goal", "Changed setup");
	await choose(app, "website");
	await app.press("role:button[Start as one chat]");
	await app.waitFor("website · Default model · medium thinking");
	await app.press("Change website setup");
	await app.press("role:button[Start chat]");
	await app.waitFor("This project or its setup changed since Pilot read it. Nothing was sent; your words stay.");
	expect(counts(app)).toContain("Sends: 0");
	expect(app.value("id:goal")).toBe("Changed setup");
	// The setup was read again: the next Start sends once.
	await app.waitFor("website · Default model · medium thinking");
	await app.press("role:button[Start chat]");
	await app.waitFor(
		"Started one Build chat in website with your words. It works on its own; that is not progress or a result yet.",
	);
	expect(counts(app)).toContain("Sends: 1");
});

test("a removed project is never swapped for another", async () => {
	const app = await ready();
	await app.type("id:goal", "Removed project");
	await choose(app, "website");
	await app.press("role:button[Start as one chat]");
	await app.waitFor("website · Default model · medium thinking");
	await app.press("Remove website");
	await app.press("role:button[Start chat]");
	await app.waitFor("The project you chose is no longer in Pilot. Choose a project.");
	expect(app.enabled("role:button[Start chat]")).toBe(false);
	expect(app.shows("Choose a project")).toBe(true);
	expect(started(app)).toBe("Started: ");
	expect(counts(app)).toContain("Sends: 0");
});

test("a lost answer stays not confirmed, blocks another chat, and Check reads it once", async () => {
	const app = await ready();
	await app.type("id:goal", "Lost answer");
	await choose(app, "pilot");
	await app.press("Lose next answer");
	await app.press("role:button[Start as one chat]");
	await app.waitFor("pilot · Default model · medium thinking");
	await app.press("role:button[Start chat]");
	await app.waitFor("A new chat in pilot is not confirmed.");
	expect(app.shows("Pilot sent this but heard nothing back. It will not send it again; Check only reads.")).toBe(true);
	expect(app.value("id:goal")).toBe("Lost answer");
	expect(app.enabled("role:button[Start chat]")).toBe(false);
	// Choosing again cannot start another one meanwhile.
	await choose(app, "website");
	await app.waitFor("An earlier new chat is not confirmed. Check it before you start another.");
	expect(counts(app)).toContain("Sends: 1");
	await app.press(
		"role:button[Check whether the new chat started. This reads Pilot's saved answer and sends nothing.]",
	);
	await app.waitFor("The chat in pilot started. It works on its own; that is not progress or a result yet.");
	expect(app.shows("A new chat in pilot is not confirmed.")).toBe(false);
	expect(app.value("id:goal")).toBe("");
	expect(counts(app)).toContain("Sends: 1 · Checks: 1");
	expect(started(app)).toBe("Started: demo-pilot build [Lost answer]");
});

test("save and reopen keeps the words and the project, and sends nothing", async () => {
	const app = await ready();
	await app.type("id:goal", "  Keep me 日本語 ✓\n");
	await choose(app, "website");
	await app.waitFor("/Users/you/src/website");
	await app.press("Save and reopen");
	await app.waitFor("/Users/you/src/website");
	expect(app.value("id:goal")).toBe("  Keep me 日本語 ✓\n");
	expect(counts(app)).toContain("Sends: 0");
	expect(app.shows("Started one")).toBe(false);
});

test("an older save's project was never the user's choice: it comes back with no project", async () => {
	const app = await ready();
	await app.type("id:goal", "Older save 日本語");
	await choose(app, "website");
	await app.waitFor("/Users/you/src/website");
	await app.press("Reopen as an older save");
	await app.waitFor("No project is chosen for you.");
	expect(app.value("id:goal")).toBe("Older save 日本語");
	expect(app.enabled("role:button[Start as one chat]")).toBe(false);
	expect(app.enabled("role:button[Plan a mission]")).toBe(false);
	expect(counts(app)).toContain("Sends: 0");
});

test("leaving New without words drops the project; words keep it", async () => {
	const app = await ready();
	await choose(app, "website");
	await app.waitFor("/Users/you/src/website");
	await app.keyboard.press("escape");
	expect(app.shows("What do you want done?")).toBe(false);
	await app.press("Open New");
	await app.waitFor("No project is chosen for you.");
	await app.type("id:goal", "Kept with its project");
	await choose(app, "website");
	await app.waitFor("/Users/you/src/website");
	await app.keyboard.press("escape");
	await app.press("Open New");
	await app.waitFor("/Users/you/src/website");
	expect(app.value("id:goal")).toBe("Kept with its project");
	expect(counts(app)).toContain("Sends: 0");
});

test("without the service, New lists no projects and starts nothing", async () => {
	const app = await ready();
	await app.press("Go offline");
	await app.type("id:goal", "Offline");
	await app.press("Save and reopen");
	await app.waitFor("Pilot cannot list your projects here. Pilot could not reach its service.");
	expect(app.enabled("role:button[Start as one chat]")).toBe(false);
	expect(counts(app)).toContain("Sends: 0");
});

test("Escape closes an open project list first, then leaves New with the words kept", async () => {
	const app = await ready();
	await app.type("id:goal", "Escape twice");
	await app.press("label:Project for a new chat");
	await app.waitFor("/Users/you/src/website");
	await app.keyboard.press("escape");
	expect(app.shows("/Users/you/src/website")).toBe(false);
	expect(app.shows("What do you want done?")).toBe(true);
	await app.keyboard.press("escape");
	expect(app.shows("What do you want done?")).toBe(false);
	expect(counts(app)).toContain("Sends: 0");
});

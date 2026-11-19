import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;

test("project pages stay small and every source remains reachable without effects", async () => {
	const app = await open("./ProjectsFixture.tsx", desktop);
	await app.waitUntil(() => app.enabled("id:projects-local"));
	await app.press("Many projects");
	await app.press("id:projects-refresh");
	await app.waitFor("Project 1");
	expect(app.shows("Project 6")).toBe(false);
	await app.press("Next projects");
	await app.waitFor("Project 6");
	expect(app.shows("Project 1")).toBe(false);
	await app.press("Next projects");
	await app.waitFor("Project 12");
	expect(app.enabled("Next projects")).toBe(false);
	await app.press("Previous projects");
	await app.waitFor("Project 6");
	expect(app.shows("Mock data. Actions: 0. Checks: 0.")).toBe(true);
});

test("a saved close or update restores unsent folder text without adding a project", async () => {
	const app = await open("./ProjectsFixture.tsx", desktop);
	await app.waitUntil(() => app.enabled("id:projects-local"));
	await app.press("id:projects-local");
	await app.type("id:project-folder", "/Users/test/日本語 notes");
	await app.press("Save and reopen");
	await app.waitUntil(() => app.enabled("id:projects-local"));
	await app.press("id:projects-local");
	expect(app.value("id:project-folder")).toBe("/Users/test/日本語 notes");
	expect(app.shows("Mock data. Actions: 0. Checks: 0.")).toBe(true);
});

test("project setup reads without effects and names the real source policy", async () => {
	const app = await open("./ProjectsFixture.tsx", desktop);
	await app.waitFor("id:projects-local");
	expect(app.shows("Private jj coding copies · Read-only main")).toBe(true);
	expect(app.shows("Source folder: /Users/test/src/harbour")).toBe(true);
	expect(app.shows("Mock data. Actions: 0. Checks: 0.")).toBe(true);
	await app.press("id:projects-refresh");
	expect(app.shows("Mock data. Actions: 0. Checks: 0.")).toBe(true);
});

test("a local folder needs a preview and explicit Add; editing clears the old preview", async () => {
	const app = await open("./ProjectsFixture.tsx", desktop);
	await app.waitUntil(() => app.enabled("id:projects-local"));
	await app.press("id:projects-local");
	await app.type("id:project-folder", "/Users/test/notes");
	await app.press("id:project-preview");
	await app.waitFor("Agents will edit your folder directly. Local edits stay visible.");
	expect(app.shows("Mock data. Actions: 0. Checks: 0.")).toBe(true);
	await app.type("id:project-folder", "-other");
	expect(app.shows("id:project-add")).toBe(false);
	await app.press("id:project-preview");
	await app.waitFor("Agents will use private jj copies. Main is read-only.");
	await app.press("id:project-add");
	await app.waitFor("Saved. Check the status below.");
	expect(app.shows("Mock data. Actions: 1. Checks: 0.")).toBe(true);
});

test("an uncertain action blocks repeat effects; refresh and Check never resend", async () => {
	const app = await open("./ProjectsFixture.tsx", desktop);
	await app.waitUntil(() => app.enabled("id:projects-local"));
	await app.press("Next uncertain");
	await app.press("id:projects-local");
	await app.type("id:project-folder", "/Users/test/notes");
	await app.press("id:project-preview");
	await app.waitFor("id:project-add");
	await app.press("id:project-add");
	await app.waitFor("id:project-check");
	expect(app.enabled("id:project-add")).toBe(false);
	await app.press("id:projects-refresh");
	await app.waitUntil(() => app.enabled("id:project-check"));
	await app.press("id:project-check");
	await app.waitFor("Mock data. Actions: 1. Checks: 1.");
});

test("import previews its destination before any clone and keeps interrupted imports visible", async () => {
	const app = await open("./ProjectsFixture.tsx", desktop);
	await app.waitUntil(() => app.enabled("id:projects-import"));
	expect(app.shows("Resume import")).toBe(true);
	await app.press("id:projects-import");
	await app.type("id:project-url", "https://github.com/test/project");
	await app.press("id:import-preview");
	await app.waitFor("id:import-start");
	expect(app.shows("/Users/test/src/project")).toBe(true);
	expect(app.shows("Mock data. Actions: 0. Checks: 0.")).toBe(true);
	await app.press("id:github-setup-open");
	expect(app.shows("GitHub account: test")).toBe(true);
	expect(app.shows("SSH verified (existing).")).toBe(true);
});

test("each project has one checkbox per work profile; Cyber starts unchecked and a tick allows it there only", async () => {
	const app = await open("./ProjectsFixture.tsx", desktop);
	await app.waitFor("id:project-profiles-one");
	expect(app.shows("Profiles allowed in this project. The planner picks from these for each task.")).toBe(true);
	expect(app.shows("id:project-profile-tick-one-backend")).toBe(true);
	expect(app.shows("id:project-profile-tick-one-cyber")).toBe(false);
	await app.press("id:project-profile-one-cyber");
	await app.waitFor("id:project-profile-tick-one-cyber");
	expect(app.shows("Mock data. Actions: 1. Checks: 0.")).toBe(true);
	expect(app.shows("id:project-profile-tick-two-cyber")).toBe(false);
	await app.press("id:project-profile-one-backend");
	await app.waitUntil(() => !app.shows("id:project-profile-tick-one-backend"));
	expect(app.shows("Mock data. Actions: 2. Checks: 0.")).toBe(true);
});

test("linking another project is one explicit tick that the next read shows, and unticking unlinks", async () => {
	const app = await open("./ProjectsFixture.tsx", desktop);
	await app.waitFor("id:project-links-one");
	expect(app.shows("Also reads: none")).toBe(true);
	expect(app.shows("id:project-link-one-two")).toBe(false);
	await app.press("id:project-links-one");
	await app.waitFor("id:project-link-one-two");
	expect(app.shows("Mock data. Actions: 0. Checks: 0.")).toBe(true);
	await app.press("id:project-link-one-two");
	await app.waitFor("Also reads: Lighthouse");
	expect(app.shows("Mock data. Actions: 1. Checks: 0.")).toBe(true);
	expect(app.shows("id:project-link-one-two")).toBe(true);
	await app.press("id:project-link-one-two");
	await app.waitFor("Mock data. Actions: 2. Checks: 0.");
	expect(app.shows("Also reads: none")).toBe(true);
});

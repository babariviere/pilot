// New's project-first guidance and its plan lists, on invented data
// (NewPlansFixture.tsx). No daemon, provider or storage.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;
const PLAN_HINT = "Pilot asks you questions first.";

function says(app: { texts(): string[] }, words: string): boolean {
	return app.texts().some((t) => t.includes(words));
}

test("New gives one project hint first and warns about planning only after reading the chosen project", async () => {
	const app = await open("./NewPlansFixture.tsx", desktop);
	await app.waitFor("What do you want done?");
	await app.press("Turn planning off");
	await app.type("id:goal", "Fix the flaky upload test");
	// No project yet: one hint, no warning and no planning guidance.
	expect(app.shows("id:planning-off")).toBe(false);
	expect(app.shows("Choose a project to see what can start there.")).toBe(true);
	expect(says(app, PLAN_HINT)).toBe(false);
	await app.press("label:Project for a new chat");
	await app.press("text:pilot");
	await app.waitFor("id:planning-off");
	expect(app.shows("Choose a project to see what can start there.")).toBe(false);
	expect(app.shows("Pilot cannot plan a mission in pilot.")).toBe(true);
	expect(
		app.shows(
			"Mission planning is not configured for this project. Nothing was sent. You can still start this as one chat in pilot.",
		),
	).toBe(true);
	// Planning guidance would contradict the notice, so it does not show.
	expect(says(app, PLAN_HINT)).toBe(false);
	expect(app.enabled("role:button[Plan a mission]")).toBe(false);
	expect(app.enabled("role:button[Start as one chat]")).toBe(true);
});

test("plans whose tasks exist are listed apart, with Today's state or a way to view status", async () => {
	const app = await open("./NewPlansFixture.tsx", desktop);
	await app.waitFor("Tasks created");
	expect(app.shows("Missions in planning")).toBe(true);
	expect(says(app, "Work admission")).toBe(false);
	// Today does not know this mission: New links to its status and claims no state.
	expect(app.shows("id:plan-status-published-search")).toBe(true);
	expect(app.texts().filter((t) => t === "View status").length).toBe(1);
	// Today knows this one: New shows Today's state for it.
	const state = (app.texts().find((t) => t.startsWith("Today's state: ")) ?? "").slice("Today's state: ".length);
	expect(state).not.toBe("none");
	expect(app.shows(`role:button[Known mission, ${state}. Open the mission.]`)).toBe(true);
});

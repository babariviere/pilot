// Registering and updating Pilot's service as a user takes it, on mock
// data: one-use confirmations with exact versions, forms saved before
// anything pauses, only working agents paused and resumed, the window
// restored without sending anything, and lost answers that stay
// unconfirmed until Check again reads them. These prove the screens and
// the mock rules, not the native updater or a real service.
import { expect, open, test } from "nsh/test";
import { type SavedView, UpdateFeed } from "pilot-day/native";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;

type App = Awaited<ReturnType<typeof open>>;

/** Prepares the offer shown, checks what it says it will do, and confirms it, as a user does. */
async function confirm(app: App, question: string, lines: string[] = []) {
	await app.press("id:update-prepare");
	await app.waitFor(question);
	for (const line of lines) expect(app.shows(line)).toBe(true);
	await app.press("id:update-confirm");
}

test("Today offers the update page only when the service needs the user", async () => {
	const quiet = await open("./App.tsx", desktop);
	await quiet.waitFor("Needs you");
	expect(quiet.shows("id:update-open")).toBe(false);

	const app = await open("./Update.tsx", desktop);
	await app.waitFor("role:button[Update ready]");
	await app.press("role:button[Update ready]");
	await app.waitFor("Pilot 0.9.3 is ready for this app and Pilot's service");
	expect(app.shows("Pilot's service is running")).toBe(true);
	expect(app.shows("This app 0.9.2 · Service 0.9.2")).toBe(true);
	// Escape goes back, and nothing was prepared or sent.
	await app.keyboard.press("escape");
	await app.waitFor("Needs you");
	expect(app.shows("role:button[Update ready]")).toBe(true);
});

test("an update saves every form, pauses only working agents, restores the window and resumes only them", async () => {
	const app = await open("./Update.tsx", desktop);
	await app.keyboard.press("mod+n");
	await app.waitFor("What do you want done?");
	await app.type("id:goal", "Export chats as Markdown files");
	await app.keyboard.press("escape");
	await app.press("id:plan-export");
	await app.waitFor("Question 2 of 7 · 3 answered");
	// Typed, not saved yet: the update saves it before anything pauses.
	if (!app.shows("id:answer-what")) await app.press("id:own-what");
	await app.type("id:answer-what", "Only the messages");

	await app.press("role:button[Update ready]");
	await confirm(app, "Update from 0.9.2 to 0.9.3?", [
		"Saves your drafts and where you are first.",
		"Pauses two agents at a safe point, then resumes only them.",
		"One agent you paused stays as you left it.",
		"Day restarts and comes back to this page.",
	]);
	await app.waitFor("Paused for the update");
	expect(app.shows("Updated to 0.9.3")).toBe(false);
	await app.waitFor("Updated to 0.9.3");
	expect(app.shows("This app 0.9.3 · Service 0.9.3")).toBe(true);
	expect(app.shows("Paused for the update")).toBe(false);
	expect(app.shows("Resumed")).toBe(true);
	expect(app.shows("Left as you paused it")).toBe(true);
	expect(app.shows("Pilot's service is running")).toBe(true);

	// The restarted window came back to the same question, with the answer
	// read from its own store, not from this run's screen state.
	await app.press("role:button[Back]");
	await app.waitFor("Question 2 of 7 · 4 answered");
	// The answer field had the keyboard focus, and has it again: Escape leaves it first.
	await app.keyboard.press("escape");
	await app.keyboard.press("escape");
	await app.waitFor("Needs you");
	// Up to date now: the top bar offers nothing.
	expect(app.shows("id:update-open")).toBe(false);
	await app.keyboard.press("mod+n");
	await app.waitFor("What do you want done?");
	// New's unsent goal came back exactly; nothing was planned or sent.
	expect(app.enabled("role:button[Plan a mission]")).toBe(true);
});

test("a stale confirmation updates nothing, and a lost answer stays unconfirmed until Check again reads it", async () => {
	const app = await open("./UpdateTrouble.tsx", desktop);
	await app.waitFor("Pilot 0.9.3 is ready for Pilot's service");
	await app.press("id:update-prepare");
	await app.waitFor("Update from 0.9.2 to 0.9.3?");
	expect(app.shows("Day restarts and comes back to this page.")).toBe(false);
	await app.press("id:update-confirm");
	await app.waitFor(
		"A newer update arrived after you confirmed, so nothing was paused or updated. Read it and confirm again.",
	);
	expect(app.shows("Pilot 0.9.4 is ready for Pilot's service")).toBe(true);
	expect(app.shows("Paused for the update")).toBe(false);

	await confirm(app, "Update from 0.9.2 to 0.9.4?");
	await app.waitFor("Update not confirmed");
	expect(
		app.shows(
			"Pilot cannot tell yet whether the update finished. Nothing will be sent again, and paused agents stay paused until Pilot checks.",
		),
	).toBe(true);
	expect(app.shows("Not confirmed")).toBe(true);
	expect(app.shows("Updated to 0.9.4")).toBe(false);
	expect(app.shows("This app 0.9.2 · Service 0.9.2")).toBe(true);
	expect(app.shows("id:update-prepare")).toBe(false);
	expect(app.shows("Paused for the update")).toBe(true);

	await app.press("id:update-check");
	await app.waitFor("Updated to 0.9.4");
	expect(app.shows("This app 0.9.2 · Service 0.9.4")).toBe(true);
	expect(app.shows("Resumed")).toBe(true);
	expect(app.shows("Resume asked, not confirmed yet")).toBe(true);
	expect(app.shows("Left as you paused it")).toBe(true);
});

test("the restored window shows the standup notes and open help again, and sends nothing", async () => {
	const app = await open("./Update.tsx", desktop);
	await app.waitFor("1 of 3");
	await app.press("Say it simpler");
	await app.waitFor("Pilot sends too many notifications. Choose when it should tell you about finished work.");
	await app.press("Ask a question");
	await app.waitFor("id:question");
	await app.press("id:standup");
	await app.waitFor("id:standup-notes");

	await app.press("role:button[Update ready]");
	await confirm(app, "Update from 0.9.2 to 0.9.3?");
	await app.waitFor("Updated to 0.9.3");
	// The service resumed the agents it paused; showing the view resumed nothing.
	expect(app.shows("Resumed")).toBe(true);
	await app.press("role:button[Back]");
	// The ritual on screen came back, on the same date.
	await app.waitFor("id:standup-notes");
	await app.press("role:button[Back to Today]");
	// Open help came back, the question field with it; nothing was asked or answered.
	// (The question's own words come back from its draft store: the connected
	// window's tests check that, since this mock does not restart Today.)
	await app.waitFor("Pilot sends too many notifications. Choose when it should tell you about finished work.");
	expect(app.shows("id:question")).toBe(true);
	expect(app.shows("Asking…")).toBe(false);
	expect(app.shows("has your answer")).toBe(false);
	expect(app.shows("1 of 3")).toBe(true);
});

test("a failed save and an unproven job exit stop the update before anything is replaced", async () => {
	const app = await open("./UpdateRefused.tsx", desktop);
	await confirm(app, "Update from 0.9.2 to 0.9.3?");
	await app.waitFor("Not updated");
	expect(
		app.shows(
			"Pilot could not save where you are: the disk is full. Nothing was paused or updated, and your drafts stay as they are.",
		),
	).toBe(true);
	expect(app.shows("Free some space, then try again.")).toBe(true);
	expect(app.shows("Stopped here")).toBe(true);
	expect(app.shows("Paused for the update")).toBe(false);
	expect(app.shows("This app 0.9.2 · Service 0.9.2")).toBe(true);

	await confirm(app, "Update from 0.9.2 to 0.9.3?");
	await app.waitFor("Needs a look");
	expect(
		app.shows(
			"Not updated. A job in “Release notes” may still have processes running, and Pilot cannot prove they ended, so it stopped before replacing anything. The other paused agents went back to work.",
		),
	).toBe(true);
	expect(app.shows("Updated to 0.9.3")).toBe(false);
	expect(app.shows("This app 0.9.2 · Service 0.9.2")).toBe(true);
	expect(app.shows("Working")).toBe(true);
	expect(app.shows("Left as you paused it")).toBe(true);
	// A durable refusal: the next attempt is off until someone checks.
	expect(app.enabled("id:update-prepare")).toBe(false);
	expect(app.shows("Pilot will not update the service until someone checks the agent whose job may still run.")).toBe(
		true,
	);
});

test("registering is explicit; a lost answer is only looked up", async () => {
	const app = await open("./ServiceAbsent.tsx", desktop);
	await app.waitFor("Pilot's service is not registered");
	expect(app.shows("This app 0.9.2 · Service unknown")).toBe(true);
	await confirm(app, "Register Pilot's service?", ["macOS may ask you to allow it in Login Items."]);
	await app.waitFor("Registration not confirmed");
	expect(app.shows("Pilot cannot tell yet whether the service was registered. Nothing will be sent again.")).toBe(
		true,
	);
	expect(app.shows("Pilot cannot tell whether its service is registered")).toBe(true);
	expect(app.shows("id:update-prepare")).toBe(false);
	await app.press("id:update-check");
	await app.waitFor("Registered");
	expect(app.shows("Pilot's service is running")).toBe(true);
	expect(app.shows("This app 0.9.2 · Service 0.9.2")).toBe(true);
	expect(app.shows("Pilot found the service registered and answering, version 0.9.2.")).toBe(true);
});

test("a registration macOS refuses says what to do, and the next one goes through", async () => {
	const app = await open("./ServiceDenied.tsx", desktop);
	await confirm(app, "Register Pilot's service?");
	await app.waitFor("Not registered");
	expect(app.shows("macOS did not allow Pilot's service to run in the background. Nothing was registered.")).toBe(
		true,
	);
	expect(app.shows("Allow Pilot in System Settings › General › Login Items, then register again.")).toBe(true);
	expect(app.shows("Pilot's service is not registered")).toBe(true);
	await confirm(app, "Register Pilot's service?");
	await app.waitFor("Registered");
	expect(app.shows("Pilot's service is running")).toBe(true);
});

test("an offline service holds updates, and Check again only reads", async () => {
	const app = await open("./ServiceOffline.tsx", desktop);
	await app.waitFor("Pilot's service is not answering");
	expect(app.enabled("id:update-prepare")).toBe(false);
	expect(app.shows("Pilot's service is not answering, so it cannot update now.")).toBe(true);
	await app.press("id:update-read");
	await app.waitFor("Pilot's service is still not answering. Nothing was changed.");
	expect(app.enabled("id:update-prepare")).toBe(false);
});

test("a newer service takes an app-only update that leaves every agent working", async () => {
	const app = await open("./ServiceNewer.tsx", desktop);
	await app.waitFor("Pilot's service does not match this app");
	expect(app.shows("This app 0.9.2 · Service 0.12.0")).toBe(true);
	await confirm(app, "Update from 0.9.2 to 0.12.0?", ["Agents keep working; only this app restarts."]);
	await app.waitFor("Updated to 0.12.0");
	expect(app.shows("This app 0.12.0 · Service 0.12.0")).toBe(true);
	expect(app.shows("Pilot's service is running")).toBe(true);
	expect(app.shows("Paused for the update")).toBe(false);
	expect(app.shows("Resumed")).toBe(false);
	expect(app.shows("Working")).toBe(true);
});

test("confirmations are one-use and exact; an oversized view is refused before anything pauses", async () => {
	const feed = new UpdateFeed("available");
	const view: SavedView = { place: "today", id: "", update: true, goal: "", focused: "", questions: [] };
	const shown = feed.snapshot();
	expect(feed.prepare({ kind: "both", revision: shown.revision - 1 }).status).toBe("stale");
	expect(feed.prepare({ kind: "service", revision: shown.revision }).status).toBe("stale");
	const first = feed.prepare({ kind: "both", revision: shown.revision });
	expect(first.status).toBe("accepted");
	const id = first.confirmation?.id ?? "";
	expect(first.confirmation?.to).toBe("0.9.3");
	expect(first.confirmation?.pauses).toBe(2);
	expect(first.confirmation?.keeps).toBe(1);
	// Exact intents: an unknown key is a TypeError before Rust acts.
	for (const forged of [
		{ confirmation: id, view, approve: true },
		{ confirmation: id, view: { ...view, path: "/tmp" } },
		{ confirmation: id, view: { ...view, place: "anywhere" } },
	]) {
		let refused = "";
		await feed.confirm(forged as never).catch((error: unknown) => {
			refused = String(error);
		});
		expect(refused).toContain("TypeError");
	}
	const big = await feed.confirm({ confirmation: id, view: { ...view, goal: "x".repeat(70 * 1024) } });
	expect(big.status).toBe("rejected");
	expect(feed.snapshot().run).toBe(null);
	expect(feed.snapshot().agents.some((a) => a.state === "paused")).toBe(false);
	// The confirmation was used: confirming it again sends nothing.
	const again = await feed.confirm({ confirmation: id, view });
	expect(again.status).toBe("rejected");
	expect(feed.snapshot().run).toBe(null);
	feed.dispose();
});

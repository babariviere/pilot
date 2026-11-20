import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1400 } as const;
const OTHER =
	"Draft: [Add keyboard shortcuts for the command palette] · demo-website/ask · request slack-1 · linked no";
const EDITED = "Draft: [Prevent overwrites in every export format] · demo-pilot/build · request none · linked yes";
const LINKED =
	"Draft: [Prevent overwrites across all chat export formats] · demo-pilot/build · request none · linked yes";

async function linked() {
	const app = await open("../../NewLinkedFixture.tsx", desktop);
	await app.press("Draft a linked mission");
	await app.waitFor("Plan a linked mission");
	await app.waitUntil(() => app.enabled("role:button[Plan mission]"));
	return app;
}

test("drafting a linked mission keeps the other New draft; going back keeps both and sends nothing", async () => {
	const app = await linked();
	expect(app.shows(LINKED)).toBe(true);
	expect(
		app.shows(
			"From Feedback: “Exported chat names collide”. Plan links the feedback to the mission. Edit the goal first.",
		),
	).toBe(true);
	expect(app.value("id:goal")?.startsWith("Prevent overwrites across all chat export formats")).toBe(true);
	expect(app.shows("id:linked-scope >> Project")).toBe(true);
	expect(app.shows("id:linked-scope >> Model")).toBe(true);
	expect(app.shows("Your other New draft stays saved.")).toBe(true);
	expect(app.shows("Add keyboard shortcuts for the command palette")).toBe(true);
	// A linked draft is planned or dropped: it is never started as one chat.
	expect(app.shows("role:button[Start as one chat]")).toBe(false);
	await app.clear("id:goal");
	await app.type("id:goal", "Prevent overwrites in every export format");
	// Drafting the same proposal again keeps the user's edits.
	await app.press("Draft a linked mission");
	expect(app.value("id:goal")).toBe("Prevent overwrites in every export format");
	await app.press("role:button[Back to Feedback]");
	await app.waitFor("Route: closed · Feedback open");
	expect(app.shows(EDITED)).toBe(true);
	await app.press("Open New");
	await app.waitFor("Plan a linked mission");
	expect(app.value("id:goal")).toBe("Prevent overwrites in every export format");
	expect(app.shows("Your other New draft stays saved.")).toBe(true);
	// Discarding edits asks first; keeping them changes nothing.
	await app.press("role:button[Discard linked draft]");
	await app.waitFor("Discard your edits to this linked draft?");
	await app.press("role:button[Keep editing]");
	expect(app.shows(EDITED)).toBe(true);
	await app.press("role:button[Discard linked draft]");
	await app.press("role:button[Discard draft]");
	await app.waitFor(OTHER);
	expect(app.shows("Plans: 0 · Checks: 0")).toBe(true);
	expect(app.shows("Chats started: 0")).toBe(true);
});

test("another suggestion never overwrites an edited linked draft without asking; the other draft stays kept", async () => {
	const app = await linked();
	await app.clear("id:goal");
	await app.type("id:goal", "Prevent overwrites in every export format");
	await app.press("Draft another suggestion");
	await app.waitFor("Switch to the suggestion from “Exports lose their images”?");
	expect(app.shows(EDITED)).toBe(true);
	await app.press("role:button[Keep editing]");
	expect(app.shows("id:linked-confirm")).toBe(false);
	expect(app.value("id:goal")).toBe("Prevent overwrites in every export format");
	await app.press("Draft another suggestion");
	await app.press("role:button[Switch draft]");
	await app.waitFor("Draft: [Keep images in chat exports] · demo-pilot/build · request none · linked yes");
	expect(app.shows("Add keyboard shortcuts for the command palette")).toBe(true);
	// An unedited linked draft switches at once: nothing of the user's is lost.
	await app.press("Draft a linked mission");
	await app.waitFor(LINKED);
	expect(app.shows("id:linked-confirm")).toBe(false);
	await app.press("role:button[Discard linked draft]");
	await app.waitFor(OTHER);
	expect(app.shows("Plans: 0 · Checks: 0")).toBe(true);
});

test("Replan does not replace New while a linked draft holds the other draft", async () => {
	const app = await linked();
	await app.press("Show Docs mission");
	await app.press("id:mission-replan-stop");
	await app.waitFor("id:mission-replan-start");
	await app.press("id:mission-replan-start");
	await app.press("id:replan-use-draft");
	await app.waitFor("New has a linked mission draft from Feedback. Plan or discard it there first. Nothing changed.");
	expect(app.shows(LINKED)).toBe(true);
	await app.press("Open New");
	await app.waitFor("Your other New draft stays saved.");
	expect(app.shows("Add keyboard shortcuts for the command palette")).toBe(true);
});

test("Plan sends the exact link once; a refusal keeps both drafts, an accepted plan gives the other draft back", async () => {
	const app = await linked();
	await app.clear("id:goal");
	await app.type("id:goal", "Prevent overwrites in every export format");
	await app.press("role:button[Plan mission]");
	await app.waitFor("The suggestion changed since you read it. Read it again in Feedback.");
	expect(app.shows("Plans: 1 · Checks: 0")).toBe(true);
	expect(
		app.shows(
			'Sent: {"goal":"Prevent overwrites in every export format","feedback":{"feedbackId":"feedback-1","triageSessionId":"triage-1","proposalDigest":"' +
				"d".repeat(64) +
				'"},"request":null,"replaces":null}',
		),
	).toBe(true);
	expect(
		app.shows("Draft: [Prevent overwrites in every export format] · demo-pilot/build · request none · linked yes"),
	).toBe(true);
	expect(app.shows("Your other New draft stays saved.")).toBe(true);
	await app.press("Next accepted");
	await app.press("role:button[Plan mission]");
	await app.waitFor("Route: plan/m-linked · Feedback closed");
	expect(app.shows(OTHER)).toBe(true);
	expect(app.shows("Plans: 2 · Checks: 0")).toBe(true);
});

test("Replace other draft is explicit: a refused plan keeps the other draft, an accepted one replaces it", async () => {
	const app = await linked();
	await app.press("role:button[Replace other draft]");
	expect(app.shows("Your other New draft will be replaced when you plan.")).toBe(true);
	await app.press("role:button[Plan mission]");
	await app.waitFor("The suggestion changed since you read it. Read it again in Feedback.");
	expect(app.shows(LINKED)).toBe(true);
	expect(app.shows("Add keyboard shortcuts for the command palette")).toBe(true);
	await app.press("role:button[Keep other draft]");
	expect(app.shows("Your other New draft stays saved.")).toBe(true);
	await app.press("role:button[Replace other draft]");
	await app.press("Next accepted");
	await app.press("role:button[Plan mission]");
	await app.waitFor("Route: plan/m-linked · Feedback closed");
	expect(app.shows("Draft: [] · none/none · request none · linked no")).toBe(true);
});

test("an unconfirmed linked plan is never resent: Check reads it, then the other draft comes back", async () => {
	const app = await linked();
	await app.press("Next unknown");
	await app.press("role:button[Plan mission]");
	await app.waitFor("Mission creation is not confirmed");
	expect(app.shows(LINKED)).toBe(true);
	expect(app.shows("role:button[Create another]")).toBe(true);
	await app.press("role:button[Check status]");
	await app.waitFor("Route: plan/m-linked · Feedback closed");
	expect(app.shows("Plans: 1 · Checks: 1")).toBe(true);
	expect(app.shows(OTHER)).toBe(true);
});

test("Check of another creation with the same words keeps the linked draft and the other draft", async () => {
	const app = await linked();
	await app.press("role:button[Replace other draft]");
	await app.press("Older receipt with the same words");
	await app.waitFor("Mission creation is not confirmed");
	await app.press("role:button[Check status]");
	await app.waitFor("Route: plan/m-linked · Feedback closed");
	expect(app.shows("Plans: 0 · Checks: 1")).toBe(true);
	expect(app.shows(LINKED)).toBe(true);
	await app.press("Open New");
	await app.waitFor("Your other New draft will be replaced when you plan.");
	expect(app.shows("Add keyboard shortcuts for the command palette")).toBe(true);
});

test("a closed window restores the linked draft and the kept other draft without sending", async () => {
	const app = await linked();
	await app.press("role:button[Replace other draft]");
	await app.press("Close and restore window");
	await app.waitFor("Plan a linked mission");
	// The other draft's request is kept with it; restore does not choose for the user.
	expect(
		app.shows(
			"Draft: [Prevent overwrites across all chat export formats] · demo-pilot/build · request none · linked yes",
		),
	).toBe(true);
	expect(app.shows("Your other New draft will be replaced when you plan.")).toBe(true);
	await app.press("role:button[Keep other draft]");
	await app.press("role:button[Discard linked draft]");
	await app.waitFor(OTHER);
	expect(app.shows("Plans: 0 · Checks: 0")).toBe(true);
});

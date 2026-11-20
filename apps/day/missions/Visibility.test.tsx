import { expect, open, test } from "nsh/test";
import { nextLine, stateMark } from "./words";

const desktop = { platform: "macos", width: 1100, height: 1800 } as const;

test("Today shows the cause, the next step and a way to the work", async () => {
	const app = await open("../VisibilityFixture.tsx", desktop);
	await app.waitUntil(() => app.texts().some((line) => line.startsWith("One stopped chat.")));
	expect(app.shows("Unresolved work is shown above. Pilot retries nothing on its own.")).toBe(true);
	expect(app.shows("What needs you is not current. Read again before acting.")).toBe(false);
	expect(app.shows("Native checks failed. The coordinator needs your help.")).toBe(true);
	expect(app.texts().some((t) => t.startsWith("Diagnostic chat") || t.includes("no further cause"))).toBe(false);
	expect(app.shows("Next: Inspect the failed check before choosing how to continue. Nothing is retried here.")).toBe(
		true,
	);
	// Only the standalone chat offers its result page; the task row opens its mission.
	expect(app.shows("role:button[See the work of Tidy the release notes]")).toBe(true);
	expect(app.shows("role:button[See the work of History work stopped]")).toBe(false);
	expect(app.shows("role:button[Open the mission for Tidy the release notes]")).toBe(false);
	await app.press("Stale read");
	await app.waitFor("Earlier read. These problems may have changed.");
	expect(app.shows("History work stopped")).toBe(true);
	await app.press("role:button[Open the mission for History work stopped]");
	// The mission's work lanes say whose words a report is (MissionWork.tsx).
	await app.waitFor("Agent report · 1 h ago · agent words, not verified");
	// Linked outputs sit with every task, folded until the user opens them.
	await app.press("Tasks · 6");
	await app.waitFor("text:https://github.com/mock/pilot/pull/431");
});

test("missing attention never claims an empty inbox", async () => {
	const app = await open("../VisibilityFixture.tsx", desktop);
	await app.press("Resolve problems");
	await app.press("Missing attention");
	await app.waitFor("Pilot cannot read all unresolved problems. This is not the same as having none.");
	expect(app.shows("That is everything for now. Pilot will tell you if something needs you.")).toBe(false);
});

test("a failed chat on Needs a look offers Continue when a retry is safe, and Dismiss", async () => {
	const app = await open("../VisibilityFixture.tsx", desktop);
	await app.waitFor("Export the audit log");
	expect(app.shows("Model request (anthropic): Allowance hold. Check funding in Settings.")).toBe(true);
	expect(app.shows("Next: Continue asks it to try again, once. Or dismiss it.")).toBe(true);
	// Only a row the service says can continue offers Continue; any failed chat offers Dismiss.
	expect(app.shows("id:problem-continue-session:held-chat")).toBe(true);
	expect(app.shows("id:problem-dismiss-session:held-chat")).toBe(true);
	expect(app.shows("id:problem-continue-session:broken-chat")).toBe(false);
	expect(app.shows("id:problem-dismiss-session:broken-chat")).toBe(true);
	expect(app.shows("id:problem-continue-failed-worker")).toBe(false);
	expect(app.shows("id:problem-dismiss-failed-worker")).toBe(false);
	await app.press("id:problem-continue-session:held-chat");
	await app.waitFor("Synthetic read. Sent: continue held-chat");
	expect(app.shows("Export the audit log")).toBe(false);
	await app.press("id:problem-dismiss-session:broken-chat");
	await app.waitFor("Synthetic read. Sent: continue held-chat, dismiss broken-chat");
	expect(app.shows("Rename the settings page")).toBe(false);
});

test("a chat waiting for a reply shows its last message; Reply sends the user's words once, and Continue applies", async () => {
	const app = await open("../VisibilityFixture.tsx", desktop);
	await app.waitFor("id:chat-waits-waiting-chat");
	expect(app.shows("id:chat-says-waiting-chat")).toBe(true);
	expect(app.shows("The mockup is ready. Should the agent rows sit above Needs you?")).toBe(true);
	expect(app.shows("id:chat-waits-continue-waiting-chat")).toBe(true);
	expect(app.shows("id:problem-continue-session:waiting-chat")).toBe(false);
	await app.type("id:chat-reply-waiting-chat", "Yes, above");
	// A new read of the same row keeps the field, its focus and its words.
	await app.keyboard.press("mod+shift+1");
	await app.keyboard.press("x");
	expect(app.value("id:chat-reply-waiting-chat")).toBe("Yes, abovex");
	await app.press("id:chat-reply-send-waiting-chat");
	await app.waitFor("Synthetic read. Sent: reply waiting-chat: Yes, abovex");
	expect(app.shows("id:chat-reply-send-waiting-chat")).toBe(false);
	expect(app.shows("id:chat-waits-sent-waiting-chat")).toBe(true);
});

// The old marks (a folded document for a stale report, thin and amber hollow squares) are gone from the library.
// A mission Pilot cannot confirm (no report, a stale or unavailable one, an unconfirmed state) now shows the one
// Unconfirmed mark; its words still say which ("Old report", "No report yet").
test("missions without a current report or a confirmed state show the Unconfirmed mark", () => {
	const report = {
		taskId: "t",
		currentness: "stale" as const,
		movement: "unknown" as const,
		byCoordinator: false,
		age: "yesterday",
		summary: "Claim",
		nextStep: "Check",
		evidence: [],
	};
	expect(stateMark({ state: "unreported", report })).toBe("unconfirmed");
	expect(stateMark({ state: "unreported", report: null })).toBe("unconfirmed");
	expect(stateMark({ state: "unreported", report: { ...report, currentness: "unavailable" } })).toBe("unconfirmed");
	expect(stateMark({ state: "stuck", report })).toBe("failed");
	expect(stateMark({ state: "unconfirmed", report })).toBe("unconfirmed");
});

test("a report that is not moving says what the work waits for", () => {
	const step = "wait for a published shared-schema release";
	expect(nextLine({ movement: "notMoving", nextStep: step })).toBe(`Waiting: ${step}`);
	expect(nextLine({ movement: "moving", nextStep: step })).toBe(`Next: ${step}`);
	expect(nextLine({ movement: "unknown", nextStep: "" })).toBe("");
});

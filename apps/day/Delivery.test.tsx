// To check and one delivered result's page as a user takes them, on a
// scripted source with the connected rules (DeliveryFixture.tsx). No
// daemon, provider or storage.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1200 } as const;
const CSV = "#4 History slice";
const CSV_ROW = "id:check-task.mock-project.native.native-4";
const DOCS_ROW = "id:check-chat.mock-project.explain-exports";
const CHECK = "role:button[Check whether it happened. This reads Pilot's saved answer and sends nothing.]";

async function ready() {
	const app = await open("./DeliveryFixture.tsx", desktop);
	await app.waitFor("id:to-check");
	await app.waitFor(CSV);
	return app;
}

function counts(app: { texts(): string[] }): string {
	return app.texts().find((t) => t.startsWith("Sends:")) ?? "";
}

function opened(app: { texts(): string[] }): string {
	return app.texts().find((t) => t.startsWith("Opened:")) ?? "";
}

const PR = "https://github.com/mock/pilot/pull/431";

async function openCsv(app: Awaited<ReturnType<typeof ready>>) {
	await app.press(CSV_ROW);
	await app.waitFor("id:delivery");
	await app.waitFor("id:your-check");
}

test("To check lists delivered results; the page shows the report, outputs and four separate lines", async () => {
	const app = await ready();
	expect(app.shows("Explain CSV exports in the guide")).toBe(true);
	expect(app.shows("#2 Chat view")).toBe(true);
	expect(app.shows("Native desktop app · PR merged · release not tracked")).toBe(true);
	await openCsv(app);
	expect(app.shows("History loads 50 older messages while a reply streams. Scroll position holds.")).toBe(true);
	expect(app.shows("This is the agent's account. It is not done until you say so.")).toBe(true);
	expect(app.shows("PR #431 · Load older messages while streaming")).toBe(true);
	expect(app.shows("History capture")).toBe(true);
	expect(app.texts().includes("Says it finished. Commit 4a1c9e0.")).toBe(true);
	expect(app.texts().includes("PR #431: open, not merged.")).toBe(true);
	expect(app.texts().includes("Not tracked.")).toBe(true);
	expect(app.texts().includes("Not checked yet.")).toBe(true);
	// Reminders and reading send nothing.
	await app.press("id:reminder-report");
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await app.keyboard.press("escape");
	await app.waitFor("id:to-check");
	expect(app.shows("id:delivery")).toBe(false);
});

test("Mark done asks first while the PR is open, then sends once; Reopen sends once", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press("id:mark-done");
	await app.waitFor("id:done-confirm");
	expect(
		app.shows(
			"PR #431 is not merged. Done means you accept the result now. Pilot won't merge it, and it won't count as released.",
		),
	).toBe(true);
	await app.press("id:done-cancel");
	expect(app.shows("id:done-confirm")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await app.press("id:mark-done");
	await app.press("id:done-anyway");
	await app.waitFor("id:delivery-done");
	expect(app.texts().includes("Done. You accepted this result.")).toBe(true);
	expect(app.texts().includes("Not tracked.")).toBe(true);
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
	await app.press("id:delivery-reopen");
	await app.waitFor("id:mark-done");
	expect(app.texts().includes("Open again. Not checked yet.")).toBe(true);
	expect(counts(app)).toBe("Sends: 2 · Checks: 0");
});

test("a newer result closes a Done that waits for confirmation", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press("id:mark-done");
	await app.waitFor("id:done-confirm");
	await app.press("New result");
	await app.waitFor("This result changed since you asked. Cancel and look again.");
	expect(app.enabled("id:done-anyway")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("Send back needs a note, sends its exact words once and keeps them until then", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press("id:send-back-open");
	await app.waitFor("id:send-back-note");
	expect(app.enabled("id:send-back")).toBe(false);
	const note = "  Large accounts still time out 👩🏽‍💻\nTry 50k rows.  ";
	await app.type("id:send-back-note", note);
	// Escape closes the note and keeps the words; leaving the page keeps them too.
	await app.keyboard.press("escape");
	await app.waitFor("Your unsent note is kept. Send back… shows it again.");
	await app.keyboard.press("escape");
	await app.waitFor("id:to-check");
	await app.press(CSV_ROW);
	await app.press("id:send-back-open");
	expect(app.value("id:send-back-note")).toBe(note);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await app.press("id:send-back");
	await app.waitFor("id:delivery-sent-back");
	expect(app.texts().includes("Sent back with your note.")).toBe(true);
	expect(app.texts().includes("Has your note. No new result yet.")).toBe(true);
	expect(app.shows(`Note sent: [${note}]`)).toBe(true);
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
	await app.keyboard.press("escape");
	await app.waitFor("Sent “#4 History slice” back. The agent has your note.");
	expect(app.shows(CSV_ROW)).toBe(false);
});

test("a lost answer stays not confirmed with Check only; Check reads once and nothing is sent again", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press("Lose next answer");
	await app.press("id:mark-done");
	await app.press("id:done-anyway");
	await app.waitFor("id:delivery-unknown");
	expect(app.texts().includes("Not confirmed. Check only.")).toBe(true);
	expect(app.shows("id:mark-done")).toBe(false);
	expect(app.shows("id:send-back-open")).toBe(false);
	await app.keyboard.press("escape");
	await app.waitFor(`Marking “${CSV}” done is not confirmed.`);
	expect(app.shows(CSV_ROW)).toBe(false);
	await app.press(CHECK);
	await app.waitFor(`Marked “${CSV}” done. Nothing was merged, released or replied to.`);
	expect(counts(app)).toBe("Sends: 1 · Checks: 1");
});

test("rapid presses while an answer is on its way send once", async () => {
	const app = await ready();
	await app.press(DOCS_ROW);
	await app.waitFor("id:your-check");
	expect(app.texts().includes("None linked.")).toBe(true);
	await app.press("Hold answers");
	await app.press("id:mark-done");
	await app.waitFor("role:button[Sending…]");
	expect(app.enabled("id:send-back-open")).toBe(false);
	await app.press("Release answer");
	await app.waitFor("id:delivery-done");
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("a save and reopen keeps the page and the unsent note, and sends nothing", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press("id:reminder-report");
	await app.waitFor("id:reminder-ticked-report");
	await app.press("id:send-back-open");
	await app.type("id:send-back-note", "Keep exact words");
	await app.press("Save and reopen");
	await app.waitFor("id:send-back-note");
	expect(app.value("id:send-back-note")).toBe("Keep exact words");
	expect(app.shows("id:delivery")).toBe(true);
	// Ticked reminders come back with the window; they were never sent.
	expect(app.shows("id:reminder-ticked-report")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("a newer result starts with no reminder ticked", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press("id:reminder-report");
	await app.waitFor("id:reminder-ticked-report");
	await app.press("New result");
	await app.waitFor("id:reminder-report");
	expect(app.shows("id:reminder-ticked-report")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("a press opens the exact pull request once, records nothing and never retries", async () => {
	const app = await ready();
	await openCsv(app);
	expect(app.shows("Pilot cannot show artifacts here yet.")).toBe(true);
	await app.press("id:output-open-pr-431");
	await app.waitFor("Sent PR #431 to your browser. Nothing was recorded.");
	expect(opened(app)).toBe(`Opened: [${PR}]`);
	expect(app.texts().includes("Not checked yet.")).toBe(true);
	expect(app.shows("id:mark-done")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	// A lost answer may have opened it: said so, and not tried again.
	await app.press("Lose next open");
	await app.press("id:output-open-pr-431");
	await app.waitFor("Pilot asked your browser to open it but did not hear back. It will not try again by itself.");
	expect(opened(app)).toBe(`Opened: [${PR} ${PR}]`);
	// The link moved since the page read it: nothing opens, and the page shows the new one.
	await app.press("Move link");
	await app.press("id:output-open-pr-431");
	await app.waitFor("This link changed since Pilot read the result. Nothing opened. Look at it again.");
	expect(app.texts().includes("https://github.com/mock/pilot/pull/432")).toBe(true);
	expect(opened(app)).toBe(`Opened: [${PR} ${PR}]`);
	await app.press("id:output-open-pr-431");
	await app.waitFor("Sent PR #431 to your browser. Nothing was recorded.");
	expect(opened(app)).toBe(`Opened: [${PR} ${PR} https://github.com/mock/pilot/pull/432]`);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("a window that cannot open links shows them as text", async () => {
	const app = await ready();
	await app.press("No browser");
	await openCsv(app);
	expect(app.shows("id:output-open-pr-431")).toBe(false);
	expect(app.shows("Pilot cannot open links in this window. Copy one; opening it records nothing.")).toBe(true);
	expect(app.texts().includes(PR)).toBe(true);
	expect(opened(app)).toBe("Opened: []");
});

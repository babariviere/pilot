// To check and one delivered result's page as a user takes them, on a
// scripted source with the connected rules (DeliveryFixture.tsx). No
// daemon, provider or storage.
import { expect, open, test } from "nsh/test";
import { type ArtifactSelection, capturedOf } from "./deliveryArtifact";
import type { DeliveredWork } from "./deliveryContract";
import {
	agentLine,
	checkLine,
	excerpt,
	prObservation,
	productionLine,
	pullRequestLine,
	SOURCE_CHARS,
	SOURCE_LINES,
} from "./deliveryView";

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

function reads(app: { texts(): string[] }): string {
	return app.texts().find((t) => t.startsWith("Source reads:")) ?? "";
}

const HTML = "3f0d6c2a-6b1e-4f7a-9d1c-2a5e8b7c4d10";
const VISUAL = "9a4e1f7b-2c3d-4e5f-8a6b-7c8d9e0f1a2b";
const IMAGE = "5b2c8d1e-0f3a-4b6c-9d7e-1a2b3c4d5e6f";
const UNPINNED = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";
const HTML_SOURCE =
	'<!doctype html>\n<script>document.title = "never run";</script>\n<p>Older messages load while a reply streams.</p>';
const VISUAL_SOURCE = '({ ui }) => ui.text("50 older messages load in 140 ms")';

function showsSource(app: { texts(): string[] }, source: string): boolean {
	return app.texts().includes(source);
}

function opened(app: { texts(): string[] }): string {
	return app.texts().find((t) => t.startsWith("Opened:")) ?? "";
}

const PR = "https://github.com/mock/pilot/pull/431";

test("publication claims, PR health observations and user verification stay separate", () => {
	const direct: DeliveredWork = {
		version: 1,
		subject: { kind: "task", projectId: "p", missionId: "m", taskId: "t" },
		deliveryId: "a".repeat(64),
		targetId: "target",
		ownerSessionId: "worker",
		completion: { commit: "b".repeat(40), checks: "Agent claims checks passed and deployed", issues: "" },
		pullRequests: [],
		artifacts: [],
		production: "not_tracked",
		verification: null,
		verificationCurrent: false,
		verificationReceiptState: "unknown",
		verificationRevision: 0,
		pendingOperationId: null,
	};
	expect(agentLine(direct)).toBe("Says it finished. Commit bbbbbbb.");
	expect(pullRequestLine(direct)).toBe("None linked.");
	expect(productionLine(direct)).toBe("Not tracked.");
	expect(checkLine(direct, undefined)).toBe("Not checked yet.");
	const pr = {
		id: "pr",
		url: PR,
		kind: "github.pr",
		relationship: "ownership" as const,
		pullRequest: {
			number: 431,
			url: PR,
			title: "History",
			state: "open" as const,
			checkedAt: 100,
			readiness: {
				state: "blocked" as const,
				checkedAt: 200,
				reasons: [{ code: "failing_checks", names: ["native tests"] }],
			},
		},
	};
	expect(prObservation(pr).includes("Checks failed: native tests.")).toBe(true);
	expect(prObservation(pr).includes("1970-01-01T00:00:00.200Z")).toBe(true);
	expect(prObservation(pr).includes("Saved observations may have changed.")).toBe(true);
	expect(prObservation({ ...pr, pullRequest: undefined }).includes("Checks not observed.")).toBe(true);
	const linked = { ...direct, pullRequests: [pr] };
	expect(pullRequestLine(linked)).toBe("PR #431: open, not merged.");
	expect(productionLine(linked)).toBe("Not tracked.");
});

async function openCsv(app: Awaited<ReturnType<typeof ready>>) {
	await app.press(CSV_ROW);
	await app.waitFor("id:delivery");
	await app.waitFor("id:your-check");
}

// NSH 0.5 rejects a covered press before dispatching any event. If a lower
// control is behind the fixture's toolbar, take the user's scroll step, then
// press it visibly. Never retry a dispatched action or suppress another error.
async function pressCheck(app: Awaited<ReturnType<typeof ready>>, selector: string, scrollBy = 2_000) {
	try {
		await app.press(selector);
	} catch (error) {
		if ((error as { code?: string }).code !== "ERR_NSH_TEST_COVERED") throw error;
		await app.scroll("id:your-check", scrollBy);
		await app.press(selector);
	}
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
	await pressCheck(app, "id:reminder-report");
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await app.keyboard.press("escape");
	await app.waitFor("id:to-check");
	expect(app.shows("id:delivery")).toBe(false);
});

test("Mark done asks first while the PR is open, then sends once; Reopen sends once", async () => {
	const app = await ready();
	await openCsv(app);
	await pressCheck(app, "id:mark-done");
	await app.waitFor("id:done-confirm");
	expect(
		app.shows(
			"PR #431 is not merged. Done means you accept the result now. Pilot won't merge it, and it won't count as released.",
		),
	).toBe(true);
	await pressCheck(app, "id:done-cancel");
	expect(app.shows("id:done-confirm")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await pressCheck(app, "id:mark-done");
	await pressCheck(app, "id:done-anyway");
	await app.waitFor("id:delivery-done");
	expect(app.texts().includes("Done. You accepted this result.")).toBe(true);
	expect(app.texts().includes("Not tracked.")).toBe(true);
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
	await pressCheck(app, "id:delivery-reopen");
	await app.waitFor("id:mark-done");
	expect(app.texts().includes("Open again. Not checked yet.")).toBe(true);
	expect(counts(app)).toBe("Sends: 2 · Checks: 0");
});

test("a newer result closes a Done that waits for confirmation", async () => {
	const app = await ready();
	await openCsv(app);
	await pressCheck(app, "id:mark-done");
	await app.waitFor("id:done-confirm");
	await app.press("New result");
	await app.waitFor("This result changed since you asked. Cancel and look again.");
	expect(app.enabled("id:done-anyway")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("Send back needs a note, sends its exact words once and keeps them until then", async () => {
	const app = await ready();
	await openCsv(app);
	await pressCheck(app, "id:send-back-open");
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
	await pressCheck(app, "id:send-back-open");
	expect(app.value("id:send-back-note")).toBe(note);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await pressCheck(app, "id:send-back");
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
	await pressCheck(app, "id:mark-done");
	await pressCheck(app, "id:done-anyway");
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
	await pressCheck(app, "id:mark-done");
	await app.waitFor("role:button[Sending…]");
	expect(app.enabled("id:send-back-open")).toBe(false);
	await app.press("Release answer");
	await app.waitFor("id:delivery-done");
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("a save and reopen keeps the page and the unsent note, and sends nothing", async () => {
	const app = await ready();
	await openCsv(app);
	await pressCheck(app, "id:reminder-report");
	await app.waitFor("id:reminder-ticked-report");
	await pressCheck(app, "id:send-back-open");
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
	await pressCheck(app, "id:reminder-report");
	await app.waitFor("id:reminder-ticked-report");
	await app.press("New result");
	await app.waitFor("id:reminder-report");
	expect(app.shows("id:reminder-ticked-report")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("a press opens the exact pull request once, records nothing and never retries", async () => {
	const app = await ready();
	await openCsv(app);
	expect(
		app.shows(
			"Inspect source shows the saved text of a pinned revision. Pilot does not run or draw artifacts, and looking records nothing.",
		),
	).toBe(true);
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

test("Inspect source reads one exact pin once, as plain text that never runs, and records nothing", async () => {
	const app = await ready();
	await openCsv(app);
	expect(app.texts().includes("HTML, revision 3")).toBe(true);
	expect(app.texts().includes("Visual, latest revision")).toBe(true);
	// Opening the page reads no source; a link without a pin has no Inspect source.
	expect(reads(app)).toBe("Source reads: []");
	expect(app.shows(`id:output-source-${UNPINNED}`)).toBe(false);
	expect(app.texts().includes("No pinned revision")).toBe(true);
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("id:artifact-source-text");
	expect(showsSource(app, HTML_SOURCE)).toBe(true);
	expect(app.texts().includes("Source · HTML · revision 3")).toBe(true);
	expect(app.texts().includes("Scroll check page")).toBe(true);
	expect(app.texts().includes("Saved copy, 208 bytes.")).toBe(true);
	expect(app.shows("Preview")).toBe(false);
	expect(reads(app)).toBe(`Source reads: [${HTML}@3]`);
	// Looking is not the user's check.
	expect(app.texts().includes("Not checked yet.")).toBe(true);
	expect(app.shows("id:mark-done")).toBe(true);
	// An image shows its title and kind only; the HTML text goes.
	await app.press(`id:output-source-${IMAGE}`);
	await app.waitFor("Pilot shows only an image's title and kind here. It does not draw images.");
	expect(app.texts().includes("Source · Image · revision 1")).toBe(true);
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	await app.press(`id:output-source-${IMAGE}`);
	expect(app.shows("id:artifact-source")).toBe(false);
	// Escape hides a shown source first, then leaves the page.
	await app.press(`id:output-source-${VISUAL}`);
	await app.waitFor("id:artifact-source-text");
	expect(showsSource(app, VISUAL_SOURCE)).toBe(true);
	await app.keyboard.press("escape");
	expect(app.shows("id:artifact-source")).toBe(false);
	expect(app.shows("id:delivery")).toBe(true);
	await app.keyboard.press("escape");
	await app.waitFor("id:to-check");
	// Reopening shows no source and reads none again.
	await openCsv(app);
	expect(app.shows("id:artifact-source")).toBe(false);
	expect(reads(app)).toBe(`Source reads: [${HTML}@3 ${IMAGE}@1 ${VISUAL}@2]`);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("a read on its way hides the earlier source, and only the newest press's answer shows", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press(`id:output-source-${VISUAL}`);
	await app.waitFor("id:artifact-source-text");
	await app.press("Hold reads");
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("Reading the saved source…");
	expect(showsSource(app, VISUAL_SOURCE)).toBe(false);
	// One press, one read: the same pin cannot be pressed again while it reads.
	expect(app.enabled(`id:output-source-${HTML}`)).toBe(false);
	await app.press(`id:output-source-${IMAGE}`);
	// The image's answer comes first; the HTML answer arrives late and is dropped.
	await app.press("Release reads");
	await app.waitFor("Pilot shows only an image's title and kind here. It does not draw images.");
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	expect(app.texts().includes("Source · Image · revision 1")).toBe(true);
	expect(reads(app)).toBe(`Source reads: [${VISUAL}@2 ${HTML}@3 ${IMAGE}@1]`);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("missing, oversize, held back and damaged copies say why, never another revision", async () => {
	const app = await ready();
	await app.press("Unsaved copies");
	await openCsv(app);
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("Pilot has no saved copy of this revision.");
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	await app.press(`id:output-source-${VISUAL}`);
	await app.waitFor("This revision's saved copy is too large to show here. Pilot does not show part of it instead.");
	await app.press("Held back");
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("Pilot held this source back because it may contain a secret.");
	await app.press(`id:output-source-${VISUAL}`);
	await app.waitFor("This revision's saved copy is damaged, so Pilot does not show it.");
	expect(showsSource(app, VISUAL_SOURCE)).toBe(false);
});

test("a refused read shows no earlier source", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("id:artifact-source-text");
	// The artifact's chat leaves the mission. Hide, then ask again: native refuses,
	// and the earlier text does not come back.
	await app.press("Leave mission");
	await app.press(`id:output-source-${HTML}`);
	expect(app.shows("id:artifact-source")).toBe(false);
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor(
		"This result or its artifact changed since Pilot read it, or the artifact is no longer part of this mission. Nothing is shown.",
	);
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	await app.press("Close channel");
	await app.press(`id:output-source-${VISUAL}`);
	await app.waitFor("Pilot is closing. Nothing is shown.");
	expect(showsSource(app, VISUAL_SOURCE)).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("a newer result or a failed read of the result hides the source at once", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("id:artifact-source-text");
	await app.press("New result");
	await app.waitFor("id:mark-done");
	expect(app.shows("id:artifact-source")).toBe(false);
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	// The newer result's own pin reads again only on a press.
	expect(reads(app)).toBe(`Source reads: [${HTML}@3]`);
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("id:artifact-source-text");
	await app.press("Lose service");
	await app.waitFor("id:delivery-off");
	expect(app.shows("id:artifact-source")).toBe(false);
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	expect(app.enabled(`id:output-source-${HTML}`)).toBe(false);
	expect(reads(app)).toBe(`Source reads: [${HTML}@3 ${HTML}@3]`);
});

test("a save and reopen keeps the note, drops a shown source and reads nothing again", async () => {
	const app = await ready();
	await openCsv(app);
	await pressCheck(app, "id:send-back-open");
	await app.type("id:send-back-note", "Keep exact words 💬");
	await pressCheck(app, `id:output-source-${HTML}`, -2_000);
	await app.waitFor("id:artifact-source-text");
	await app.press("Save and reopen");
	await app.waitFor("id:send-back-note");
	expect(app.value("id:send-back-note")).toBe("Keep exact words 💬");
	expect(app.shows("id:artifact-source")).toBe(false);
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	expect(reads(app)).toBe(`Source reads: [${HTML}@3]`);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("only the exact inert answer for the pin asked is shown", () => {
	const asked: ArtifactSelection = {
		subject: { kind: "task", projectId: "p", missionId: "m", taskId: "t" },
		targetId: "a".repeat(64),
		deliveryId: "b".repeat(64),
		ownerSessionId: null,
		sourceSessionId: "s",
		artifactId: HTML,
		revision: 3,
	};
	const reply = {
		version: 1,
		reference: asked,
		metadata: { title: "T", kind: "html" },
		rendering: "unsupported",
		content: { state: "text", source: "<p>x</p>", containerSha256: "c".repeat(64), containerBytes: 9 },
		html: "<p>prepared</p>",
	};
	const shown = capturedOf(reply, asked, "html");
	expect(shown?.content).toEqual(reply.content);
	// Unlisted fields never pass through.
	expect(JSON.stringify(shown).includes("prepared")).toBe(false);
	expect(capturedOf({ ...reply, reference: { ...asked, revision: 2 } }, asked, "html")).toBe(null);
	expect(capturedOf({ ...reply, reference: { ...asked, ownerSessionId: "o" } }, asked, "html")).toBe(null);
	expect(capturedOf({ ...reply, rendering: "html" }, asked, "html")).toBe(null);
	expect(capturedOf(reply, asked, "visual")).toBe(null);
	expect(capturedOf({ ...reply, metadata: { title: "T", kind: "image" } }, asked, "image")).toBe(null);
	expect(capturedOf({ ...reply, content: { state: "unavailable", reason: "latest" } }, asked, "html")).toBe(null);
	expect(
		capturedOf({ ...reply, content: { state: "unavailable", reason: "oversize" } }, asked, "html")?.content,
	).toEqual({ state: "unavailable", reason: "oversize" });
});

test("a long source shows its start with a note until Show all", () => {
	const lines = Array.from({ length: SOURCE_LINES + 10 }, (_, i) => `line ${i}`).join("\n");
	const part = excerpt(lines, false);
	expect(part.text.split("\n").length).toBe(SOURCE_LINES);
	expect(part.note).toBe(`Showing the first ${SOURCE_LINES} of ${SOURCE_LINES + 10} lines.`);
	expect(excerpt(lines, true)).toEqual({ text: lines, note: "" });
	const wide = `${"x".repeat(SOURCE_CHARS - 1)}😀tail`;
	const cut = excerpt(wide, false);
	// Never half a character.
	expect(cut.text).toBe("x".repeat(SOURCE_CHARS - 1));
	expect(cut.note).toBe("Showing the first 39,999 of 40,005 characters.");
	expect(excerpt("short", false)).toEqual({ text: "short", note: "" });
});

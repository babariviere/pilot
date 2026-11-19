// To check and one delivered result's page as a user takes them, on a
// scripted source with the connected rules (DeliveryFixture.tsx). No
// daemon, provider or storage.
import { expect, open, test } from "nsh/test";
import { type ArtifactSelection, capturedOf } from "./deliveryArtifact";
import type { DeliveredWork } from "./deliveryContract";
import { DEMO_SCREENS } from "./deliveryDemo";
import { noScreens, screenIds, screenLine, screenPairs } from "./deliveryScreens";
import {
	agentLine,
	attemptOutcome,
	attemptsOf,
	checkLine,
	excerpt,
	kindName,
	prObservation,
	productionLine,
	pullRequestLine,
	SOURCE_CHARS,
	SOURCE_LINES,
	selectionLine,
	unavailableLine,
	whenOf,
} from "./deliveryView";

const desktop = { platform: "macos", width: 1100, height: 1200 } as const;
const CSV = "#4 History slice";
const CSV_ROW = "id:check-task.mock-project.native.native-4";
const DOCS_ROW = "id:check-chat.mock-project.explain-exports";
const CHECK = "role:button[Check whether it happened. This reads Pilot's saved answer and sends nothing.]";

test("linked feedback resolution on a result is explicit and does not verify the result", async () => {
	let resolved = false;
	let writes = 0;
	const app = await open("./DeliveryFixture.tsx", {
		...desktop,
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": (name: string, request: { args: Record<string, unknown> }) => {
					const mark = { operationId: "mark", kind: "resolved", recordedAt: 2 };
					if (name === "day.feedback.step") {
						writes++;
						expect(request.args).toEqual({ action: "resolve", feedbackId: "feedback-1" });
						resolved = true;
						return { version: 1, value: { operations: [], outcome: { state: "accepted" } } };
					}
					expect(name).toBe("day.feedback.read");
					expect(request.args.result).toEqual({ kind: "mission", projectId: "mock-project", id: "native" });
					return {
						version: 1,
						value: {
							operations: [],
							snapshot: {
								version: 1,
								more: false,
								before: null,
								older: false,
								items: [
									{
										id: "feedback-1",
										text: "CSV exports forget the title.",
										origin: null,
										operationId: "saved",
										recordedAt: 1,
										sequence: 1,
										work: [
											{
												operationId: "linked",
												kind: "mission",
												projectId: "mock-project",
												missionId: "native",
												recordedAt: 1,
											},
											...(resolved ? [mark] : []),
										],
									},
								],
							},
						},
					};
				},
			},
		},
	});
	await app.press("Show linked feedback fixture");
	await app.press(CSV_ROW);
	await app.waitFor("id:result-feedback-mark-feedback-1");
	expect(writes).toBe(0);
	await app.press("id:result-feedback-mark-feedback-1");
	await app.waitFor("Resolved by you.");
	expect(writes).toBe(1);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

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
	const report = {
		reportId: "r",
		reportedAt: 1,
		summary: "The user chose layout A.",
		nextStep: "Build it in #40.",
		evidence: [],
		checks: "Asked the user with the mockup.",
		issues: "",
	};
	const { completion: _code, ...noCompletion } = direct;
	expect(agentLine({ ...noCompletion, workerDelivery: report })).toBe("Reports it finished. No code changed.");
	expect(agentLine({ ...noCompletion, workerDelivery: { ...report, commit: "c".repeat(40) } })).toBe(
		"Reports it finished. Commit ccccccc.",
	);
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
	// The primary image opens automatically, even when its saved bytes are unavailable.
	// These source-focused cases close it before inspecting other outputs.
	await app.waitFor("Hide preview");
	await pressCheck(app, `id:output-preview-${IMAGE}`);
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
	expect(app.shows("The agent's account is evidence, not your acceptance.")).toBe(true);
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

test("Today's To check sits in Needs you with a small heading; a mission's lists only its own results", async () => {
	const app = await ready();
	expect(app.shows("text:/^To check · \\d+$/")).toBe(true);
	expect(app.shows("Explain CSV exports in the guide")).toBe(true);
	await app.press("Mission native");
	await app.waitFor("#2 Chat view");
	expect(app.shows("Explain CSV exports in the guide")).toBe(false);
	expect(app.shows("text:/^Native desktop app/")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
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
	await openCsv(app);
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

test("a finished chat with no report shows its last message, word for word", async () => {
	const app = await ready();
	await app.press(DOCS_ROW);
	await app.waitFor("id:delivery-final-reply");
	expect(app.shows("Its last message")).toBe(true);
	expect(
		app.shows("Done. The guide's Export section now explains CSV exports, with one example of a filtered export."),
	).toBe(true);
	expect(app.shows("Shortened here. The chat keeps the whole message.")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("a job chat's report shows its answer, proof, limits, next step and links instead of its last message", async () => {
	const app = await ready();
	await pressCheck(app, "id:check-chat.mock-project.phishing-check");
	await app.waitFor("id:delivery-chat-report");
	expect(app.shows("It is a true positive. The password was typed on the look-alike page at 09:14.")).toBe(true);
	expect(app.shows("How it knows")).toBe(true);
	expect(app.shows("I did not check other users' logs.")).toBe(true);
	expect(app.shows("Next step for you")).toBe(true);
	expect(app.shows("Event 4821 · https://example.com/events/4821")).toBe(true);
	expect(app.shows("Its last message")).toBe(false);
	expect(app.shows("The chat says it is done.")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("a planned mission's worker delivery report shows as the result, with what it asks the coordinator", async () => {
	const app = await ready();
	await pressCheck(app, "id:check-task.mock-project.native.native-5");
	await app.waitFor("id:delivery-worker-report");
	expect(app.texts().includes("Reports it finished. Commit 5c0ffee.")).toBe(true);
	expect(app.shows("Today opens against the real service and shows a clear error when the service is down.")).toBe(
		true,
	);
	expect(app.shows("Native checks passed against port 4319.")).toBe(true);
	expect(app.shows("Please arrange the required independent review.")).toBe(true);
	expect(app.shows("Answer with Send back, or in a thread with the mission.")).toBe(true);
	expect(app.shows("Commit 5c0ffee10000")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("a worker's screens show Before and After from their pins, reading each side once", async () => {
	const app = await ready();
	await pressCheck(app, "id:check-task.mock-project.native.native-5");
	await app.waitFor("id:delivery-screens");
	expect(app.shows("Today: mission rows")).toBe(true);
	expect(app.shows("Before and After")).toBe(true);
	expect(app.shows("New screen")).toBe(true);
	// The first screen opens with the page, on After. Outputs does not open the same capture again.
	await app.waitFor("id:screens-comparison");
	await app.waitUntil(() => reads(app) === `Source reads: [${DEMO_SCREENS.after}@1]`);
	expect(app.count("id:artifact-pane")).toBe(1);
	await pressCheck(app, "id:screens-tab-before");
	await app.waitUntil(() => reads(app) === `Source reads: [${DEMO_SCREENS.after}@1 ${DEMO_SCREENS.before}@1]`);
	// Switching back reads nothing again.
	await pressCheck(app, "id:screens-tab-after");
	expect(reads(app)).toBe(`Source reads: [${DEMO_SCREENS.after}@1 ${DEMO_SCREENS.before}@1]`);
	// One screen opens at a time. A new screen has no Before.
	await pressCheck(app, `id:screen-${DEMO_SCREENS.added}`);
	await app.waitUntil(() => reads(app).includes(DEMO_SCREENS.added));
	expect(app.count("id:screens-comparison")).toBe(1);
	await pressCheck(app, "id:screens-tab-before");
	expect(app.shows("This screen is new. It has no Before.")).toBe(true);
	await app.keyboard.press("escape");
	expect(app.shows("id:screens-comparison")).toBe(false);
	expect(app.shows("id:delivery")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("screen pairs name pinned image links only, and a reason shows instead of captures", () => {
	const link = (artifactId: string, kind = "image", revision: number | null = 1) => ({
		artifactId,
		sessionId: "w",
		title: `${artifactId} (After)`,
		kind,
		linkedAt: 1,
		...(revision ? { revision } : {}),
	});
	const work: DeliveredWork = {
		version: 1,
		subject: { kind: "task", projectId: "p", missionId: "m", taskId: "t" },
		deliveryId: "a".repeat(64),
		targetId: "target",
		ownerSessionId: "w",
		pullRequests: [],
		artifacts: [link("a"), link("b"), link("nsh", "nsh"), link("loose", "image", null)],
		screens: {
			pairs: [{ before: "b", after: "a" }, { after: "nsh" }, { before: "gone", after: "b" }, { after: "loose" }],
			reportId: "r",
			reportedAt: 1,
		},
		production: "not_tracked",
		verification: null,
		verificationCurrent: false,
		verificationReceiptState: "unknown",
		verificationRevision: 0,
		pendingOperationId: null,
	};
	const pairs = screenPairs(work);
	expect(pairs.map((p) => p.title)).toEqual(["a", "Screen", "b", "Screen"]);
	expect(pairs.map(screenLine)).toEqual([
		"Before and After",
		"Not linked to this result now",
		"After only: Before is not linked now",
		"Not linked to this result now",
	]);
	expect([...screenIds(work)]).toEqual(["b", "a", "nsh", "gone", "loose"]);
	expect(noScreens(work)).toBe("");
	const none: DeliveredWork = { ...work, screens: { none: "No visible change", reportId: "r", reportedAt: 1 } };
	expect(screenPairs(none)).toEqual([]);
	expect(noScreens(none)).toBe("No visible change");
	// Without a delivery there is no pin to read.
	expect(screenPairs({ ...work, deliveryId: null })[0]?.after).toBe(null);
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
			"Inspect source shows the saved text of a pinned revision. NSH previews run apart from Pilot and change only their own state. Looking records nothing.",
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

test("consecutive PR clicks open the exact link without selecting the action", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press("id:output-open-pr-431");
	await app.waitFor(`Opened: [${PR}]`);
	await app.press("id:output-open-pr-431");
	await app.waitFor(`Opened: [${PR} ${PR}]`);
	expect(app.texts().includes("Not checked yet.")).toBe(true);
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
	expect(reads(app)).toBe(`Source reads: [${IMAGE}@1]`);
	expect(app.shows(`id:output-source-${UNPINNED}`)).toBe(false);
	expect(app.texts().includes("No pinned revision")).toBe(true);
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("id:artifact-source-text");
	expect(showsSource(app, HTML_SOURCE)).toBe(true);
	expect(app.texts().includes("Source · HTML · revision 3")).toBe(true);
	expect(app.texts().includes("Scroll check page")).toBe(true);
	expect(app.texts().includes("Saved copy, 208 bytes.")).toBe(true);
	expect(app.shows("Preview")).toBe(true);
	expect(reads(app)).toBe(`Source reads: [${IMAGE}@1 ${HTML}@3]`);
	// Looking is not the user's check.
	expect(app.texts().includes("Not checked yet.")).toBe(true);
	expect(app.shows("id:mark-done")).toBe(true);
	// An image shows its title and kind only. Each output keeps its own view.
	await app.press(`id:output-source-${IMAGE}`);
	await app.waitFor("This service does not provide this image's saved bytes here. Its title and version are kept.");
	expect(app.texts().includes("Image · revision 1")).toBe(true);
	// Unavailable bytes offer nothing to share or enlarge.
	expect(app.shows(`id:output-${IMAGE}-share`)).toBe(false);
	expect(app.shows(`id:output-${IMAGE}-full`)).toBe(false);
	expect(showsSource(app, HTML_SOURCE)).toBe(true);
	await app.press(`id:output-source-${IMAGE}`);
	expect(app.texts().includes("Image · revision 1")).toBe(false);
	await app.press(`id:output-source-${HTML}`);
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
	expect(reads(app)).toBe(`Source reads: [${IMAGE}@1 ${HTML}@3 ${IMAGE}@1 ${VISUAL}@2 ${IMAGE}@1]`);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("each output reads on its own, and a hidden read's late answer is dropped", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press(`id:output-source-${VISUAL}`);
	await app.waitFor("id:artifact-source-text");
	await app.press("Hold reads");
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("Reading the saved source…");
	expect(showsSource(app, VISUAL_SOURCE)).toBe(true);
	// One press, one read: the same pin cannot be pressed again while it reads.
	expect(app.enabled(`id:output-source-${HTML}`)).toBe(false);
	// Escape hides the view opened last, still reading; its late answer is dropped.
	await app.keyboard.press("escape");
	expect(app.texts().includes("Reading the saved source…")).toBe(false);
	await app.press("Release reads");
	await app.press(`id:output-source-${IMAGE}`);
	await app.waitFor("This service does not provide this image's saved bytes here. Its title and version are kept.");
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	expect(showsSource(app, VISUAL_SOURCE)).toBe(true);
	expect(reads(app)).toBe(`Source reads: [${IMAGE}@1 ${VISUAL}@2 ${HTML}@3 ${IMAGE}@1]`);
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
	// Each output keeps its view: hide it, then read it again.
	await app.press(`id:output-source-${HTML}`);
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("Pilot held this source back because it may contain a secret.");
	await app.press(`id:output-source-${VISUAL}`);
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
	await app.waitFor("Hide preview");
	await pressCheck(app, `id:output-preview-${IMAGE}`);
	expect(app.shows("id:artifact-source")).toBe(false);
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	// The newer result's own pin reads again only on a press.
	expect(reads(app)).toBe(`Source reads: [${IMAGE}@1 ${HTML}@3 ${IMAGE}@1]`);
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("id:artifact-source-text");
	await app.press("Lose service");
	await app.waitFor("id:delivery-off");
	expect(app.shows("id:artifact-source")).toBe(false);
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	expect(app.enabled(`id:output-source-${HTML}`)).toBe(false);
	expect(reads(app)).toBe(`Source reads: [${IMAGE}@1 ${HTML}@3 ${IMAGE}@1 ${HTML}@3]`);
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
	await app.waitFor("Hide preview");
	await pressCheck(app, `id:output-preview-${IMAGE}`, -2_000);
	expect(app.value("id:send-back-note")).toBe("Keep exact words 💬");
	expect(app.shows("id:artifact-source")).toBe(false);
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	expect(reads(app)).toBe(`Source reads: [${IMAGE}@1 ${HTML}@3 ${IMAGE}@1]`);
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

test("comparison switches one pane between both saved pins, sends nothing and closes before the result", async () => {
	const app = await ready();
	await openCsv(app);
	await pressCheck(app, "id:outputs-compare");
	// After is the side shown first.
	await app.waitFor("id:outputs-comparison");
	expect(app.texts().includes("Choose which saved output is After.")).toBe(true);
	expect(app.count("id:artifact-pane")).toBe(0);
	await pressCheck(app, "label:After output");
	await app.press("Load timing · revision 2");
	await app.waitFor("Source · Visual · revision 2");
	expect(showsSource(app, VISUAL_SOURCE)).toBe(true);
	// The pane's header names the chosen output by its saved title.
	expect(app.shows("id:outputs-title")).toBe(true);
	// One pane of a fixed height, whichever side shows.
	expect(app.count("id:artifact-pane")).toBe(1);
	await pressCheck(app, "id:outputs-tab-before");
	expect(showsSource(app, VISUAL_SOURCE)).toBe(false);
	expect(app.texts().includes("Choose which saved output is Before.")).toBe(true);
	await pressCheck(app, "label:Before output");
	await app.press("Scroll check page · revision 3");
	await app.waitFor("Source · HTML · revision 3");
	expect(showsSource(app, HTML_SOURCE)).toBe(true);
	expect(showsSource(app, VISUAL_SOURCE)).toBe(false);
	expect(app.count("id:artifact-pane")).toBe(1);
	// Switching back shows the After pin read before, without reading it again.
	await pressCheck(app, "id:outputs-tab-after");
	await app.waitFor("Source · Visual · revision 2");
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	expect(reads(app)).toBe(`Source reads: [${IMAGE}@1 ${VISUAL}@2 ${HTML}@3]`);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await app.keyboard.press("escape");
	expect(app.shows("id:outputs-comparison")).toBe(false);
	expect(app.shows("id:delivery")).toBe(true);
});

test("an output's header shares its source and opens the full window, which a newer result closes", async () => {
	const app = await ready();
	await openCsv(app);
	await app.press(`id:output-source-${HTML}`);
	await app.waitFor("id:artifact-source-text");
	// Share offers the saved source of the pin shown, never an image of it.
	await pressCheck(app, `id:output-${HTML}-share`);
	await app.waitFor("Export source…");
	expect(app.shows("Export image…")).toBe(false);
	expect(app.texts().includes("Scroll check page · revision 3")).toBe(true);
	await app.keyboard.press("escape");
	await app.waitUntil(() => !app.shows("Export source…"));
	await pressCheck(app, `id:output-${HTML}-full`);
	await app.waitFor("id:artifact-full");
	expect(app.texts().includes("Scroll check page · HTML · revision 3")).toBe(true);
	// One copy: the row gives its pane to the full window, and nothing is read again.
	expect(app.texts().filter((t) => t === HTML_SOURCE).length).toBe(1);
	expect(reads(app)).toBe(`Source reads: [${IMAGE}@1 ${HTML}@3]`);
	// Escape comes back to the row as it was.
	await app.keyboard.press("escape");
	expect(app.shows("id:artifact-full")).toBe(false);
	expect(showsSource(app, HTML_SOURCE)).toBe(true);
	await pressCheck(app, `id:output-${HTML}-full`);
	await app.waitFor("id:artifact-full");
	// A newer result replaces the pin under it: the copy goes at once (by key: the dialog covers the fixture).
	await app.keyboard.press("mod+shift+n");
	await app.waitUntil(() => !app.shows("id:artifact-full"));
	expect(showsSource(app, HTML_SOURCE)).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("a comparison's full window shows the chosen side and closes when the result is lost", async () => {
	const app = await ready();
	await openCsv(app);
	await pressCheck(app, "id:outputs-compare");
	await pressCheck(app, "label:After output");
	await app.press("Load timing · revision 2");
	await app.waitFor("Source · Visual · revision 2");
	await pressCheck(app, "id:outputs-full");
	await app.waitFor("id:artifact-full");
	expect(app.texts().includes("Load timing · Visual · revision 2")).toBe(true);
	expect(app.texts().includes("After · Source · Visual · revision 2")).toBe(true);
	expect(app.texts().filter((t) => t === VISUAL_SOURCE).length).toBe(1);
	// The full window owns Escape first; the comparison stays open on After.
	await app.keyboard.press("escape");
	expect(app.shows("id:artifact-full")).toBe(false);
	expect(app.shows("id:outputs-comparison")).toBe(true);
	expect(showsSource(app, VISUAL_SOURCE)).toBe(true);
	await pressCheck(app, "id:outputs-full");
	await app.waitFor("id:artifact-full");
	await app.keyboard.press("mod+shift+l");
	await app.waitUntil(() => !app.shows("id:artifact-full"));
	expect(showsSource(app, VISUAL_SOURCE)).toBe(false);
	expect(reads(app)).toBe(`Source reads: [${IMAGE}@1 ${VISUAL}@2]`);
});

test("NSH artifacts read as inert saved source, never as a preview", () => {
	const asked: ArtifactSelection = {
		subject: { kind: "task", projectId: "p", missionId: "m", taskId: "t" },
		targetId: "a".repeat(64),
		deliveryId: "b".repeat(64),
		ownerSessionId: null,
		sourceSessionId: "s",
		artifactId: "nsh-artifact",
		revision: 2,
	};
	const source = "export default function Artifact() {\n\treturn <Text>Plan</Text>;\n}\n";
	const reply = {
		version: 1,
		reference: asked,
		metadata: { title: "Plan", kind: "nsh" },
		rendering: "unsupported",
		content: { state: "text", source, containerSha256: "c".repeat(64), containerBytes: 80 },
	};
	expect(capturedOf(reply, asked, "nsh")?.content).toEqual(reply.content);
	expect(capturedOf({ ...reply, rendering: "nsh" }, asked, "nsh")).toBe(null);
	expect(capturedOf(reply, asked, "visual")).toBe(null);
	expect(kindName("nsh")).toBe("NSH");
	expect(unavailableLine("nsh", "unsupported")).toBe(
		"Pilot does not run NSH artifacts yet, and cannot show this source here.",
	);
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

const WORK = "id:agent-work-toggle";

function workReads(app: { texts(): string[] }): string {
	return app.texts().find((t) => t.startsWith("Work reads:")) ?? "";
}

async function pressWork(app: Awaited<ReturnType<typeof ready>>, selector = WORK) {
	try {
		await app.press(selector);
	} catch (error) {
		if ((error as { code?: string }).code !== "ERR_NSH_TEST_COVERED") throw error;
		await app.scroll("id:agent-work", 600);
		await app.press(selector);
	}
}

test("Agent work stays folded until Show, reads once and keeps attempts, results and Unknown apart", async () => {
	const app = await ready();
	await openCsv(app);
	// Opening the page reads no agent work.
	expect(workReads(app)).toBe("Work reads: 0");
	expect(app.shows("id:agent-work")).toBe(true);
	expect(app.texts().some((t) => t.startsWith("Change "))).toBe(false);
	await pressWork(app);
	await app.waitFor("Change kkkkkkkkkkkk");
	expect(workReads(app)).toBe("Work reads: 1");
	// The owned change, its baseline and how it changed, at one repository operation.
	expect(app.texts().includes("Started on bbbbbbbbbbbb. Created as aaaaaaaaaaaa.")).toBe(true);
	expect(app.texts().includes("cccccccccccc on dddddddddddd")).toBe(true);
	expect(app.texts().includes("In the repository")).toBe(true);
	expect(
		app.texts().includes("Read at repository operation ffffffffffff. Another chat may have made that operation."),
	).toBe(true);
	expect(
		app
			.texts()
			.includes(
				"Pilot cannot show this change here. It may be older than change tracking, or its history moved on.",
			),
	).toBe(true);
	// A confirmed command, an attempt whose result never came back and an older record.
	expect(app.texts().includes("Push main")).toBe(true);
	expect(app.texts().find((t) => t === "Command succeeded")).toBe("Command succeeded");
	expect(app.texts().includes("Open a pull request")).toBe(true);
	expect(app.texts().includes("No result saved. Unknown.")).toBe(true);
	expect(app.texts().includes("Push history")).toBe(true);
	expect(app.texts().includes("2026-11-12 18:00 UTC. An older record: Pilot kept no separate attempt.")).toBe(true);
	// A local selection is never shown as what reached GitHub.
	expect(
		app
			.texts()
			.includes(
				"Selected locally before it ran: cccccccccccc (change kkkkkkkkkkkk). Not proof that it reached GitHub.",
			),
	).toBe(true);
	expect(
		app
			.texts()
			.includes(
				"Pilot did not read the pull request's head revision here, so it cannot say which revision GitHub has.",
			),
	).toBe(true);
	// Reading is not the user's check, a merge or a release.
	expect(app.texts().includes("Not checked yet.")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await pressWork(app);
	expect(app.texts().includes("Change kkkkkkkkkkkk")).toBe(false);
	expect(workReads(app)).toBe("Work reads: 1");
});

test("a newer result folds Agent work; a refused read says why and shows nothing else", async () => {
	const app = await ready();
	await openCsv(app);
	await pressWork(app);
	await app.waitFor("Change kkkkkkkkkkkk");
	await app.press("New result");
	await app.waitUntil(() => !app.texts().includes("Change kkkkkkkkkkkk"));
	expect(workReads(app)).toBe("Work reads: 1");
	await app.press("Refuse work");
	await pressWork(app);
	await app.waitFor("This Pilot service cannot show agent work here.");
	expect(app.texts().includes("Change kkkkkkkkkkkk")).toBe(false);
	expect(app.texts().includes("Push main")).toBe(false);
	expect(workReads(app)).toBe("Work reads: 2");
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("attempt outcomes come only from their own saved records", () => {
	const base = {
		kind: "push" as const,
		branch: "main",
		prNumber: null,
		url: null,
		summary: "jj git push",
		description: "pushed main",
		at: 1,
		exitCode: null,
		publication: null,
	};
	const local = { status: "unknown" as const };
	const dispatch = {
		...base,
		id: "a:attempt",
		publication: {
			attemptId: "a:attempt",
			stage: "attempted" as const,
			evidence: "command-dispatch" as const,
			local,
		},
	};
	const failed = {
		...base,
		id: "a",
		at: 2,
		exitCode: 1,
		publication: { attemptId: "a:attempt", stage: "unknown" as const, evidence: "command-result" as const, local },
	};
	const lost = { ...failed, exitCode: null };
	const [one] = attemptsOf([dispatch, failed]);
	expect(attemptOutcome(one)).toEqual({ word: "Failed, exit 1", known: true });
	expect(selectionLine(one)).toBe("Pilot did not save which local revision it selected.");
	expect(attemptOutcome(attemptsOf([dispatch, lost])[0])).toEqual({ word: "Unknown", known: false });
	expect(attemptOutcome(attemptsOf([dispatch])[0])).toEqual({ word: "No result saved. Unknown.", known: false });
	// An older record keeps its own exit only.
	expect(attemptOutcome(attemptsOf([{ ...base, id: "old", exitCode: 0 }])[0])).toEqual({
		word: "Command succeeded",
		known: true,
	});
	expect(attemptsOf([dispatch, failed, { ...base, id: "old", at: 9 }]).map((a) => a.id)).toEqual(["old", "a:attempt"]);
	expect(whenOf(0)).toBe("Time unknown");
});

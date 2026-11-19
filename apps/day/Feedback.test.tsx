// The feedback page on a scripted source (FeedbackFixture.tsx). No daemon,
// provider or storage. Headless: not native appearance, focus or IME.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1600 } as const;

test("suggested words use their origin only in an empty draft", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("Suggested feedback");
	await app.waitFor("id:feedback-text");
	expect(app.value("id:feedback-text")).toBe("Suggested report");
	expect(app.shows("“Faster search”")).toBe(true);
	await app.press("id:feedback-general");
	await app.type("id:feedback-text", "My existing draft");
	await app.press("Suggested feedback");
	await app.waitFor("id:feedback-offer");
	expect(app.value("id:feedback-text")).toBe("Suggested reportMy existing draft");
	expect(app.shows("Your unsent feedback is about Pilot in general.")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("native paste keeps image bytes on a disconnected host and leaves text paste intact", async () => {
	const app = await open("./FeedbackFixture.tsx", {
		...desktop,
		host: { params: { day: { version: 1, window: "fixture" } } },
	});
	await app.press("id:feedback-open");
	await app.paste("id:feedback-text", { files: ["../macos/Resources/LegacyApp/HomeSky.png"] });
	await app.waitFor("id:feedback-image-retry");
	expect(app.shows("Image not attached")).toBe(true);
	expect(app.enabled("id:feedback-send")).toBe(false);
	await app.press("Remove image");
	await app.paste("id:feedback-text", { text: "Still editable 日本語" });
	expect(app.value("id:feedback-text")).toBe("Still editable 日本語");
});

test("pasted screenshots retry the same upload, survive reopening, and clear only with the exact Send receipt", async () => {
	const file = "../macos/Resources/LegacyApp/HomeSky.png";
	const reference = { uploadId: "00000000-0000-4000-8000-000000000001", sha256: "a".repeat(64), bytes: 70 };
	const uploads: unknown[] = [];
	let reservations = 0;
	const app = await open("./FeedbackFixture.tsx", {
		...desktop,
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": async (_name: string, envelope: { args: { uploadId?: string } }) => {
					if (!envelope.args.uploadId) {
						reservations++;
						return { version: 1, value: { uploadId: reference.uploadId } };
					}
					uploads.push(envelope.args);
					return uploads.length === 1
						? { version: 1, error: "offline" }
						: { version: 1, value: { image: reference } };
				},
			},
		},
	});
	await app.press("id:feedback-open");
	await app.type("id:feedback-text", "This popup blocks my work");
	await app.paste("id:feedback-text", { files: [file] });
	await app.waitFor("id:feedback-image-retry");
	expect(app.enabled("id:feedback-send")).toBe(false);
	await app.press("id:feedback-image-retry");
	await app.waitFor("Image 1 attached");
	expect(app.shows(`id:feedback-image-preview-${reference.uploadId}`)).toBe(true);
	expect(reservations).toBe(1);
	const png = (uploads[0] as { data: string }).data;
	expect(png.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
	expect(png.length > 1_000_000).toBe(true);
	expect(uploads).toEqual([
		{ uploadId: reference.uploadId, data: png },
		{ uploadId: reference.uploadId, data: png },
	]);
	await app.press("Save and reopen");
	await app.waitFor("Image 1 attached");
	expect(app.shows(`id:feedback-image-preview-${reference.uploadId}`)).toBe(true);
	await app.press("Next unknown");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-unknown");
	expect(app.shows("Image 1 attached")).toBe(true);
	await app.press("id:feedback-check");
	await app.waitFor("Your feedback was saved.");
	expect(app.shows("Image 1 attached")).toBe(false);
	expect(app.shows("1 image attached · available to the agent")).toBe(true);
});

test("text paste stays native and the image picker is an accessible icon", async () => {
	const app = await feedback();
	await app.paste("id:feedback-text", { text: "Copied feedback 日本語" });
	expect(app.value("id:feedback-text")).toBe("Copied feedback 日本語");
	expect(app.shows("label:Add image…")).toBe(true);
	expect(app.texts().includes("Add image…")).toBe(false);
	expect(app.shows("Paste image")).toBe(false);
	expect(app.shows("Image 1 attached")).toBe(false);
});

test("uploaded previews can be removed without changing the feedback words", async () => {
	const calls: unknown[] = [];
	const uploadId = "00000000-0000-4000-8000-000000000002";
	const app = await open("./FeedbackFixture.tsx", {
		...desktop,
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": (_name: string, envelope: { args: { uploadId?: string; data?: string } }) => {
					const args = envelope.args;
					calls.push(args);
					return {
						version: 1,
						value: !args.uploadId
							? { uploadId }
							: args.data
								? { image: { uploadId, sha256: "a".repeat(64), bytes: 70 } }
								: { removed: true },
					};
				},
			},
		},
	});
	await app.press("id:feedback-open");
	await app.paste("id:feedback-text", {
		text: "Keep these words",
		files: ["../macos/Resources/LegacyApp/HomeSky.png"],
	});
	await app.waitFor(`id:feedback-image-preview-${uploadId}`);
	await app.press("label:Remove image 1");
	await app.waitUntil(() => !app.shows(`id:feedback-image-preview-${uploadId}`));
	expect(app.value("id:feedback-text")).toBe("Keep these words");
	expect(calls.length).toBe(3);
	expect(calls[2]).toEqual({ uploadId });
});

test("removing an image from a rejected active draft does not delete a kept draft's upload", async () => {
	let deletes = 0;
	const image = { uploadId: "00000000-0000-4000-8000-000000000003", sha256: "a".repeat(64), bytes: 70 };
	const app = await open("./FeedbackFixture.tsx", {
		...desktop,
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": (_name: string, envelope: { args: { uploadId?: string; data?: string } }) => {
					const args = envelope.args;
					if (args.uploadId && !args.data) deletes++;
					return {
						version: 1,
						value: !args.uploadId ? { uploadId: image.uploadId } : args.data ? { image } : { removed: true },
					};
				},
			},
		},
	});
	await app.press("id:feedback-open");
	await app.type("id:feedback-text", "Keep this screenshot");
	await app.paste("id:feedback-text", { files: ["../macos/Resources/LegacyApp/HomeSky.png"] });
	await app.waitFor("Image 1 attached");
	await app.press("Next unknown");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-unknown");
	await app.press("Check rejects");
	await app.press("id:feedback-check");
	await app.waitFor("id:feedback-resume");
	await app.press("label:Remove image 1");
	expect(deletes).toBe(0);
	await app.press("Save and reopen");
	await app.press("id:feedback-resume");
	expect(app.shows("Image 1 attached")).toBe(true);
	expect(app.value("id:feedback-text")).toBe("Keep this screenshot");
});

async function feedback() {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-text");
	return app;
}

const counts = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Sends:"));
const steps = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Steps:"));

test("both feedback header chats open their own history without sending at narrow and normal widths", async () => {
	for (const width of [720, 1100]) {
		const app = await feedback();
		await app.setViewport(width, 1600);
		await chooseProject(app);
		await sendWords(app, "A long feedback title about chat icons staying on the top right of every card. ".repeat(3));
		await app.press("id:feedback-open-triage-f1");
		await app.waitFor("Triage this feedback.");
		await app.press("id:back");
		expect(steps(app)).toBe("Steps: [triage]");
		await app.press("Triage fix");
		await app.press("id:feedback-fix-f1");
		await app.waitFor("id:feedback-open-fix-f1");
		await app.press("Triage asks");
		expect(app.shows("id:feedback-open-triage-f1")).toBe(true);
		await app.press("id:feedback-open-fix-f1");
		await app.waitFor("I added the assignee to each plan row.");
		await app.press("id:back");
		await app.waitFor("id:feedback-open-fix-f1");
		await app.press("id:feedback-open-triage-f1");
		await app.waitFor("Triage this feedback.");
		await app.press("id:back");
		expect(steps(app)).toBe("Steps: [triage,fix]");
		expect(counts(app)).toBe("Sends: 1 · Checks: 0");
		expect(app.shows("Continues: 0")).toBe(true);
		app.dispose();
	}
});

test("an uncertain item can be checked after another Send without clearing a new draft", async () => {
	const app = await feedback();
	await app.press("Next unknown");
	await app.type("id:feedback-text", "First report");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-unknown");
	await app.press("id:feedback-another");
	await sendWords(app, "Independent report");
	await app.type("id:feedback-text", "Third draft");
	await app.press("id:feedback-check");
	await app.waitFor("Your feedback was saved.");
	expect(app.value("id:feedback-text")).toBe("Third draft");
	expect(counts(app)).toBe("Sends: 2 · Checks: 1");
});

test("a rejected earlier save keeps its own draft across reopening and Resume swaps newer words safely", async () => {
	const app = await feedback();
	await app.type("id:feedback-text", "Report whose reply is lost");
	await app.press("Next unknown");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-unknown");
	await app.press("id:feedback-another");
	await app.type("id:feedback-text", "Unrelated newer draft");
	await app.press("Check rejects");
	await app.press("id:feedback-check");
	await app.waitUntil(() => !app.shows("id:feedback-unknown"));
	expect(app.value("id:feedback-text")).toBe("Unrelated newer draft");
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-resume");
	await app.press("id:feedback-resume");
	expect(app.value("id:feedback-text")).toBe("Report whose reply is lost");
	expect(app.shows("Unrelated newer draft")).toBe(true);
	expect(app.enabled("id:feedback-send")).toBe(true);
	expect(counts(app)).toBe("Sends: 1 · Checks: 1");
});

test("history lists open items first and keeps its search while navigating", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Older open report");
	await sendWords(app, "Newer resolved report");
	await app.press("Triage fix");
	await app.press("id:feedback-resolve-f2");
	await app.waitFor("id:feedback-resolved-f2");
	const words = app.texts();
	expect(words.indexOf("Older open report") < words.indexOf("Newer resolved report")).toBe(true);
	await app.type("id:feedback-search", "Newer resolved");
	expect(app.shows("Older open report")).toBe(false);
	expect(app.shows("Newer resolved report")).toBe(true);
	await app.keyboard.press("escape");
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-search");
	expect(app.value("id:feedback-search")).toBe("Newer resolved");
	expect(app.shows("Older open report")).toBe(false);
	expect(counts(app)).toBe("Sends: 2 · Checks: 0");
});

test("remove asks once in place, Keep changes nothing, and Remove sends one step", async () => {
	const app = await feedback();
	await sendWords(app, "Report to keep");
	await sendWords(app, "Report to remove");
	await app.press("id:feedback-remove-f2");
	await app.waitFor("id:feedback-remove-confirm-f2");
	expect(app.shows("Remove this feedback? Its chats and missions stay.")).toBe(true);
	await app.press("id:feedback-remove-cancel-f2");
	expect(app.shows("Report to remove")).toBe(true);
	expect(app.shows("Steps: []")).toBe(true);
	await app.press("id:feedback-remove-f2");
	await app.press("id:feedback-remove-confirm-f2");
	await app.waitFor("Steps: [remove]");
	expect(app.shows("Report to remove")).toBe(false);
	expect(app.shows("Report to keep")).toBe(true);
});

test("an image-only draft keeps its mission when reopened from the header", async () => {
	const app = await open("./FeedbackFixture.tsx", {
		...desktop,
		host: { params: { day: { version: 1, window: "fixture" } } },
	});
	await app.press("id:mission-search");
	await app.press("id:mission-feedback");
	await app.paste("id:feedback-text", { files: ["../macos/Resources/LegacyApp/HomeSky.png"] });
	await app.waitFor("id:feedback-image-retry");
	await app.keyboard.press("escape");
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-offer");
	expect(app.shows("“Faster search”")).toBe(true);
	expect(app.shows("Image not attached")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("long Today feedback keeps details, Later and Bring back usable across window widths", async () => {
	const words =
		"The feedback description overlaps Later when this long report appears in Today at a narrow window width. ".repeat(
			3,
		);
	for (const width of [480, 1100]) {
		const app = await feedback();
		await chooseProject(app);
		await sendWords(app, words);
		await app.press("Triage fix");
		await app.keyboard.press("escape");
		await app.setViewport(width, 1600);
		await app.press("id:feedback-new-f1");
		await app.waitFor("id:feedback-proposal-f1");
		expect(app.shows(words.trim())).toBe(true);
		expect(app.enabled("id:feedback-later-f1")).toBe(true);
		await app.press("id:feedback-later-f1");
		await app.waitUntil(() => !app.shows("id:feedback-new-f1"));
		await app.press("id:feedback-later-show");
		await app.press("id:feedback-bring-back-f1");
		await app.waitFor("id:feedback-new-f1");
		expect(app.shows("id:feedback-proposal-f1")).toBe(false);
		await app.press("id:feedback-new-f1");
		await app.waitFor("id:feedback-proposal-f1");
		expect(steps(app)).toBe("Steps: [triage]");
		expect(counts(app)).toBe("Sends: 1 · Checks: 0");
		app.dispose();
	}
});

test("finished triage joins Needs you; opening and saved Later start nothing", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Show feedback in Today");
	await app.press("Triage fix");
	await app.waitFor("id:feedback-proposal-f1");
	await app.keyboard.press("escape");
	await app.waitFor("id:feedback-new-f1");
	await app.press("id:feedback-new-f1");
	await app.waitFor("id:feedback-proposal-f1");
	expect(steps(app)).toBe("Steps: [triage]");
	await app.press("id:feedback-later-f1");
	await app.waitUntil(() => !app.shows("id:feedback-new-f1"));
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-later-show");
	expect(app.shows("id:feedback-new-f1")).toBe(false);
	await app.press("id:feedback-later-show");
	await app.press("id:feedback-bring-back-f1");
	await app.waitFor("id:feedback-new-f1");
	expect(steps(app)).toBe("Steps: [triage]");
});

test("a triage question joins Needs you and a later proposal returns after deferral", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Which plan shows people?");
	await app.keyboard.press("escape");
	expect(app.shows("id:feedback-new-f1")).toBe(false);
	await app.press("Triage asks");
	await app.waitFor("id:feedback-new-f1");
	await app.press("id:feedback-new-f1");
	await app.waitFor("id:feedback-question-f1");
	expect(steps(app)).toBe("Steps: [triage]");
	await app.press("id:feedback-later-f1");
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-later-show");
	expect(app.shows("id:feedback-new-f1")).toBe(false);
	await app.press("Triage fix");
	await app.waitFor("id:feedback-new-f1");
	expect(steps(app)).toBe("Steps: [triage]");
});

async function chooseProject(app: Awaited<ReturnType<typeof feedback>>) {
	await app.press("label:Project where agents triage and fix your feedback");
	await app.press("text:Pilot code");
	await app.waitFor("id:feedback-project-none");
}

async function sendWords(app: Awaited<ReturnType<typeof feedback>>, words: string) {
	await app.type("id:feedback-text", words);
	await app.waitUntil(() => app.enabled("id:feedback-send"));
	await app.press("id:feedback-send");
	await app.waitFor("Saved. Thank you.");
}

test("the header opens Feedback about Pilot in general; opening sends nothing and Send waits for words", async () => {
	const app = await feedback();
	expect(app.shows("Pilot in general")).toBe(true);
	expect(app.shows("id:feedback-empty")).toBe(true);
	expect(app.enabled("id:feedback-send")).toBe(false);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
	await app.keyboard.press("escape");
	await app.waitFor("id:feedback-open");
	expect(app.shows("id:feedback")).toBe(false);
});

test("literal user paths show their read scope before feedback is sent", async () => {
	const app = await feedback();
	await app.type("id:feedback-text", "Read `/tmp/example folder` and ~/Library/Logs/Pilot for this failure");
	await app.waitFor("id:feedback-named-paths");
	expect(app.shows("/tmp/example folder")).toBe(true);
	expect(app.shows("~/Library/Logs/Pilot")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("Send saves the words once and lists them; only the accepted receipt clears the draft", async () => {
	const app = await feedback();
	await app.type("id:feedback-text", "The plan page hides who is working 日本語 ✓");
	await app.waitUntil(() => app.enabled("id:feedback-send"));
	await app.press("id:feedback-send");
	await app.waitFor("Saved. Thank you.");
	expect(app.value("id:feedback-text")).toBe("");
	expect(app.shows("The plan page hides who is working 日本語 ✓")).toBe(true);
	expect(app.texts().some((t) => t.startsWith("Saved · ") && t.endsWith("Pilot in general"))).toBe(true);
	expect(app.shows("id:feedback-empty")).toBe(false);
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("a refused Send keeps the words; a lost one stays Unknown until Check reads it, never resent", async () => {
	const app = await feedback();
	await app.press("Next reject");
	await app.type("id:feedback-text", "Search is slow");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-message");
	expect(app.value("id:feedback-text")).toBe("Search is slow");
	await app.press("Next unknown");
	await app.press("id:feedback-send");
	await app.waitFor("id:feedback-unknown");
	expect(app.value("id:feedback-text")).toBe("Search is slow");
	expect(app.enabled("id:feedback-send")).toBe(false);
	expect(app.shows("Check this feedback first, or write another item. Your text stays.")).toBe(true);
	await app.press("id:feedback-check");
	await app.waitFor("Your feedback was saved.");
	expect(app.shows("id:feedback-unknown")).toBe(false);
	expect(app.value("id:feedback-text")).toBe("");
	expect(counts(app)).toBe("Sends: 2 · Checks: 1");
});

test("from a mission the feedback names it; words keep their own context, and Back returns to the mission", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:mission-search");
	await app.waitFor("id:mission-feedback");
	await app.press("id:mission-feedback");
	await app.waitFor("id:feedback-text");
	expect(app.shows("“Faster search”")).toBe(true);
	await app.type("id:feedback-text", "Reports here are hard to scan");
	await app.press("id:back");
	await app.waitFor("id:mission-feedback");
	// Opening from the header does not move words about a mission to Pilot in general.
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-offer");
	expect(app.shows("“Faster search”")).toBe(true);
	await app.press("id:feedback-offer-keep");
	await app.waitUntil(() => !app.shows("id:feedback-offer"));
	await app.press("id:feedback-send");
	await app.waitFor("Saved. Thank you.");
	expect(app.texts().some((t) => t.endsWith("About “Mission search”"))).toBe(true);
	await app.press("id:feedback-general");
	await app.waitFor("Pilot in general");
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("unsent words and their mission come back after a close or update, sending nothing", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("id:mission-search");
	await app.press("id:mission-feedback");
	await app.waitFor("id:feedback-text");
	await app.type("id:feedback-text", "Kept 👩🏽‍💻\nsecond line");
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-text");
	expect(app.value("id:feedback-text")).toBe("Kept 👩🏽‍💻\nsecond line");
	expect(app.shows("“Faster search”")).toBe(true);
	expect(app.shows("Kept: [mission/search\nKept 👩🏽‍💻\nsecond line]")).toBe(true);
	expect(counts(app)).toBe("Sends: 0 · Checks: 0");
});

test("an unreadable list is not shown as empty; older feedback reads a page at a time", async () => {
	const app = await open("./FeedbackFixture.tsx", desktop);
	await app.press("Many saved");
	await app.press("id:feedback-open");
	await app.waitFor("Older note 5");
	expect(app.shows("Older note 3")).toBe(false);
	await app.press("id:feedback-more");
	await app.waitFor("Older note 3");
	await app.press("id:back");
	await app.press("Unreadable");
	await app.press("id:feedback-open");
	await app.waitFor("id:feedback-off");
	expect(app.shows("This is not the same as having none.")).toBe(true);
	expect(app.shows("id:feedback-empty")).toBe(false);
});

test("with a chosen project a saved Send starts one triage; Start fix is a separate step on the exact proposal", async () => {
	const app = await feedback();
	expect(app.shows("Choose the project with Pilot's code to have an agent triage what you send.")).toBe(true);
	await chooseProject(app);
	await sendWords(app, "The plan page hides who is working");
	await app.waitFor("id:feedback-triage-f1");
	expect(app.shows("An agent is triaging this. It reads and proposes; it changes nothing.")).toBe(true);
	expect(steps(app)).toBe("Steps: [triage]");
	expect(app.shows("id:feedback-resolve-f1")).toBe(false);
	await app.press("Triage fix");
	await app.waitFor("id:feedback-proposal-f1");
	expect(app.shows("Proposed: a small fix")).toBe(true);
	expect(app.shows("Show the assignee on each plan row and check it in Plan.test.tsx.")).toBe(true);
	expect(app.shows("Sonnet · medium")).toBe(true);
	expect(app.shows("$2.00")).toBe(true);
	// The proposal itself starts nothing.
	expect(steps(app)).toBe("Steps: [triage]");
	await app.press("id:feedback-fix-f1");
	await app.waitFor("id:feedback-fixing-f1");
	expect(app.shows("A fix is in progress.")).toBe(true);
	expect(app.shows("id:feedback-fix-f1")).toBe(false);
	// A running fix does not resolve the feedback.
	expect(app.shows("id:feedback-resolve-f1")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,fix]");
});

test("a prototype proposal starts one prototype; its mockups and choice show on the item, and the choice is the fix", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Plan rows feel crowded");
	await app.waitFor("id:feedback-triage-f1");
	await app.press("Triage prototype");
	await app.waitFor("id:feedback-directions-f1");
	expect(app.shows("Proposed: try a prototype first")).toBe(true);
	expect(app.shows("1. Inline owner chips")).toBe(true);
	expect(app.shows("2. An owner column")).toBe(true);
	expect(steps(app)).toBe("Steps: [triage]");
	// Start prototype is sent once. A lost reply stays Unknown; Check only reads it.
	await app.press("Next step unknown");
	await app.press("id:feedback-prototype-start-f1");
	await app.waitFor("id:feedback-step-unknown-f1");
	expect(app.enabled("id:feedback-prototype-start-f1")).toBe(false);
	await app.press("id:feedback-step-check-f1");
	await app.waitFor("Pilot did it.");
	expect(steps(app)).toBe("Steps: [triage,prototype]");
	expect(app.shows("A prototype is in progress. It makes mockups to choose from; it writes no code.")).toBe(true);
	expect(app.shows("id:feedback-prototype-start-f1")).toBe(false);
	// Its question shows here with the mockups it attached, and the shared answer form.
	await app.press("Prototype asks");
	await app.waitFor("id:feedback-question-f1");
	expect(app.shows("The prototype needs your choice.")).toBe(true);
	expect(app.shows("id:question-artifacts")).toBe(true);
	expect(app.shows("Owner column")).toBe(true);
	await app.press("id:choice-9-0");
	await app.press("id:next");
	await app.waitFor("id:submit");
	expect(app.shows("Your choice becomes the fix proposal. It starts no fix.")).toBe(true);
	expect(steps(app)).toBe("Steps: [triage,prototype]");
	await app.press("id:submit");
	await app.waitFor("id:feedback-chose-f1");
	expect(app.shows("Answer: [Inline owner chips]")).toBe(true);
	expect(steps(app)).toBe("Steps: [triage,prototype,answer]");
	// The choice comes back as the fix proposal, with the chosen mockup linked.
	await app.press("Prototype chose");
	await app.waitFor("Proposed: a small fix, from your choice");
	expect(app.shows("The mockup you chose:")).toBe(true);
	expect(app.shows("Proposed: try a prototype first")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,prototype,answer]");
	await app.press("id:feedback-fix-f1");
	await app.waitFor("id:feedback-fixing-f1");
	expect(steps(app)).toBe("Steps: [triage,prototype,answer,fix]");
	expect(counts(app)).toBe("Sends: 1 · Checks: 1");
});

test("resolving hides the saved fix proposal and its action; reopening restores them without starting work", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "The plan page hides who is working");
	await app.waitFor("id:feedback-triage-f1");
	await app.press("Triage fix");
	await app.waitFor("id:feedback-proposal-f1");
	expect(app.shows("id:feedback-fix-f1")).toBe(true);
	await app.press("id:feedback-resolve-f1");
	await app.waitFor("id:feedback-resolved-f1");
	expect(app.shows("id:feedback-proposal-f1")).toBe(false);
	expect(app.shows("Show the assignee on each plan row and check it in Plan.test.tsx.")).toBe(false);
	expect(app.shows("id:feedback-fix-f1")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,resolve]");
	await app.press("id:feedback-reopen-f1");
	await app.waitFor("id:feedback-proposal-f1");
	expect(app.shows("id:feedback-resolved-f1")).toBe(false);
	expect(app.shows("Show the assignee on each plan row and check it in Plan.test.tsx.")).toBe(true);
	expect(app.enabled("id:feedback-fix-f1")).toBe(true);
	expect(app.shows("id:feedback-fixing-f1")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,resolve,reopen]");
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("without a project nothing triages; a lost step stays Unknown and Check reads it once", async () => {
	const app = await feedback();
	await sendWords(app, "Search is slow");
	expect(steps(app)).toBe("Steps: []");
	expect(app.enabled("id:feedback-triage-start-f1")).toBe(false);
	await chooseProject(app);
	await app.waitUntil(() => app.enabled("id:feedback-triage-start-f1"));
	await app.press("Next step unknown");
	await app.press("id:feedback-triage-start-f1");
	await app.waitFor("id:feedback-step-unknown-f1");
	expect(app.enabled("id:feedback-triage-start-f1")).toBe(false);
	await app.press("id:feedback-step-check-f1");
	await app.waitFor("Pilot did it.");
	expect(app.shows("id:feedback-step-unknown-f1")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage]");
	expect(counts(app)).toBe("Sends: 1 · Checks: 1");
});

test("a new-mission proposal opens New with its goal; linking a mission and resolving are the user's own steps", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Plans never say who works on them");
	await app.waitFor("id:feedback-triage-f1");
	await app.press("Triage new mission");
	await app.waitFor("Proposed: plan a new mission");
	// It can also be done as one chat, tied to no mission.
	expect(app.shows("id:feedback-fix-f1")).toBe(true);
	await app.press("label:Mission to link this feedback to");
	await app.press("text:Faster search");
	await app.waitFor("id:feedback-mission-f1");
	expect(app.shows("Linked to “Mission search” · 1 of 4 tasks done")).toBe(true);
	await app.press("id:feedback-resolve-f1");
	await app.waitFor("id:feedback-resolved-f1");
	expect(steps(app)).toBe("Steps: [triage,link,resolve]");
	expect(app.shows("id:feedback-proposal-f1")).toBe(false);
	expect(app.shows("id:feedback-plan-f1")).toBe(false);
	expect(app.shows("id:feedback-fix-f1")).toBe(false);
	expect(app.shows("id:feedback-link-f1")).toBe(false);
	await app.press("id:feedback-reopen-f1");
	await app.waitFor("id:feedback-proposal-f1");
	expect(app.shows("id:feedback-fix-f1")).toBe(true);
	expect(app.shows("id:feedback-link-f1")).toBe(true);
	expect(steps(app)).toBe("Steps: [triage,link,resolve,reopen]");
	await app.press("id:feedback-plan-f1");
	// New gets the goal as an editable draft; nothing is created or sent.
	await app.waitFor("New goal: [Make plans show their people]");
	expect(app.shows("id:feedback")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,link,resolve,reopen]");
});

test("feedback reuses the interview form: kept draft, review, explicit submit, no other work", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "The plan page hides who is working");
	await app.waitFor("id:feedback-triage-f1");
	await app.press("Triage asks");
	await app.waitFor("id:feedback-question-f1");
	expect(app.shows("Which page do you mean?")).toBe(true);
	expect(app.shows("The task list on a mission")).toBe(true);
	await app.press("More context");
	expect(app.shows("Plans and missions both list tasks.")).toBe(true);
	expect(app.shows("The triage needs your answer before it can propose a next step.")).toBe(true);
	expect(app.shows("id:submit")).toBe(false);
	await app.press("id:choice-7-1");
	await app.press("id:own-7");
	await app.type("id:answer-7", "The one with the task rows 日本語");
	// Picking and typing send nothing.
	expect(steps(app)).toBe("Steps: [triage]");
	// The unsent answer, its pick and the chosen project come back after a close or update.
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-question-f1");
	// Restored answers may open at review, never submit themselves.
	if (app.shows("id:review-7")) await app.press("id:review-7");
	expect(app.value("id:answer-7")).toBe("The one with the task rows 日本語");
	await app.waitFor("id:feedback-project-none");
	expect(steps(app)).toBe("Steps: [triage]");
	await app.press("id:next");
	await app.waitFor("id:answers");
	expect(steps(app)).toBe("Steps: [triage]");
	await app.press("id:submit");
	await app.waitFor("id:feedback-answered-f1");
	expect(app.shows("Answer: [Mission overview\n\nThe one with the task rows 日本語]")).toBe(true);
	expect(app.shows("id:feedback-question-f1")).toBe(false);
	// It only clarifies: no fix, link or mark follows.
	expect(steps(app)).toBe("Steps: [triage,answer]");
	expect(app.shows("id:feedback-fix-f1")).toBe(false);
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("a lost answer stays Unknown with its words kept; Check reads it once and nothing is sent again", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Search is slow");
	await app.waitFor("id:feedback-triage-f1");
	await app.press("Triage asks");
	await app.waitFor("id:feedback-question-f1");
	await app.press("id:own-7");
	await app.type("id:answer-7", "Only on large projects");
	await app.press("id:next");
	await app.waitFor("id:submit");
	await app.press("Next step unknown");
	await app.press("id:submit");
	await app.waitFor("id:feedback-step-unknown-f1");
	expect(app.shows("Only on large projects")).toBe(true);
	expect(app.shows("id:submit")).toBe(false);
	await app.press("Check again");
	await app.waitFor("Pilot did it.");
	expect(app.shows("id:feedback-question-f1")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,answer]");
	expect(counts(app)).toBe("Sends: 1 · Checks: 1");
});

test("multiple feedback choices use the shared form without losing selections", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Both pages lose the filter");
	await app.press("Triage multiple");
	await app.waitFor("id:question-7");
	expect(app.shows("id:submit")).toBe(false);
	await app.press("id:choice-7-0");
	await app.press("id:choice-7-1");
	await app.press("id:choice-7-0");
	await app.press("id:choice-7-0");
	expect(steps(app)).toBe("Steps: [triage]");
	await app.press("id:next");
	await app.waitFor("id:submit");
	expect(app.shows("The plan page; Mission overview")).toBe(true);
	await app.press("id:submit");
	await app.waitFor("id:feedback-answered-f1");
	expect(app.shows("Answer: [- The plan page\n- Mission overview]")).toBe(true);
});

test("an unusable explanation stays linked while correction drafts and uncertain sends survive reopen", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Filter resets after restarting");
	await app.press("Triage unusable");
	await app.waitFor("id:feedback-unusable-f1");
	expect(app.shows("The filter belongs to the search improvements. Keep the filter when Pilot reopens.")).toBe(true);
	expect(app.shows("id:feedback-triage-start-f1")).toBe(false);
	await app.press("id:feedback-correct-f1");
	const q = `correction-${"d".repeat(64)}`;
	await app.press(`id:own-${q}`);
	await app.type(`id:answer-${q}`, "Restart, not navigation 日本語");
	await app.press("Save and reopen");
	await app.waitFor("id:feedback-correct-f1");
	await app.press("id:feedback-correct-f1");
	if (app.shows(`id:review-${q}`)) await app.press(`id:review-${q}`);
	expect(app.value(`id:answer-${q}`)).toBe("Restart, not navigation 日本語");
	await app.press("id:next");
	await app.press("Next step unknown");
	await app.press("id:submit");
	await app.waitFor("id:feedback-step-unknown-f1");
	expect(app.shows("Restart, not navigation 日本語")).toBe(true);
	expect(steps(app)).toBe("Steps: [triage,correct]");
	await app.press("Check again");
	await app.waitFor("Pilot did it.");
	expect(steps(app)).toBe("Steps: [triage,correct]");
	expect(app.shows("id:feedback-unusable-f1")).toBe(false);
});

test("a readable but wrong suggestion can be corrected without starting its fix", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Wrong recommendation");
	await app.press("Triage fix");
	await app.press("id:feedback-correct-f1");
	const q = `correction-${"d".repeat(64)}`;
	await app.press(`id:own-${q}`);
	await app.type(`id:answer-${q}`, "This happens only after restarting");
	expect(app.shows("The plan page hides who works on each task.")).toBe(true);
	await app.press("id:next");
	await app.press("id:submit");
	await app.waitUntil(() => steps(app) === "Steps: [triage,correct]");
	expect(app.shows("id:feedback-fixing-f1")).toBe(false);
});

test("a changed corrected proposal does not inherit Later from the previous explanation", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "Suggestion needs correction");
	await app.press("Triage fix");
	await app.keyboard.press("escape");
	await app.press("id:feedback-new-f1");
	await app.press("id:feedback-later-f1");
	await app.press("id:feedback-open");
	await app.press("id:feedback-correct-f1");
	const q = `correction-${"d".repeat(64)}`;
	await app.press(`id:own-${q}`);
	await app.type(`id:answer-${q}`, "This is about restart");
	await app.press("id:next");
	await app.press("id:submit");
	await app.press("Triage new mission");
	await app.keyboard.press("escape");
	await app.waitFor("id:feedback-new-f1");
	expect(steps(app)).toBe("Steps: [triage,correct]");
});

test("Today shows only one question, switches without answering, and Later returns with its draft", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "First question");
	await app.press("Triage asks");
	await sendWords(app, "Second question");
	await app.press("Triage asks");
	await app.keyboard.press("escape");
	await app.waitFor("id:feedback-new-f2");
	expect(app.shows("id:feedback-question-f1")).toBe(false);
	expect(app.shows("id:feedback-question-f2")).toBe(false);
	await app.press("id:feedback-new-f2");
	await app.waitFor("id:feedback-question-f2");
	expect(app.shows("id:feedback-question-f1")).toBe(false);
	expect(app.shows("How should finished work reach you?")).toBe(false);
	await app.press("id:own-7");
	await app.type("id:answer-7", "Keep this draft");
	await app.press("id:feedback-later-f2");
	await app.press("id:feedback-new-f1");
	await app.waitFor("id:feedback-question-f1");
	expect(app.shows("id:feedback-question-f2")).toBe(false);
	await app.press("id:feedback-later-show");
	await app.press("id:feedback-bring-back-f2");
	await app.press("id:feedback-new-f2");
	await app.waitFor("id:feedback-question-f2");
	expect(app.value("id:answer-7")).toBe("Keep this draft");
	expect(steps(app)).toBe("Steps: [triage,triage]");
});

test("only the touched feedback history form owns question shortcuts", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "First question");
	await app.press("Triage asks");
	await sendWords(app, "Second question");
	await app.press("Triage asks");
	await app.press("id:feedback-question-f1 >> id:own-7");
	await app.type("id:feedback-question-f1 >> id:answer-7", "Only first question");
	await app.keyboard.press("mod+enter");
	await app.waitFor("id:feedback-question-f1 >> id:submit");
	expect(app.shows("id:feedback-question-f2 >> id:submit")).toBe(false);
	expect(steps(app)).toBe("Steps: [triage,triage]");
	await app.press("id:feedback-question-f1 >> id:submit");
	await app.waitFor("id:feedback-answered-f1");
	expect(app.shows("id:feedback-question-f2")).toBe(true);
});

test("the fix and triage chats open read only with their rows and state; Back and Escape return to Feedback", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "The plan page hides who is working");
	await app.waitFor("id:feedback-open-triage-f1");
	expect(app.shows("id:feedback-open-triage-f1 >> text:Open triage chat")).toBe(true);
	await app.press("id:feedback-open-triage-f1");
	await app.waitFor("Triage this feedback.");
	expect(app.shows("id:chat-state")).toBe(true);
	expect(app.shows("Working.")).toBe(true);
	await app.keyboard.press("escape");
	await app.waitFor("id:feedback-triage-f1");
	expect(app.shows("id:chat")).toBe(false);
	await app.press("Triage fix");
	await app.waitFor("id:feedback-fix-f1");
	await app.press("id:feedback-fix-f1");
	await app.waitFor("id:feedback-open-fix-f1");
	expect(app.shows("id:feedback-open-fix-f1 >> text:Open fix chat")).toBe(true);
	expect(app.shows("text:Fix chat: pilot://chat/fix-1")).toBe(false);
	await app.press("id:feedback-open-fix-f1");
	await app.waitFor("I added the assignee to each plan row.");
	expect(app.shows("id:feedback")).toBe(false);
	expect(app.shows("Fix: show plan assignees")).toBe(true);
	expect(app.shows("Show the assignee on each plan row.")).toBe(true);
	expect(app.shows("Read apps/day/PlanScreen.tsx")).toBe(true);
	expect(app.shows("Done. What it says below is its own report, not a checked result.")).toBe(true);
	expect(app.shows("Earlier words")).toBe(false);
	await app.press("id:chat-earlier");
	await app.waitFor("Earlier words");
	expect(app.shows("id:chat-earlier")).toBe(false);
	await app.press("id:back");
	await app.waitFor("id:feedback-fixing-f1");
	expect(app.shows("id:chat")).toBe(false);
	// Reading chats sends nothing.
	expect(steps(app)).toBe("Steps: [triage,fix]");
	expect(counts(app)).toBe("Sends: 1 · Checks: 0");
});

test("a stopped chat offers Continue once; a working or finished chat does not", async () => {
	const app = await feedback();
	await chooseProject(app);
	await sendWords(app, "The plan page hides who is working");
	await app.press("id:feedback-open-triage-f1");
	await app.waitFor("Triage this feedback.");
	expect(app.shows("id:chat-continue")).toBe(false);
	await app.keyboard.press("escape");
	await app.press("Fix stops");
	await app.press("Triage fix");
	await app.waitFor("id:feedback-fix-f1");
	await app.press("id:feedback-fix-f1");
	await app.waitFor("id:feedback-open-fix-f1");
	await app.press("id:feedback-open-fix-f1");
	await app.waitFor("id:chat-continue");
	expect(app.shows("Stopped.")).toBe(true);
	expect(app.shows("Continues: 0")).toBe(true);
	await app.press("id:chat-continue");
	await app.waitFor("Working.");
	expect(app.shows("id:chat-continue")).toBe(false);
	expect(app.shows("Continues: 1")).toBe(true);
});

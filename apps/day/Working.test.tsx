import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 1600 } as const;
async function ready() {
	const app = await open("./WorkingFixture.tsx", desktop);
	await app.waitFor("Reading working chats…");
	await app.press("Release newer");
	await app.waitFor("id:working-mission-agent");
	return app;
}

test("Today shows mission and standalone activity across projects with explicit missing purpose", async () => {
	const app = await ready();
	expect(app.shows("pilot · Daily work · Show working agents")).toBe(true);
	expect(app.shows("website · Standalone chat · Task or purpose not available")).toBe(true);
	expect(app.shows("How should finished work reach you?")).toBe(true);
	expect(app.shows("label:Open chat “Native activity” in pilot")).toBe(true);
	expect(app.shows("id:working-open-mission-agent >> text:Open chat")).toBe(false);
	await app.press("Duplicate read");
	expect(app.texts().filter((t) => t === "Native activity").length).toBe(1);
	await app.press("Change task");
	await app.waitFor("pilot · Daily work · Updated task");
	await app.press("Start agent");
	await app.waitFor("id:working-new-agent");
	await app.press("Stop agent");
	await app.waitUntil(() => !app.shows("id:working-mission-agent"));
	expect(app.shows("id:working-solo-agent")).toBe(true);
});

test("an activity update leaves the focused reply field and its draft alone", async () => {
	const app = await ready();
	await app.press("Ask a question");
	await app.type("id:question", "My draft");
	await app.keyboard.press("mod+shift+u");
	await app.waitFor("pilot · Daily work · Updated task");
	await app.keyboard.press("x");
	expect(app.value("id:question")).toBe("My draftx");
});

test("a chat waiting for a coding slot shows under Working, updates in place and keeps the focus", async () => {
	const app = await ready();
	await app.press("Queue chat");
	await app.waitFor("id:waiting-queued-agent");
	expect(app.shows("Waiting · 1")).toBe(true);
	expect(
		app.shows("pilot · Waiting for a coding slot · 2nd in line · slots used by Native activity, Other work"),
	).toBe(true);
	// Not Needs you, no action beyond opening the chat.
	expect(app.shows("label:Open chat “Queued fix” in pilot")).toBe(true);
	await app.press("Ask a question");
	await app.type("id:question", "My draft");
	await app.keyboard.press("mod+shift+q");
	await app.waitFor("pilot · Waiting for a coding slot · 1st in line · slots used by Native activity");
	expect(app.count("id:waiting-queued-agent")).toBe(1);
	await app.keyboard.press("x");
	expect(app.value("id:question")).toBe("My draftx");
	await app.press("Start queued");
	await app.waitFor("id:working-queued-agent");
	expect(app.shows("id:waiting-queued-agent")).toBe(false);
	expect(app.shows("id:working-waiting")).toBe(false);
});

test("activity distinguishes confirmed empty, old reads, disconnected and failed reads", async () => {
	for (const [button, words] of [
		["None working", "No chat is working now."],
		["Disconnected", "Not connected. Working chats are not known."],
		["Failed", "Working chats could not be read. This does not mean none are working."],
		// An earlier read: its rows say "Was working", with no note.
		["Stale", "Was working"],
	]) {
		const app = await ready();
		await app.press(button);
		await app.waitFor(words);
		if (button === "Stale") expect(app.shows("Was working")).toBe(true);
		else expect(app.shows("id:working-mission-agent")).toBe(false);
	}
});

test("access loss removes chat details and late reads cannot resurrect stopped activity", async () => {
	const app = await ready();
	await app.press("Access lost");
	await app.waitUntil(() => !app.shows("id:working-solo-agent"));
	expect(app.shows("Standalone investigation")).toBe(false);
	await app.press("Hold reads");
	// Holding a read is an ordinary refresh: rows never flicker to "Was working".
	expect(app.shows("Was working")).toBe(false);
	await app.press("Stop agent");
	await app.press("Release newer");
	await app.waitFor("No chat is working now.");
	await app.press("Release older");
	expect(app.shows("id:working-mission-agent")).toBe(false);
});

test("opening exact chat and Back preserve Today reply draft and send nothing", async () => {
	const app = await ready();
	await app.press("Ask a question");
	await app.type("id:question", "Keep my unsent words");
	await app.press("id:working-open-solo-agent");
	await app.waitFor("Exact chat solo-agent");
	await app.keyboard.press("escape");
	await app.waitFor("id:question");
	expect(app.value("id:question")).toBe("Keep my unsent words");
	expect(app.texts().some((t) => t === "Opened: solo-agent · Sends: 0")).toBe(true);
});

test("Show all stays expanded across chat navigation and invalidation fences an entered read", async () => {
	const app = await ready();
	await app.press("Start many");
	await app.press("Show all 7");
	await app.waitFor("id:working-extra-4");
	await app.press("id:working-open-extra-4");
	await app.waitFor("Exact chat extra-4");
	await app.keyboard.press("escape");
	await app.waitFor("Show fewer");
	await app.press("Hold reads");
	await app.press("Invalidate");
	await app.press("Release newer");
	expect(app.shows("Was working")).toBe(false);
	expect(app.shows("Show fewer")).toBe(true);
	await app.press("Duplicate read");
	await app.waitFor("id:working-extra-4");
});

test("each read crossed by a notification still advances starts, task changes and stops, without flicker", async () => {
	const app = await ready();
	for (const action of ["Start agent", "Change task", "Stop agent"]) {
		await app.press("Hold reads");
		await app.press(action);
		await app.press("Invalidate");
		await app.press("Release newer");
		// An ordinary refresh is not old data: rows keep saying "Working".
		expect(app.shows("Was working")).toBe(false);
		if (action === "Start agent") expect(app.shows("id:working-new-agent")).toBe(true);
		if (action === "Change task") expect(app.shows("pilot · Daily work · Updated task")).toBe(true);
		if (action === "Stop agent") expect(app.shows("id:working-mission-agent")).toBe(false);
		await app.press("Release older");
	}
});

test("identity loss cannot resurrect revoked activity on invalidation or a delayed read", async () => {
	const app = await ready();
	await app.press("Identity lost");
	await app.waitUntil(() => !app.shows("id:working-mission-agent"));
	await app.press("Invalidate");
	expect(app.shows("Native activity")).toBe(false);
	await app.press("Hold reads");
	expect(app.shows("Native activity")).toBe(false);
	expect(app.shows("Standalone investigation")).toBe(false);
	await app.press("Release newer");
	expect(app.shows("Native activity")).toBe(false);
	await app.press("Restore access");
	await app.waitFor("id:working-mission-agent");
	await app.press("label:Projects Today shows");
	expect(app.shows("text:website")).toBe(true);
});

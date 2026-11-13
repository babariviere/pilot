// Mission threads on scripted topics (ThreadFixture.tsx). No daemon,
// provider or storage. Headless: not native appearance, focus, scrolling or IME.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 2600 } as const;

async function mission() {
	const app = await open("./ThreadFixture.tsx", desktop);
	await app.press("id:mission-search");
	await app.waitFor("id:thread-search-scope");
	return app;
}

async function thread() {
	const app = await mission();
	await app.press("id:thread-search-scope");
	await app.waitFor("id:thread-reply");
	return app;
}

const counts = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Writes:"));

test("a mission lists its threads; opening one shows its links and the original conversation, sending nothing", async () => {
	const app = await mission();
	expect(app.shows("Which file types are in scope?")).toBe(true);
	expect(app.shows("What counts as released?")).toBe(true);
	expect(app.shows("Later")).toBe(true);
	await app.press("id:thread-search-scope");
	await app.waitFor("id:thread-history");
	expect(app.shows("Task #1 Read the exporter")).toBe(true);
	// The coordinator's whole conversation, with only this thread's own message marked.
	expect(
		app.shows(
			"The coordinator's whole conversation, not only this thread. Messages this thread sent or linked are marked.",
		),
	).toBe(true);
	expect(app.shows("Sent in this thread")).toBe(true);
	expect(app.shows("Do we need PDFs in the first version?")).toBe(true);
	expect(app.shows("id:thread-earlier")).toBe(true);
	await app.press("id:thread-earlier");
	await app.waitFor("Pilot sent the coordinator a planning request.");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
	await app.keyboard.press("escape");
	await app.waitFor("id:mission-threads");
});

test("Send sends the exact words once; the service's acceptance is not the coordinator's answer", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "  What about zip files? 日本語\n");
	await app.press("id:thread-send");
	await app.waitFor("Sent. The coordinator has your message; its answer shows here when it writes one.");
	expect(app.value("id:thread-reply")).toBe("");
	expect(app.texts().some((t) => t.includes("What about zip files? 日本語"))).toBe(true);
	expect(app.shows("PDFs can wait. I noted it.")).toBe(false);
	expect(counts(app)).toBe("Writes: 1 · Sends: 1 · Checks: 0");
	await app.press("Coordinator replies");
	await app.waitFor("PDFs can wait. I noted it.");
	expect(counts(app)).toBe("Writes: 1 · Sends: 1 · Checks: 0");
});

test("a lost answer stays Unknown with the words kept; Check only reads and nothing is sent again", async () => {
	const app = await thread();
	await app.press("Next unknown");
	await app.type("id:thread-reply", "Exact words");
	await app.press("id:thread-send");
	await app.waitFor("id:thread-unknown");
	expect(app.shows("Message not confirmed: “Exact words”")).toBe(true);
	expect(app.value("id:thread-reply")).toBe("Exact words");
	expect(app.enabled("id:thread-send")).toBe(false);
	expect(app.enabled("id:thread-later")).toBe(false);
	await app.press("text:Check");
	await app.waitUntil(() => !app.shows("id:thread-unknown"));
	expect(counts(app)).toBe("Writes: 1 · Sends: 1 · Checks: 1");
	// Check proved the service took these exact words, so they are no longer unsent.
	expect(app.value("id:thread-reply")).toBe("");
	expect(app.shows("Sent in this thread")).toBe(true);
});

test("a held coordinator or a changed mission refuses honestly and keeps the words", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "Keep me");
	await app.press("Hold");
	await app.press("id:threads-read-again");
	await app.waitFor("id:thread-cannot-send");
	expect(app.enabled("id:thread-send")).toBe(false);
	expect(app.value("id:thread-reply")).toBe("Keep me");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("a thread missing from the last read shows why the next read failed, with Read again, and keeps that read", async () => {
	const app = await mission();
	await app.press("Open a gone thread");
	await app.waitFor("id:thread-absent");
	// The read worked: the thread is just not in it.
	expect(app.shows("This thread is not in the latest read. Your words for it stay.")).toBe(true);
	expect(app.shows("id:thread-absent-failed")).toBe(false);
	await app.press("Unreadable");
	await app.press("id:threads-read");
	await app.waitFor("id:thread-absent-failed");
	expect(
		app.shows(
			"Pilot could not reach its service. This thread is not in Pilot's last read, so Pilot cannot show it now. Your words for it stay.",
		),
	).toBe(true);
	expect(app.shows("This thread is not in the latest read. Your words for it stay.")).toBe(false);
	await app.press("Denied");
	await app.press("id:threads-read");
	await app.waitFor(
		"This Pilot service cannot show mission threads yet. This thread is not in Pilot's last read, so Pilot cannot show it now. Your words for it stay.",
	);
	expect(app.shows("id:threads-read")).toBe(true);
	// The mission still shows its whole earlier read, marked as such.
	await app.press("id:back");
	await app.waitFor("id:mission-threads");
	expect(app.shows("Which file types are in scope?")).toBe(true);
	expect(app.shows("This Pilot service cannot show mission threads yet. What shows is from Pilot's last read.")).toBe(
		true,
	);
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("a stale or refused send changes nothing and keeps the words", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "Keep me");
	await app.press("Changed elsewhere");
	await app.press("id:thread-send");
	await app.waitFor("This mission's threads changed since you read them. Nothing was sent; your words stay.");
	expect(app.value("id:thread-reply")).toBe("Keep me");
	await app.press("Next reject");
	await app.press("id:threads-read-again");
	await app.press("id:thread-send");
	await app.waitFor("id:thread-message");
	expect(app.texts().some((t) => t.startsWith("Pilot's service refused it:"))).toBe(true);
	expect(app.value("id:thread-reply")).toBe("Keep me");
});

test("Later and Discard keep the history and can be undone; neither sends to the coordinator", async () => {
	const app = await thread();
	await app.press("id:thread-later");
	await app.waitFor("id:thread-closed");
	expect(app.shows("This thread is in Later. Its history stays.")).toBe(true);
	expect(app.shows("Do we need PDFs in the first version?")).toBe(true);
	await app.press("id:thread-reopen");
	await app.waitFor("id:thread-reply");
	await app.press("id:thread-discard");
	await app.waitFor("This thread is discarded. Its history stays.");
	await app.press("id:back");
	await app.waitFor("id:threads-discarded");
	expect(app.shows("id:thread-search-scope")).toBe(false);
	await app.press("id:threads-discarded");
	await app.waitFor("id:thread-search-scope");
	expect(counts(app)).toBe("Writes: 3 · Sends: 0 · Checks: 0");
});

test("unsent words and their thread come back after Back, and after a close or update", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "Kept 日本語 ✓\nline two");
	await app.press("id:back");
	await app.waitUntil(() => app.texts().some((t) => t.endsWith("unsent words kept")));
	await app.press("id:thread-search-scope");
	await app.waitFor("id:thread-reply");
	expect(app.value("id:thread-reply")).toBe("Kept 日本語 ✓\nline two");
	await app.press("Save and reopen");
	await app.waitFor("id:thread-reply");
	expect(app.value("id:thread-reply")).toBe("Kept 日本語 ✓\nline two");
	expect(
		app
			.texts()
			.some((t) => t.startsWith("Kept: [search/search-scope | search\nsearch-scope\nKept 日本語 ✓\nline two")),
	).toBe(true);
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("a new thread starts with an explicit title and sends nothing to the coordinator", async () => {
	const app = await mission();
	await app.press("id:thread-new");
	await app.type("id:thread-title", "Do we keep PDF support?");
	await app.press("id:thread-start");
	await app.waitFor("id:thread-reply");
	expect(app.shows("Do we keep PDF support?")).toBe(true);
	expect(counts(app)).toBe("Writes: 1 · Sends: 0 · Checks: 0");
});

test("unreadable threads are not shown as none", async () => {
	const app = await open("./ThreadFixture.tsx", desktop);
	await app.press("Unreadable");
	await app.press("id:mission-search");
	await app.waitFor("id:threads-off");
	expect(app.shows("id:threads-empty")).toBe(false);
	expect(app.texts().some((t) => t.includes("this is not the same as having none"))).toBe(true);
});

test("a linked task's Agent work opens its result page and sends nothing", async () => {
	const app = await thread();
	// A linked task with a result opens its page with Agent work shown. That only reads.
	await app.press("id:thread-agent-work-t-1");
	await app.waitFor("id:delivery");
	expect(app.shows("#1 Read the exporter")).toBe(true);
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
	await app.keyboard.press("escape");
	await app.waitFor("id:thread-reply");
});

test("Escape closes an open link list before leaving the thread, and keeps the words", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "Keep me");
	await app.press("id:thread-link-open");
	await app.waitFor("id:thread-link-t-2");
	await app.keyboard.press("escape");
	await app.waitUntil(() => !app.shows("id:thread-link-t-2"));
	expect(app.shows("id:thread-reply")).toBe(true);
	await app.keyboard.press("escape");
	await app.waitFor("id:mission-threads");
	await app.press("id:thread-search-scope");
	await app.waitFor("id:thread-reply");
	expect(app.value("id:thread-reply")).toBe("Keep me");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("Escape puts a new thread's title away before leaving the mission; the title stays", async () => {
	const app = await mission();
	await app.press("id:thread-new");
	await app.type("id:thread-title", "Do we keep PDF support?");
	await app.keyboard.press("escape");
	await app.waitFor("id:thread-new");
	expect(app.shows("id:mission-threads")).toBe(true);
	await app.press("id:thread-new");
	await app.waitFor("id:thread-title");
	expect(app.value("id:thread-title")).toBe("Do we keep PDF support?");
	await app.keyboard.press("escape");
	await app.waitFor("id:thread-new");
	await app.keyboard.press("escape");
	await app.waitUntil(() => !app.shows("id:mission-threads"));
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("a thread read that fails after an earlier one says what shows is from the last read", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "Keep me");
	expect(app.shows("id:thread-stale")).toBe(false);
	await app.press("Unreadable");
	await app.press("id:threads-read-again");
	await app.waitFor("id:thread-stale");
	expect(app.shows("Pilot could not reach its service. What shows is from Pilot's last read.")).toBe(true);
	expect(app.shows("Do we need PDFs in the first version?")).toBe(true);
	expect(app.value("id:thread-reply")).toBe("Keep me");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

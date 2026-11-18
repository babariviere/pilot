// Mission threads on scripted topics (ThreadFixture.tsx). No daemon,
// provider or storage. Headless: not native appearance, focus, scrolling or IME.
import { expect, open, test } from "nsh/test";

// Seeded rows reach 09:18 today. New replies must follow them even when the host is past midnight.
const desktop = {
	platform: "macos",
	width: 1100,
	height: 2600,
	clock: { time: new Date(2026, 10, 16, 12) },
} as const;

async function mission() {
	const app = await open("./ThreadFixture.tsx", desktop);
	await app.press("id:mission-search");
	await app.press("id:mission-section-discussions");
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

test("Interrupt asks first; Escape keeps the draft and the discussion open", async () => {
	const app = await thread();
	await app.press("Hand off");
	await app.waitFor("Thread chat");
	await app.type("id:thread-reply", "Address this now");
	await app.press("id:thread-interrupt");
	await app.waitFor("id:thread-interrupt-confirm");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
	await app.keyboard.press("escape");
	expect(app.shows("id:thread-interrupt-confirm")).toBe(false);
	expect(app.value("id:thread-reply")).toBe("Address this now");
	await app.press("id:thread-interrupt");
	await app.press("role:button[Interrupt]");
	await app.waitFor("Writes: 1 · Sends: 1 · Checks: 0");
	expect(app.value("id:thread-reply")).toBe("");
});

test("a mission lists its threads; opening one shows its links and its whole own conversation, sending nothing", async () => {
	const app = await mission();
	expect(app.shows("Which file types are in scope?")).toBe(true);
	expect(app.shows("What counts as released?")).toBe(true);
	expect(app.shows("Later")).toBe(true);
	await app.press("id:thread-search-scope");
	await app.waitFor("id:thread-conversation");
	await app.waitFor("Do we need PDFs in the first version?");
	expect(app.shows("Task #1 Read the exporter")).toBe(true);
	// Only this thread's messages and the replies saved as its own, with who and when.
	expect(
		app.shows("No PDFs in the first version: the agreement names Markdown only. Released means merged and tagged."),
	).toBe(true);
	expect(app.shows("Today, 09:10")).toBe(true);
	expect(app.shows("Coordinator")).toBe(true);
	expect(app.shows("I checked the native build for another task. It passes.")).toBe(false);
	expect(app.shows("Does released mean merged or tagged?")).toBe(false);
	// Other work waits behind Show activity.
	expect(app.shows("id:thread-history")).toBe(false);
	expect(app.shows("Show activity")).toBe(true);
	// Earlier messages come a page at a time, across pages that hold none of this thread's.
	await app.press("id:thread-earlier-messages");
	await app.waitFor("Do customers still upload PDFs?");
	expect(app.shows("Yesterday, 16:24")).toBe(true);
	// A coordinator reply is linked whole, and says so.
	expect(app.shows("id:message-shared-s-coordinator:8")).toBe(true);
	await app.press("id:thread-earlier-messages");
	await app.waitFor("Markdown for now. PDFs need a separate reader; we can decide here.");
	expect(app.shows("id:thread-earlier-messages")).toBe(false);
	const texts = app.texts();
	const at = (words: string) => texts.findIndex((t) => t.startsWith(words));
	expect(at("Markdown for now.")).toBeLessThan(at("Do customers still upload PDFs?"));
	expect(at("Do customers still upload PDFs?")).toBeLessThan(at("Do we need PDFs in the first version?"));
	expect(at("Do we need PDFs in the first version?")).toBeLessThan(at("Before we settle this"));
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
	await app.keyboard.press("escape");
	await app.waitFor("id:mission-threads");
});

test("a long message shows every word, and a pending message says it awaits a reply", async () => {
	const app = await thread();
	await app.waitFor("id:message-reply-s-coordinator:16:op-batch-scope");
	const long = app.texts().find((t) => t.startsWith("Before we settle this"));
	expect(long?.includes("Point 12: customers upload PDFs")).toBe(true);
	expect(long?.endsWith("Last line: if we leave PDFs out now, say so in the release notes.")).toBe(true);
	expect(app.shows("Awaiting a reply")).toBe(true);
	// An answered message says nothing more; one with no saved link to an answer says Pilot cannot tell.
	expect(app.shows("id:message-reply-s-coordinator:11")).toBe(false);
	expect(app.shows("id:message-reply-s-coordinator:14")).toBe(false);
	await app.waitFor("id:message-reply-s-coordinator:15");
	expect(app.texts()).toContain("Reply status unknown");
	await app.press("Turn ended");
	await app.press("Fixture read");
	await app.waitFor("The turn ended without a reply");
	expect(app.shows("Awaiting a reply")).toBe(false);
	await app.press("Coordinator replies");
	await app.waitFor("PDFs can wait. I noted it.");
	await app.waitUntil(() => !app.shows("id:message-reply-s-coordinator:16:op-batch-scope"));
	await app.press("Replies unknown");
	await app.type("id:thread-reply", "And zip files?");
	await app.keyboard.press("mod+enter");
	await app.waitFor("Sent. The thread chat has your message; its answer shows here when it writes one.");
	await app.waitUntil(() => app.texts().includes("And zip files?"));
	// Pilot cannot tell whether it has an answer, and says so instead of claiming one.
	expect(app.shows("Awaiting a reply")).toBe(false);
	expect(app.texts().filter((t) => t === "Reply status unknown")).toHaveLength(2);
	expect(counts(app)).toBe("Writes: 1 · Sends: 1 · Checks: 0");
});

test("Show activity adds the original history below, keeping the conversation, its pages and the draft", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "Keep me 日本語");
	await app.press("id:thread-earlier-messages");
	await app.waitFor("Do customers still upload PDFs?");
	// The button names what it shows, and that it only reads.
	await app.press(
		"label:Show the original history with other work and tool steps below this conversation. This only reads.",
	);
	await app.waitFor("id:thread-history");
	expect(app.shows("Coordinator activity")).toBe(true);
	// Other threads' messages and tool steps, which the conversation leaves out.
	expect(app.shows("Does released mean merged or tagged?")).toBe(true);
	expect(app.shows("Sent in another thread")).toBe(true);
	expect(app.shows("Sent in this thread")).toBe(true);
	// Tool steps fold into one line that opens to show exactly what each did.
	expect(app.texts().includes("Tool result: bash\nFinished in 41s")).toBe(false);
	await app.press("label:One tool step or note. Show what they did. This only reads.");
	await app.waitUntil(() => app.texts().includes("Tool result: bash\nFinished in 41s"));
	await app.press("id:thread-earlier");
	await app.waitFor("I read the mission and its plan. I will keep to the agreed scope.");
	expect(app.shows("I checked the native build for another task. It passes.")).toBe(true);
	expect(app.shows("Do customers still upload PDFs?")).toBe(true);
	expect(app.value("id:thread-reply")).toBe("Keep me 日本語");
	// Back and in again: the activity and the draft are as they were.
	await app.press("id:back");
	await app.waitFor("id:mission-threads");
	await app.press("id:thread-search-scope");
	await app.waitFor("id:thread-history");
	expect(app.value("id:thread-reply")).toBe("Keep me 日本語");
	await app.press("label:Hide the activity below this conversation. Your words stay.");
	await app.waitUntil(() => !app.shows("id:thread-history"));
	expect(app.value("id:thread-reply")).toBe("Keep me 日本語");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("Original message names the exact saved entry and opens the activity at it, even far back", async () => {
	const app = await thread();
	expect(app.shows("label:Where the coordinator's message from Today, 09:12 is saved. This only reads.")).toBe(true);
	await app.press("id:message-original-s-coordinator:14");
	await app.waitFor("id:message-origin-s-coordinator:14");
	expect(app.shows("Saved as entry 14 of the coordinator's conversation.")).toBe(true);
	await app.press("id:message-activity-s-coordinator:14");
	await app.waitFor("The original of a message in this thread");
	expect(app.shows("id:entry-14")).toBe(true);
	// One far back, outside the activity read so far: Pilot reads the page that ends at it.
	await app.press("id:thread-earlier-messages");
	await app.waitFor("Do customers still upload PDFs?");
	await app.press("id:thread-earlier-messages");
	await app.waitFor("id:message-original-s-coordinator:3");
	await app.press("id:message-original-s-coordinator:3");
	await app.press("id:message-activity-s-coordinator:3");
	await app.waitFor("Pilot sent the coordinator a planning request.");
	expect(app.shows("id:entry-3")).toBe(true);
	expect(app.shows("id:entry-14")).toBe(false);
	expect(app.texts().filter((t) => t === "The original of a message in this thread")).toHaveLength(1);
	// A live reply leaves the opened stretch where it is, until the user asks for the latest.
	await app.press("Coordinator replies");
	await app.waitFor("PDFs can wait. I noted it.");
	expect(app.shows("id:entry-3")).toBe(true);
	expect(app.shows("The original of a message in this thread")).toBe(true);
	await app.press("id:thread-activity-latest");
	await app.waitFor("id:entry-14");
	expect(app.shows("id:thread-activity-latest")).toBe(false);
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("threads keep their own conversations: a reply linked to two is flagged in each, an unlinked one stays in activity", async () => {
	const app = await thread();
	await app.waitFor("id:message-shared-s-coordinator:14");
	expect(app.shows("Also linked to another thread. Parts of this reply may be about it.")).toBe(true);
	await app.press("id:back");
	await app.press("id:thread-search-release");
	await app.waitFor("Does released mean merged or tagged?");
	expect(app.shows("id:message-shared-s-coordinator:14")).toBe(true);
	expect(app.shows("Do we need PDFs in the first version?")).toBe(false);
	await app.press("Coordinator replies elsewhere");
	await app.waitFor("Tagged releases only.");
	await app.press("Coordinator works");
	await app.press("id:back");
	await app.press("id:thread-search-scope");
	await app.waitFor("Do we need PDFs in the first version?");
	expect(app.shows("Tagged releases only.")).toBe(false);
	expect(app.shows("I ran the exporter tests for another task.")).toBe(false);
	await app.press("id:thread-activity-toggle");
	await app.waitFor("I ran the exporter tests for another task.");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("a late page lands only in its own thread; live replies keep earlier pages, the activity and the draft", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "Keep me");
	await app.press("id:thread-earlier-messages");
	await app.waitFor("Do customers still upload PDFs?");
	await app.press("id:thread-activity-toggle");
	await app.waitFor("id:thread-history");
	await app.press("Coordinator replies");
	await app.waitFor("PDFs can wait. I noted it.");
	expect(app.shows("Do customers still upload PDFs?")).toBe(true);
	expect(app.shows("id:thread-history")).toBe(true);
	expect(app.value("id:thread-reply")).toBe("Keep me");
	// A read that answers late, after the user moved to another thread.
	await app.press("Hold reads");
	await app.press("Fixture read");
	await app.press("id:back");
	await app.press("id:thread-search-release");
	await app.waitFor("id:thread-conversation");
	await app.press("Release reads");
	await app.waitFor("Does released mean merged or tagged?");
	expect(app.shows("Do we need PDFs in the first version?")).toBe(false);
	expect(app.shows("PDFs can wait. I noted it.")).toBe(false);
	await app.press("id:back");
	await app.press("id:thread-search-scope");
	await app.waitFor("PDFs can wait. I noted it.");
	expect(app.value("id:thread-reply")).toBe("Keep me");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("a conversation read that fails is never shown as empty; a later failure keeps the last read", async () => {
	const app = await mission();
	await app.press("Pages fail");
	await app.press("id:thread-search-scope");
	await app.waitFor("id:thread-conversation-off");
	expect(app.shows("Pilot could not reach its service to read this thread's conversation.")).toBe(true);
	expect(app.shows("id:thread-conversation-empty")).toBe(false);
	await app.press("Pages work");
	await app.press("Fixture read");
	await app.waitFor("Do we need PDFs in the first version?");
	expect(app.shows("id:thread-conversation-off")).toBe(false);
	await app.type("id:thread-reply", "Keep me");
	await app.press("Pages fail");
	await app.press("Fixture read");
	// The messages stay, with no note: only the shared old-data rule warns.
	await app.wait(200);
	expect(app.shows("id:thread-conversation-off")).toBe(false);
	expect(app.shows("Do we need PDFs in the first version?")).toBe(true);
	expect(app.value("id:thread-reply")).toBe("Keep me");
	await app.press("Pages work");
	await app.press("Unlinked replies");
	await app.press("Fixture read");
	await app.waitFor("id:thread-unlinked");
	expect(app.shows("id:thread-conversation-off")).toBe(false);
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("one planning input that carried two threads' sends shows each in its own thread, with the same original", async () => {
	const app = await thread();
	await app.waitFor("id:message-s-coordinator:16:op-batch-scope");
	expect(app.shows("Also keep the CSV header row.")).toBe(true);
	expect(app.shows("Tag only from main.")).toBe(false);
	await app.press("id:message-original-s-coordinator:16:op-batch-scope");
	await app.waitFor("Saved as entry 16 of the coordinator's conversation.");
	await app.press("id:message-activity-s-coordinator:16:op-batch-scope");
	await app.waitFor("The original of a message in this thread");
	expect(app.shows("id:entry-16")).toBe(true);
	await app.press("id:back");
	await app.press("id:thread-search-release");
	await app.waitFor("id:message-s-coordinator:16:op-batch-release");
	expect(app.shows("Tag only from main.")).toBe(true);
	expect(app.shows("Also keep the CSV header row.")).toBe(false);
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("a newest page that does not reach what showed keeps every message and marks the gap until it is read", async () => {
	const app = await thread();
	await app.press("id:thread-earlier-messages");
	await app.waitFor("Do customers still upload PDFs?");
	// More new entries than one page: the newest page does not reach the messages shown.
	await app.press("Coordinator busy");
	await app.waitFor("Markdown export is ready to review.");
	await app.waitFor("id:thread-gap");
	expect(app.shows("Do customers still upload PDFs?")).toBe(true);
	expect(app.shows("Do we need PDFs in the first version?")).toBe(true);
	expect(app.shows("id:thread-earlier-messages")).toBe(false);
	const texts = app.texts();
	expect(texts.findIndex((t) => t.startsWith("Pilot has not read the messages between these yet."))).toBeLessThan(
		texts.indexOf("Markdown export is ready to review."),
	);
	await app.press("id:thread-gap-read");
	await app.waitUntil(() => !app.shows("id:thread-gap"));
	// Closed: earlier messages go on from where they were.
	await app.waitFor("id:thread-earlier-messages");
	for (const words of [
		"Do customers still upload PDFs?",
		"Do we need PDFs in the first version?",
		"Markdown export is ready to review.",
	])
		expect(app.texts().filter((t) => t === words)).toHaveLength(1);
	await app.press("id:thread-earlier-messages");
	await app.waitFor("Markdown for now. PDFs need a separate reader; we can decide here.");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("an earlier read and a live read in flight together both land, in order, and neither is left reading", async () => {
	const app = await thread();
	await app.press("Hold reads");
	await app.press("id:thread-earlier-messages");
	await app.waitFor("Reading…");
	await app.press("Coordinator replies");
	await app.press("Coordinator replies elsewhere");
	await app.press("Release reads");
	await app.waitFor("PDFs can wait. I noted it.");
	await app.waitFor("Do customers still upload PDFs?");
	await app.waitUntil(() => !app.shows("Reading…"));
	expect(app.shows("Tagged releases only.")).toBe(false);
	expect(app.shows("id:thread-earlier-messages")).toBe(true);
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("earlier messages keep the message on screen where it was; hiding the activity keeps its button on screen", async () => {
	const app = await open("./ThreadFixture.tsx", { platform: "macos", width: 1100, height: 1000 });
	await app.press("id:mission-search");
	await app.press("id:mission-section-discussions");
	await app.press("id:thread-search-scope");
	await app.waitFor("id:message-s-coordinator:11");
	await app.press("Where");
	await app.waitFor("Scroll: 0");
	await app.press("id:thread-earlier-messages");
	await app.waitUntil(() => !app.shows("Reading…"));
	await app.press("Where");
	// Pilot scrolled by what it added above, so the message read before stays in view.
	await app.waitUntil(() => app.texts().some((t) => /^Scroll: [1-9]/.test(t)));
	expect(app.shows("id:message-s-coordinator:11")).toBe(true);
	await app.type("id:thread-reply", "Keep me");
	await app.press("id:thread-activity-toggle");
	await app.waitFor("id:thread-history");
	await app.press("id:thread-earlier");
	await app.scroll("id:thread", 4000);
	await app.press("label:Hide the activity below this conversation. Your words stay.");
	await app.waitUntil(() => !app.shows("id:thread-history"));
	expect(app.shows("id:thread-activity-toggle")).toBe(true);
	expect(app.value("id:thread-reply")).toBe("Keep me");
});

test("a live update that removes old words and status lines above the screen keeps the message being read exactly in place", async () => {
	const app = await open("./ThreadFixture.tsx", { platform: "macos", width: 1100, height: 1000 });
	await app.press("id:mission-search");
	await app.press("id:mission-section-discussions");
	await app.press("id:thread-search-scope");
	await app.waitFor("id:message-s-coordinator:11");
	// The service reports old words it cannot place, and does not know yet which turns answered your messages.
	await app.press("Old words unplaced");
	await app.waitFor("id:thread-unplaced");
	await app.press("Reply links unknown");
	await app.waitFor("id:message-reply-s-coordinator:11");
	// Read on to the middle of the page, past the old words and a status line, away from the end.
	await app.scroll("id:thread", 1000);
	await app.wait(500);
	const probe = async (n: number) => {
		await app.press("Where");
		await app.waitUntil(() => app.texts().some((t) => t.startsWith(`Anchor ${n}: `)));
		const text = app.texts().find((t) => t.startsWith(`Anchor ${n}: `)) ?? "";
		const [, key, top] = /^Anchor \d+: (\S+) (-?\d+)$/.exec(text) ?? [];
		const scroll = Number(
			app
				.texts()
				.find((t) => t.startsWith("Scroll: "))
				?.slice(8),
		);
		return { key: key ?? "", top: Number(top), scroll };
	};
	const before = await probe(1);
	expect(before.key).toBe("s-coordinator:15");
	expect(before.top).toBeLessThan(0);
	expect(before.scroll).toBeGreaterThan(0);
	// Both learned live: the old words' places, and which turns answered. What sat above the reader goes away.
	await app.press("Old words placed");
	await app.press("Reply links learned");
	await app.waitUntil(() => !app.shows("id:thread-unplaced") && !app.shows("id:message-reply-s-coordinator:11"));
	await app.wait(500);
	const after = await probe(2);
	// The same message, at the same place in the viewport; the page scrolled back by what went away.
	expect(after.key).toBe(before.key);
	expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
	expect(after.scroll).toBeLessThan(before.scroll);
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("Send sends the exact words once; the service's acceptance is not the coordinator's answer", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "  What about zip files? 日本語\n");
	await app.press("id:thread-send");
	await app.waitFor("Sent. The thread chat has your message; its answer shows here when it writes one.");
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
	await app.waitUntil(() => app.texts().includes("Exact words"));
});

test("a held coordinator saves the message to wait and shows it there, sending nothing yet", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "Keep me");
	await app.press("Hold");
	await app.press("Fixture read");
	await app.waitFor("id:thread-will-wait");
	await app.press("id:thread-send");
	// It shows in the conversation, in its order, with no original yet: Pilot invents none.
	await app.waitFor("Saved. Not placed in the conversation yet.");
	expect(app.texts().filter((t) => t === "Keep me")).toHaveLength(1);
	expect(app.shows("id:thread-waiting")).toBe(false);
	expect(app.value("id:thread-reply")).toBe("");
	expect(app.shows("Saved. It waits for the coordinator.")).toBe(true);
	expect(app.shows("id:thread-will-wait")).toBe(false);
	// Placed in the conversation, it is the same message once, now with its original.
	await app.press("Place waiting");
	await app.waitUntil(() => !app.shows("Saved. Not placed in the conversation yet."));
	expect(app.texts().filter((t) => t === "Keep me")).toHaveLength(1);
	expect(counts(app)).toBe("Writes: 1 · Sends: 0 · Checks: 0");
});

test("a thread missing from the last read shows why the next read failed, and keeps that read", async () => {
	const app = await mission();
	await app.press("Open a gone thread");
	await app.waitFor("id:thread-absent");
	// The read worked: the thread is just not in it.
	expect(app.shows("This thread is not in the latest read. Your words for it stay.")).toBe(true);
	expect(app.shows("id:thread-absent-failed")).toBe(false);
	await app.press("Unreadable");
	await app.press("Fixture read");
	await app.waitFor("id:thread-absent-failed");
	expect(
		app.shows(
			"Pilot could not reach its service. This thread is not in Pilot's last read, so Pilot cannot show it now. Your words for it stay.",
		),
	).toBe(true);
	expect(app.shows("This thread is not in the latest read. Your words for it stay.")).toBe(false);
	await app.press("Denied");
	await app.press("Fixture read");
	await app.waitFor(
		"This Pilot service cannot show mission threads yet. This thread is not in Pilot's last read, so Pilot cannot show it now. Your words for it stay.",
	);
	// The mission still shows its whole earlier read, with no note until the shared old-data rule.
	await app.press("id:back");
	await app.waitFor("id:mission-threads");
	expect(app.shows("Which file types are in scope?")).toBe(true);
	expect(app.shows("This Pilot service cannot show mission threads yet. What shows is from Pilot's last read.")).toBe(
		false,
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
	await app.press("Fixture read");
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

test("a new thread starts with its first message: its first sentence is the title, and the message is sent in it", async () => {
	const app = await mission();
	await app.press("id:thread-new");
	await app.type("id:thread-title", "Do we keep PDF support? Customers still upload them every week.");
	await app.waitFor("Title: Do we keep PDF support?");
	await app.press("id:thread-start");
	await app.waitFor("id:thread-reply");
	await app.waitUntil(() => !!counts(app)?.includes("Sends: 1"));
	expect(app.shows("Do we keep PDF support?")).toBe(true);
	expect(app.shows("Do we keep PDF support? Customers still upload them every week.")).toBe(true);
	expect(app.value("id:thread-reply")).toBe("");
	expect(counts(app)).toBe("Writes: 2 · Sends: 1 · Checks: 0");
});

test("when the coordinator cannot take a message, the new thread opens with its first message waiting", async () => {
	const app = await mission();
	await app.press("Hold");
	await app.press("id:thread-new");
	await app.type("id:thread-title", "Do we keep PDF support?");
	await app.press("id:thread-start");
	await app.waitFor("Saved. Not placed in the conversation yet.");
	expect(app.value("id:thread-reply")).toBe("");
	expect(counts(app)).toBe("Writes: 2 · Sends: 0 · Checks: 0");
});

test("a long first message gets a short title cut at a word", async () => {
	const app = await mission();
	await app.press("id:thread-new");
	await app.type(
		"id:thread-title",
		"We should rework a bit the plan detail page because right now the expedition map is not that useful even if it is cool",
	);
	await app.waitFor("Title: We should rework a bit the plan detail page because right now the expedition…");
});

test("unreadable threads are not shown as none", async () => {
	const app = await open("./ThreadFixture.tsx", desktop);
	await app.press("Unreadable");
	await app.press("id:mission-search");
	await app.press("id:mission-section-discussions");
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

test("a thread read that fails after an earlier one keeps the last read, with no note", async () => {
	const app = await thread();
	await app.type("id:thread-reply", "Keep me");
	expect(app.shows("id:thread-stale")).toBe(false);
	await app.press("Unreadable");
	await app.press("Fixture read");
	await app.wait(200);
	expect(app.shows("id:thread-stale")).toBe(false);
	expect(app.shows("Do we need PDFs in the first version?")).toBe(true);
	expect(app.value("id:thread-reply")).toBe("Keep me");
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

test("a thread chat's messages join the coordinator's in one chronology; a confirmed revision resolves the thread", async () => {
	const app = await mission();
	await app.press("Hand off");
	await app.press("id:thread-search-scope");
	await app.waitFor("id:thread-handoff");
	expect(app.shows("Sent to the planner")).toBe(true);
	expect(app.shows("Export CSV and JSON first; PDFs later.")).toBe(true);
	expect(app.shows("· Export CSV and JSON")).toBe(true);
	await app.waitFor("Yes. CSV and JSON first, PDFs later. I sent that to the planner.");
	expect(app.shows("Thread chat")).toBe(true);
	// Earlier messages go on into the coordinator's conversation, from their original entries.
	await app.press("id:thread-earlier-messages");
	await app.waitFor("Do we need PDFs in the first version?");
	const texts = app.texts();
	expect(texts.indexOf("Do we need PDFs in the first version?")).toBeLessThan(
		texts.indexOf("Can we export CSV and JSON first?"),
	);
	await app.press("id:message-original-s-thread-chat:3");
	await app.waitFor("Saved as entry 3 of this thread's chat.");
	// The activity opens on the thread chat; the coordinator's, with replies no thread links, is one press away.
	await app.press("id:thread-activity-toggle");
	await app.waitFor("Thread chat activity");
	await app.press("id:thread-activity-coordinator");
	await app.waitFor("Does released mean merged or tagged?");
	expect(app.shows("I checked the native build for another task. It passes.")).toBe(false);
	await app.press("Chat replies");
	await app.waitFor("CSV first, then JSON.");
	// A live read leaves the chosen conversation on screen.
	expect(app.shows("Does released mean merged or tagged?")).toBe(true);
	await app.press("id:thread-activity-chat");
	await app.waitUntil(() => !app.shows("Does released mean merged or tagged?"));
	expect(app.shows("Do we need PDFs in the first version?")).toBe(true);
	await app.press("Resolve");
	await app.waitFor("id:thread-closed");
	expect(
		app.shows("A confirmed revision resolved this thread. It added #1 Read the exporter. Its history stays."),
	).toBe(true);
	expect(app.shows("id:thread-handoff")).toBe(false);
	expect(app.shows("id:thread-reopen")).toBe(true);
	expect(counts(app)).toBe("Writes: 0 · Sends: 0 · Checks: 0");
});

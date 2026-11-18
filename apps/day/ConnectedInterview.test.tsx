// A mission interview over the real TSX adapter (bridge.ts) with scripted
// root replies: words that waited to save when Pilot reworded their question
// are kept for the user, never sent again by a later save or a close.
import { expect, open, test } from "nsh/test";
import { PlanFeed, type PlanPage } from "pilot-day/native";

async function interviewPage(): Promise<PlanPage> {
	const feed = new PlanFeed("interview");
	await feed.open("export");
	const page = feed.page("export");
	if (!page?.interview) throw new Error("the interview is open");
	return page;
}

/** The same page after Pilot reworded question "what". */
function reworded(page: PlanPage): PlanPage {
	const iv = page.interview!;
	const questions = iv.questions.map((q) =>
		q.id === "what" ? { ...q, prompt: "Which parts of a chat should one export hold?", digest: "f".repeat(64) } : q,
	);
	return { ...page, interview: { ...iv, questions } };
}

const reply = (snapshot: unknown, outcome: unknown = null) => ({ version: 1, value: { snapshot, outcome } });

test("words for a reworded question are kept for the user and never re-sent by a later save or a close", async () => {
	const before = await interviewPage();
	const after = reworded(before);
	const saves: { digest: unknown; text: unknown }[] = [];
	const app = await open("./ConnectedInterviewFixture.tsx", {
		platform: "macos",
		width: 1100,
		height: 1400,
		clock: {},
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": (name: string, envelope: { args: { intent?: { digest?: string; text?: string } } }) => {
					if (name === "day.plan.read") return reply(saves.length === 0 ? before : after);
					if (name !== "day.plan.save") return { version: 1, error: "unavailable" };
					const intent = envelope.args.intent ?? {};
					saves.push({ digest: intent.digest, text: intent.text });
					// The first save names the old wording: Rust refuses it and returns the new page.
					return saves.length === 1
						? reply(after, {
								status: "stale",
								revision: 1,
								message: "This question changed. Your text is kept here; read it again.",
							})
						: reply(after, { status: "accepted", revision: 2, message: "" });
				},
			},
		},
	});
	await app.waitFor("What should one export include?");
	await app.press("id:own-what");
	await app.type("id:answer-what", "Only the messages");
	await app.wait(1_000);
	await app.waitFor("This question changed before your words were saved. Pilot did not send them.");
	expect(app.shows("Your words: Only the messages")).toBe(true);
	expect(saves.length).toBe(1);
	// A close flushes every waiting answer: these words no longer wait, so nothing is sent.
	await app.press("role:button[Close window]");
	await app.wait(1_000);
	expect(saves.length).toBe(1);
	// The user puts them back under the new wording: that is a new, explicit answer.
	await app.press("Use these words");
	await app.wait(1_000);
	expect(saves.length).toBe(2);
	expect(saves[1]).toEqual({ digest: "f".repeat(64), text: "Only the messages" });
	expect(app.shows("Your words: Only the messages")).toBe(false);
});

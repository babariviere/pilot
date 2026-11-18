// A task result with nothing delivered names where its chat is and the one
// action that moves it (DeliveryChatFixture.tsx). No daemon or provider.
import { expect, open, test } from "nsh/test";
import { queueLine } from "./codingQueue";
import { chatNow } from "./deliveryView";
import { chatLine } from "./feedbackSteps";

const desktop = { platform: "macos", width: 1000, height: 1200 } as const;

const counts = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Continues:")) ?? "";

test("a failed chat behind an empty result offers Continue, sent once, then shows it working", async () => {
	const app = await open("./DeliveryChatFixture.tsx", desktop);
	await app.waitFor("Its chat failed: Model request (anthropic): Allowance hold");
	expect(app.shows("No report with this result.")).toBe(true);
	expect(app.shows("id:chat-continue")).toBe(true);
	await app.press("id:chat-continue");
	await app.waitFor("Its chat is working on it.");
	expect(counts(app)).toBe("Continues: 1 · Chat open: none");
	expect(app.shows("id:chat-continue")).toBe(false);
	await app.press("id:delivery-chat-open");
	await app.waitFor("Continues: 1 · Chat open: worker-1");
});

test("each chat state names its action: open, answer or continue", async () => {
	const app = await open("./DeliveryChatFixture.tsx", desktop);
	await app.waitFor("id:delivery-chat-now");
	await app.press("Queued");
	await app.waitFor("Waiting for a Pilot coding slot (4 of 4 occupied).");
	expect(app.shows("id:chat-continue")).toBe(false);
	expect(app.shows("id:delivery-chat-open")).toBe(true);
	await app.press("Asking");
	await app.waitFor("Its chat asks you a question and waits for your answer.");
	expect(app.shows("id:delivery-chat-answer")).toBe(true);
	await app.press("Stopped");
	await app.waitFor("Its chat stopped before it delivered.");
	expect(app.shows("id:chat-continue")).toBe(true);
	// A failure the service says is not safe to retry offers only its chat.
	await app.press("Failed for good");
	await app.waitFor("Its chat failed: Startup failed");
	expect(app.shows("id:chat-continue")).toBe(false);
	expect(app.shows("id:delivery-chat-open")).toBe(true);
});

test("a chat waiting for a reply shows its last message with Reply, sent once, and Continue", async () => {
	const app = await open("./DeliveryChatFixture.tsx", desktop);
	await app.waitFor("id:delivery-chat-now");
	await app.press("Waiting");
	await app.waitFor("Its chat ended its turn without a result or a question. It may be waiting for your reply.");
	expect(app.shows("Here is the mockup. Does the layout work for you?")).toBe(true);
	expect(app.shows("id:chat-waits-continue-worker-1")).toBe(true);
	await app.type("id:chat-reply-worker-1", "Yes, ship it");
	await app.press("id:chat-reply-send-worker-1");
	await app.waitFor("Replies: Yes, ship it");
	expect(app.shows("id:chat-reply-send-worker-1")).toBe(false);
});

test("chatNow says nothing once there is a result", () => {
	const base = {
		version: 1 as const,
		subject: { kind: "task" as const, projectId: "p", missionId: "m", taskId: "t" },
		targetId: "x",
		ownerSessionId: "w",
		pullRequests: [],
		artifacts: [],
		production: "not_tracked" as const,
		verification: null,
		verificationCurrent: false,
		verificationReceiptState: "unknown" as const,
		verificationRevision: 0,
		pendingOperationId: null,
	};
	expect(chatNow({ ...base, deliveryId: "d", chat: { state: "failed" } })).toBe(null);
	expect(chatNow({ ...base, deliveryId: null })).toBe(null);
	expect(chatNow({ ...base, deliveryId: null, chat: { state: "stopped" } })?.move).toBe("open");
	expect(chatNow({ ...base, deliveryId: null, chat: { state: "stopped", canContinue: true } })?.move).toBe("continue");
	// A chat waiting for a reply has nothing new to check: it shows beside an earlier result too.
	expect(chatNow({ ...base, deliveryId: "d", chat: { state: "waiting", canContinue: true } })?.move).toBe("reply");
	// A queued chat says where it is in line; without the view, the service's reason.
	const queue = { kind: "files" as const, position: 1, holders: ["Search index"] };
	expect(chatNow({ ...base, deliveryId: null, chat: { state: "queued", reason: "Waiting.", queue } })).toEqual({
		line: "Waiting for shared files · 1st in line · files used by Search index",
		move: "open",
	});
	expect(chatNow({ ...base, deliveryId: null, chat: { state: "queued", reason: "Waiting." } })?.line).toBe("Waiting.");
});

test("the queue line is the same for a feedback fix chat and counts places in English", () => {
	expect(queueLine({ kind: "slots", position: 12, holders: [] })).toBe("Waiting for a coding slot · 12th in line");
	expect(queueLine({ kind: "slots", position: 23, holders: ["A"] })).toBe(
		"Waiting for a coding slot · 23rd in line · slots used by A",
	);
	const fix = {
		kind: "fix" as const,
		operationId: "op",
		recordedAt: 1,
		sessionId: "fix",
		projectId: "p",
		triageSessionId: "triage",
		proposalDigest: "d",
		chat: {
			title: "Fix",
			state: "starting" as const,
			queue: { kind: "slots" as const, position: 2, holders: ["A", "B"] },
		},
	};
	expect(chatLine(fix as never)).toBe("Waiting for a coding slot · 2nd in line · slots used by A, B");
});

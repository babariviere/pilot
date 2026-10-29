import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, GenerationTask, InboxDoc, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import {
	admitWithHeld,
	discardHeld,
	HeldInputsDoc,
	holdOnStop,
	initializeQuestionHold,
	pauseInputs,
	publishQuestionWithHeld,
} from "./held-inputs.ts";
import { editQueuedMessage, queueUpdateForDisplay, removeQueuedMessage } from "./queue.ts";

async function fixture() {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	const conversation = await session.commit(async (tx) => {
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		const inbox = await tx.doc(InboxDoc, conversation.id);
		for (const [requestId, mode, content] of [
			["mission:send:follow", "followUp", "Follow"],
			["user:follow", "followUp", "User follow"],
			["native:jobs.result:job", "followUp", "Job"],
			["mission:send:steer", "steer", "Correction"],
			["user:steer", "steer", "User steer"],
			["pr-follow-up:1", "followUp", "PR"],
		] as const) {
			const input = await tx.createSubmission({
				conversationId: conversation.id,
				requestId,
				type: "input",
				status: "queued",
			});
			inbox.items.push({ id: input.id, mode, content });
		}
		return conversation;
	}, context);
	const read = (id: Parameters<typeof storage.submission>[0]) => storage.submission(id, context);
	return { storage, session, id: conversation.id, read };
}

test("question publication and legacy recovery fence automatic inbox entries atomically", async () => {
	const f = await fixture();
	try {
		await f.session.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, f.id);
			inbox.items = inbox.items.filter(
				(item) => !["User follow", "User steer"].includes(String("content" in item ? item.content : "")),
			);
		}, context);
		await publishQuestionWithHeld(f.session, f.id, f.read, "question:one", { question: "Which?" }, context);
		await publishQuestionWithHeld(f.session, f.id, f.read, "question:one", { question: "Which?" }, context);
		let held = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		assert.equal(held.questionPending, true);
		assert.equal(held.items.length, 4);
		assert.equal((await f.storage.scanEntries({ conversationId: f.id }, 100, undefined, context)).items.length, 1);
		// Simulate a pre-upgrade store, with a committed question and automatic inbox still waiting.
		await f.session.commit(async (tx) => {
			const held = await tx.doc(HeldInputsDoc, f.id);
			const inbox = await tx.doc(InboxDoc, f.id);
			delete held.questionPending;
			inbox.items.push(...held.items);
			held.items = [];
		}, context);
		await initializeQuestionHold(f.session, f.id, f.read, context);
		held = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		assert.equal(held.questionPending, true);
		assert.equal(held.items.length, 4);
		assert.equal((await f.session.snapshot(InboxDoc, f.id, context))?.items.length, 0);
		await holdOnStop(f.session, f.id, f.read, context);
		await initializeQuestionHold(f.session, f.id, f.read, context);
		assert.equal(
			(await f.session.snapshot(HeldInputsDoc, f.id, context))?.questionPending,
			false,
			"recovery cannot undo explicit Stop",
		);
	} finally {
		await f.session.close(context);
	}
});

test("an answer accepted during queue pause resolves the question without bypassing pause", async () => {
	const f = await fixture();
	try {
		await f.session.commit(async (tx) => {
			(await tx.doc(InboxDoc, f.id)).items = [];
		}, context);
		await publishQuestionWithHeld(f.session, f.id, f.read, "question:one", { question: "Which?" }, context);
		await pauseInputs(f.session, f.id, context);
		await admitWithHeld(
			f.session,
			f.id,
			{ requestId: "mission:send:one", content: "Automatic", mode: "steer" },
			context,
		);
		const answer = await admitWithHeld(
			f.session,
			f.id,
			{ requestId: "user:answer", content: "Answer", mode: "followUp" },
			context,
		);
		assert.equal(answer?.held, true);
		assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run, undefined);
		const held = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		assert.equal(held.questionPending, false);
		assert.equal(held.paused, true);
		assert.deepEqual(
			held.items.map((item) => item.content),
			["Answer", "Automatic"],
		);
		assert.equal((await admitWithHeld(f.session, f.id, undefined, context, false, true))?.started, true);
	} finally {
		await f.session.close(context);
	}
});

test("a blocking reply resolves current work during pause but preserves held automatic FIFO", async () => {
	const f = await fixture();
	try {
		await f.session.commit(async (tx) => {
			(await tx.doc(InboxDoc, f.id)).items = [];
			(await tx.doc(LiveDoc, f.id)).run = {
				taskId: await tx.createTask(
					GenerationTask,
					{},
					{ ownership: { kind: "conversation" }, conversationId: f.id },
				),
				inputs: [],
			};
		}, context);
		await publishQuestionWithHeld(
			f.session,
			f.id,
			f.read,
			"question:blocking",
			{ question: "Which?", blocking: true },
			context,
		);
		await pauseInputs(f.session, f.id, context);
		for (const requestId of ["mission:send:one", "native:jobs.result:two"])
			await admitWithHeld(f.session, f.id, { requestId, content: requestId, mode: "steer" }, context);
		const answer = await admitWithHeld(
			f.session,
			f.id,
			{ requestId: "user:answer", content: "Answer", mode: "steer" },
			context,
		);
		assert.equal(answer?.held, undefined);
		assert.equal((await f.storage.submission(answer!.id!, context))?.status, "done");
		const held = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		assert.equal(held.questionPending, false);
		assert.equal(held.blockingQuestion?.answer, "Answer");
		assert.deepEqual(held.questionReplies, ["Answer"]);
		assert.deepEqual(
			held.items.map((item) => item.content),
			["mission:send:one", "native:jobs.result:two"],
		);
		assert.equal((await f.session.snapshot(InboxDoc, f.id, context))?.items.length, 0);
	} finally {
		await f.session.close(context);
	}
});

test("concurrent questions cannot replace a live awaited question or break its session", async () => {
	const f = await fixture();
	try {
		await f.session.commit(async (tx) => {
			(await tx.doc(InboxDoc, f.id)).items = [];
		}, context);
		await publishQuestionWithHeld(
			f.session,
			f.id,
			f.read,
			"question:one",
			{ question: "First?", blocking: true },
			context,
		);
		await assert.rejects(
			publishQuestionWithHeld(
				f.session,
				f.id,
				f.read,
				"question:two",
				{ question: "Second?", blocking: true },
				context,
			),
			/pending question/,
		);
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.blockingQuestion?.callId, "question:one");
		assert.equal(await initializeQuestionHold(f.session, f.id, f.read, context), true);
		assert.equal(
			await initializeQuestionHold(f.session, f.id, f.read, context),
			true,
			"a crash before retiring the run cannot lose the recovery marker",
		);
	} finally {
		await f.session.close(context);
	}
});

for (const user of [false, true]) {
	test(
		user
			? "next user input carries held input in one turn"
			: "Send now places all held input, steering first, in one turn",
		async () => {
			const f = await fixture();
			try {
				const withdrawn = await holdOnStop(f.session, f.id, f.read, context);
				assert.deepEqual(
					withdrawn.map((item) => item.content),
					["User steer", "User follow"],
				);
				assert.equal((await f.session.snapshot(InboxDoc, f.id, context))?.items.length, 0);
				const held = await f.session.snapshot(HeldInputsDoc, f.id, context);
				assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run, undefined);
				assert.equal(held?.items.length, 4);
				for (const item of held!.items) assert.equal((await f.read(item.id))?.status, "queued");
				const display = await queueUpdateForDisplay(null, f.read, undefined, 1, held!);
				assert.equal(display.items.length, 0);
				assert.ok(display.automatic!.every((item) => item.held));
				assert.equal(display.automatic!.length, 4);
				assert.equal(held?.events.length, 2);
				// Repeated Stop neither drops nor duplicates the parked submissions or their events.
				await holdOnStop(f.session, f.id, f.read, context);
				assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.events.length, 2);
				const result = await admitWithHeld(
					f.session,
					f.id,
					user ? { requestId: "next", content: "Next user", mode: "steer" } : undefined,
					context,
				);
				assert.equal(result?.started, true);
				const live = await f.session.snapshot(LiveDoc, f.id, context);
				assert.equal(live?.run?.inputs.length, user ? 5 : 4);
				const entries = await f.storage.scanEntries({ conversationId: f.id }, 100, undefined, context);
				assert.deepEqual(
					[...entries.items].reverse().map((entry) => entry.model?.[0]?.content),
					["Correction", "Follow", "Job", "PR", ...(user ? ["Next user"] : [])],
				);
				assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.items.length, 0);
				assert.equal(await admitWithHeld(f.session, f.id, undefined, context), undefined);
			} finally {
				await f.session.close(context);
			}
		},
	);
}

test("discard per row and all only settles held input and emits durable events", async () => {
	const f = await fixture();
	try {
		await holdOnStop(f.session, f.id, f.read, context);
		const held = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		await discardHeld(f.session, f.id, f.read, context, held.items[0]!.id);
		assert.equal((await f.read(held.items[0]!.id))?.status, "unanswered");
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.items.length, 3);
		await discardHeld(f.session, f.id, f.read, context, held.items[0]!.id);
		await discardHeld(f.session, f.id, f.read, context);
		const after = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		assert.equal(after.items.length, 0);
		assert.ok(after.stopped);
		assert.deepEqual(
			after.events.map((event) => event.state),
			["held", "held", "discarded", "discarded"],
		);
		assert.equal(new Set(after.events.map((event) => event.id)).size, 4);
		await f.session.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, f.id);
			const input = await tx.createSubmission({
				conversationId: f.id,
				requestId: "mission:send:waiting",
				type: "input",
				status: "queued",
			});
			inbox.items.push({ id: input.id, mode: "steer", content: "Waiting" });
		}, context);
		await discardHeld(f.session, f.id, f.read, context);
		assert.equal((await f.session.snapshot(InboxDoc, f.id, context))?.items.length, 1);
	} finally {
		await f.session.close(context);
	}
});

test("late automatic input stays held, and request retries do not duplicate it", async () => {
	const f = await fixture();
	try {
		await holdOnStop(f.session, f.id, f.read, context);
		const input = { requestId: "mission:send:late", content: "Late correction", mode: "steer" } as const;
		const admission = await admitWithHeld(f.session, f.id, input, context);
		assert.equal(admission?.held, true);
		assert.deepEqual(await admitWithHeld(f.session, f.id, input, context), admission);
		assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run, undefined);
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.items.length, 5);
	} finally {
		await f.session.close(context);
	}
});

test("pause holds all input durably, keeps the queue editable, and resume starts exactly one run", async () => {
	const f = await fixture();
	try {
		await pauseInputs(f.session, f.id, context);
		await pauseInputs(f.session, f.id, context);
		assert.equal((await f.session.snapshot(InboxDoc, f.id, context))?.items.length, 0);
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.items.length, 6);
		for (const requestId of ["user:late", "control:send:late", "native:jobs.result:late"]) {
			const input = { requestId, content: "Late", mode: "followUp" } as const;
			const result = await admitWithHeld(f.session, f.id, input, context);
			assert.ok(result?.held);
			assert.deepEqual(await admitWithHeld(f.session, f.id, input, context), result);
		}
		assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run, undefined);
		const held = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		const user = held.items[1]!;
		await editQueuedMessage(f.session, f.id, user.id, "Edited", context, "steer");
		await removeQueuedMessage(f.session, f.id, held.items[4]!.id, context);
		assert.equal((await f.read(held.items[4]!.id))?.status, "unanswered");
		assert.equal(
			(await admitWithHeld(f.session, f.id, undefined, context))?.held,
			true,
			"Send now cannot bypass pause",
		);
		const resumed = await admitWithHeld(f.session, f.id, undefined, context, false, true);
		assert.ok(resumed?.started);
		assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run?.inputs.length, 8);
		const after = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		assert.equal(after.paused, false);
		assert.equal(after.items.length, 0);
		assert.equal((await admitWithHeld(f.session, f.id, undefined, context, false, true))?.started, false);
	} finally {
		await f.session.close(context);
	}
});

test("Stop withdraws paused user input but preserves automatic input; redirect retains automatic provenance", async () => {
	const f = await fixture();
	try {
		await pauseInputs(f.session, f.id, context);
		const withdrawn = await holdOnStop(f.session, f.id, f.read, context);
		assert.deepEqual(
			withdrawn.map((item) => item.content),
			["User steer", "User follow"],
		);
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.items.length, 4);
		const input = { requestId: "control:redirect:1", content: "New instruction", mode: "followUp" } as const;
		const result = await admitWithHeld(f.session, f.id, input, context, false, true);
		assert.ok(result?.started);
		assert.equal((await f.read(result!.id!))?.requestId, input.requestId);
		assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run?.inputs.length, 5);
	} finally {
		await f.session.close(context);
	}
});

test("pause preserves the active task and resume restores queue modes without creating a second run", async () => {
	const f = await fixture();
	try {
		const taskId = await f.session.commit(async (tx) => {
			const taskId = await tx.createTask(
				GenerationTask,
				{},
				{ ownership: { kind: "conversation" }, conversationId: f.id },
			);
			(await tx.doc(LiveDoc, f.id)).run = { taskId, inputs: [] };
			return taskId;
		}, context);
		await pauseInputs(f.session, f.id, context);
		assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run?.taskId, taskId);
		assert.equal((await admitWithHeld(f.session, f.id, undefined, context, false, true))?.started, false);
		assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run?.taskId, taskId);
		assert.deepEqual(
			(await f.session.snapshot(InboxDoc, f.id, context))?.items.map((item) => item.mode),
			["followUp", "followUp", "followUp", "steer", "steer", "followUp"],
		);
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.items.length, 0);
	} finally {
		await f.session.close(context);
	}
});

test("discarding held system messages cannot discard paused user queue rows", async () => {
	const f = await fixture();
	try {
		await pauseInputs(f.session, f.id, context);
		await discardHeld(f.session, f.id, f.read, context);
		const held = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		assert.deepEqual(
			held.items.map((item) => item.content),
			["User follow", "User steer"],
		);
		for (const item of held.items) assert.equal((await f.read(item.id))?.status, "queued");
	} finally {
		await f.session.close(context);
	}
});

test("lost queue-control acknowledgements cannot replay over a newer pause", async () => {
	const f = await fixture();
	try {
		await pauseInputs(f.session, f.id, context, 1);
		// An older resume command may still be in the daemon outbox when a newer pause takes priority.
		await pauseInputs(f.session, f.id, context, 3);
		await admitWithHeld(f.session, f.id, undefined, context, false, true, 2);
		await pauseInputs(f.session, f.id, context, 1);
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.paused, true);
		assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run, undefined);
		assert.ok((await admitWithHeld(f.session, f.id, undefined, context, false, true, 4))?.started);
		await pauseInputs(f.session, f.id, context, 3);
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.paused, false);
	} finally {
		await f.session.close(context);
	}
});

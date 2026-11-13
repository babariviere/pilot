import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { HeldInputsDoc, pauseInputs } from "./held-inputs.ts";
import { DECISION_BATCH_MS, DecisionInbox, DecisionInboxDoc } from "./mission-decision-inbox.ts";
import type { MissionContext } from "./policy.ts";
import { openSessionStorage } from "./storage.ts";

const empty: MissionContext = {
	id: "mission",
	title: "Shared",
	goal: "Ship",
	status: "active",
	coordinator: "self",
	tasks: [],
	decisions: [],
	decisionState: [],
	decisionRoutes: {},
};
const rule = { id: "one", number: 1, text: "First", audience: "reference" as const, selected: false };
function snapshot(
	decisions: NonNullable<MissionContext["decisionState"]>,
	route: "unknown" | "relevant" = "unknown",
): MissionContext {
	return {
		...empty,
		decisionState: decisions,
		decisionRoutes: Object.fromEntries(decisions.map((d) => [d.id, route])),
	};
}
const own = new Map();
async function fixture(t: TestContext) {
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context);
	const inbox = new DecisionInbox(harness, conversation);
	const entries = async () =>
		(await conversation.entries({}, 100, undefined, context)).items.filter((e) => e.kind === "pilot.activity");
	return { storage, harness, conversation, inbox, entries };
}

test("related routine updates form one fixed-deadline batch, repeated snapshots deduplicate", async (t) => {
	const f = await fixture(t);
	await f.inbox.observe(empty, own, 0);
	const one = snapshot([rule]);
	const two = snapshot([rule, { ...rule, id: "two", number: 2, text: "Second" }]);
	await f.inbox.observe(one, own, 1_000);
	await f.inbox.observe(one, own, 2_000);
	await f.inbox.observe(two, own, 5_000);
	assert.equal(await f.inbox.deadline(), 1_000 + DECISION_BATCH_MS);
	await f.inbox.flush(30_999);
	assert.equal((await f.entries()).length, 0);
	await f.inbox.flush(31_000);
	await f.inbox.observe(two, own, 32_000);
	await f.inbox.flush(99_000);
	const entries = await f.entries();
	assert.equal(entries.length, 1);
	assert.match(JSON.stringify(entries[0]!.data), /2 grouped updates/);
	assert.match(JSON.stringify(entries[0]!.data), /First.*Second/);
	assert.match(JSON.stringify(entries[0]!.data), /Uncertain relevance.*coordinator must route/);
	assert.equal((await f.harness.snapshot(LiveDoc, f.conversation.id, context))?.run, undefined);
	assert.equal((await f.harness.inspect(context)).tasks.length, 0, "no classifier, worker or provider generation");
});

test("mission-wide safety and current-work edits bypass a routine batch without releasing Pause", async (t) => {
	const f = await fixture(t);
	await f.inbox.observe(empty, own, 0);
	await pauseInputs(f.harness, f.conversation.id, context, 1);
	await f.inbox.observe(snapshot([rule]), own, 1_000);
	const safety = {
		...rule,
		id: "safety",
		number: 2,
		text: "Stop unsafe work",
		audience: "all" as const,
		selected: true,
	};
	const current = {
		...snapshot([rule, safety]),
		decisionRoutes: { one: "unknown" as const, safety: "relevant" as const },
	};
	await f.inbox.observe(current, own, 2_000);
	assert.equal(await f.inbox.deadline(), 2_000);
	await f.inbox.flush(2_000);
	assert.equal((await f.entries()).length, 1);
	assert.match(JSON.stringify((await f.entries())[0]!.data), /First.*Stop unsafe work/);
	await f.inbox.observe({ ...current, decisionState: [rule, { ...safety, text: "Revised safety" }] }, own, 2_001);
	await f.inbox.flush(2_001);
	assert.equal((await f.entries()).length, 2);
	assert.equal((await f.harness.snapshot(HeldInputsDoc, f.conversation.id, context))?.paused, true);
	assert.equal((await f.harness.snapshot(LiveDoc, f.conversation.id, context))?.run, undefined);
});

test("uncertain edits surface immediately, while unrelated worker changes produce no entry", async (t) => {
	const f = await fixture(t);
	await f.inbox.observe(snapshot([rule]), own, 0);
	await f.inbox.observe(snapshot([{ ...rule, text: "Possibly conflicting revision" }]), own, 1_000);
	await f.inbox.flush(1_000);
	assert.equal((await f.entries()).length, 1);
	const worker = { ...snapshot([rule]), coordinator: "other" as const, decisionRoutes: { one: "unrelated" as const } };
	await f.inbox.observe(worker, own, 2_000);
	await f.inbox.observe({ ...worker, decisionState: [{ ...rule, text: "Not this worker" }] }, own, 3_000);
	await f.inbox.flush(99_000);
	assert.equal((await f.entries()).length, 1);
});

test("new coordinator gets unknown guidance; moving missions or losing coordinator ownership drops pending routing", async (t) => {
	const f = await fixture(t);
	await f.inbox.observe(snapshot([rule]), own, 0);
	assert.equal(await f.inbox.deadline(), DECISION_BATCH_MS);
	await f.inbox.observe({ ...empty, id: "another" }, own, 1_000);
	await f.inbox.flush(99_000);
	assert.equal((await f.entries()).length, 0);
	await f.inbox.observe(snapshot([rule]), own, 100_000);
	await f.inbox.observe(
		{ ...snapshot([rule]), coordinator: "other", decisionRoutes: { one: "unrelated" } },
		own,
		101_000,
	);
	await f.inbox.flush(999_000);
	assert.equal((await f.entries()).length, 0);
	await f.inbox.observe(undefined, own);
	assert.equal(await f.inbox.deadline(), undefined);
	await f.inbox.observe(snapshot([rule]), own, 1_000_000);
	await f.inbox.observe({ ...snapshot([rule]), status: "archived" }, own, 1_000_001);
	await f.inbox.flush(9_000_000);
	assert.equal((await f.entries()).length, 0);
});

test("lost placement ACK retries the same frozen ID and bytes, without duplicate delivery", async (t) => {
	const f = await fixture(t);
	await f.inbox.observe(empty, own, 0);
	await f.inbox.observe(snapshot([{ ...rule, audience: "all", selected: true }], "relevant"), own, 1);
	const submit = f.conversation.submit.bind(f.conversation);
	const fault = t.mock.method(f.conversation, "submit", async (...args: Parameters<typeof submit>) => {
		await submit(...args);
		throw new Error("lost ACK");
	});
	await assert.rejects(f.inbox.flush(1), /lost ACK/);
	const frozen = (await f.harness.snapshot(DecisionInboxDoc, f.conversation.id, context))!.frozen!;
	assert.equal((await f.entries()).length, 1);
	fault.mock.restore();
	const reconnected = new DecisionInbox(f.harness, f.conversation);
	await reconnected.flush(100_000);
	assert.equal((await f.entries()).length, 1);
	assert.equal(await reconnected.deadline(), undefined);
	assert.ok(await f.storage.submissionByRequest(f.conversation.id, frozen.requestId, context));
});

test("retirement strips queued bodies and quarantines exact uncertain placement bytes", async (t) => {
	const f = await fixture(t);
	await f.inbox.observe(empty, own, 0);
	await f.inbox.observe(snapshot([rule]), own, 1);
	const submit = t.mock.method(f.conversation, "submit", async () => {
		throw new Error("Lost placement ACK");
	});
	await assert.rejects(f.inbox.flush(99_000), /Lost placement ACK/);
	const frozen = (await f.harness.snapshot(DecisionInboxDoc, f.conversation.id, context))!.frozen!;
	submit.mock.restore();
	const retired = snapshot([
		{ ...rule, text: "", withdrawn: { at: 2, reason: "No longer current", proposalId: "withdraw" } },
	]);
	await f.inbox.observe(retired, own, 2);
	await f.inbox.flush(99_000);
	const history = (await f.conversation.entries({}, 100, undefined, context)).items;
	const quarantined = history.find((entry) => entry.kind === "pilot.decision-notice-quarantined");
	assert.deepEqual(quarantined?.data, { frozen }, "exact uncertain bytes stay saved, not rewritten/replayed");
	assert.equal(quarantined?.model, undefined);
	assert.doesNotMatch(JSON.stringify(await f.entries()), /First/);
	assert.match(JSON.stringify(await f.entries()), /no longer binding/);
	assert.equal((await f.harness.snapshot(LiveDoc, f.conversation.id, context))?.run, undefined);
});

test("a resolved task association cancels pending unknown routing before delivery", async (t) => {
	const f = await fixture(t);
	await f.inbox.observe(empty, own, 0);
	await f.inbox.observe(snapshot([rule]), own, 1);
	await f.inbox.observe({ ...snapshot([rule]), decisionRoutes: { one: "unrelated" } }, own, 2);
	await f.inbox.flush(99_000);
	assert.equal((await f.entries()).length, 0);
	assert.equal(await f.inbox.deadline(), undefined);
});

test("retired bodies waiting behind a question are kept out of automatic replay", async (t) => {
	const f = await fixture(t);
	await f.inbox.observe(empty, own, 0);
	await f.harness.commit(async (tx) => {
		(await tx.doc(HeldInputsDoc, f.conversation.id)).questionPending = true;
	}, context);
	await f.inbox.observe(snapshot([{ ...rule, audience: "all" }]), own, 1);
	await f.inbox.flush(1);
	assert.equal((await f.harness.snapshot(HeldInputsDoc, f.conversation.id, context))?.questionWrites?.length, 1);
	await f.inbox.observe(
		snapshot([{ ...rule, text: "", withdrawn: { at: 2, reason: "Obsolete", proposalId: "p" } }]),
		own,
		2,
	);
	await f.inbox.flush(2);
	const held = await f.harness.snapshot(HeldInputsDoc, f.conversation.id, context);
	assert.equal(held?.questionPending, true);
	assert.doesNotMatch(JSON.stringify(held?.questionWrites), /First/);
	const history = (await f.conversation.entries({}, 100, undefined, context)).items;
	const quarantined = history.filter((entry) => entry.kind === "pilot.decision-notice-quarantined");
	assert.equal(quarantined.length, 1);
	assert.match(JSON.stringify(quarantined[0]?.data), /First/);
	assert.equal(quarantined[0]?.model, undefined);
});

test("question deferral is durable and deduplicated without answering or waking the question", async (t) => {
	const f = await fixture(t);
	await f.inbox.observe(empty, own, 0);
	await f.harness.commit(async (tx) => {
		(await tx.doc(HeldInputsDoc, f.conversation.id)).questionPending = true;
	}, context);
	const current = snapshot([{ ...rule, audience: "all", selected: true }], "relevant");
	await f.inbox.observe(current, own, 1);
	await f.inbox.flush(1);
	await f.inbox.observe(current, own, 2);
	await f.inbox.flush(99_000);
	const held = await f.harness.snapshot(HeldInputsDoc, f.conversation.id, context);
	assert.equal(held?.questionPending, true);
	assert.equal(held?.questionWrites?.length, 1);
	assert.equal((await f.entries()).length, 0);
	assert.equal((await f.harness.snapshot(LiveDoc, f.conversation.id, context))?.run, undefined);
});

test("SQLite reopen keeps batch deadlines, reconnect dedupe and offline changes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "decision-inbox-"));
	let opened = await openSessionStorage(dir);
	let harness = await Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, context);
	t.after(async () => {
		await harness.close(context);
		opened.release();
		await rm(dir, { recursive: true, force: true });
	});
	let conversation = await harness.root(context);
	let inbox = new DecisionInbox(harness, conversation);
	await inbox.observe(empty, own, 0);
	await inbox.observe(snapshot([rule]), own, 1_000);
	await harness.close(context);
	opened.release();
	opened = await openSessionStorage(dir);
	harness = await Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, context);
	conversation = await harness.root(context);
	inbox = new DecisionInbox(harness, conversation);
	assert.equal(await inbox.deadline(), 31_000);
	await inbox.observe(snapshot([rule]), own, 40_000);
	await inbox.flush(40_000);
	assert.equal((await conversation.entries({}, 100, undefined, context)).items.length, 1);
	await inbox.observe(snapshot([rule]), own, 41_000);
	await inbox.flush(41_000);
	assert.equal((await conversation.entries({}, 100, undefined, context)).items.length, 1);
	await harness.close(context);
	opened.release();
	opened = await openSessionStorage(dir);
	harness = await Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, context);
	conversation = await harness.root(context);
	inbox = new DecisionInbox(harness, conversation);
	await inbox.observe(snapshot([{ ...rule, text: "Changed while offline" }]), own, 42_000);
	await inbox.flush(42_000);
	const entries = (await conversation.entries({}, 100, undefined, context)).items;
	assert.equal(entries.length, 2);
	assert.ok(entries.some((entry) => JSON.stringify(entry.data).includes("Changed while offline")));
});

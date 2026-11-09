import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	AssistanceOutput,
	AssistanceRequest,
	AttentionResult,
	HumanActionCommand,
	HumanActionContent,
	HumanActionIdentity,
	HumanActionRecord,
} from "@pilot/protocol";
import { assistanceSource, nativeQuestionAssistance } from "./assistance-source.ts";
import { type AttentionDependencies, AttentionError, AttentionService } from "./attention-service.ts";
import { attentionDigest } from "./attention-store.ts";
import { MissionStore } from "./missions.ts";

function value<T>(result: AttentionResult<T>): T {
	assert.ok(result.ok, JSON.stringify(result));
	return result.value;
}
function error<T>(result: AttentionResult<T>, code: string) {
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, code, result.error.message);
}
const ref = ({ id, revision, digest }: HumanActionRecord): HumanActionIdentity => ({ id, revision, digest });
function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
const digest = attentionDigest("authority");
const action: HumanActionContent = {
	projectId: "project",
	sessionId: "chat",
	missionId: "mission",
	action: "Upload extension.zip",
	reason: "Browser upload requires you",
	files: [
		{ kind: "file", uri: "file:///packages/extension.zip", version: "1.2.3", sha256: attentionDigest("zip bytes") },
	],
	destination: { uri: "https://chrome.google.com/webstore/devconsole", targetId: "extension-id", version: "1.2.3" },
	completionRequirements: ["Confirm this exact package was submitted. Review and publication can follow later."],
};
function fixture(store = new MissionStore(":memory:")) {
	const state = {
		source: "Choose A or B",
		eventId: 1,
		authority: digest,
		actor: "user" as "user" | "agent",
		calls: 0,
		valid: true,
	};
	const deps: AttentionDependencies = {
		store: store.attention,
		subject: (subject) => ({
			source: state.source,
			scope: {
				subject,
				projectId: "project",
				eventId: state.eventId,
				contentDigest: attentionDigest(state.source),
				authorityDigest: state.authority,
			},
		}),
		generate: async (req) => {
			state.calls++;
			return req.kind === "question"
				? { kind: "question", question: req.question!, answer: "Here is why" }
				: { kind: "simpler", text: "Pick A or B" };
		},
		authorize: () => ({ digest: state.authority, actor: state.actor }),
		verifyAction: async () => state.valid,
	};
	const service = new AttentionService(deps);
	const scope = value(service.prepare({ kind: "question", sessionId: "chat", entryId: 12 }));
	return {
		store,
		deps,
		state,
		service,
		req: { requestId: "help", scope, kind: "simpler" } satisfies AssistanceRequest,
	};
}
const create: HumanActionCommand = { kind: "create", operationId: "create", id: "upload", content: action };

test("native help uses only the exact current ordinary question boundary", () => {
	const current = {
		projectId: "p",
		sessionId: "chat",
		entryId: 12,
		eventId: 20,
		questionPending: true,
		stopped: false,
		question: { question: "Which?", options: [] },
		authorityDigest: digest,
	};
	const read = nativeQuestionAssistance(() => current);
	const subject = { kind: "question" as const, sessionId: "chat", entryId: 12 };
	assert.match(read(subject).source, /Which/);
	assert.throws(() => read({ ...subject, entryId: 11 }), AttentionError);
	current.questionPending = false;
	assert.throws(() => read(subject), AttentionError);
	current.questionPending = true;
	current.stopped = true;
	assert.throws(() => read(subject), AttentionError);
	current.stopped = false;
	Object.assign(current.question, { databaseAccess: { id: "db", env: "prod", mode: "write" } });
	assert.throws(() => read(subject), AttentionError);
});

test("all help modes remain commentary; exact inline question and immutable visual", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	value(await f.service.assist(f.req));
	f.deps.generate = async () => ({ kind: "context", text: "More facts" });
	value(await f.service.assist({ ...f.req, requestId: "context", kind: "context" }));
	f.deps.generate = async (req) => ({ kind: "question", question: req.question!, answer: "It reduces risk" });
	value(await f.service.assist({ ...f.req, requestId: "inline", kind: "question", question: "Why A?" }));
	const artifact = {
		kind: "artifact" as const,
		sessionId: "chat",
		artifactId: "diagram",
		revision: 3,
		sha256: attentionDigest("visual"),
	};
	f.deps.generate = async () => ({ kind: "visual", explanation: "Trade-offs", artifact });
	f.deps.verifyArtifact = async (a) => {
		assert.deepEqual(a, artifact);
		return true;
	};
	value(await f.service.assist({ ...f.req, requestId: "visual", kind: "visual" }));
	f.deps.verifyArtifact = async () => false;
	error(await f.service.lookupAssistance({ ...f.req, requestId: "visual", kind: "visual" }), "unavailable");
	assert.equal(f.store.attention.humanAction("upload"), undefined);
	assert.equal(f.state.source, "Choose A or B");
	assert.equal(f.state.eventId, 1);
	error(
		await f.service.lookupAssistance({
			...f.req,
			scope: { ...f.req.scope, subject: { kind: "question", sessionId: "other", entryId: 12 } },
		}),
		"conflict",
	);
});

test("help rechecks exact source, event and authority after asynchronous generation", async (t) => {
	for (const change of ["text", "event", "authority"] as const) {
		const f = fixture();
		t.after(() => f.store.close());
		const generated = deferred<AssistanceOutput>();
		const entered = deferred<void>();
		f.deps.generate = async () => {
			entered.resolve();
			return generated.promise;
		};
		const pending = f.service.assist(f.req);
		await entered.promise;
		if (change === "text") f.state.source = "Different choice";
		if (change === "event") f.state.eventId++;
		if (change === "authority") f.state.authority = attentionDigest("new authority");
		generated.resolve({ kind: "simpler", text: "Old answer" });
		error(await pending, "stale");
		assert.equal(f.store.attention.assistance("help")?.output, undefined);
	}
});

test("invalid help cannot smuggle approval or change inline questions", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	f.deps.generate = async () => ({ kind: "simpler", text: "yes", approve: true }) as AssistanceOutput;
	error(await f.service.assist(f.req), "invalid");
	f.deps.generate = async () => ({ kind: "question", question: "different", answer: "yes" });
	error(await f.service.assist({ ...f.req, requestId: "q", kind: "question", question: "why?" }), "invalid");
	error(await f.service.assist({ ...f.req, requestId: "invalid", approve: true } as AssistanceRequest), "invalid");
	assert.equal(f.store.attention.assistance("invalid"), undefined);
});

test("visual reads recheck scope and never substitute latest artifacts", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	f.deps.generate = async () => ({
		kind: "visual",
		explanation: "diagram",
		artifact: { kind: "artifact", sessionId: "chat", artifactId: "a", revision: 1, sha256: digest },
	});
	f.deps.verifyArtifact = async () => {
		f.state.eventId++;
		return true;
	};
	error(await f.service.assist({ ...f.req, kind: "visual" }), "stale");
});

test("entered assistance is lookup-only across restart, never regenerated", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "attention-help-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite");
	const f = fixture(new MissionStore(file));
	f.store.attention.enter(f.req);
	await f.store.durable();
	f.store.close();
	const second = fixture(new MissionStore(file));
	t.after(() => second.store.close());
	error(await second.service.lookupAssistance(f.req), "unknown");
	error(await second.service.assist(f.req), "conflict");
	assert.equal(second.state.calls, 0);
});

test("failed pre-generation durability ACK never invokes the producer", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const durable = f.store.attention.durable.bind(f.store.attention);
	f.store.attention.durable = async () => {
		throw new Error("disk ACK unavailable");
	};
	error(await f.service.assist(f.req), "unknown");
	assert.equal(f.state.calls, 0);
	f.store.attention.durable = durable;
	error(await f.service.lookupAssistance(f.req), "unknown");
	assert.equal(f.state.calls, 0);
});

test("mission adapter distinguishes binding guidance and exact pending proposals", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const mission = store.create({ projectId: "project", title: "Work" });
	const decision = store.addDecision(mission.id, "Do not publish");
	const read = assistanceSource(store, () => digest);
	const binding = { kind: "binding_decision" as const, missionId: mission.id, id: decision.id };
	const before = read(binding);
	assert.match(before.source, /Do not publish/);
	store.updateDecision(mission.id, decision.id, "Do not publish yet");
	assert.notEqual(read(binding).scope.contentDigest, before.scope.contentDigest);
	store.updateDecision(mission.id, decision.id, "Do not publish");
	assert.notEqual(read(binding).scope.eventId, before.scope.eventId, "edit/revert is fenced");
	assert.throws(() => read({ kind: "proposal", missionId: mission.id, id: decision.id }), AttentionError);
	const other = store.create({ projectId: "other", title: "Other" });
	assert.throws(() => read({ ...binding, missionId: other.id }), AttentionError);
	assert.throws(() => read({ kind: "question", sessionId: "chat", entryId: 12 }), AttentionError);
	assert.equal(store.detail(mission.id).decisions[0]?.text, "Do not publish");
	assert.equal(store.workflowConfirmations.latest(mission.id, false), undefined);
	store.join("lead", mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	const proposal = store.proposeDecision(mission.id, decision.id, "Publish now", undefined, "Changed needs", {
		sessionId: "lead",
	});
	const choice = { kind: "proposal" as const, missionId: mission.id, id: proposal.id };
	assert.match(read(choice).source, /Publish now/);
	const f = fixture(store);
	f.deps.subject = read;
	const scope = value(f.service.prepare(choice));
	value(await f.service.assist({ requestId: "proposal-help", kind: "simpler", scope }));
	assert.equal(store.proposals(mission.id)[0]?.status, "pending");
	assert.equal(store.detail(mission.id).decisions[0]?.text, "Do not publish");
	store.resolveProposal(mission.id, proposal.id, false);
	error(await f.service.lookupAssistance({ requestId: "proposal-help", kind: "simpler", scope }), "stale");
});

test("human actions save deferral/progress and restart without resolving asks or publishing", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "attention-actions-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite");
	const f = fixture(new MissionStore(file));
	const first = value(await f.service.mutate(create));
	const later = value(
		await f.service.mutate({
			kind: "defer",
			operationId: "later",
			expected: ref(first),
			progress: "Signed in. Upload tomorrow.",
		}),
	);
	assert.equal(later.state, "deferred");
	assert.equal(later.completion, null);
	f.store.close();
	const next = fixture(new MissionStore(file));
	t.after(() => next.store.close());
	assert.deepEqual(value(await next.service.read(ref(later))), later);
	const resumed = value(
		await next.service.mutate({
			kind: "resume",
			operationId: "resume",
			expected: ref(later),
			progress: later.progress,
		}),
	);
	assert.equal(resumed.state, "pending");
	assert.equal(resumed.progress, later.progress);
	error(await next.service.completion(ref(resumed), "missing"), "unknown");
	assert.equal(next.state.calls, 0);
});

test("completion requires native user authority and explicit report, not link opening or agent prose", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const first = value(await f.service.mutate(create));
	const cmd: HumanActionCommand = {
		kind: "complete",
		operationId: "done",
		expected: ref(first),
		report: "Submitted package 1.2.3. Review pending.",
	};
	f.state.actor = "agent";
	error(await f.service.mutate(cmd), "forbidden");
	f.state.actor = "user";
	const progress = value(
		await f.service.mutate({
			kind: "progress",
			operationId: "opened",
			expected: ref(first),
			progress: "Opened the store link. Agent says published.",
		}),
	);
	assert.equal(progress.completion, null);
	assert.equal(progress.state, "pending");
	error(await f.service.mutate(cmd), "stale");
	const exact = { ...cmd, expected: ref(progress) };
	const done = value(await f.service.mutate(exact));
	assert.equal(done.completion?.source, "user_report");
	assert.equal(value(await f.service.completion(ref(progress), "done")).source, "user_report");
	error(await f.service.mutate(exact), "conflict");
	assert.equal(value(await f.service.lookupOperation(exact)).current, true);
	error(await f.service.mutate({ ...exact, operationId: "done-again" }), "stale");
	error(await f.service.lookupOperation({ ...exact, report: "changed" }), "conflict");
});

test("replacement, stale files and exact revision fence old completion", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const first = value(await f.service.mutate(create));
	const replaced = value(
		await f.service.mutate({
			kind: "replace",
			operationId: "replace",
			expected: ref(first),
			content: { ...action, action: "Upload corrected package" },
		}),
	);
	error(
		await f.service.mutate({ kind: "complete", operationId: "old", expected: ref(first), report: "Done" }),
		"stale",
	);
	f.state.valid = false;
	error(
		await f.service.mutate({ kind: "complete", operationId: "new", expected: ref(replaced), report: "Done" }),
		"stale",
	);
	assert.equal(f.store.attention.operation("new"), undefined);
	assert.equal(value(await f.service.lookupOperation(create)).current, false);
	error(
		await f.service.mutate({
			kind: "replace",
			operationId: "move",
			expected: ref(replaced),
			content: { ...action, sessionId: "other" },
		}),
		"invalid",
	);
});

test("asynchronous verification fences concurrent replacement and authority changes", async (t) => {
	for (const change of ["revision", "authority"] as const) {
		const f = fixture();
		t.after(() => f.store.close());
		const first = value(await f.service.mutate(create));
		const waiting = deferred<boolean>();
		const entered = deferred<void>();
		f.deps.verifyAction = async () => {
			entered.resolve();
			return waiting.promise;
		};
		const pending = f.service.mutate({
			kind: "complete",
			operationId: "complete",
			expected: ref(first),
			report: "Done",
		});
		await entered.promise;
		if (change === "revision")
			value(
				await f.service.mutate({ kind: "defer", operationId: "later", expected: ref(first), progress: "later" }),
			);
		else f.state.authority = attentionDigest("new membership");
		waiting.resolve(true);
		error(await pending, "stale");
		assert.equal(f.store.attention.operation("complete"), undefined);
	}
});

test("lost completion ACK is Unknown; exact durable lookup survives restart without repeating work", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "attention-lost-ack-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite");
	const f = fixture(new MissionStore(file));
	const first = value(await f.service.mutate(create));
	const original = f.store.attention.durable.bind(f.store.attention);
	f.store.attention.durable = async () => {
		await original();
		throw new Error("ACK lost");
	};
	const cmd: HumanActionCommand = {
		kind: "complete",
		operationId: "done",
		expected: ref(first),
		report: "Submitted, not yet published",
	};
	error(await f.service.mutate(cmd), "unknown");
	f.store.close();
	const next = fixture(new MissionStore(file));
	t.after(() => next.store.close());
	assert.equal(value(await next.service.lookupOperation(cmd)).record.completion?.report, cmd.report);
	assert.equal(value(await next.service.completion(ref(first), cmd.operationId)).source, "user_report");
	error(await next.service.mutate(cmd), "conflict");
	next.state.valid = false;
	error(await next.service.completion(ref(first), cmd.operationId), "stale");
});

test("durability barriers cannot acknowledge a newer unflushed human-action row", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const first = value(await f.service.mutate(create));
	const barrier = deferred<void>();
	const entered = deferred<void>();
	const durable = f.store.attention.durable.bind(f.store.attention);
	f.store.attention.durable = async () => {
		entered.resolve();
		await barrier.promise;
	};
	const reading = f.service.read(ref(first));
	await entered.promise;
	f.store.attention.durable = durable;
	value(await f.service.mutate({ kind: "defer", operationId: "later", expected: ref(first), progress: "later" }));
	barrier.resolve();
	error(await reading, "stale");
});

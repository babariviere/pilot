import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { deliveryDigest } from "./mission-delivery-evidence.ts";
import { parseRetainedReviewReport, prepareRetainedReviewInput } from "./retained-review-contract.ts";
import {
	compareRetainedReviewClaims as compare,
	compareRetainedReviewTargetInput as compareInput,
	retainedReviewLinkageDigest as digest,
	RETAINED_REVIEW_LINKAGE_LIMITS as LIMITS,
	parseRetainedReviewRunBindingClaim as parseBinding,
	parseRetainedReviewCallClaim as parseCall,
	parseRetainedReviewCompletionClaim as parseCompletion,
	parseRetainedReviewProducerClaim as parseProducer,
	parseRetainedReviewTargetClaim as parseTarget,
	parseRetainedReviewUsageClaim as parseUsage,
	retainedReviewDispatchStatus,
} from "./retained-review-linkage-contract.ts";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const clone = <T>(v: T): T => structuredClone(v);
function fixture() {
	const bytes = Buffer.from("\uFEFFé😀 original requirements\n");
	const entries = [
		{
			blobId: "blob",
			sha256: sha(bytes),
			bytes: bytes.length,
			label: "Brief",
			sourceId: "source",
			category: "source",
		},
	];
	const d = {
		version: 1,
		hostId: "host",
		daemonLineageId: "daemon-lineage",
		projectId: "project",
		missionId: "mission",
		taskId: "task",
		runId: "run",
		ownerSessionId: "owner",
		coordinatorSessionId: "coordinator",
		policyId: "policy",
		submissionId: "submission",
		allocationId: "allocation",
		definitionRevision: 4,
		assignment: {
			version: 1,
			revision: 2,
			intent: "Review retained requirements",
			scope: "One brief",
			criteria: ["Accuracy"],
			classification: {
				version: 1,
				effort: "small",
				difficulty: "routine",
				risk: "low",
				uncertainty: "known",
				scope: "bounded",
				role: "explorer",
				deliveryKind: "research",
			},
		},
		contextFence: {
			briefRevision: 3,
			decisionEventId: 4,
			artifactEventId: 5,
			memberEventId: 6,
			coordinatorEventId: 7,
		},
		contextPackageSha256: sha("context"),
		profile: {
			profileId: "profile",
			revision: 1,
			definition: {
				version: 1,
				purpose: "Compare",
				rubric: "Requirements",
				applicableIntents: ["research"],
				modelSelection: { provider: "fixture", model: "never-called" },
				reasoningEffort: null,
				timeLimitMs: 1000,
				outputInterpretation: { kind: "pass-fail", pass: "No issues", fail: "Issues" },
			},
		},
		runtime: {
			buildSha256: sha("build"),
			configSha256: sha("runtime-config"),
			provider: "fixture",
			model: "never-called",
			promptVersion: "v1",
			toolSchemaVersion: "v1",
			outputSchemaVersion: 1,
		},
		manifest: {
			schemaVersion: 1,
			kind: "evidence",
			id: "manifest",
			hostId: "host",
			projectId: "project",
			sourceIds: ["source"],
			createdAt: 10,
			sealed: true,
			sha256: deliveryDigest({ entries, omissions: [] }),
			entries,
			omissions: [],
			complete: true,
		},
		content: [
			{
				reference: { kind: "brief", revision: 3 },
				part: "brief",
				artifactKind: null,
				referenceSha256: sha("reference metadata"),
				sourceOwnerSessionId: null,
				blobId: "blob",
				originalSha256: sha(bytes),
				originalBytes: bytes.length,
			},
		],
	};
	const input = prepareRetainedReviewInput(d, [{ blobId: "blob", bytes }]);
	const target = {
		version: 1,
		kind: "retained-non-code",
		targetId: "target",
		hostId: d.hostId,
		daemonLineageId: d.daemonLineageId,
		projectId: d.projectId,
		missionId: d.missionId,
		taskId: d.taskId,
		ownerSessionId: d.ownerSessionId,
		coordinatorSessionId: d.coordinatorSessionId,
		policyId: d.policyId,
		submissionId: d.submissionId,
		allocationId: d.allocationId,
		definitionRevision: d.definitionRevision,
		assignment: d.assignment,
		contextFence: d.contextFence,
		inputSha256: input.inputSha256,
		profileSha256: input.profileSha256,
		contextSha256: input.contextSha256,
		runtimeSha256: input.runtimeSha256,
		manifestId: d.manifest.id,
		manifestSha256: d.manifest.sha256,
		profileId: d.profile.profileId,
		profileRevision: d.profile.revision,
		contextPackageSha256: d.contextPackageSha256,
	};
	const binding = {
		version: 1,
		kind: "retained-run-binding",
		runId: d.runId,
		targetId: target.targetId,
		targetSha256: digest("target", target),
		admissionId: "admission-claim",
		lineageId: "reviewer-lineage-claim",
		evidenceId: "manifest",
		contextId: "context-claim",
		configObservationId: "config-claim",
		channelGeneration: "channel-claim",
		inputSha256: input.inputSha256,
		profileSha256: input.profileSha256,
		contextSha256: input.contextSha256,
		runtimeSha256: input.runtimeSha256,
		provider: d.runtime.provider,
		model: d.runtime.model,
		account: {
			kind: "claimed",
			bindingId: "account-claim",
			billing: "subscription",
			configSha256: deliveryDigest([
				"retained-review-linkage",
				1,
				"account-config",
				{ effectiveAccount: "fixture-account", billing: "subscription" },
			]),
		},
		authorLineage: { kind: "unknown" },
	};
	const call = {
		version: 1,
		kind: "retained-call",
		observationId: "call-observation",
		runId: "run",
		callId: "call",
		bindingSha256: digest("binding", binding),
		stop: { kind: "observed", source: "provider", exactReason: "length\n \u0000é" },
	};
	const usage = {
		version: 1,
		kind: "retained-usage",
		observationId: "usage-observation",
		runId: "run",
		callId: "call",
		bindingSha256: call.bindingSha256,
		receiptSource: "provider-receipt",
		receiptIdentity: "receipt",
		rateSha256: sha("rate"),
		billing: "subscription",
		input: 10,
		generated: 5,
		durationMs: 100,
	};
	const completion = {
		version: 1,
		kind: "retained-completion",
		completionId: "completion",
		runId: "run",
		bindingSha256: call.bindingSha256,
		terminalCallId: "call" as string | null,
		hostTermination: { kind: "observed", source: "host", exactReason: "cancelled\r\n \u0000" },
		raw: { kind: "bytes", sha256: sha(""), bytesRef: "raw-claim", length: 0 },
		usageAtCompletion: { kind: "unknown" },
	};
	const producer = {
		version: 1,
		kind: "host-retained-run",
		runId: "run",
		admissionId: binding.admissionId,
		completionId: completion.completionId,
		bindingSha256: call.bindingSha256,
		completionSha256: digest("completion", completion),
		rawSha256: completion.raw.sha256 as string | null,
	};
	return { d, input, target, binding, call, usage, completion, producer };
}
type Fixture = ReturnType<typeof fixture>;
type Kind = Parameters<typeof digest>[0];
const kinds: Kind[] = ["target", "binding", "call", "usage", "completion", "producer"];
function parseAll(f: Fixture) {
	return {
		target: parseTarget(f.target),
		binding: parseBinding(f.target, f.binding),
		call: parseCall(f.binding, f.call),
		usage: parseUsage(f.binding, f.call, f.usage),
		completion: parseCompletion(f.binding, [f.call], [], f.completion),
		producer: parseProducer(f.binding, f.completion, f.producer),
	};
}

test("six detached claims, canonical/version/domain bindings, disabled dispatch", () => {
	const f = fixture(),
		parsed = parseAll(f);
	assert.equal(compareInput(f.target, f.binding, f.input), true);
	assert.equal(compareInput(clone(f.target), clone(f.binding), clone(f.input)), true); // NOT D38 WeakMap membership.
	for (const k of kinds) {
		assert.deepEqual(parsed[k], f[k]);
		assert.equal(Object.isFrozen(parsed[k]), true);
		assert.equal(compare(k, f[k], clone(f[k])), "replay");
		assert.equal(digest(k, f[k]), deliveryDigest(["retained-review-linkage", 1, k, f[k]]));
		assert.notEqual(digest(k, f[k]), deliveryDigest(["retained-review-linkage", 2, k, f[k]]));
		assert.notEqual(digest(k, f[k]), deliveryDigest(["retained-review", 1, k, f[k]]));
		const reverse = Object.fromEntries(Object.entries(f[k]).reverse());
		assert.equal(compare(k, f[k], reverse), "replay");
	}
	assert.deepEqual(retainedReviewDispatchStatus(), { enabled: false, reason: "retained-dispatch-disabled" });
	assert.equal(Object.isFrozen(retainedReviewDispatchStatus()), true);
	assert.throws(() => Object.assign(retainedReviewDispatchStatus(), { enabled: true }));
	assert.notEqual(f.binding.account.configSha256, f.d.runtime.configSha256);
});

test("target rechecks are distinct; target identity reuse conflicts, not a budget key", () => {
	const f = fixture();
	assert.equal(compare("target", f.target, { ...f.target, targetId: "fresh-target" }), "distinct");
	assert.equal(compare("target", f.target, { ...f.target, inputSha256: sha("recheck") }), "conflict");
	assert.equal(
		compare("target", f.target, { ...f.target, targetId: "fresh-target", inputSha256: sha("recheck") }),
		"distinct",
	);
	assert.throws(() => parseBinding({ ...f.target, targetId: "fresh-target" }, f.binding));
	assert.throws(() => parseBinding(f.target, { ...f.binding, targetId: "fresh-target" }));
});

test("every target identity/digest/assignment/definition/fence pin affects exact input comparison", () => {
	const f = fixture();
	const paths = [
		"hostId",
		"daemonLineageId",
		"projectId",
		"missionId",
		"taskId",
		"ownerSessionId",
		"coordinatorSessionId",
		"policyId",
		"submissionId",
		"allocationId",
		"definitionRevision",
		"assignment.revision",
		"assignment.intent",
		"assignment.scope",
		"assignment.criteria.0",
		"assignment.classification.uncertainty",
		...Object.keys(f.target.contextFence).map((k) => `contextFence.${k}`),
		"inputSha256",
		"manifestId",
		"manifestSha256",
		"profileId",
		"profileRevision",
		"profileSha256",
		"contextSha256",
		"runtimeSha256",
		"contextPackageSha256",
	];
	for (const path of paths) {
		const t = clone(f.target);
		mutate(t, path);
		const b = { ...f.binding, targetSha256: digest("target", t) };
		assert.equal(compareInput(t, b, f.input), false, path);
		assert.notEqual(digest("target", t), digest("target", f.target), path);
		assert.equal(compare("target", f.target, t), "conflict", path);
	}
});
function mutate(value: unknown, path: string) {
	const keys = path.split(".");
	let p = value as Record<string, any>;
	for (const k of keys.slice(0, -1)) p = p[k];
	const k = keys.at(-1)!;
	p[k] =
		typeof p[k] === "number"
			? p[k] + 1
			: /Sha256$/.test(k)
				? sha(`different ${path}`)
				: p[k] === "known"
					? "unknown"
					: `${p[k]}2`;
}

test("descriptor tampering cannot hide behind unchanged public digest labels", () => {
	const f = fixture();
	for (const path of [
		"runId",
		"runtime.provider",
		"runtime.model",
		"runtime.buildSha256",
		"runtime.configSha256",
		"runtime.promptVersion",
		"runtime.toolSchemaVersion",
		"runtime.outputSchemaVersion",
		"profile.definition.rubric",
		"profile.revision",
		"profile.profileId",
		"contextFence.memberEventId",
		"contextFence.coordinatorEventId",
		"contextPackageSha256",
		"assignment.revision",
		"definitionRevision",
		"manifest.entries.0.sha256",
		"manifest.sha256",
		"content.0.referenceSha256",
		"content.0.originalSha256",
	]) {
		const input = clone(f.input);
		mutate(input.descriptor, path);
		assert.equal(compareInput(f.target, f.binding, input), false, path);
	}
	for (const key of [
		"runId",
		"provider",
		"model",
		"evidenceId",
		"targetId",
		"targetSha256",
		"inputSha256",
		"profileSha256",
		"contextSha256",
		"runtimeSha256",
	]) {
		const b = clone(f.binding);
		mutate(b, key);
		assert.equal(compareInput(f.target, b, f.input), false, key);
	}
	// Recompute ALL supplied structural digests and links after tampering. Still no byte validation:
	const input = clone(f.input) as any;
	input.descriptor.content[0].originalSha256 = sha("unverified different bytes");
	input.inputSha256 = deliveryDigest(["retained-review", 1, "input", input.descriptor]);
	const t = { ...f.target, inputSha256: input.inputSha256 };
	const b = { ...f.binding, inputSha256: input.inputSha256, targetSha256: digest("target", t) };
	assert.equal(compareInput(t, b, input), true); // Structural consistency, never byte/seal proof.
});

test("contextual binding/call/usage/completion/producer mismatches reject every overlapping pin", () => {
	const f = fixture();
	for (const key of [
		"targetId",
		"targetSha256",
		"evidenceId",
		"inputSha256",
		"profileSha256",
		"contextSha256",
		"runtimeSha256",
	]) {
		const b = clone(f.binding);
		mutate(b, key);
		assert.throws(() => parseBinding(f.target, b), key);
	}
	for (const key of ["runId", "bindingSha256"]) {
		for (const k of ["call", "usage", "completion", "producer"] as const) {
			const bad = clone(f[k]);
			mutate(bad, key);
			assert.throws(
				() =>
					({
						call: () => parseCall(f.binding, bad),
						usage: () => parseUsage(f.binding, f.call, bad),
						completion: () => parseCompletion(f.binding, [f.call], [], bad),
						producer: () => parseProducer(f.binding, f.completion, bad),
					})[k](),
				`${k}.${key}`,
			);
		}
	}
	for (const key of ["callId", "billing"] as const) {
		const u = clone(f.usage);
		u[key] = key === "billing" ? "api" : "foreign-call";
		assert.throws(() => parseUsage(f.binding, f.call, u));
	}
	for (const key of ["admissionId", "completionId", "completionSha256", "rawSha256"]) {
		const p = clone(f.producer);
		mutate(p, key);
		assert.throws(() => parseProducer(f.binding, f.completion, p), key);
	}
	assert.throws(() => parseProducer(f.binding, { ...f.completion, runId: "foreign" }, f.producer));
	assert.throws(() => parseUsage(f.binding, { ...f.call, runId: "foreign" }, f.usage));
	assert.throws(() => parseCompletion(f.binding, [f.call], [], { ...f.completion, terminalCallId: "foreign" }));
});

test("all changed fields conflict under reused snapshot identity; new identities are explicit", () => {
	const f = fixture();
	for (const k of kinds) {
		for (const key of Object.keys(f[k]).filter(
			(key) =>
				![
					"version",
					"kind",
					"targetId",
					"runId",
					"observationId",
					"completionId",
					"assignment",
					"contextFence",
					"account",
					"authorLineage",
					"stop",
					"hostTermination",
					"raw",
					"usageAtCompletion",
					"billing",
					"terminalCallId",
				].includes(key),
		)) {
			const changed = clone(f[k]);
			mutate(changed, key);
			assert.notEqual(digest(k, changed), digest(k, f[k]), `${k}.${key}`);
			assert.equal(compare(k, f[k], changed), "conflict", `${k}.${key}`);
		}
	}
	assert.equal(compare("binding", f.binding, { ...f.binding, runId: "other" }), "distinct");
	assert.equal(compare("completion", f.completion, { ...f.completion, completionId: "other" }), "conflict");
	assert.equal(compare("completion", f.completion, { ...f.completion, runId: "other" }), "conflict");
	assert.equal(
		compare("completion", f.completion, { ...f.completion, completionId: "other", runId: "other" }),
		"distinct",
	);
	assert.equal(compare("producer", f.producer, { ...f.producer, runId: "other" }), "conflict");
	assert.equal(compare("producer", f.producer, { ...f.producer, runId: "other", completionId: "other" }), "distinct");
});

test("distinct call observations preserve multiple reasons and unknown then observed", () => {
	const f = fixture();
	const transport = {
		...f.call,
		observationId: "transport-observation",
		stop: { kind: "observed", source: "transport", exactReason: "socket closed\n" },
	};
	const unknown = { ...f.call, observationId: "unknown-observation", stop: { kind: "unknown" } };
	assert.equal(compare("call", f.call, transport), "distinct");
	assert.equal(compare("call", f.call, unknown), "distinct");
	assert.equal(compare("call", f.call, { ...transport, observationId: f.call.observationId }), "conflict");
	for (const key of ["runId", "bindingSha256"]) {
		const c = clone(transport);
		mutate(c, key);
		assert.equal(compare("call", f.call, c), "conflict", key);
	}
	assert.equal(compare("call", f.call, { ...transport, callId: "other-call" }), "distinct");
	assert.deepEqual(parseCompletion(f.binding, [unknown, f.call, transport], [], f.completion), f.completion);
	assert.throws(() => parseCompletion(f.binding, [f.call, clone(f.call)], [], f.completion));
});

test("usage identity aliases conflict; only exact same bound usage with independent IDs corroborates", () => {
	const f = fixture();
	const u = { ...f.usage, observationId: "another-observation", receiptIdentity: "another-receipt" };
	assert.equal(compare("usage", f.usage, u), "corroboration");
	assert.equal(compare("usage", f.usage, { ...u, receiptIdentity: f.usage.receiptIdentity }), "conflict");
	assert.equal(compare("usage", f.usage, { ...u, observationId: f.usage.observationId }), "conflict");
	for (const key of ["runId", "bindingSha256", "rateSha256", "input", "generated", "durationMs"]) {
		const bad = clone(u);
		mutate(bad, key);
		assert.equal(compare("usage", f.usage, bad), "conflict", key);
		assert.throws(() => parseCompletion(f.binding, [f.call], [f.usage, bad], f.completion), key);
	}
	assert.equal(compare("usage", f.usage, { ...u, billing: "api" }), "conflict");
	assert.equal(compare("usage", f.usage, { ...u, callId: "other-call" }), "distinct");
	// Same receipt/observation alias on another call/run always conflicts, not distinct/corroboration.
	for (const alias of [
		{ ...u, receiptIdentity: f.usage.receiptIdentity },
		{ ...u, observationId: f.usage.observationId },
	]) {
		assert.equal(compare("usage", f.usage, { ...alias, runId: "other-run", callId: "other-call" }), "conflict");
	}
	assert.deepEqual(parseCompletion(f.binding, [f.call], [f.usage, u], f.completion), f.completion);
	assert.throws(() =>
		parseCompletion(f.binding, [f.call], [f.usage, { ...u, receiptIdentity: f.usage.receiptIdentity }], f.completion),
	);
	assert.throws(() => parseCompletion(f.binding, [f.call], [f.usage, clone(f.usage)], f.completion));
});

test("unknown at completion remains immutable with later call-bound usage; captured IDs resolve exactly", () => {
	const f = fixture();
	const c = parseCompletion(f.binding, [f.call], [], f.completion);
	const before = JSON.stringify(c),
		beforeHash = digest("completion", c);
	const later = parseUsage(f.binding, f.call, f.usage);
	assert.deepEqual(parseCompletion(f.binding, [f.call], [later], c), c);
	assert.equal(JSON.stringify(c), before);
	assert.equal(digest("completion", c), beforeHash);
	assert.deepEqual(c.usageAtCompletion, { kind: "unknown" });
	const captured = {
		...f.completion,
		usageAtCompletion: { kind: "observed", usageObservationIds: [f.usage.observationId] },
	};
	assert.deepEqual(parseCompletion(f.binding, [f.call], [later], captured), captured);
	assert.throws(() => parseCompletion(f.binding, [f.call], [], captured));
	assert.throws(() =>
		parseCompletion(f.binding, [f.call], [later], {
			...captured,
			usageAtCompletion: { kind: "observed", usageObservationIds: [] },
		}),
	);
	assert.throws(() =>
		parseCompletion(f.binding, [f.call], [later], {
			...captured,
			usageAtCompletion: { kind: "observed", usageObservationIds: [later.observationId, later.observationId] },
		}),
	);
	assert.equal(compare("completion", c, captured), "conflict");
	assert.throws(() => parseCompletion(f.binding, [], [later], { ...f.completion, terminalCallId: null }));
});

test("raw and exact stop fidelity, null terminal call and host/model state stay independent", () => {
	const f = fixture();
	const variants = [
		f.completion.raw,
		{ kind: "no-output", reason: "No bytes observed\r\n \u0000" },
		{ kind: "unknown" },
	];
	for (const raw of variants) {
		const value = { ...f.completion, terminalCallId: null, raw };
		const c = parseCompletion(f.binding, [], [], value);
		assert.deepEqual(c, value);
		const p = {
			...f.producer,
			completionSha256: digest("completion", c),
			rawSha256: raw.kind === "bytes" ? f.completion.raw.sha256 : null,
		};
		assert.deepEqual(parseProducer(f.binding, c, p), p);
		assert.throws(() => parseProducer(f.binding, c, { ...p, rawSha256: p.rawSha256 === null ? sha("") : null }));
	}
	for (const reason of [
		"length",
		"timed-out",
		"cancelled",
		"unavailable",
		"new-unknown-reason",
		" ",
		"\uFEFFé😀\r\n\u0000",
	]) {
		const value = {
			...f.completion,
			hostTermination: { kind: "observed", source: "provider-claim", exactReason: reason },
		};
		assert.deepEqual(parseCompletion(f.binding, [f.call], [], value), value);
	}
	assert.deepEqual(
		parseCompletion(f.binding, [f.call], [], { ...f.completion, hostTermination: { kind: "unknown" } })
			.hostTermination,
		{ kind: "unknown" },
	);
	const modelReport = {
		version: 1,
		runId: "run",
		inputSha256: f.input.inputSha256,
		profileSha256: f.input.profileSha256,
		contextSha256: f.input.contextSha256,
		runtimeSha256: f.input.runtimeSha256,
		state: "completed",
		reportedOutcome: "pass",
		reason: "Model claim",
		findings: [],
		coverage: [],
		omissions: [],
		limitations: ["No independent execution"],
	};
	assert.equal(parseRetainedReviewReport(f.input, JSON.stringify(modelReport)).state, "completed");
	assert.equal(parseCompletion(f.binding, [f.call], [], f.completion).hostTermination.kind, "observed");
	assert.equal(f.completion.hostTermination.exactReason, "cancelled\r\n \u0000");
	assert.throws(() => digest("completion", { ...f.completion, modelState: "completed" }));
});

test("claimed author/account variants retain unknowns, billing consistency and ordered lineage", () => {
	const f = fixture();
	const b = {
		...f.binding,
		account: { kind: "unknown" },
		authorLineage: { kind: "claimed", lineageIds: ["author-a", "author-b"], basis: "Supplied provenance claim only" },
	};
	assert.deepEqual(parseBinding(f.target, b), b);
	assert.notEqual(
		digest("binding", b),
		digest("binding", {
			...b,
			authorLineage: { ...b.authorLineage, lineageIds: [...b.authorLineage.lineageIds].reverse() },
		}),
	);
	const c = { ...f.call, bindingSha256: digest("binding", b) };
	for (const billing of ["api", "subscription"])
		assert.doesNotThrow(() => parseUsage(b, c, { ...f.usage, billing, bindingSha256: c.bindingSha256 }));
	const api = { ...f.binding, account: { ...f.binding.account, billing: "api" } };
	const apiCall = { ...f.call, bindingSha256: digest("binding", api) };
	assert.doesNotThrow(() =>
		parseUsage(api, apiCall, { ...f.usage, billing: "api", bindingSha256: apiCall.bindingSha256 }),
	);
	assert.throws(() =>
		digest("binding", { ...b, authorLineage: { ...b.authorLineage, lineageIds: ["author-a", "author-a"] } }),
	);
});

test("all schemas refuse unknown kinds/versions/extra fields/missing fields and invalid scalar IDs", () => {
	const f = fixture();
	for (const k of kinds) {
		for (const v of [2, "1", null]) assert.throws(() => digest(k, { ...f[k], version: v }), `${k} version`);
		for (const v of ["session", "pull_request", "unknown", null])
			assert.throws(() => digest(k, { ...f[k], kind: v }), `${k} kind`);
		for (const name of ["eligible", "human", "independent", "sessionId", "authority"])
			assert.throws(() => digest(k, { ...f[k], [name]: true }));
		for (const name of Object.keys(f[k])) {
			const missing = { ...f[k] } as Record<string, unknown>;
			delete missing[name];
			assert.throws(() => digest(k, missing), `${k}.${name} missing`);
		}
		for (const name of Object.keys(f[k]).filter((key) => key.endsWith("Id") || key.endsWith("Sha256"))) {
			for (const invalid of [
				"",
				"a/b",
				"x".repeat(129),
				1,
				...(["terminalCallId", "rawSha256"].includes(name) ? [] : [null]),
			])
				assert.throws(() => digest(k, { ...f[k], [name]: invalid }), `${k}.${name}`);
		}
	}
	assert.throws(() => digest("unexpected" as Kind, f.target));
	assert.throws(() => compare("unexpected" as Kind, f.target, f.target));
	for (const path of ["account", "authorLineage"])
		assert.throws(() => digest("binding", { ...f.binding, [path]: { kind: "trusted" } }));
	for (const path of ["raw", "usageAtCompletion", "hostTermination"])
		assert.throws(() => digest("completion", { ...f.completion, [path]: { kind: "trusted" } }));
	assert.throws(() => digest("call", { ...f.call, stop: { kind: "trusted" } }));
	for (const [kind, path] of [
		["binding", "account"],
		["binding", "authorLineage"],
		["call", "stop"],
		["completion", "raw"],
		["completion", "hostTermination"],
		["completion", "usageAtCompletion"],
	] as const) {
		assert.throws(() => digest(kind, { ...f[kind], [path]: { ...(f[kind] as any)[path], extra: true } }));
	}
});

test("strict snapshots reject hostile JSON before normalization; accessors/toJSON never invoked", () => {
	const f = fixture();
	let invoked = 0;
	const getter = { ...f.target };
	Object.defineProperty(getter, "targetId", {
		enumerable: true,
		get() {
			invoked++;
			return "target";
		},
	});
	const toJSON = {
		...f.target,
		toJSON() {
			invoked++;
			return f.target;
		},
	};
	const cycle: any = clone(f.target);
	cycle.assignment = cycle;
	const hidden = { ...f.target };
	Object.defineProperty(hidden, "hidden", { value: 1 });
	const symbol = { ...f.target, [Symbol("claim")]: true };
	const exotic = Object.assign(Object.create({}), f.target);
	for (const bad of [
		getter,
		toJSON,
		cycle,
		hidden,
		symbol,
		exotic,
		new Date(),
		new Map(),
		new Uint8Array(),
		{ ...f.target, extra: undefined },
		{ ...f.target, extra: Infinity },
		{ ...f.target, extra: 1n },
	]) {
		assert.throws(() => parseTarget(bad));
		assert.throws(() => digest("target", bad));
		assert.throws(() => compare("target", f.target, bad));
		assert.throws(() => parseBinding(bad, f.binding));
		assert.throws(() => compareInput(bad, f.binding, f.input));
	}
	assert.equal(invoked, 0);
	const badKind = {
		toString() {
			invoked++;
			return "target";
		},
	} as unknown as Kind;
	assert.throws(() => digest(badKind, f.target));
	assert.throws(() => compare(badKind, f.target, f.target));
	assert.equal(invoked, 0);
	const array = clone(f.target);
	delete array.assignment.criteria[0];
	assert.throws(() => parseTarget(array));
	Object.assign(array.assignment.criteria, { trust: true });
	assert.throws(() => parseTarget(array));
	const nullPrototype = Object.assign(Object.create(null), f.target);
	assert.deepEqual(parseTarget(nullPrototype), parseTarget(f.target));
});

test("sparse and non-index decimal array keys cannot disappear through map or hash", () => {
	for (const key of ["4294967295", "4294967296", "9007199254740993", "01", "-1", "1.0"]) {
		const f = fixture();
		for (const accessor of [false, true]) {
			const t = clone(f.target),
				values = t.assignment.criteria;
			values.length = 2;
			let invoked = false;
			Object.defineProperty(
				values,
				key,
				accessor
					? {
							enumerable: true,
							get() {
								invoked = true;
								return "discarded";
							},
						}
					: { enumerable: true, value: "discarded" },
			);
			assert.equal(Reflect.ownKeys(values).length, values.length + 1);
			assert.throws(() => parseTarget(t), key);
			assert.throws(() => digest("target", t), key);
			assert.throws(() => compare("target", f.target, t), key);
			assert.equal(invoked, false);
			// Use a map-based lineage list too, so downstream assignment validation cannot
			// accidentally conceal a broken dense-array preflight.
			const b = { ...f.binding, authorLineage: { kind: "claimed", lineageIds: values, basis: "Claim" } };
			assert.throws(() => digest("binding", b), key);
			assert.equal(invoked, false);
		}
	}
});

test("every public parent is strictly reparsed, not a trusted TypeScript cast", () => {
	const f = fixture();
	let invoked = 0;
	const b = { ...f.binding };
	Object.defineProperty(b, "runId", {
		enumerable: true,
		get() {
			invoked++;
			return "run";
		},
	});
	for (const invoke of [
		() => parseCall(b, f.call),
		() => parseUsage(b, f.call, f.usage),
		() => parseCompletion(b, [f.call], [], f.completion),
		() => parseProducer(b, f.completion, f.producer),
		() => compareInput(f.target, b, f.input),
	])
		assert.throws(invoke);
	const c = { ...f.call };
	Object.defineProperty(c, "callId", {
		enumerable: true,
		get() {
			invoked++;
			return "call";
		},
	});
	assert.throws(() => parseUsage(f.binding, c, f.usage));
	assert.throws(() => parseCompletion(f.binding, [c], [], f.completion));
	const completion = { ...f.completion };
	Object.defineProperty(completion, "raw", {
		enumerable: true,
		get() {
			invoked++;
			return f.completion.raw;
		},
	});
	assert.throws(() => parseProducer(f.binding, completion, f.producer));
	const input = clone(f.input);
	Object.defineProperty(input.descriptor, "runtime", {
		enumerable: true,
		get() {
			invoked++;
			return f.input.descriptor.runtime;
		},
	});
	assert.throws(() => compareInput(f.target, f.binding, input));
	assert.equal(invoked, 0);
	assert.throws(() => parseCall({ ...f.binding, extra: true }, f.call));
	assert.throws(() => parseProducer(f.binding, { ...f.completion, extra: true }, f.producer));
});

test("mutation after parse cannot rewrite snapshots or completion knowledge", () => {
	const f = fixture(),
		p = parseAll(f),
		bytes = Object.fromEntries(kinds.map((k) => [k, digest(k, p[k])]));
	f.target.assignment.criteria[0] = "rewritten";
	f.target.contextFence.memberEventId++;
	f.binding.account.configSha256 = sha("rewritten");
	f.call.stop.exactReason = "rewritten";
	f.usage.input++;
	f.completion.raw.length++;
	f.producer.rawSha256 = null;
	for (const k of kinds) assert.equal(digest(k, p[k]), bytes[k]);
	assert.throws(() => (p.target.assignment.criteria as any).push("extra"));
	assert.throws(() => Object.assign(p.target.contextFence, { memberEventId: 999 }));
	assert.throws(() => Object.assign(p.binding.account, { kind: "unknown" }));
	assert.throws(() => Object.assign(p.completion.raw, { kind: "unknown" }));
	assert.throws(() => Object.assign(p.completion.usageAtCompletion, { kind: "observed" }));
});

test("declared count/text/raw/integer ceilings preserve exact boundaries, reject overflow", () => {
	const f = fixture();
	for (const n of [0, LIMITS.rawBytes])
		assert.doesNotThrow(() => digest("completion", { ...f.completion, raw: { ...f.completion.raw, length: n } }));
	for (const n of [-1, 1.1, NaN, Infinity, LIMITS.rawBytes + 1])
		assert.throws(() => digest("completion", { ...f.completion, raw: { ...f.completion.raw, length: n } }));
	for (const key of ["input", "generated", "durationMs"]) {
		for (const n of [0, Number.MAX_SAFE_INTEGER])
			assert.doesNotThrow(() => digest("usage", { ...f.usage, [key]: n }));
		for (const n of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
			assert.throws(() => digest("usage", { ...f.usage, [key]: n }));
	}
	for (const [field, bound] of [
		["source", LIMITS.source],
		["exactReason", LIMITS.reason],
	] as const) {
		assert.doesNotThrow(() => digest("call", { ...f.call, stop: { ...f.call.stop, [field]: "é".repeat(bound) } }));
		for (const value of ["", "x".repeat(bound + 1)])
			assert.throws(() => digest("call", { ...f.call, stop: { ...f.call.stop, [field]: value } }));
	}
	const lineages = Array.from({ length: LIMITS.authorLineages }, (_, i) => `lineage-${i}`);
	assert.doesNotThrow(() =>
		digest("binding", { ...f.binding, authorLineage: { kind: "claimed", lineageIds: lineages, basis: "Claim" } }),
	);
	assert.throws(() =>
		digest("binding", {
			...f.binding,
			authorLineage: { kind: "claimed", lineageIds: [...lineages, "too-many"], basis: "Claim" },
		}),
	);
	const calls = Array.from({ length: LIMITS.calls }, (_, i) => ({
		...f.call,
		callId: `call-${i}`,
		observationId: `call-observation-${i}`,
		stop: { kind: "unknown" },
	}));
	const usage = calls.map((c, i) => ({
		...f.usage,
		callId: c.callId,
		observationId: `usage-${i}`,
		receiptIdentity: `receipt-${i}`,
	}));
	const c = {
		...f.completion,
		terminalCallId: calls[0]!.callId,
		usageAtCompletion: { kind: "observed", usageObservationIds: usage.map((u) => u.observationId) },
	};
	assert.doesNotThrow(() => parseCompletion(f.binding, calls, usage, c));
	assert.throws(() => parseCompletion(f.binding, [...calls, { ...f.call, observationId: "extra" }], usage, c));
	assert.throws(() => parseCompletion(f.binding, calls, [...usage, { ...f.usage, observationId: "extra" }], c));
	assert.throws(() =>
		digest("completion", {
			...c,
			usageAtCompletion: { kind: "observed", usageObservationIds: Array(129).fill("id") },
		}),
	);
	const tooManyKeys = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), 0]));
	assert.throws(() => digest("target", { ...f.target, extra: tooManyKeys }));
	const nested: any = {};
	let p = nested;
	for (let i = 0; i < 17; i++) {
		p.extra = {};
		p = p.extra;
	}
	assert.throws(() => digest("target", { ...f.target, extra: nested }));
	assert.throws(() => digest("target", { ...f.target, extra: "x".repeat(LIMITS.jsonBytes + 1) }));
	assert.throws(() => compareInput(f.target, f.binding, { ...f.input, extra: "😀".repeat(LIMITS.jsonBytes / 2) }));
});

test("aggregate JSON byte budget accepts exactly 64 KiB, refuses one more without clipping", () => {
	const f = fixture();
	const calls = Array.from({ length: LIMITS.calls }, (_, i) => ({
		...f.call,
		observationId: `observation-${i}`,
		stop: { kind: "observed", source: "s", exactReason: "x" },
	}));
	const aggregate = { bindingValue: f.binding, calls, observations: [], value: f.completion };
	let padding = LIMITS.jsonBytes - Buffer.byteLength(JSON.stringify(aggregate));
	assert.ok(padding > 0 && padding < LIMITS.calls * (LIMITS.reason - 1));
	for (const c of calls) {
		const n = Math.min(padding, LIMITS.reason - 1);
		c.stop.exactReason += "x".repeat(n);
		padding -= n;
	}
	assert.equal(padding, 0);
	assert.equal(Buffer.byteLength(JSON.stringify(aggregate)), LIMITS.jsonBytes);
	assert.deepEqual(parseCompletion(f.binding, calls, [], f.completion), f.completion);
	calls.find((c) => c.stop.exactReason.length < LIMITS.reason)!.stop.exactReason += "x";
	assert.equal(Buffer.byteLength(JSON.stringify(aggregate)), LIMITS.jsonBytes + 1);
	assert.throws(() => parseCompletion(f.binding, calls, [], f.completion));
});

test("inactive surface has no runtime imports/entry points or fabricated accounting targets", async () => {
	const root = new URL("./", import.meta.url);
	const source = await readFile(new URL("retained-review-linkage-contract.ts", root), "utf8");
	assert.doesNotMatch(
		source,
		/from ["'](?:.*(?:store|service|vault|runtime|sdk|accounting)|node:(?:fs|worker_threads|child_process))["']/,
	);
	assert.doesNotMatch(source, /\b(?:fetch|setInterval|setTimeout)\s*\(/);
	for (const src of [root, new URL("../../kernel/src/", root), new URL("../../protocol/src/", root)]) {
		for (const path of await readdir(src, { recursive: true })) {
			if (!path.endsWith(".ts") || path.endsWith(".test.ts") || path === "retained-review-linkage-contract.ts")
				continue;
			assert.doesNotMatch(
				await readFile(new URL(path, src), "utf8"),
				/(?:from\s*|import\s*\(|export\s*\*\s*from\s*)["'][^"']*retained-review-linkage-contract/,
				path,
			);
		}
	}
	assert.equal(retainedReviewDispatchStatus().enabled, false);
});

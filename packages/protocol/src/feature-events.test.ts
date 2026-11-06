import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURE_NAMES, type FeatureEvent, parseFeatureEvent } from "./feature-events.ts";

test("feature catalog accepts each closed stage", () => {
	for (const feature of FEATURE_NAMES) {
		assert.ok(
			parseFeatureEvent({
				catalogVersion: 1,
				feature,
				stage: "eligibility",
				availability: "available",
				reason: "none",
			}),
		);
		assert.ok(
			parseFeatureEvent({
				catalogVersion: 1,
				feature,
				stage: "eligibility",
				availability: "disconnected",
				reason: "disconnected",
			}),
		);
		assert.ok(parseFeatureEvent({ catalogVersion: 1, feature, stage: "exposure" }));
		assert.ok(parseFeatureEvent({ catalogVersion: 1, feature, stage: "attempt" }));
		assert.ok(
			parseFeatureEvent({ catalogVersion: 1, feature, stage: "outcome", outcome: "success", reason: "none" }),
		);
		assert.ok(
			parseFeatureEvent({ catalogVersion: 1, feature, stage: "outcome", outcome: "failure", reason: "transport" }),
		);
	}
});

test("feature catalog rejects content, identifiers and incoherent classifications", () => {
	const base = { catalogVersion: 1, feature: "diagnose_chat" };
	for (const event of [
		{ ...base, stage: "attempt", sessionId: "private-id" },
		{ ...base, stage: "outcome", outcome: "failure", reason: "raw failure text" },
		{ ...base, stage: "outcome", outcome: "success", reason: "transport" },
		{ ...base, stage: "eligibility", availability: "available", reason: "unsupported" },
		{ ...base, stage: "eligibility", availability: "permission_denied", reason: "permission_denied" },
		{ ...base, stage: "exposure", title: "conversation content" },
		{ ...base, stage: "repeat" },
		{ ...base, stage: "outcome", outcome: "unwanted", reason: "none" },
	])
		assert.equal(parseFeatureEvent(event), undefined);
});

test("outcomes accept only their matching reasons without changing the event", () => {
	const base = { catalogVersion: 1, feature: "diagnose_chat", stage: "outcome" } as const;
	const events: Extract<FeatureEvent, { stage: "outcome" }>[] = [
		{ ...base, outcome: "success", reason: "none" },
		{ ...base, outcome: "cancelled", reason: "user" },
		{ ...base, outcome: "failure", reason: "rejected" },
		{ ...base, outcome: "failure", reason: "transport" },
		{ ...base, outcome: "failure", reason: "unknown" },
		{ ...base, outcome: "unavailable", reason: "not_configured" },
		{ ...base, outcome: "unavailable", reason: "disconnected" },
		{ ...base, outcome: "unavailable", reason: "unsupported" },
	];
	for (const event of events) {
		assert.deepEqual(parseFeatureEvent(event), event);
		for (const reason of new Set(events.map((candidate) => candidate.reason))) {
			if (events.some((candidate) => candidate.outcome === event.outcome && candidate.reason === reason)) continue;
			assert.equal(parseFeatureEvent({ ...event, reason }), undefined, `${event.outcome}/${reason}`);
		}
	}
});

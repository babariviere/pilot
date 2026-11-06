import assert from "node:assert/strict";
import { test } from "node:test";
import type { InsightsOwnerBinding } from "@pilot/protocol";
import { validateInsightsOwnerBinding } from "./insights-owner-binding.ts";

const host = { hostId: "daemon", daemonId: "synthetic", lineageId: "synthetic" };
const binding: InsightsOwnerBinding = {
	schemaVersion: 2,
	grantId: "00000000-0000-4000-8000-000000000004",
	revision: 1,
	enabled: true,
	reportSessionId: "00000000-0000-4000-8000-000000000002",
	projectId: "p",
	host,
	owner: {
		schemaVersion: 2,
		workspaceId: "00000000-0000-4000-8000-000000000001",
		reportSessionId: "00000000-0000-4000-8000-000000000002",
		scheduleId: "00000000-0000-4000-8000-000000000003",
		projectId: "p",
		expectedHome: host,
		context: "a".repeat(64),
	},
};
test("owner bindings have an independent closed parser and never accept a mission slot", () => {
	validateInsightsOwnerBinding(binding);
	for (const patch of [
		undefined,
		null,
		[],
		{ ...binding, missionId: binding.owner.workspaceId },
		{ ...binding, schemaVersion: 1 },
		{ ...binding, enabled: false },
		{ ...binding, revision: 0 },
		{ ...binding, grantId: "not-a-grant" },
		{ ...binding, owner: { ...binding.owner, expectedHome: { ...host, lineageId: "other" } } },
		{ ...binding, owner: { ...binding.owner, projectId: "other" } },
		{ ...binding, owner: { ...binding.owner, context: "unknown" } },
		{ ...binding, owner: { ...binding.owner, scheduleId: binding.reportSessionId } },
		{ ...binding, owner: { ...binding.owner, missionId: "hidden" } },
	])
		assert.throws(() => validateInsightsOwnerBinding(patch), /owner Insights binding/);
});

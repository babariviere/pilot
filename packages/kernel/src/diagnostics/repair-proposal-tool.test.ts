import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepairProposalTool, REPAIR_PROPOSAL_TOOL } from "./repair-proposal-tool.ts";

test("repair proposal only publishes bounded review material and grants no execution action", async () => {
	const drafts: unknown[] = [];
	const tool = createRepairProposalTool(async (draft) => {
		drafts.push(draft);
		return {
			schemaVersion: 1,
			id: "diagnostic-proposal:v1:01234567-89ab-4cde-8fab-0123456789ab",
			targetSessionId: "01234567-89ab-4cde-8fab-0123456789ab",
			createdAt: "2026-01-01T00:00:00.000Z",
			...draft,
		};
	});
	assert.equal(tool.name, REPAIR_PROPOSAL_TOOL);
	assert.equal(tool.annotations?.readOnlyHint, false);
	assert.equal(tool.annotations?.destructiveHint, false);
	assert.match(tool.description, /diagnostic:v1: refs from diagnostics, never history\/log refs/);
	const schema = tool.parameters as { properties: { evidenceRefs: { description: string } } };
	const evidenceGuidance = schema.properties.evidenceRefs.description;
	assert.match(evidenceGuidance, /diagnostic:v1: refs returned by diagnostics for the proposal subject/);
	assert.match(evidenceGuidance, /diagnostic-history:v1: and diagnostic-log:v1: refs are not accepted/);
	assert.match(evidenceGuidance, /no eligible evidence .* report that limitation rather than inventing refs/);
	assert.doesNotMatch(JSON.stringify(tool.parameters), /start|spawn|execute|retry|restart|replay/i);
	const draft = {
		evidenceRefs: ["diagnostic:v1:lifecycle:one"],
		findings: "The worker exited during startup.",
		uncertainty: "medium",
		suggestedRepair: "Preserve the startup error until the worker settles.",
		regressionTestGuidance: "Cover the failed startup transition.",
	};
	const result = await tool.execute("call", draft as never, undefined, undefined, {} as never);
	assert.deepEqual(drafts, [draft]);
	assert.match((result.content[0] as { text: string }).text, /diagnostic-proposal:v1/);
});

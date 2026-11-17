import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePatch } from "./tracked-item-patch.ts";

test("Slack detail overrides allow partial evidenced corrections and explicit unknowns", () => {
	validatePatch({ slack: { details: { client: { value: "Acme", evidence: "For Acme" }, reporter: null } } });
	validatePatch({ slack: { type: "bug", details: {} } });
	for (const details of [
		null,
		[],
		{ author: null },
		{ client: "Acme" },
		{ client: { value: "Acme", evidence: "" } },
		{ issue: { value: "x".repeat(241), evidence: "x" } },
		{ reporter: { value: "Joe", evidence: "x".repeat(501) } },
		{ reporter: { value: "Joe", evidence: "Joe", extra: true } },
	])
		assert.throws(() => validatePatch({ slack: { details } }), /Invalid Slack details/);
});

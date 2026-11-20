import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeAdmission, RuntimeResources } from "./runtime-admission.ts";

test("freeze is synchronous before async inspection, counts pending work and composes independent owners", async () => {
	const transfers = new RuntimeAdmission(),
		terminals = new RuntimeAdmission();
	const end = transfers.begin({ kind: "transfer", id: "queued-cleanup" });
	const resources = new RuntimeResources([transfers, terminals]);
	const release = resources.freezeAdmissions(),
		other = resources.freezeAdmissions();
	assert.throws(() => terminals.begin({ kind: "terminal", id: "race" }), /frozen/);
	assert.deepEqual(await resources.blockers(), [{ kind: "transfer", id: "queued-cleanup" }]);
	end();
	assert.deepEqual(await resources.blockers(), []);
	release();
	release();
	assert.throws(() => transfers.begin({ kind: "transfer", id: "race" }), /frozen/);
	other();
	transfers.begin({ kind: "transfer", id: "new" })();
});
test("failed or uncertain inspection remains a blocker and partial freeze releases earlier owners", async () => {
	const source = new RuntimeAdmission();
	const unknown = {
		freezeAdmissions: () => () => {},
		blockers: async () => {
			throw new Error("lost IPC");
		},
	};
	assert.equal((await new RuntimeResources([source, unknown]).blockers())[0]?.kind, "unknown");
	assert.throws(() =>
		new RuntimeResources([
			source,
			{
				...unknown,
				freezeAdmissions() {
					throw new Error("failed");
				},
			},
		]).freezeAdmissions(),
	);
	source.begin({ kind: "terminal", id: "not-frozen" })();
});

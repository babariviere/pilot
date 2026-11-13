import assert from "node:assert/strict";
import { test } from "node:test";
import { nshSource } from "./nsh-source.ts";
import { parseStoredArtifactRevision } from "./stored-revision.ts";

test("NSH saved revisions keep runtime provenance across app upgrades without granting rendering", () => {
	const source = '\uFEFFexport default () => "é😀";\r\n';
	const expected = { id: "11111111-1111-1111-1111-111111111111", sessionId: "owner", revision: 1 };
	const value = {
		...expected,
		kind: "nsh",
		title: "Saved",
		source,
		html: "",
		libraries: [],
		createdAt: 1,
		updatedAt: 1,
		nsh: { ...nshSource(source, "view.tsx"), runtime: "nsh older-release", rendering: "unsupported" },
	};
	const bytes = Buffer.from(JSON.stringify(value));
	const read = parseStoredArtifactRevision(bytes, expected);
	assert.deepEqual(read.bytes, bytes);
	assert.equal(read.artifact.nsh?.runtime, "nsh older-release");
	assert.deepEqual(read.artifact.nsh, value.nsh, "legacy metadata stays exact, not current app authority");
	const fresh = nshSource(source, "view.tsx");
	assert.ok(!("rendering" in fresh), "preview availability belongs to the app");
	for (const patch of [{ api: 2 }, { sourceSha256: "0".repeat(64) }, { sourceBytes: 1 }, { entry: "../view.tsx" }]) {
		assert.throws(
			() =>
				parseStoredArtifactRevision(
					Buffer.from(JSON.stringify({ ...value, nsh: { ...value.nsh, ...patch } })),
					expected,
				),
			/NSH/,
		);
	}
	assert.throws(() => parseStoredArtifactRevision(bytes, { ...expected, revision: 2 }), /mismatch/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJSON } from "./canonical-json.ts";
import { interviewDigest } from "./interview-round.ts";

test("persisted identities keep code-unit key ordering, nested objects and array order", () => {
	const value = { z: [{ b: 2, a: 1 }, 0], a: { é: 3, Z: 2, a: 1 } };
	const encoded = '{"a":{"Z":2,"a":1,"é":3},"z":[{"a":1,"b":2},0]}';
	assert.equal(canonicalJSON(value), encoded);
	assert.equal(canonicalJSON({ a: { a: 1, Z: 2, é: 3 }, z: [{ a: 1, b: 2 }, 0] }), encoded);
	assert.notEqual(canonicalJSON({ ...value, z: [...value.z].reverse() }), encoded);
	assert.equal(interviewDigest(value), "e9f5b211cd0204f59a6358875b33ef62b0834df0975d280e1c860d5d58fa6738");
});

test("canonical serialization keeps JSON omission, numeric and array semantics", () => {
	assert.equal(
		canonicalJSON({ z: undefined, b: [undefined, Number.NaN, -0], a: { b: undefined, a: null } }),
		'{"a":{"a":null},"b":[null,null,0]}',
	);
});

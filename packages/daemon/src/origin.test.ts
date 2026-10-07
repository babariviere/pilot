import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedOrigin } from "./origin.ts";

test("allows clients without an Origin header", () => {
	assert.equal(isAllowedOrigin(undefined), true);
});

test("rejects every browser origin, including loopback", () => {
	assert.equal(isAllowedOrigin("https://evil.example"), false);
	assert.equal(isAllowedOrigin("http://127.0.0.1:4319"), false);
	assert.equal(isAllowedOrigin("null"), false);
});

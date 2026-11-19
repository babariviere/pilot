import assert from "node:assert/strict";
import { test } from "node:test";
import { isSlackChannelId, isSlackTimestamp } from "./slack-ids.ts";

test("Slack identifier syntax keeps exact lengths and rejects coercion", () => {
	for (const prefix of ["C", "D", "G"]) {
		assert.equal(isSlackChannelId(`${prefix}A`), true);
		assert.equal(isSlackChannelId(prefix + "A".repeat(199)), true);
		for (const value of [prefix, prefix + "A".repeat(200), `${prefix}a`, ` ${prefix}A`, `${prefix}A `])
			assert.equal(isSlackChannelId(value), false, value);
	}
	for (const value of ["1.000000", "123456789012.123456"]) assert.equal(isSlackTimestamp(value), true);
	for (const value of [".123456", "1234567890123.123456", "1.12345", "1.1234567", " 1.123456", "1.123456 "])
		assert.equal(isSlackTimestamp(value), false, value);
	for (const value of [undefined, null, 1, {}, [], { toString: () => "CA" }])
		for (const validate of [isSlackChannelId, isSlackTimestamp]) assert.equal(validate(value), false);
});

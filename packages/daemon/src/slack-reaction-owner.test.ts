import assert from "node:assert/strict";
import { test } from "node:test";
import { isSlackChannelId, isSlackTimestamp, isSlackUserId, slackReactionUser } from "./slack-reaction-owner.ts";

test("Slack identifier syntax keeps exact lengths and rejects coercion", () => {
	for (const prefix of ["U", "W"]) {
		assert.equal(isSlackUserId(`${prefix}A`), true);
		assert.equal(isSlackUserId(prefix + "A".repeat(39)), true);
		for (const value of [prefix, prefix + "A".repeat(40), `${prefix}a`, ` ${prefix}A`, `${prefix}A `])
			assert.equal(isSlackUserId(value), false, value);
	}
	for (const prefix of ["C", "D", "G"]) {
		assert.equal(isSlackChannelId(`${prefix}A`), true);
		assert.equal(isSlackChannelId(prefix + "A".repeat(199)), true);
		for (const value of [prefix, prefix + "A".repeat(200), `${prefix}a`, ` ${prefix}A`, `${prefix}A `])
			assert.equal(isSlackChannelId(value), false, value);
	}
	for (const value of ["1.000000", "123456789012.123456"]) assert.equal(isSlackTimestamp(value), true);
	for (const value of [".123456", "1234567890123.123456", "1.12345", "1.1234567", " 1.123456", "1.123456 "])
		assert.equal(isSlackTimestamp(value), false, value);
	for (const value of [undefined, null, 1, {}, [], { toString: () => "UA" }])
		for (const validate of [isSlackUserId, isSlackChannelId, isSlackTimestamp]) assert.equal(validate(value), false);
});

test("valid user syntax does not make message identity authenticated profile evidence", () => {
	assert.equal(slackReactionUser({ user: "UA", reactions: [{ users: ["UA"] }] }), undefined);
	assert.equal(slackReactionUser({ user_id: "UA", ok: false }), undefined);
	assert.equal(slackReactionUser({ user_id: "UA", error: "invalid_auth" }), undefined);
	assert.equal(slackReactionUser({ user_id: "UA" }), "UA");
	assert.equal(slackReactionUser({ result: "User ID: UA\nEmail: private@example.test\n" }), "UA");
});

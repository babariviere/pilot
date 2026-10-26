import assert from "node:assert/strict";
import { test } from "node:test";
import { isWatchNotice } from "./worker-notice.ts";

test("every Node watch notice is ignored, and a worker reply is not", () => {
	assert.equal(isWatchNotice({ "watch:import": ["file:///a.ts"] }), true);
	assert.equal(isWatchNotice({ "watch:require": [null] }), true);
	assert.equal(isWatchNotice({ "watch:change": "a.ts" }), true);
	assert.equal(isWatchNotice({ view: { events: [] }, bytes: 12 }), false);
	assert.equal(isWatchNotice({ error: "failed" }), false);
	assert.equal(isWatchNotice(null), false);
	assert.equal(isWatchNotice("watch:import"), false);
});

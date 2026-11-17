import assert from "node:assert/strict";
import { test } from "node:test";
import { namedFeedbackPaths } from "./feedback-paths.ts";

test("named feedback paths keep exact quoted roots and reject traversal or whole filesystem", () => {
	assert.deepEqual(namedFeedbackPaths('Read `/tmp/a folder` and "~/Logs/Pilot" then /tmp/one.txt.'), [
		"/tmp/a folder",
		"~/Logs/Pilot",
		"/tmp/one.txt",
	]);
	assert.deepEqual(namedFeedbackPaths("Do not grant / or ~/ or /tmp/../secret or https://example.com/private"), []);
	assert.deepEqual(namedFeedbackPaths("Read /tmp/one and /tmp/one"), ["/tmp/one"]);
	assert.equal(namedFeedbackPaths(Array.from({ length: 20 }, (_, i) => `/tmp/${i}`).join(" ")).length, 8);
});

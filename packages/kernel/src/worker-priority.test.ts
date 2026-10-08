import assert from "node:assert/strict";
import { constants } from "node:os";
import test from "node:test";
import { lowerWorkerPriority } from "./worker-priority.ts";

test("background workers yield scheduling priority and never elevate an existing lower priority", () => {
	const writes: number[] = [];
	lowerWorkerPriority(
		() => 0,
		(priority) => writes.push(priority),
	);
	assert.deepEqual(writes, [constants.priority.PRIORITY_BELOW_NORMAL]);
	lowerWorkerPriority(
		() => 19,
		(priority) => writes.push(priority),
	);
	assert.equal(writes.length, 1);
});

test("unsupported scheduling policies never prevent worker startup", () => {
	assert.doesNotThrow(() =>
		lowerWorkerPriority(() => {
			throw new Error("unsupported");
		}),
	);
	assert.doesNotThrow(() =>
		lowerWorkerPriority(
			() => 0,
			() => {
				throw new Error("denied");
			},
		),
	);
});

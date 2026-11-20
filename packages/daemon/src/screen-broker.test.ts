import assert from "node:assert/strict";
import { test } from "node:test";
import { NotFound } from "./errors.ts";
import { ScreenBroker } from "./screen-broker.ts";

test("an unanswered request expires at its broker's deadline and cannot accept a late reply", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const broker = new ScreenBroker(
		{
			requireScreenChat: () => {},
			readPicture: async () => assert.fail("a query does not read a picture"),
		},
		{ query: 1000 },
	);
	broker.bind({ sessionId: "screen", windowId: "window" });
	const result = broker.call("screen", { op: "query", text: "New" });
	const rejected = assert.rejects(result, {
		message: "The window did not answer within 1 s. It may be closed or busy.",
	});
	const [request] = broker.requests("window");
	assert.ok(request);
	assert.equal(request.deadline, 1000);
	t.mock.timers.tick(999);
	assert.deepEqual(broker.requests("window"), [request]);
	t.mock.timers.tick(1);
	await rejected;
	assert.deepEqual(broker.requests("window"), []);
	assert.throws(() => broker.answer("window", request.id, { ok: true, value: [] }), NotFound);
});

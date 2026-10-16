import assert from "node:assert/strict";
import { test } from "node:test";
import { openUpdateFixtureTerminal } from "./update-terminal.mjs";

class Socket extends EventTarget {
	static last;
	readyState = 1;
	sent = [];
	constructor(url) {
		super();
		this.url = new URL(url);
		Socket.last = this;
	}
	send(frame) {
		this.sent.push(JSON.parse(frame));
	}
	message(value) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
	}
	close(code = 1000, reason = "") {
		this.readyState = 3;
		const event = new Event("close");
		event.code = code;
		event.reason = reason;
		this.dispatchEvent(event);
	}
}
test("package fixture sends protocol 2 sizes on the route, then boot/request identity in the open frame", async () => {
	const opening = openUpdateFixtureTerminal("http://127.0.0.1:4319", "fixture", { Socket });
	const ws = Socket.last;
	assert.equal(ws.url.pathname, "/api/sessions/fixture/terminal/ws");
	assert.deepEqual(Object.fromEntries(ws.url.searchParams), { protocol: "2", cols: "80", rows: "24" });
	ws.message({ type: "terminal.hello", bootId: "boot" });
	assert.equal(ws.sent[0].bootId, "boot");
	assert.equal(ws.sent[0].type, "terminal.open");
	assert.match(ws.sent[0].requestId, /^[a-f0-9-]{36}$/);
	ws.message({ type: "terminal.ready", terminalId: "terminal" });
	const terminal = await opening;
	const closed = terminal.closeShell();
	assert.deepEqual(ws.sent[1], { type: "terminal.close", terminalId: "terminal" });
	assert.equal(ws.readyState, 1, "keep the socket until actual process exit");
	ws.message({ type: "terminal.exit", code: 0 });
	await closed;
	assert.equal(ws.readyState, 3);
});
test("route rejection, close and transport errors fail with bounded diagnostics, not a blind readiness timeout", async (t) => {
	for (const kind of ["refused", "close", "error"])
		await t.test(kind, async () => {
			const opening = openUpdateFixtureTerminal("http://127.0.0.1:4319", "fixture", { Socket });
			const ws = Socket.last;
			ws.message({ type: "terminal.data", data: "not retained shell output" });
			if (kind === "refused") ws.message({ type: "error", message: "Invalid terminal size" });
			else if (kind === "close") ws.close(4404, "Unknown session");
			else {
				const error = new Event("error");
				error.message = "transport failed";
				ws.dispatchEvent(error);
			}
			await assert.rejects(opening, (error) => {
				assert.match(error.message, /was refused|4404:Unknown session|transport failed/);
				assert.doesNotMatch(error.message, /not retained shell output/);
				assert.ok(error.message.length < 2300);
				return true;
			});
		});
});
test("a stalled handshake has a bounded diagnostic deadline", async () => {
	await assert.rejects(
		openUpdateFixtureTerminal("http://127.0.0.1:4319", "fixture", { Socket, timeoutMs: 5 }),
		/open deadline/,
	);
});

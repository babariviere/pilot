/** Socket I/O lives off the caller thread. Only MCP's pinned synchronous status methods use this bridge. */
import { parentPort } from "node:worker_threads";
import { AUTH_FRAME_LIMIT, credentialRequest } from "./credential-rpc.ts";

parentPort!.on("message", async ({ endpoint, request, shared }) => {
	const status = new Int32Array(shared, 0, 2);
	const data = new Uint8Array(shared, 8);
	let value: string;
	try {
		value = JSON.stringify({ ok: true, value: await credentialRequest(endpoint, request) });
	} catch {
		value = '{"ok":false}';
	}
	const bytes = Buffer.from(value);
	if (bytes.length > AUTH_FRAME_LIMIT) {
		Atomics.store(status, 0, -1);
	} else {
		data.set(bytes);
		Atomics.store(status, 1, bytes.length);
		Atomics.store(status, 0, 1);
	}
	Atomics.notify(status, 0);
});

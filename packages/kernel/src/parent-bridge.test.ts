import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { startParentBridge } from "./parent-bridge.ts";

test("usage bridge enforces its UTF-8 body limit before publication", { timeout: 10_000 }, async (t) => {
	let publications = 0;
	const bridge = await startParentBridge(
		async () => [],
		undefined,
		async () => {
			publications++;
			return "stored";
		},
	);
	t.after(() => bridge.close());
	const { socketPath, token } = JSON.parse(process.env.PILOT_TODO_BRIDGE!);
	const send = (body: string) =>
		new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
			const req = request(
				{ socketPath, path: "/usage-history", method: "POST", headers: { authorization: `Bearer ${token}` } },
				(res) => {
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						text += chunk;
					});
					res.on("error", reject);
					res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	const overhead = Buffer.byteLength(JSON.stringify({ padding: "" }));
	const accepted = JSON.stringify({ padding: "é".repeat((4096 - overhead) / 2) });
	assert.equal(Buffer.byteLength(accepted), 4096);
	assert.deepEqual(await send(accepted), { status: 200, body: { result: "stored" } });
	const refused = JSON.stringify({ padding: "é".repeat((4096 - overhead) / 2 + 1) });
	assert.equal(Buffer.byteLength(refused), 4098);
	assert.deepEqual(await send(refused), { status: 400, body: { error: "Bridge request too large" } });
	assert.equal(publications, 1);
});

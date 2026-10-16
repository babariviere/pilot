import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { api, child, hash, operation, quote, setupSource } from "./workflow-fixture.mjs";

test("workflow fixture keeps immutable request bytes, targets and host pins separate", () => {
	const hello = { daemonId: "remote", lineageId: "history" };
	const op = operation(hello, { message: "original", cwd: "/remote/path" });
	assert.equal(op.payloadHash, hash(op.payload));
	assert.equal(op.destination.daemonId, "remote");
	assert.notEqual(op.origin.daemonId, op.destination.daemonId);
	assert.equal(JSON.parse(op.payload).cwd, "/remote/path");
	assert.notEqual(
		operation({ ...hello, lineageId: "clone" }, { message: "original" }).destination.lineageId,
		op.destination.lineageId,
	);
	assert.equal(quote("a'b"), "'a'\\''b'");
});

test("generated provider setup parses as a module and resolves only the target's packaged faux provider", () => {
	const source = setupSource("/home/disposable ' fixture");
	const parsed = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: source, encoding: "utf8" });
	assert.equal(parsed.status, 0, parsed.stderr);
	assert.match(source, /import\.meta\.resolve\('@earendil-works\/pi-ai\/providers\/faux'\)/);
	assert.doesNotMatch(source, /auth\.json|apiKey|access_token|refresh_token|sudo|fetch\(/);
	for (const kind of ["html", "react", "image"]) assert.ok(source.includes(`kind:"${kind}"`));
});

test("fixture requests are bounded and preserve remote resource paths without fallback", async (t) => {
	const paths = [];
	const server = createServer((req, res) => {
		paths.push(req.url);
		res.writeHead(req.url.includes("missing") ? 503 : 200);
		res.end(req.url.includes("large") ? JSON.stringify("x".repeat(200)) : JSON.stringify({ content: "remote" }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(
		() =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(resolve);
			}),
	);
	const base = `http://127.0.0.1:${server.address().port}`;
	assert.deepEqual(await api(base, "sessions/colliding/files?path=folder%2Ffile"), { content: "remote" });
	await assert.rejects(api(base, "large", { maximumBytes: 30 }), /response limit/);
	await assert.rejects(api(base, "missing"), /HTTP 503/);
	assert.deepEqual(paths, ["/api/sessions/colliding/files?path=folder%2Ffile", "/api/large", "/api/missing"]);
});

test("fixture subprocesses bound output and deadlines and never expose raw diagnostics", async () => {
	assert.equal(await child(process.execPath, ["-e", "process.stdout.write('ok')"]), "ok");
	await assert.rejects(
		child(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000))"], undefined, { maximumBytes: 10 }),
		/output limit/,
	);
	await assert.rejects(
		child(process.execPath, ["-e", "setInterval(()=>{},1000)"], undefined, { timeoutMs: 30 }),
		/deadline/,
	);
	await assert.rejects(
		child(process.execPath, ["-e", "process.stderr.write('private');process.exit(7)"]),
		(error) => !error.message.includes("private") && error.message.includes("7"),
	);
});

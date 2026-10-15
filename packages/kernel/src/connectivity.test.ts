import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { isTransportFailure, OfflineGate, offlineRequestStream } from "./connectivity.ts";

const model = fauxProvider().getModel();
async function until(check: () => boolean) {
	const end = Date.now() + 3000;
	while (!check()) {
		assert.ok(Date.now() < end, "timed out");
		await delay(2);
	}
}

test("transport classification excludes HTTP/auth/quota/provider failures", () => {
	for (const error of [
		new TypeError("fetch failed"),
		{ cause: { code: "ENETUNREACH" } },
		"Connection error.",
		"terminated",
	])
		assert.equal(isTransportFailure(error), true);
	for (const error of [
		"401 Unauthorized",
		"429 rate limit",
		"503 network error",
		"Invalid API key",
		"quota exceeded",
		"overloaded",
		{ status: 403, code: "ECONNRESET" },
		"bad model",
		new Error("tool failed"),
	])
		assert.equal(isTransportFailure(error), false);
	const cyclic: { cause?: unknown } = {};
	cyclic.cause = cyclic;
	assert.equal(isTransportFailure(cyclic), false);
});

test("offline before dispatch and during a stream holds work, cancels only the request and retries once", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-offline-stream-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "connectivity.json");
	const save = async (online: boolean) => {
		await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, online, checkedAt: Date.now() }));
		await rename(`${path}.tmp`, path);
	};
	await save(false);
	const controller = new AbortController();
	t.after(() => controller.abort());
	let calls = 0,
		aborted = 0;
	const events: string[] = [];
	const stream = offlineRequestStream(
		(signal) => {
			calls++;
			const source = createAssistantMessageEventStream();
			if (calls === 1) {
				signal.addEventListener(
					"abort",
					() => {
						aborted++;
						source.end(fauxAssistantMessage("partial", { stopReason: "aborted" }));
					},
					{ once: true },
				);
			} else source.end(fauxAssistantMessage("finished"));
			return source;
		},
		model,
		new OfflineGate(path),
		controller.signal,
	);
	const reading = (async () => {
		for await (const event of stream) events.push(event.type);
	})();
	await delay(25);
	assert.equal(calls, 0);
	await save(true);
	await until(() => calls === 1);
	await save(false);
	await until(() => aborted === 1);
	await delay(25);
	assert.equal(calls, 1);
	assert.deepEqual(events, []);
	await save(true);
	assert.equal((await stream.result()).stopReason, "stop");
	await reading;
	assert.equal(calls, 2);
	assert.deepEqual(events, ["done"]);
});

test("transport failure requests a fresh central check; online failures remain errors, offline waits for recovery", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-offline-confirm-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "connectivity.json");
	const save = (online: boolean) => writeFile(path, JSON.stringify({ version: 1, online, checkedAt: Date.now() + 1 }));
	await save(true);
	let checks = 0;
	const gate = new OfflineGate(path, async () => {
		checks++;
		await save(true);
	});
	assert.equal(await gate.recover("fetch failed"), false);
	assert.equal(checks, 1);
	assert.equal(await gate.recover("401 Unauthorized"), false);
	assert.equal(checks, 1);
	let checkedResolve!: () => void;
	const checked = {
		promise: new Promise<void>((resolve) => {
			checkedResolve = resolve;
		}),
		resolve: () => checkedResolve(),
	};
	const held = new OfflineGate(path, async () => {
		await save(false);
		checked.resolve();
	});
	let finished = false;
	const recovery = held.recover("fetch failed").then((value) => {
		finished = true;
		return value;
	});
	await checked.promise;
	await delay(25);
	assert.equal(finished, false);
	await save(true);
	assert.equal(await recovery, true);
});

test("manual stop aborts a missing or malformed admission file without dispatch or later resurrection", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-offline-stop-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "missing.json");
	for (const malformed of [false, true]) {
		if (malformed) await writeFile(path, "not-json");
		const stop = new AbortController();
		let calls = 0;
		const stream = offlineRequestStream(
			() => {
				calls++;
				throw new Error("must not dispatch");
			},
			model,
			new OfflineGate(path),
			stop.signal,
		);
		await delay(10);
		stop.abort();
		assert.equal((await stream.result()).stopReason, "aborted");
		assert.equal(calls, 0);
	}
	await writeFile(path, JSON.stringify({ version: 1, online: true, checkedAt: Date.now() }));
});

test("an HTTP error racing offline stays an error; a successful response waits without being repeated", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-offline-boundary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "connectivity.json");
	const save = (online: boolean) => writeFile(path, JSON.stringify({ version: 1, online, checkedAt: Date.now() }));
	for (const failure of [true, false]) {
		await save(true);
		let calls = 0,
			cancelled = false,
			finished = false;
		const stop = new AbortController();
		t.after(() => stop.abort());
		const stream = offlineRequestStream(
			(signal) => {
				calls++;
				const source = createAssistantMessageEventStream();
				signal.addEventListener(
					"abort",
					() => {
						cancelled = true;
						source.end(
							fauxAssistantMessage(
								"response",
								failure ? { stopReason: "error", errorMessage: "401 Unauthorized" } : {},
							),
						);
					},
					{ once: true },
				);
				return source;
			},
			model,
			new OfflineGate(path),
			stop.signal,
		);
		const result = stream.result().then((message) => {
			finished = true;
			return message;
		});
		await until(() => calls === 1);
		await save(false);
		await until(() => cancelled);
		if (failure) assert.equal((await result).stopReason, "error");
		else {
			await delay(15);
			assert.equal(finished, false);
			await save(true);
			assert.equal((await result).stopReason, "stop");
		}
		assert.equal(calls, 1);
	}
});

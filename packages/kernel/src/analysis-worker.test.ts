import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runAnalysisWorker } from "./analysis-worker.ts";

const fixture = new URL("./testing/analysis-worker-fixture.ts", import.meta.url);

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((ready) => {
		resolve = ready;
	});
	return { promise, resolve };
}

test("queued cancellation preserves an explicit null reason", { timeout: 10_000 }, async () => {
	const release = deferred<Uint8Array>();
	const started = [deferred<void>(), deferred<void>()];
	const running = started.map((ready) =>
		runAnalysisWorker(fixture, { mode: "bytes", state: new SharedArrayBuffer(8) }, undefined, async () => {
			ready.resolve();
			return release.promise;
		}),
	);
	try {
		await Promise.all(started.map((ready) => ready.promise));
		const controller = new AbortController();
		const queued = runAnalysisWorker(
			fixture,
			{ mode: "success", state: new SharedArrayBuffer(8) },
			controller.signal,
		);
		controller.abort(null);
		await assert.rejects(queued, (reason) => reason === null);
	} finally {
		release.resolve(new Uint8Array([1]));
		await Promise.all(running);
	}
});

for (const reason of [false, 0, "", null]) {
	for (const mode of ["result", "bytes"]) {
		test(`falsy cancellation ${JSON.stringify(reason)} blocks ${mode}, drains reads and releases slots`, {
			timeout: 10_000,
		}, async () => {
			const state = new Int32Array(new SharedArrayBuffer(8));
			const controller = new AbortController();
			const started = deferred<void>();
			const read = deferred<Uint8Array>();
			let settled = false;
			const result = runAnalysisWorker(fixture, { mode, state: state.buffer }, controller.signal, async () => {
				started.resolve();
				return read.promise;
			})
				.then(
					(value) => ({ status: "fulfilled", value }),
					(error: unknown) => ({ status: "rejected", value: error }),
				)
				.finally(() => {
					settled = true;
				});
			try {
				await started.promise;
				controller.abort(reason);
				const deadline = performance.now() + 5_000;
				while (!Atomics.load(state, 0)) {
					assert.ok(performance.now() < deadline, "worker did not acknowledge cancellation");
					await nextTurn();
				}
				await nextTurn();
				assert.equal(settled, false, "cancellation must drain the pending read before settling");
			} finally {
				read.resolve(new Uint8Array([1]));
			}
			assert.deepEqual(await result, { status: "rejected", value: reason });
			assert.equal(Atomics.load(state, 1), 0, "no bytes reach the worker after cancellation");
			assert.equal(await runAnalysisWorker(fixture, { mode: "success", state: state.buffer }), "ready");
		});
	}
}

import assert from "node:assert/strict";
import { on } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

test("cold reader entrypoints do not eagerly load the coding SDK", { timeout: 20_000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-reader-imports-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const entry of ["snapshot-worker.ts", "subagent-watch-worker.ts"]) {
		await t.test(entry, async () => {
			const worker = new Worker(new URL("./testing/guarded-reader-worker.ts", import.meta.url), {
				execArgv: [],
				workerData: {
					entry: new URL(`./${entry}`, import.meta.url).href,
					directory,
					cwd: directory,
					conversationId: "1",
					includeTodos: false,
				},
			});
			const messages = on(worker, "message", { signal: t.signal });
			try {
				const first = await messages.next();
				assert.ok(!first.done);
				const [message] = first.value;
				if (entry === "snapshot-worker.ts") {
					assert.equal(message.error, undefined);
					assert.equal(message.view.events[0]?.type, "snapshot");
				} else {
					assert.deepEqual(message, { ready: true });
					const next = await messages.next();
					assert.ok(!next.done);
					const [snapshot] = next.value;
					assert.deepEqual(snapshot, { full: true, events: [] });
				}
				assert.deepEqual(await readdir(directory), [], "readers must not create storage");
			} finally {
				await messages.return?.();
				await worker.terminate();
			}
		});
	}
});

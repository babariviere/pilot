/** Synthetic only: node packages/kernel/bench/paged-history.ts. Never reads a real session. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@pilot/protocol";
import { ChatStreams } from "../../daemon/src/chat-streams.ts";
import { HeldInputsDoc } from "../src/held-inputs-doc.ts";
import { openSessionStorage } from "../src/storage.ts";

const directory = await mkdtemp(join(tmpdir(), "pilot-paged-bench-"));
const owned = await openSessionStorage(directory);
const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
try {
	const root = await harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(HeldInputsDoc, root.id)).questionPending = false;
		for (let i = 0; i < 6000; i++) {
			const user = i % 4 === 0;
			const entry = await tx.appendEntry(root.id, {
				kind: user ? "pi.user" : "pilot.activity",
				...(user
					? { model: [{ role: "user" as const, content: `Synthetic 日本 ${i} ${"body ".repeat(400)}` }] }
					: { data: { text: `Synthetic activity ${i} ${"body ".repeat(400)}` } }),
			});
			if (user)
				await tx.createSubmission({
					conversationId: root.id,
					requestId: `native:user:fixture-${i}`,
					type: "input",
					status: "done",
					entry: entry.id,
				});
		}
	}, context);
	const results = [];
	for (let trial = 0; trial < 5; trial++)
		for (const recent of [false, true]) {
			const start = performance.now();
			const worker = new Worker(
				`
            void(async()=>{
                const {parentPort,workerData}=await import("node:worker_threads");
                const {readSessionSnapshot}=await import(workerData.module);
                const start=performance.now();
                const view=await readSessionSnapshot(workerData.directory,workerData.directory,true,workerData.recent);
                const prepared=performance.now();
                const encoded=JSON.stringify(view);
                const serialized=performance.now();
                parentPort.postMessage({view,prepareMs:prepared-start,encodeMs:serialized-prepared,ipcBytes:Buffer.byteLength(encoded)});
                parentPort.close();
            })().catch(e=>{throw e});`,
				{
					eval: true,
					workerData: { directory, recent, module: new URL("../src/snapshot.ts", import.meta.url).href },
				},
			);
			const result = await new Promise<{
				view: { events: AgentEvent[] };
				prepareMs: number;
				encodeMs: number;
				ipcBytes: number;
			}>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
			});
			await new Promise<void>((resolve, reject) => {
				worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`reader exit ${code}`))));
			});
			const receiptMs = performance.now() - start;
			let bytes = 0;
			const streams = new ChatStreams((_id, listener) => {
				listener(result.view.events);
				return () => {};
			});
			const wireStart = performance.now();
			streams.attach(
				"synthetic",
				(data) => {
					bytes += Buffer.byteLength(data);
				},
				undefined,
				undefined,
				recent,
			);
			const frameMs = performance.now() - wireStart;
			streams.close();
			const snapshot = result.view.events.find((e) => e.type === "snapshot");
			results.push({
				trial,
				recent,
				prepareMs: result.prepareMs,
				workerEncodeMs: result.encodeMs,
				workerStartupPrepareTransferExitMs: receiptMs,
				ipcBytes: result.ipcBytes,
				frameEncodeMs: frameMs,
				wireBytes: bytes,
				entries: snapshot?.type === "snapshot" ? snapshot.entries.length : 0,
			});
		}
	console.log(JSON.stringify({ fixture: { entries: 6000, submissions: 1500, bytesPerBody: 2000 }, results }, null, 2));
} finally {
	await harness.close(context);
	owned.release();
	await rm(directory, { recursive: true, force: true });
}

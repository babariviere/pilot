/** Offline cold-thread/import/read probe. node packages/kernel/src/subagent-reader-startup.bench.ts <baseline> [busy-threads=0] [pairs=5] */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const baseline = process.argv[2];
const busyThreads = Number(process.argv[3] ?? 0);
const pairs = Number(process.argv[4] ?? 5);
assert.ok(baseline && /^[a-f\d]{6,40}$/.test(baseline), "Pass a baseline commit hash");
assert.ok(Number.isInteger(busyThreads) && busyThreads >= 0 && busyThreads <= 4, "Use 0–4 busy threads");
assert.ok(Number.isInteger(pairs) && pairs >= 1 && pairs <= 20, "Use 1–20 pairs");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "pilot-reader-startup-"));
const burners: Worker[] = [];
let harness: Harness | undefined;

type ImportStats = { modules: number; sourceBytes: number; sdkModules: number; cpuMs: number; heapBytes: number };
type Sample = {
	variant: string;
	load: number[];
	onlineMs?: number;
	bootstrapMs?: number;
	importsMs?: number;
	snapshotMs?: number;
	readMs?: number;
	imports?: ImportStats;
};

async function sample(variant: string, source: URL, directory: string, conversationId: string): Promise<Sample> {
	const result: Sample = { variant, load: loadavg() };
	const start = performance.now();
	// Dynamic import is intentional: instrumentation starts *before* the real entry's static imports.
	// "online" only measures V8 startup, not module readiness. CPU is this thread, not the busy siblings.
	const worker = new Worker(
		`
		const { parentPort, workerData } = require('node:worker_threads');
		const { registerHooks } = require('node:module');
		let modules = 0, sourceBytes = 0, sdkModules = 0;
		const cpu = process.threadCpuUsage();
		registerHooks({ load(url, context, next) {
			const result = next(url, context);
			modules++;
			if (result.source) sourceBytes += Buffer.byteLength(result.source);
			if (url.includes('/pi-coding-agent/')) sdkModules++;
			return result;
		}});
		parentPort.postMessage({ phase: 'bootstrap' });
		(async () => {
			await import(workerData.snapshot);
			const usage = process.threadCpuUsage(cpu);
			parentPort.postMessage({ phase: 'imports', modules, sourceBytes, sdkModules,
				cpuMs: (usage.user + usage.system) / 1000, heapBytes: process.memoryUsage().heapUsed });
			await import(workerData.entry);
		})().catch(error => { throw error; });
	`,
		{
			eval: true,
			execArgv: [],
			workerData: {
				snapshot: new URL("snapshot.ts", source).href,
				entry: new URL("subagent-watch-worker.ts", source).href,
				directory,
				conversationId,
			},
		},
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			// Observation ceiling, not a production/read deadline: measure starts exceeding the old 5s budget too.
			timer = setTimeout(() => reject(new Error(`No snapshot within 30s: ${JSON.stringify(result)}`)), 30_000);
			worker.once("error", reject);
			worker.once("exit", (code) => reject(new Error(`Reader exited before snapshot (${code})`)));
			worker.once("online", () => {
				result.onlineMs = performance.now() - start;
			});
			worker.on("message", (message) => {
				const elapsed = performance.now() - start;
				if (message.phase === "bootstrap") result.bootstrapMs = elapsed;
				else if (message.phase === "imports") {
					result.importsMs = elapsed;
					const { phase: _, ...stats } = message;
					result.imports = stats;
				} else if (!message.ready) {
					try {
						assert.equal(message.error, undefined);
						assert.equal(message.full, true);
						assert.equal(message.events[0]?.type, "snapshot");
						assert.deepEqual(
							message.events[0].entries.map((entry: { data: unknown }) => entry.data),
							[{ text: "first" }],
						);
						result.snapshotMs = elapsed;
						result.readMs = elapsed - result.importsMs!;
						resolve();
					} catch (error) {
						reject(error);
					}
				}
			});
		});
		return result;
	} finally {
		clearTimeout(timer);
		await worker.terminate();
	}
}

try {
	// Materialize immutable source only, with the identical dependency installation and no git checkout/rewrite.
	const archive = execFileSync(
		"/usr/bin/git",
		["archive", baseline, "package.json", "packages/kernel/package.json", "packages/kernel/src"],
		{
			cwd: root,
			maxBuffer: 32 * 1024 * 1024,
		},
	);
	execFileSync("tar", ["-xf", "-", "-C", scratch], { input: archive });
	await symlink(join(root, "packages/kernel/node_modules"), join(scratch, "packages/kernel/node_modules"), "dir");
	const directory = join(scratch, "fixture");
	await mkdir(directory);
	const storage = await openNodeSqliteStorage(join(directory, "runs.sqlite"));
	harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	const conversation = await harness.root(context, { agent: { model: { provider: "missing", modelId: "offline" } } });
	await conversation.commit(async (tx) => {
		await tx.appendEntry(conversation.id, { kind: "note", data: { text: "first" } });
	}, context);
	for (let i = 0; i < busyThreads; i++)
		burners.push(new Worker("for (;;) Math.sqrt(Math.random());", { eval: true, execArgv: [] }));
	await Promise.all(burners.map((worker) => once(worker, "online")));
	console.log(
		JSON.stringify({
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			baseline,
			busyThreads,
			pairs,
		}),
	);
	const variants = [
		{ name: "baseline", source: pathToFileURL(`${join(scratch, "packages/kernel/src")}/`) },
		{ name: "current", source: new URL("./", import.meta.url) },
	];
	for (let round = 0; round < pairs; round++) {
		for (const variant of round % 2 ? [...variants].reverse() : variants) {
			console.log(
				JSON.stringify({
					round,
					...(await sample(variant.name, variant.source, directory, String(conversation.id))),
				}),
			);
		}
	}
} finally {
	await Promise.all(burners.map((worker) => worker.terminate()));
	await harness?.close(context);
	await rm(scratch, { recursive: true, force: true });
}

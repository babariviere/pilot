/** Offline multi-process discovery probe. Baseline keeps the merged per-runtime startup fixes. */
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CredentialClient, credentialClient, credentialEnvironment } from "@pilot/kernel/credential-client";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import { CredentialBroker } from "./credential-broker.ts";

type Sample = { startupMs: number; rss: number; heap: number; reads: number };
const worker = process.argv[2] === "--worker";
if (worker) {
	await installCredentialBrokerHooks();
	const client = credentialClient()!;
	let reads = 0;
	const request = client.request.bind(client);
	client.request = (args) => {
		if (args.op === "read") reads++;
		return request(args);
	};
	const start = performance.now();
	const runtime = await ModelRuntime.create({
		modelsPath: join(process.env.PI_CODING_AGENT_DIR!, "models.json"),
		allowModelNetwork: false,
	});
	await runtime.getAvailable();
	process.send?.({ startupMs: performance.now() - start, ...process.memoryUsage(), reads });
	// Keep the runtime resident until the controller measures the whole cohort.
	process.on("message", () => {
		void runtime;
		process.exit(0);
	});
} else {
	const sessions = Number(process.argv[2] ?? 12),
		samples = Number(process.argv[3] ?? 3);
	if (
		!Number.isSafeInteger(sessions) ||
		sessions < 2 ||
		sessions > 32 ||
		!Number.isSafeInteger(samples) ||
		samples < 1 ||
		samples > 10
	)
		throw new Error("Usage: node packages/daemon/src/shared-model-catalog.bench.ts [2..32 sessions] [1..10 samples]");
	// No user accounts, provider environment, inherited preload or Pilot credentials in this probe.
	const safe = Object.fromEntries(
		["PATH", "TMPDIR", "SYSTEMROOT"].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
	);
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, safe, { PI_OFFLINE: "1" });
	await installCredentialBrokerHooks();
	async function run(shared: boolean) {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-catalog-bench-")));
		const dir = join(root, "agent");
		await mkdir(dir);
		await writeFile(
			join(dir, "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						api: "openai-completions",
						baseUrl: "https://example.invalid/v1",
						apiKey: "offline-fixture",
						models: [{ id: "offline", contextWindow: 32000, maxTokens: 4096 }],
					},
				},
			}),
		);
		// Keep cache-file creation outside the measured discovery work in both variants.
		await writeFile(join(dir, "models-store.json"), "{}");
		const broker = new CredentialBroker(dir);
		await broker.start();
		let reads = 0;
		const instrumented = broker as unknown as { readCredential(...args: unknown[]): Promise<unknown> };
		const readCredential = instrumented.readCredential.bind(broker);
		instrumented.readCredential = (...args) => {
			reads++;
			return readCredential(...args);
		};
		const probe = new CredentialClient(broker.grant());
		const children: ChildProcess[] = [],
			results: Sample[] = [],
			responses: number[] = [];
		let peakRss = process.memoryUsage().rss,
			last = performance.now(),
			maxGap = 0;
		let probing = false;
		const heartbeat = setInterval(() => {
			const now = performance.now();
			maxGap = Math.max(maxGap, now - last);
			last = now;
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
			if (!probing) {
				probing = true;
				const begin = performance.now();
				void probe
					.request({ op: "status", namespace: "pi", key: "fixture" })
					.then(() => responses.push(performance.now() - begin))
					.finally(() => {
						probing = false;
					});
			}
		}, 5);
		const started = performance.now();
		try {
			// Match the merged two-start admission limit; ready workers remain resident.
			let next = 0;
			await Promise.all(
				Array.from({ length: 2 }, async () => {
					while (next < sessions) {
						next++;
						const endpoint = broker.grant();
						const env: NodeJS.ProcessEnv = {
							...safe,
							...credentialEnvironment(endpoint),
							HOME: root,
							PI_OFFLINE: "1",
							PI_CODING_AGENT_DIR: dir,
						};
						if (!shared) delete env.PILOT_SHARED_CATALOG_DIR;
						const child = fork(fileURLToPath(import.meta.url), ["--worker"], {
							execArgv: [],
							env,
							stdio: ["ignore", "ignore", "inherit", "ipc"],
						});
						children.push(child);
						const message = once(child, "message", { signal: AbortSignal.timeout(60_000) });
						const exited = once(child, "exit").then(() => {
							throw new Error("Probe worker exited before ready");
						});
						const [result] = await Promise.race([message, exited]);
						results.push(result as Sample);
					}
				}),
			);
			const sorted = results.map((r) => r.startupMs).sort((a, b) => a - b);
			const status = responses.sort((a, b) => a - b);
			return {
				variant: shared ? "daemon" : "per-worker",
				sessions,
				discoveryPasses: shared ? broker.catalog.stats.discoveries : sessions,
				credentialReads: reads,
				cohortMs: performance.now() - started,
				startupMedianMs: sorted[Math.floor(sorted.length / 2)],
				startupP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
				maxHeartbeatGapMs: maxGap,
				statusP95Ms: status[Math.ceil(status.length * 0.95) - 1] ?? 0,
				daemonPeakRssMiB: peakRss / 1024 ** 2,
				workerRssMiB: results.reduce((sum, r) => sum + r.rss, 0) / 1024 ** 2,
				snapshotBytes: broker.catalog.stats.snapshotBytes,
			};
		} finally {
			clearInterval(heartbeat);
			for (const child of children) child.kill("SIGKILL");
			await Promise.allSettled(
				children.map((child) =>
					child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve(),
				),
			);
			await probe.close();
			await broker.close();
			await rm(root, { recursive: true, force: true });
		}
	}
	console.log(
		JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, sessions, samples }),
	);
	for (let sample = 0; sample <= samples; sample++) {
		for (const shared of sample % 2 ? [true, false] : [false, true])
			console.log(JSON.stringify({ sample, warmup: sample === 0, ...(await run(shared)) }));
	}
}

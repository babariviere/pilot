// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access observes private lifecycle barriers in the fixture.
/** Offline startup/update probe. Synthetic metadata and workers only, no model/account access. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { KernelCommand } from "@pilot/kernel";
import { EventLoopWatchdog, threadCpuMs } from "../event-loop-watchdog.ts";
import { LIFECYCLE_FILE } from "../lifecycle-diagnostics.ts";
import type { ModelCatalog } from "../models.ts";
import { ProjectStore } from "../projects.ts";
import { createDaemonServer } from "../server.ts";
import { SessionManager, type SessionWorker } from "../sessions.ts";
import type { TerminalManager } from "../terminals.ts";

export async function startupResponsiveness(
	count: number,
	payloadBytes: number,
	Manager: typeof SessionManager = SessionManager,
) {
	const home = await mkdtemp(join(tmpdir(), "pilot-startup-probe-"));
	const ids = Array.from({ length: count }, () => randomUUID());
	const content = "synthetic preparation data ".repeat(Math.ceil(payloadBytes / 27)).slice(0, payloadBytes);
	const requests = new Map<string, KernelCommand[]>();
	const release: Array<() => void> = [];
	let active = 0,
		peak = 0,
		opened = 0;
	const projects = new ProjectStore(home);
	const sessions = new Manager(home, projects, undefined, {
		title: async () => undefined,
		worker: (spec, report) => {
			active++;
			peak = Math.max(peak, active);
			opened++;
			let ready!: () => void;
			const commands: KernelCommand[] = [];
			requests.set(spec.sessionId, commands);
			const worker: SessionWorker = {
				ready: new Promise<void>((resolve) => {
					ready = resolve;
				}),
				state: "starting",
				busy: false,
				send(command) {
					commands.push(command);
					if (command.type === "update.pause") report({ type: "update.paused", id: command.id });
				},
				async request(command) {
					commands.push(command);
				},
				async close() {},
			};
			const open = () => {
				active--;
				worker.state = "idle";
				report({ type: "ready", model: "fixture/model", working: false, usage: {} });
				ready();
			};
			// Hold the first pair to test queued cancellation and update exclusion, not a CPU spin.
			if (opened <= 2) release.push(open);
			else void setImmediate().then(open);
			return worker;
		},
	});
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		{} as ModelCatalog,
		{} as TerminalManager,
	);
	const agent = new Agent({ keepAlive: true, maxSockets: 1 });
	const histogram = monitorEventLoopDelay({ resolution: 5 });
	const watchdog = new EventLoopWatchdog({ intervalMs: 5, thresholdMs: 250, log: () => {} });
	let timer: ReturnType<typeof globalThis.setInterval> | undefined;
	let stopped = false;
	let probing: Promise<void> | undefined;
	try {
		await projects.load();
		for (const id of ids) {
			const directory = join(home, "sessions", id);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, "meta.json"),
				JSON.stringify({
					id,
					cwd: home,
					title: "Synthetic",
					createdAt: 1,
					updatedAt: 1,
					initializing: true,
					pending: [{ type: "input", requestId: `input:${id}`, content, mode: "followUp" }],
				}),
			);
		}
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const probe = () =>
			new Promise<void>((resolve, reject) => {
				get({ host: "127.0.0.1", port: address.port, path: "/api/sessions", agent }, (response) => {
					response.resume();
					response.on("error", reject);
					response.on("end", () =>
						response.statusCode === 200 ? resolve() : reject(new Error("Control read failed")),
					);
				}).on("error", reject);
			});
		await probe();
		histogram.enable();
		await setTimeout(15);
		histogram.reset();
		watchdog.start();
		let ticks = 0,
			controls = 0,
			maxHeartbeatMs = 0,
			maxControlMs = 0;
		let last = performance.now();
		timer = globalThis.setInterval(() => {
			const now = performance.now();
			maxHeartbeatMs = Math.max(maxHeartbeatMs, now - last);
			last = now;
			ticks++;
		}, 5);
		probing = (async () => {
			while (!stopped) {
				const start = performance.now();
				await probe();
				maxControlMs = Math.max(maxControlMs, performance.now() - start);
				controls++;
			}
		})();
		void probing.catch(() => {});
		const start = performance.now(),
			cpu = threadCpuMs();
		await sessions.load();
		const deadline = performance.now() + 10_000;
		while (opened !== 2) {
			assert.ok(performance.now() < deadline, "first workers did not start");
			await setTimeout(1);
		}
		assert.equal(sessions.list().length, count);
		assert.equal(sessions.prepareUpdate().ready, false, "startup must retain update admission");
		assert.equal(sessions.pauseForUpdate().ready, false, "cannot drain an unready worker");
		sessions["resumeAfterUpdate"]();
		const cancelled = ids.findLast((id) => !requests.has(id))!;
		assert.ok(!requests.has(cancelled), "cancellation exercises a queued worker");
		assert.deepEqual(await sessions.stop(cancelled), { ok: true, draft: content });
		for (const open of release.splice(0)) open();
		await Promise.all(sessions["starting"].values());
		const startupMs = performance.now() - start;
		assert.equal(peak, 2);
		assert.equal(opened, count);
		for (const id of ids) {
			const delivered = requests.get(id)!.filter((command) => command.type === "input" || command.type === "abort");
			assert.equal(delivered.length, 1, "no duplicate delivery");
			if (id === cancelled) assert.equal(delivered[0]!.type, "abort");
			else assert.deepEqual(delivered[0], { type: "input", requestId: `input:${id}`, content, mode: "followUp" });
		}
		const updateStart = performance.now();
		while (!sessions.pauseForUpdate().ready) {
			assert.ok(performance.now() - updateStart < 10_000, "update drain did not settle");
			await setTimeout(1);
		}
		sessions["resumeAfterUpdate"]();
		await Promise.all(sessions["saving"].values());
		const updateMs = performance.now() - updateStart;
		await setTimeout(15);
		stopped = true;
		await probing;
		const metrics = {
			sessions: count,
			payloadBytes,
			startupMs,
			updateMs,
			localCpuMs: threadCpuMs() - cpu,
			// Faux workers never call a provider. Do not conflate these numbers with request/provider latency.
			providerMs: 0,
			ticks,
			controls,
			maxHeartbeatMs,
			maxControlMs,
			maxLoopDelayMs: histogram.max / 1e6,
			busyStalls: watchdog.snapshot().stalls.busy,
			sleepPauses: watchdog.snapshot().stalls.sleep,
		};
		await sessions["lifecycle"].flush();
		for (const id of ids) {
			const rows = (await readFile(join(home, "sessions", id, LIFECYCLE_FILE), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; reason: string; state: string });
			const starts = rows.filter((row) => row.kind.startsWith("worker.start"));
			assert.deepEqual(
				starts.map((row) => row.kind),
				["worker.start.requested", "worker.started"],
			);
			assert.deepEqual(
				rows
					.filter((row) => row.kind === "pause.changed" && row.reason === "update")
					.map((row) => row.state)
					.slice(-2),
				["paused", "resumed"],
			);
			const commands = requests.get(id)!;
			const pause = commands.findIndex((command) => command.type === "update.pause");
			assert.ok(pause >= 0 && commands.findIndex((command) => command.type === "update.resume") > pause);
		}
		return metrics;
	} finally {
		for (const open of release.splice(0)) open();
		stopped = true;
		clearInterval(timer);
		watchdog.stop();
		histogram.disable();
		await probing?.catch(() => {});
		agent.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await sessions.shutdown();
		await Promise.allSettled(sessions["starting"].values());
		await rm(home, { recursive: true, force: true });
	}
}

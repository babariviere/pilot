/**
 * Environment setup service (docs/environment-setup.md). Constructed only when the host advertises
 * DaemonCapabilities.environmentSetup; routes answer environment_unavailable otherwise.
 */
import { Worker } from "node:worker_threads";
import type { EnvironmentDiscovery } from "@pilot/protocol";
import { ServiceUnavailable } from "./errors.ts";
import type { ProjectStore } from "./projects.ts";
import { type Runner, run } from "./workspaces.ts";

interface Flight {
	resolve(value: EnvironmentDiscovery): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/** One idle-reclaimed worker thread for discovery, with a bounded queue. */
export class DiscoveryWorker {
	private worker?: Worker;
	private readonly pending = new Map<number, Flight>();
	private nextId = 0;
	private idle?: ReturnType<typeof setTimeout>;
	private readonly idleMs: number;
	private readonly timeoutMs: number;

	constructor(options: { idleMs?: number; timeoutMs?: number } = {}) {
		this.idleMs = options.idleMs ?? 30_000;
		this.timeoutMs = options.timeoutMs ?? 30_000;
	}

	discover(projectId: string, root: string): Promise<EnvironmentDiscovery> {
		if (this.pending.size >= 4) return Promise.reject(new ServiceUnavailable("Environment discovery is busy"));
		clearTimeout(this.idle);
		const worker = this.worker ?? this.start();
		worker.ref();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => void this.close(new ServiceUnavailable("Environment discovery timed out")),
				this.timeoutMs,
			);
			this.pending.set(id, { resolve, reject, timer });
			worker.postMessage({ id, projectId, root });
		});
	}

	async close(error = new Error("Environment discovery closed")): Promise<void> {
		clearTimeout(this.idle);
		const worker = this.worker;
		this.worker = undefined;
		for (const flight of this.pending.values()) {
			clearTimeout(flight.timer);
			flight.reject(error);
		}
		this.pending.clear();
		if (worker) await worker.terminate();
	}

	private start(): Worker {
		const worker = new Worker(new URL("./environment-discovery-worker.ts", import.meta.url));
		this.worker = worker;
		worker.on("message", (reply: { id: number; result?: EnvironmentDiscovery; error?: string }) => {
			if (this.worker !== worker) return;
			const flight = this.pending.get(reply.id);
			if (!flight) return;
			this.pending.delete(reply.id);
			clearTimeout(flight.timer);
			if (reply.result) flight.resolve(reply.result);
			else flight.reject(new Error(reply.error ?? "Environment discovery failed"));
			if (!this.pending.size) {
				worker.unref();
				this.idle = setTimeout(() => void this.close(), this.idleMs);
				this.idle.unref();
			}
		});
		worker.on("error", (error) => {
			if (this.worker === worker) void this.close(error);
		});
		worker.on("exit", () => {
			if (this.worker === worker) void this.close(new Error("Environment discovery stopped"));
		});
		return worker;
	}
}

export class EnvironmentService {
	private readonly projects: ProjectStore;
	private readonly discoveries: DiscoveryWorker;
	/** Concurrent requests for one project share a read. */
	private readonly inFlight = new Map<string, Promise<EnvironmentDiscovery>>();

	private readonly git: Runner;

	constructor(projects: ProjectStore, options: { discoveries?: DiscoveryWorker; git?: Runner } = {}) {
		this.projects = projects;
		this.discoveries = options.discoveries ?? new DiscoveryWorker();
		this.git = options.git ?? run;
	}

	/** Read-only discovery from the project's checkout on this host. */
	discover(projectId: string): Promise<EnvironmentDiscovery> {
		const project = this.projects.require(projectId);
		const key = `${project.id}\0${project.path}`;
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const read = this.discoveries
			.discover(project.id, project.path)
			.then(async (discovery) => ({
				...discovery,
				localFiles: await ignoredFiles(project.path, discovery.localFiles, this.git),
			}))
			.finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, read);
		return read;
	}

	async close(): Promise<void> {
		await this.discoveries.close();
	}
}

/**
 * The names Git ignores in the checkout, like copyLocalConfigs. Git runs with the repository's fsmonitor disabled
 * and no file is opened. Outside a Git checkout, or on any failure, nothing is suggested.
 */
export async function ignoredFiles(root: string, names: string[], git: Runner = run): Promise<string[]> {
	if (!names.length) return [];
	try {
		const output = await git(
			"git",
			[
				"-c",
				"core.fsmonitor=false",
				"ls-files",
				"--others",
				"--ignored",
				"--exclude-standard",
				"-z",
				"--",
				...names,
			],
			root,
			5000,
		);
		const ignored = new Set(output.split("\0"));
		return names.filter((name) => ignored.has(name));
	} catch {
		return [];
	}
}

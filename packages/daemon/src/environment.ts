/**
 * Environment setup service (docs/environment-setup.md). Constructed only when the host advertises
 * DaemonCapabilities.environmentSetup; routes answer environment_unavailable otherwise.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
	EnvironmentDiscovery,
	EnvironmentHostRef,
	EnvironmentPlan,
	EnvironmentToolCatalog,
	Project,
	ReviewPin,
} from "@pilot/protocol";
import { computeEnvironmentPlan } from "./environment-plan.ts";
import { miseRegistry, type ProbeDeps, type ProbeHost, probeDeps, probeHost } from "./environment-probes.ts";
import { effectiveEnvironment } from "./environment-profile.ts";
import type { EnvironmentStateStore } from "./environment-state.ts";
import { ServiceUnavailable } from "./errors.ts";
import type { ProjectStore } from "./projects.ts";
import { scopedPath } from "./repository-browser.ts";
import { type Runner, run } from "./workspaces.ts";

/** Reviewed files larger than this count as changed; review covers readable scripts, not artifacts. */
const REVIEW_FILE_BYTES = 4 * 1024 * 1024;

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

export interface EnvironmentServiceOptions {
	/** Pilot's data directory: holds the neutral probe directory and is never searched for tools. */
	home: string;
	host: EnvironmentHostRef;
	state?: EnvironmentStateStore;
	discoveries?: DiscoveryWorker;
	/** Runs git for local file suggestions. */
	git?: Runner;
	probes?: ProbeDeps;
	/** Overrides for tests: user home, PATH entries and mise data directory. */
	probeHost?: Partial<Pick<ProbeHost, "home" | "path" | "platform" | "miseDataDir">>;
	now?: () => number;
}

export class EnvironmentService {
	private readonly projects: ProjectStore;
	private readonly options: EnvironmentServiceOptions;
	private readonly discoveries: DiscoveryWorker;
	/** Concurrent requests for one project share a read or a plan. */
	private readonly inFlight = new Map<string, Promise<EnvironmentDiscovery>>();
	private readonly planning = new Map<string, Promise<EnvironmentPlan>>();
	/** The host's mise registry changes only when mise does; read it at most every ten minutes. */
	private catalog?: { at: number; value: Promise<EnvironmentToolCatalog> };

	private readonly git: Runner;

	constructor(projects: ProjectStore, options: EnvironmentServiceOptions) {
		this.projects = projects;
		this.options = options;
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

	/** Probe this host and compute the install plan for the saved profile. Changes nothing on the host. */
	plan(projectId: string): Promise<EnvironmentPlan> {
		const project = this.projects.require(projectId);
		const existing = this.planning.get(project.id);
		if (existing) return existing;
		const plan = this.computePlan(project).finally(() => this.planning.delete(project.id));
		this.planning.set(project.id, plan);
		return plan;
	}

	/** Tool names from the host's mise registry, for adding tools. Read-only; runs only the user's mise. */
	tools(): Promise<EnvironmentToolCatalog> {
		const now = (this.options.now ?? Date.now)();
		if (this.catalog && now - this.catalog.at < 10 * 60_000) return this.catalog.value;
		const value = this.probeHost().then(async (host) => {
			const registry = await miseRegistry(host, this.options.probes ?? probeDeps);
			return { mise: registry.mise !== undefined, tools: registry.tools };
		});
		this.catalog = { at: now, value };
		// A failed read is not cached.
		value.catch(() => {
			if (this.catalog?.value === value) this.catalog = undefined;
		});
		return value;
	}

	private async probeHost(checkout?: string): Promise<ProbeHost> {
		const neutralDir = join(this.options.home, "environment", "probe");
		await mkdir(neutralDir, { recursive: true, mode: 0o700 });
		const overrides = this.options.probeHost ?? {};
		const roots = [this.options.home, ...(checkout ? [checkout] : [])];
		const home = overrides.home ?? process.env.HOME ?? homedir();
		return {
			platform: overrides.platform ?? this.options.host.platform,
			home,
			path: overrides.path ?? (process.env.PATH ?? "").split(delimiter).filter(Boolean),
			miseDataDir:
				overrides.miseDataDir ??
				process.env.MISE_DATA_DIR ??
				join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "mise"),
			neutralDir,
			excluded: [
				...new Set([...roots, ...(await Promise.all(roots.map((root) => realpath(root).catch(() => root))))]),
			],
		};
	}

	private async computePlan(project: Project): Promise<EnvironmentPlan> {
		// Plans always use this host's effective profile: the shared layer with its override applied.
		const profile = effectiveEnvironment(project.environment, project.environmentOverride);
		const host = await this.probeHost(project.path);
		const [probes, goTools, reviews, catalog] = await Promise.all([
			probeHost(host, profile?.tools ?? [], profile?.services ?? [], this.options.probes ?? probeDeps),
			profile?.tools.length ? this.goTools(project.id) : Promise.resolve({}),
			this.reviewState(project),
			profile?.tools.length ? this.tools().catch(() => undefined) : Promise.resolve(undefined),
		]);
		const plan = computeEnvironmentPlan({
			projectId: project.id,
			host: this.options.host,
			...(profile ? { profile } : {}),
			probes,
			overrideRevision: project.environmentOverride?.revision ?? 0,
			...(catalog?.tools.length ? { registry: catalog.tools } : {}),
			goTools,
			reviews,
			now: (this.options.now ?? Date.now)(),
		});
		const result = probes.exhausted ? { ...plan, incomplete: true as const } : plan;
		await this.options.state
			?.update(project.id, { plan: result })
			.catch((error: unknown) => console.warn(`pilotd: environment plan for ${project.id} not kept: ${error}`));
		return result;
	}

	/** go.mod tool directives and their module versions, from discovery. */
	private async goTools(projectId: string): Promise<Record<string, string>> {
		try {
			const discovery = await this.discover(projectId);
			return Object.fromEntries(
				discovery.subjects.flatMap((subject) =>
					subject.findings
						.filter(
							(finding) => finding.note === "provided by go tool" && finding.kind === "exact" && finding.value,
						)
						.map((finding) => [subject.subject, finding.value!]),
				),
			);
		} catch {
			return {};
		}
	}

	/** Files whose checkout content differs from each review pin. */
	private async reviewState(project: Project): Promise<Record<string, string[]>> {
		const pins: [string, ReviewPin][] = [];
		const profile = effectiveEnvironment(project.environment, project.environmentOverride);
		for (const step of profile?.steps ?? []) if (step.review) pins.push([step.id, step.review]);
		for (const service of profile?.services ?? [])
			if (service.compose?.review) pins.push([`service:${service.id}`, service.compose.review]);
		const entries = await Promise.all(
			pins.map(async ([key, pin]) => {
				const changed: string[] = [];
				for (const file of pin.files)
					if ((await hashCheckoutFile(project.path, file.path)) !== file.sha256) changed.push(file.path);
				return [key, changed] as const;
			}),
		);
		return Object.fromEntries(entries);
	}

	async close(): Promise<void> {
		await this.discoveries.close();
		await Promise.allSettled([...this.planning.values()]);
		await this.options.state?.flush();
	}
}

/** SHA-256 of a regular checkout file without following links, or undefined when it can't be read. */
export async function hashCheckoutFile(root: string, path: string): Promise<string | undefined> {
	try {
		const canonical = await scopedPath(root, path);
		const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size > REVIEW_FILE_BYTES) return undefined;
			const bytes = Buffer.alloc(info.size);
			let read = 0;
			while (read < info.size) {
				const { bytesRead } = await handle.read(bytes, read, info.size - read, read);
				if (!bytesRead) break;
				read += bytesRead;
			}
			return createHash("sha256").update(bytes.subarray(0, read)).digest("hex");
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
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

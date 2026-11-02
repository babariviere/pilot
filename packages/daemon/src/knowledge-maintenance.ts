/** Bounded source observation and coordinator batching. Never runs a model or writes repository content. */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type {
	KnowledgeCheckInput,
	KnowledgeObservation,
	KnowledgeObservationResult,
	KnowledgeSource,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import type { KnowledgeProjects, KnowledgeSessions } from "./project-knowledge.ts";
import { execFileOffThread } from "./subprocess.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type RepositoryObservation = (root: string, paths: string[]) => Promise<Map<string, string>>;

/** One local head snapshot plus bounded path chunks. No fetch, checkout, bodies or live-file traversal. */
export const observeRepository: RepositoryObservation = async (root, paths) => {
	const options = { cwd: root, timeoutMs: 10_000, maxBytes: 1024 * 1024 };
	const tree = (await execFileOffThread("/usr/bin/git", ["rev-parse", "--verify", "HEAD^{tree}"], options)).trim();
	if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error("Invalid repository tree");
	const versions = new Map<string, string>();
	// Bound argv as well as output. All chunks name the same immutable tree, not moving HEADs.
	for (let start = 0; start < paths.length; start += 24) {
		const output = await execFileOffThread(
			"/usr/bin/git",
			["--literal-pathspecs", "ls-tree", "-t", "-z", "--full-tree", tree, "--", ...paths.slice(start, start + 24)],
			options,
		);
		for (const row of output.split("\0")) {
			const tab = row.indexOf("\t");
			if (tab < 0) continue;
			const [mode, kind, oid] = row.slice(0, tab).split(" ");
			if (mode === "120000" || kind === "commit") continue; // No symlink/submodule target coverage.
			versions.set(row.slice(tab + 1), `${mode}:${kind}:${oid}`);
		}
	}
	return versions;
};

export class KnowledgeMaintenance {
	private readonly store: MissionStore;
	private readonly projects: KnowledgeProjects;
	private readonly sessions: KnowledgeSessions;
	private readonly repository: RepositoryObservation;
	private stopListening?: () => void;
	private stopArtifacts?: () => void;
	private running?: Promise<void>;
	private readonly queued = new Set<string>();
	private readonly active = new Set<Promise<unknown>>();
	private closed = false;
	constructor(
		store: MissionStore,
		projects: KnowledgeProjects,
		sessions: KnowledgeSessions,
		repository: RepositoryObservation = observeRepository,
	) {
		this.store = store;
		this.projects = projects;
		this.sessions = sessions;
		this.repository = repository;
	}

	/** Startup/reconnect recovery is a source-version scan, never a model scan or a GET side effect. */
	start(): void {
		if (this.stopListening || this.closed) return;
		this.stopListening = this.store.onKnowledgeChange((projectId) => this.hint(projectId));
		this.stopArtifacts = this.sessions.onArtifactsChanged?.((sessionId) => {
			const projectId = this.sessions.get(sessionId)?.projectId;
			if (projectId) this.hint(projectId);
		});
		this.hint("*");
	}

	/** In-memory hints may be lost; durable observations and startup/explicit reconciliation recover them. */
	hint(projectId: string): void {
		if (!this.stopListening || this.closed) return;
		if (projectId === "*") this.queued.clear();
		else if (this.queued.has("*")) return;
		this.queued.add(projectId);
		if (this.running) return;
		this.running = this.drain().finally(() => {
			this.running = undefined;
			if (!this.closed && this.queued.size) this.hint(this.queued.values().next().value!);
		});
	}

	private async drain(): Promise<void> {
		await yieldTurn(); // Coalesce related synchronous deliveries/decisions.
		while (!this.closed && this.queued.size) {
			const project = this.queued.values().next().value!;
			this.queued.delete(project);
			let after = "";
			while (!this.closed) {
				const batch = this.store.knowledge.maintenanceEntries(after, project === "*" ? undefined : project);
				if (!batch.length) break;
				after = batch.at(-1)!.id;
				for (const projectId of new Set(batch.map((entry) => entry.projectId))) {
					try {
						await this.observeKnowledgeSources(
							projectId,
							batch.filter((e) => e.projectId === projectId).map((e) => e.id),
						);
					} catch (error) {
						console.warn(
							`pilotd: knowledge observation failed: ${error instanceof Error ? error.message : "unavailable"}`,
						);
					}
				}
				await yieldTurn();
			}
		}
	}

	async stop(): Promise<void> {
		this.closed = true;
		this.stopListening?.();
		this.stopArtifacts?.();
		this.stopListening = undefined;
		this.queued.clear();
		await this.running;
		await Promise.allSettled([...this.active]);
	}

	private admitted<T>(work: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Conflict("Knowledge maintenance is closed"));
		const operation = work();
		this.active.add(operation);
		void operation.then(
			() => this.active.delete(operation),
			() => this.active.delete(operation),
		);
		return operation;
	}

	private admit(projectId: string, ids: string[]): void {
		this.projects.require(projectId);
		if (!Array.isArray(ids) || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length)
			throw new Error("Observe 1-50 distinct entry IDs per batch");
		for (const id of ids)
			if (!this.store.knowledge.summary(projectId, id))
				throw new NotFound("Knowledge entry not found in this project");
	}

	/** Host-only implementation, reached by the supervised writer action, never HTTP GET/Refresh. */
	observeKnowledgeSources(projectId: string, ids: string[]): Promise<KnowledgeObservationResult[]> {
		return this.admitted(() => this.observe(projectId, ids));
	}

	private async observe(projectId: string, ids: string[]): Promise<KnowledgeObservationResult[]> {
		this.admit(projectId, ids);
		const details = ids.map((id) => this.store.knowledge.detail(projectId, id)!);
		const generations = new Map(ids.map((id) => [id, this.store.knowledge.pendingGeneration(id)]));
		const paths = [
			...new Set(
				details.flatMap((d) =>
					d.revision.sources
						.filter((s) => s.type === "repository")
						.map((s) => posix.normalize(s.path).replace(/\/$/, "")),
				),
			),
		];
		let repository: Map<string, string> | undefined;
		if (paths.length) {
			try {
				const project = this.projects.require(projectId) as { path?: string };
				if (project.path) repository = await this.repository(project.path, paths);
			} catch {
				/* Unavailable coverage is retained below, not treated as an empty tree. */
			}
		}
		const cache = new Map<string, Promise<KnowledgeObservation["sources"][number]>>();
		const results: KnowledgeObservationResult[] = [];
		for (const detail of details) {
			const sources: KnowledgeObservation["sources"] = [];
			for (const source of detail.revision.sources) {
				const key = hash(source); // Exact registered ref, including pin/coverage metadata.
				let read = cache.get(key);
				if (!read) {
					read = this.source(projectId, source, key, repository);
					cache.set(key, read);
				}
				sources.push(await read);
			}
			this.admit(projectId, [detail.entry.id]); // Access and current entry revision after all awaits.
			try {
				this.store.knowledge.observe(
					projectId,
					detail.entry.id,
					{ revision: detail.revision.revision, at: Date.now(), sources },
					generations.get(detail.entry.id)!,
				);
				results.push(this.capture(projectId, detail.entry.id));
			} catch (error) {
				this.store.knowledge.recordFailure(
					projectId,
					detail.entry.id,
					"Entry changed during observation; reconcile again",
				);
				results.push({ id: detail.entry.id, error: error instanceof Error ? error.message : "Observation failed" });
			}
		}
		await this.store.durable();
		return results;
	}

	private async source(
		projectId: string,
		source: KnowledgeSource,
		key: string,
		repository?: Map<string, string>,
	): Promise<KnowledgeObservation["sources"][number]> {
		try {
			switch (source.type) {
				case "repository": {
					const path = posix.normalize(source.path).replace(/\/$/, "");
					const version = repository?.get(path) ?? null;
					return {
						key,
						version,
						coverage: "Committed Git object only; live edits, symlink and submodule targets excluded",
					};
				}
				case "mission":
					return {
						key,
						version: hash(this.store.knowledge.missionSourceVersion(source, projectId)),
						coverage: "Current canonical mission record; citation may be historical",
					};
				case "knowledge": {
					const entry = this.store.knowledge.summary(projectId, source.knowledgeId);
					if (!entry || !this.store.knowledge.hasRevision(projectId, source.knowledgeId, source.revision))
						throw new NotFound("Unavailable knowledge source");
					return {
						key,
						version: String(entry.revision),
						coverage: "Current knowledge revision; original cited revision retained",
					};
				}
				case "artifact": {
					if (this.sessions.get(source.sessionId)?.projectId !== projectId)
						throw new NotFound("Unavailable artifact owner");
					await this.sessions.artifact(source.sessionId, source.artifactId, source.revision);
					const latest = await this.sessions.artifact(source.sessionId, source.artifactId);
					if (this.sessions.get(source.sessionId)?.projectId !== projectId)
						throw new Conflict("Artifact owner moved");
					return {
						key,
						version: String(latest.revision),
						coverage: "Latest artifact pointer and exact citation available; not a revision catalogue",
					};
				}
				case "web":
					return { key, version: null, coverage: "External web source not observed" };
			}
		} catch {
			return { key, version: null, coverage: `${source.type} source unavailable` };
		}
	}

	capture(projectId: string, id: string): KnowledgeCheckInput {
		const entry = this.store.knowledge.detail(projectId, id);
		if (!entry?.observation) throw new Conflict("Observe the current entry first");
		const pendingGeneration = this.store.knowledge.pendingGeneration(id);
		const revision = entry.revision.revision;
		return {
			id,
			revision,
			pendingGeneration,
			observationToken: hash([projectId, id, revision, pendingGeneration, entry.observation.sources]),
		};
	}

	/** A writer asserts a scoped content check. Re-observe before CAS; an observation alone is never a check. */
	recordCheck(projectId: string, input: KnowledgeCheckInput, checker: string, coverage: string): Promise<void> {
		return this.admitted(() => this.check(projectId, input, checker, coverage));
	}

	private async check(
		projectId: string,
		input: KnowledgeCheckInput,
		checker: string,
		coverage: string,
	): Promise<void> {
		this.admit(projectId, [input.id]);
		await this.observe(projectId, [input.id]);
		const current = this.capture(projectId, input.id);
		const observation = this.store.knowledge.observation(input.id)!;
		if (
			current.revision !== input.revision ||
			current.pendingGeneration !== input.pendingGeneration ||
			current.observationToken !== input.observationToken ||
			observation.sources.some((s) => s.version === null) ||
			!observation.sources.length
		) {
			this.store.knowledge.recordFailure(
				projectId,
				input.id,
				"Stale or unavailable check inputs; pending work retained",
			);
			await this.store.durable();
			throw new Conflict("Stale or unavailable check inputs; observe and check the current sources again");
		}
		this.store.knowledge.recordCheck(projectId, input.id, {
			revision: input.revision,
			pendingGeneration: input.pendingGeneration,
			checker,
			coverage,
			sourceVersions: observation.sources,
		});
		await this.store.durable();
	}
}

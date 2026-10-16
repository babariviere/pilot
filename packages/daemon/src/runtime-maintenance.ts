import { type FSWatcher, watch } from "node:fs";
import { dirname, join } from "node:path";
import type { DaemonHello } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { durableJSON } from "./operation-journal.ts";
import type { RuntimeResources } from "./runtime-admission.ts";
import {
	fencedPhases,
	processIdentity,
	publicUpdate,
	readUpdate,
	sameProcess,
	updatePath,
} from "./runtime-update-journal.ts";
import type { SessionManager } from "./sessions.ts";

/** The daemon owns live admission holds; the independent systemd updater owns durable intent. */
export class RuntimeMaintenance {
	private releaseSessions?: () => void;
	private releaseResources?: () => void;
	private resources?: RuntimeResources;
	private watcher?: FSWatcher;
	private inspecting = false;
	private refreshing?: Promise<void>;
	private dirty = false;
	private stopped = false;
	private opened = new Set<() => void>();
	private readonly home: string;
	private readonly hello: DaemonHello;
	private readonly sessions: SessionManager;
	private readonly identify: typeof processIdentity;
	constructor(home: string, hello: DaemonHello, sessions: SessionManager, identify = processIdentity) {
		this.home = home;
		this.hello = hello;
		this.sessions = sessions;
		this.identify = identify;
	}
	get frozen(): boolean {
		return !!this.releaseSessions;
	}
	async load(): Promise<void> {
		await this.refresh(); // Before SessionManager.load, delegation recovery or schedules.
		this.watcher = watch(dirname(updatePath(this.home)), () => {
			this.dirty = true;
			void this.refresh().catch(() => this.freeze()); // Invalid/unreadable intent fails closed.
		});
		this.watcher.unref();
	}
	bind(resources: RuntimeResources): void {
		this.resources = resources;
		if (this.frozen) this.releaseResources = resources.freezeAdmissions();
	}
	onOpen(action: () => void): () => void {
		this.opened.add(action);
		return () => {
			this.opened.delete(action);
		};
	}
	private freeze(): void {
		this.releaseSessions ??= this.sessions.freezeAdmissions();
		if (this.resources) this.releaseResources ??= this.resources.freezeAdmissions();
	}
	private async release(): Promise<void> {
		this.releaseResources?.();
		this.releaseResources = undefined;
		this.releaseSessions?.();
		this.releaseSessions = undefined;
		await this.sessions.resumeMaintenance();
		for (const action of this.opened) action();
	}
	private refresh(): Promise<void> {
		this.dirty = true;
		this.refreshing ??= (async () => {
			do {
				this.dirty = false;
				const journal = await readUpdate(this.home);
				if (this.stopped) return;
				if (journal && (journal.daemonId !== this.hello.daemonId || journal.lineageId !== this.hello.lineageId)) {
					this.freeze();
					throw new Conflict("Update belongs to a different host history");
				}
				if (journal && fencedPhases.has(journal.phase)) this.freeze();
				// Only readable, explicit non-maintenance intent releases an existing owner.
				// A disappeared file cannot prove that its previously known transaction ended.
				else if (this.frozen && journal) await this.release();
			} while (this.dirty);
		})().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}
	async status(id?: string) {
		let journal = await readUpdate(this.home);
		if (id && journal?.id !== id) journal = await readUpdate(this.home, id);
		if (journal && (journal.daemonId !== this.hello.daemonId || journal.lineageId !== this.hello.lineageId))
			throw new Conflict("Update belongs to a different host history");
		return journal ? publicUpdate(journal) : null;
	}
	async cancel(id: string) {
		const journal = await readUpdate(this.home);
		if (
			!journal ||
			journal.id !== id ||
			!["staged", "requested", "waiting", "draining", "ready"].includes(journal.phase)
		)
			throw new Conflict("This update can no longer be cancelled");
		// A request, not an invented cancellation acknowledgment. Only the locked remote owner settles it.
		await durableJSON(join(dirname(updatePath(this.home)), "cancel.json"), { id });
		return { id, requested: true };
	}
	async inspect(id: string, commit = false) {
		if (this.inspecting) throw new Conflict("Update inspection is already running");
		this.inspecting = true;
		const wasFrozen = this.frozen;
		let observedIntent = false;
		this.freeze(); // Before the first await, including queued transfer/terminal creation.
		try {
			const journal = await readUpdate(this.home);
			observedIntent = journal !== undefined;
			if (
				!journal ||
				journal.id !== id ||
				!["draining", "ready", "stopping", "validating"].includes(journal.phase) ||
				journal.daemonId !== this.hello.daemonId ||
				journal.lineageId !== this.hello.lineageId
			)
				throw new Conflict("Update intent does not match this host");
			const identity = await this.identify();
			if (commit && (!sameProcess(journal.process, identity) || journal.phase !== "ready"))
				throw new Conflict("Service process changed; drain it again before restarting");
			if (!this.resources) throw new Conflict("Runtime resource inspection is unavailable");
			const paused = this.sessions.pauseForUpdate();
			if (!paused.ready)
				return { ready: false, process: identity, blockers: [{ kind: "tool-drain", id: "agents" }] };
			const snapshot = await this.resources.blockers();
			const blockers =
				snapshot.length > 1024
					? [...snapshot.slice(0, 1023), { kind: "unknown-process", id: "blocker-overflow" }]
					: snapshot;
			// A journal update during inspection invalidates the proof, even if the id matches.
			const current = await readUpdate(this.home);
			if (current?.id !== id || current.revision !== journal.revision || !this.frozen)
				throw new Conflict("Update changed while inspecting running work");
			return { ready: blockers.length === 0, process: identity, blockers };
		} catch (error) {
			if (!wasFrozen) {
				let safeToRelease = false;
				try {
					const journal = await readUpdate(this.home);
					// Missing on both reads is an unowned request. A vanished known intent,
					// unreadable/corrupt state or foreign history is not permission to resume.
					safeToRelease = journal
						? journal.daemonId === this.hello.daemonId &&
							journal.lineageId === this.hello.lineageId &&
							!fencedPhases.has(journal.phase)
						: !observedIntent;
				} catch {
					// Preserve the original inspection failure and its maintenance holds.
				}
				if (safeToRelease) await this.release();
			}
			throw error;
		} finally {
			this.inspecting = false;
		}
	}
	close(): void {
		this.stopped = true;
		this.watcher?.close();
	}
}

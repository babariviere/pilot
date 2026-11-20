/** Immutable revisions plus an atomic latest pointer. The session worker is the sole writer. */
import { randomUUID } from "node:crypto";
import type { Dir, Dirent, Stats } from "node:fs";
import { lstat, mkdir, open, opendir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactRevision, ArtifactSummary, ArtifactWrite } from "@pilot/protocol";
import { assertArtifactWriteKind, isArtifactKind, prepareArtifact, prepareArtifactWrite } from "./render.ts";
import {
	ArtifactNotFound,
	artifactSummary,
	parseStoredArtifactRevision,
	readStoredFile,
	STORED_REVISION_LIMITS,
} from "./stored-revision.ts";

export { ArtifactNotFound } from "./stored-revision.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type SearchMetadata = Pick<ArtifactSummary, "id" | "sessionId" | "title" | "kind" | "revision" | "updatedAt">;

async function plainDirectory(path: string): Promise<Stats> {
	const info = await lstat(path);
	if (!info.isDirectory()) throw new Error("Unsafe artifact directory");
	return info;
}

async function checkDirectory(path: string, before: Stats): Promise<void> {
	const current = await plainDirectory(path);
	if (current.dev !== before.dev || current.ino !== before.ino) throw new Error("Artifact directory changed");
}

/** Flush data before the rename and the directory entry after it, so a crash or power loss
 * leaves either the previous file or the complete new one, never an empty replacement. */
async function atomicJson(path: string, value: unknown, directory: string): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`;
	const file = await open(temp, "w", 0o600);
	try {
		await file.writeFile(JSON.stringify(value));
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temp, path);
	const parent = await open(directory, "r");
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}

/** Image revisions keep their bytes once, in source; the identical image document is rebuilt on read. */
const DERIVED_IMAGE_HTML = "";

export class ArtifactStore {
	private readonly directory: string;
	private writes: Promise<unknown> = Promise.resolve();

	private readonly identity: { sessionId: string; projectId?: string };

	constructor(sessionDir: string, identity: { sessionId: string; projectId?: string }) {
		this.identity = identity;
		this.directory = join(sessionDir, "artifacts");
	}

	async list(): Promise<ArtifactSummary[]> {
		let names: string[];
		try {
			names = await readdir(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const items = await Promise.all(
			names
				.filter((name) => ID.test(name))
				.map(async (id): Promise<ArtifactSummary | undefined> => {
					try {
						const item = JSON.parse(
							await readFile(join(this.directory, id, "latest.json"), "utf8"),
						) as ArtifactSummary;
						return item.id === id && item.sessionId === this.identity.sessionId && isArtifactKind(item.kind)
							? artifactSummary(item)
							: undefined;
					} catch (error) {
						// An interrupted first publication has no latest pointer and is not visible. One damaged
						// pointer must not hide every other artifact in the session or project.
						if ((error as NodeJS.ErrnoException).code !== "ENOENT")
							console.warn(`pilot: skipping unreadable artifact ${id}: ${error}`);
						return undefined;
					}
				}),
		);
		return items
			.filter((item): item is ArtifactSummary => item !== undefined)
			.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
	}

	/** Resume the directory itself, not an offset that would reread the entire prefix. */
	searchMetadata() {
		const sessionDir = dirname(this.directory);
		const sessionRoot = dirname(sessionDir);
		let dir: Dir | undefined;
		let identity: { root: Stats; session: Stats; storage: Stats } | undefined;
		let pending: Dirent | undefined;
		const close = async () => {
			const opened = dir;
			dir = undefined;
			await opened?.close();
		};
		const checkParents = async () => {
			if (!identity) throw new Error("Artifact inventory unavailable");
			await checkDirectory(sessionRoot, identity.root);
			await checkDirectory(sessionDir, identity.session);
			await checkDirectory(this.directory, identity.storage);
		};
		const read = async (entryLimit: number) => {
			const rows: SearchMetadata[] = [];
			let visited = 0;
			let partial = false;
			try {
				if (!dir) {
					const root = await plainDirectory(sessionRoot);
					const session = await plainDirectory(sessionDir);
					const storage = await plainDirectory(this.directory).catch((error) => {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					});
					if (!storage) return { rows, visited, more: false, partial };
					identity = { root, session, storage };
					dir = await opendir(this.directory, { bufferSize: 8 });
				}
				await checkParents();
				let entry = pending ?? (await dir.read());
				while (entry && visited < entryLimit) {
					visited++;
					const current = entry;
					entry = await dir.read();
					if (!ID.test(current.name)) continue;
					try {
						const directory = join(this.directory, current.name);
						const before = await plainDirectory(directory);
						const latest = await this.readLatestPointer(current.name).catch((error) => {
							// No commit marker after an interrupted first save.
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						});
						await checkDirectory(directory, before);
						if (latest === undefined) continue;
						const { id, sessionId, title, kind, revision, updatedAt, createdAt, projectId } = latest;
						if (!isArtifactKind(kind)) continue;
						if (
							id !== current.name ||
							sessionId !== this.identity.sessionId ||
							// Older pointers did not name a project. Current exact session ownership is still required.
							(projectId !== undefined && projectId !== this.identity.projectId) ||
							typeof title !== "string" ||
							!Number.isSafeInteger(revision) ||
							revision < 1 ||
							!Number.isSafeInteger(createdAt) ||
							createdAt < 0 ||
							!Number.isSafeInteger(updatedAt) ||
							updatedAt < 0
						) {
							partial = true;
							continue;
						}
						rows.push({ id, sessionId, title, kind, revision, updatedAt });
					} catch {
						partial = true;
					}
				}
				await checkParents();
				pending = entry ?? undefined;
				if (!pending) await close();
				return { rows, visited, more: pending !== undefined, partial };
			} catch {
				// Ambiguous inventory root or incomplete traversal. Do not disclose rows from it.
				await close().catch(() => undefined);
				return { rows: [], visited, more: false, partial: true };
			}
		};
		return { read, close };
	}

	private async readLatestPointer(id: string, signal?: AbortSignal): Promise<ArtifactSummary> {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				await readStoredFile(join(this.directory, id, "latest.json"), STORED_REVISION_LIMITS.pointerBytes, signal),
			),
		) as ArtifactSummary;
	}

	/** Read only the committed pointer, without loading or rendering the artifact body. */
	async summary(id: string): Promise<ArtifactSummary> {
		if (!ID.test(id)) throw new ArtifactNotFound("Unknown artifact");
		try {
			const latest = JSON.parse(await readFile(join(this.directory, id, "latest.json"), "utf8")) as ArtifactSummary;
			if (latest.sessionId !== this.identity.sessionId || latest.id !== id || !isArtifactKind(latest.kind))
				throw new ArtifactNotFound("Unknown artifact");
			return artifactSummary(latest);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArtifactNotFound("Unknown artifact");
			throw error;
		}
	}

	async get(id: string, revision?: number): Promise<ArtifactRevision> {
		if (!ID.test(id)) throw new ArtifactNotFound("Unknown artifact");
		if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
			throw new Error("Invalid artifact revision");
		try {
			const latest = await this.summary(id);
			if (revision !== undefined && revision > latest.revision)
				throw new ArtifactNotFound("Unknown artifact revision");
			if (latest.kind === "nsh") return (await this.readCapturedRevision(id, revision ?? latest.revision)).artifact;
			const value = JSON.parse(
				await readFile(join(this.directory, id, `${revision ?? latest.revision}.json`), "utf8"),
			) as ArtifactRevision;
			if (
				value.sessionId !== this.identity.sessionId ||
				value.id !== id ||
				value.revision !== (revision ?? latest.revision) ||
				value.kind !== "image"
			)
				throw new ArtifactNotFound("Unknown artifact");
			const { html } = await prepareArtifact({ title: value.title, kind: "image", source: value.source });
			return { ...artifactSummary(value), source: value.source, html };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new ArtifactNotFound("Unknown artifact or revision");
			throw error;
		}
	}

	/** Passive numbered container read for text inspection. Never prepares HTML, images or callbacks. */
	async readCapturedRevision(id: string, revision: number, signal?: AbortSignal) {
		if (!ID.test(id) || !Number.isSafeInteger(revision) || revision < 1)
			throw new Error("Invalid explicit artifact revision");
		try {
			const directory = join(this.directory, id);
			const latest = await this.readLatestPointer(id, signal);
			if (
				latest.id !== id ||
				latest.sessionId !== this.identity.sessionId ||
				latest.projectId !== this.identity.projectId ||
				!isArtifactKind(latest.kind) ||
				!Number.isSafeInteger(latest.revision) ||
				revision > latest.revision
			)
				throw new ArtifactNotFound("Unknown committed artifact revision");
			const bytes = await readStoredFile(
				join(directory, `${revision}.json`),
				STORED_REVISION_LIMITS.containerBytes,
				signal,
			);
			signal?.throwIfAborted();
			const stored = parseStoredArtifactRevision(bytes, { ...this.identity, id, revision });
			if (stored.artifact.kind !== latest.kind) throw new ArtifactNotFound("Unknown artifact revision");
			return stored;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new ArtifactNotFound("Unknown artifact revision");
			if (error instanceof SyntaxError) throw new SyntaxError("Invalid stored artifact JSON or UTF-8");
			throw error;
		}
	}

	create(write: ArtifactWrite, signal?: AbortSignal): Promise<ArtifactRevision> {
		return this.serialize(async () => this.publish(randomUUID(), write, undefined, signal));
	}

	update(
		id: string,
		write: ArtifactWrite,
		expectedRevision?: number,
		signal?: AbortSignal,
	): Promise<ArtifactRevision> {
		return this.serialize(async () => {
			assertArtifactWriteKind(write.kind);
			if (write.kind === "nsh" && expectedRevision === undefined)
				throw new Error("NSH updates require expectedRevision");
			const previous = await this.get(id);
			if ((previous.kind === "nsh" || write.kind === "nsh") && previous.kind !== write.kind)
				throw new Error("NSH artifact identity cannot change kind");
			if (expectedRevision !== undefined && previous.revision !== expectedRevision)
				throw new Error(`Artifact revision conflict: expected ${expectedRevision}, latest is ${previous.revision}`);
			return this.publish(id, write, previous, signal);
		});
	}

	private serialize<T>(write: () => Promise<T>): Promise<T> {
		const next = this.writes.catch(() => undefined).then(write);
		this.writes = next;
		return next;
	}

	private async publish(
		id: string,
		input: ArtifactWrite,
		previous?: ArtifactRevision,
		signal?: AbortSignal,
	): Promise<ArtifactRevision> {
		const { write, prepared } = await prepareArtifactWrite(input, { signal });
		signal?.throwIfAborted();
		const now = Date.now();
		const artifact: ArtifactRevision = {
			id,
			...this.identity,
			title: write.title,
			kind: write.kind,
			revision: (previous?.revision ?? 0) + 1,
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
			source: write.source,
			...prepared,
		};
		const directory = join(this.directory, id);
		if (
			artifact.kind === "nsh" &&
			Buffer.byteLength(JSON.stringify(artifact)) > STORED_REVISION_LIMITS.containerBytes
		)
			throw new Error("NSH revision exceeds the 1 MiB stored-container limit");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await atomicJson(
			join(directory, `${artifact.revision}.json`),
			artifact.kind === "image" ? { ...artifact, html: DERIVED_IMAGE_HTML } : artifact,
			directory,
		);
		await atomicJson(join(directory, "latest.json"), artifactSummary(artifact), directory);
		return artifact;
	}
}

/** Immutable revisions plus an atomic latest pointer. The session worker is the sole writer. */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRevision, ArtifactSummary, ArtifactWrite } from "@pilot/protocol";
import { libraryVersions, prepareArtifact, validateArtifact } from "./render.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ArtifactNotFound extends Error {}

function summary(value: ArtifactRevision): ArtifactSummary {
	const { source: _source, html: _html, libraries: _libraries, libraryVersions: _versions, ...rest } = value;
	return rest;
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
						return item.id === id && item.sessionId === this.identity.sessionId ? item : undefined;
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

	async get(id: string, revision?: number): Promise<ArtifactRevision> {
		if (!ID.test(id)) throw new ArtifactNotFound("Unknown artifact");
		if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
			throw new Error("Invalid artifact revision");
		try {
			const latest = JSON.parse(await readFile(join(this.directory, id, "latest.json"), "utf8")) as ArtifactSummary;
			if (latest.sessionId !== this.identity.sessionId || latest.id !== id)
				throw new ArtifactNotFound("Unknown artifact");
			if (revision !== undefined && revision > latest.revision)
				throw new ArtifactNotFound("Unknown artifact revision");
			const value = JSON.parse(
				await readFile(join(this.directory, id, `${revision ?? latest.revision}.json`), "utf8"),
			) as ArtifactRevision;
			if (value.sessionId !== this.identity.sessionId || value.id !== id)
				throw new ArtifactNotFound("Unknown artifact");
			if (value.kind === "image" && value.html === DERIVED_IMAGE_HTML)
				value.html = (await prepareArtifact({ title: value.title, kind: "image", source: value.source })).html;
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new ArtifactNotFound("Unknown artifact or revision");
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
			const previous = await this.get(id);
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
		const write = validateArtifact(input);
		const prepared = await prepareArtifact(write, { signal });
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
			libraryVersions: libraryVersions(prepared.libraries),
		};
		const directory = join(this.directory, id);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await atomicJson(
			join(directory, `${artifact.revision}.json`),
			artifact.kind === "image" ? { ...artifact, html: DERIVED_IMAGE_HTML } : artifact,
			directory,
		);
		await atomicJson(join(directory, "latest.json"), summary(artifact), directory);
		return artifact;
	}
}

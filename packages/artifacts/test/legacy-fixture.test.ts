/** Test-only historical disk fixture, excluded from runtime bundles. Never publishes. */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactKind, ArtifactRevision, ArtifactWrite } from "@pilot/protocol";
import { ArtifactStore } from "../src/store.ts";

type HistoricalWrite = Omit<ArtifactWrite, "kind"> & { kind: ArtifactKind };

export class LegacyArtifactFixture extends ArtifactStore {
	private readonly root: string;
	private readonly owner: { sessionId: string; projectId?: string };
	constructor(root: string, owner: { sessionId: string; projectId?: string }) {
		super(root, owner);
		this.root = root;
		this.owner = owner;
	}

	override async create(write: HistoricalWrite): Promise<ArtifactRevision> {
		return this.seed(randomUUID(), write);
	}

	override async update(id: string, write: HistoricalWrite, expectedRevision?: number): Promise<ArtifactRevision> {
		const previous = await this.get(id);
		if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new Error("Fixture conflict");
		return this.seed(id, write, previous);
	}

	private async seed(id: string, write: HistoricalWrite, previous?: ArtifactRevision): Promise<ArtifactRevision> {
		const now = Date.now();
		const value: ArtifactRevision = {
			...this.owner,
			...write,
			id,
			revision: (previous?.revision ?? 0) + 1,
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
			html: "<script>throw new Error('Legacy body must never execute')</script>",
			libraries: write.libraries ?? [],
			libraryVersions: write.libraries?.length ? { react: "historical-version" } : {},
		};
		const directory = join(this.root, "artifacts", id);
		await mkdir(directory, { recursive: true });
		const {
			source: _source,
			html: _html,
			libraries: _libraries,
			libraryVersions: _versions,
			data: _data,
			...summary
		} = value;
		await writeFile(join(directory, `${value.revision}.json`), JSON.stringify(value));
		await writeFile(join(directory, "latest.json"), JSON.stringify(summary));
		return value;
	}
}

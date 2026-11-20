/** Test-only historical disk fixture, excluded from runtime bundles. Never publishes. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRevision, ArtifactWrite } from "@pilot/protocol";

type HistoricalWrite = Omit<ArtifactWrite, "kind"> & {
	kind: "html" | "react" | "swiftui" | "shader" | "visual";
	data?: unknown;
	visual?: unknown;
	libraries?: string[];
};
type HistoricalRevision = Omit<ArtifactRevision, "kind"> &
	HistoricalWrite & { libraryVersions: Record<string, string> };

export class LegacyArtifactFixture {
	private readonly root: string;
	private readonly owner: { sessionId: string; projectId?: string };
	constructor(root: string, owner: { sessionId: string; projectId?: string }) {
		this.root = root;
		this.owner = owner;
	}

	async create(write: HistoricalWrite): Promise<HistoricalRevision> {
		return this.seed(randomUUID(), write);
	}

	async update(id: string, write: HistoricalWrite, expectedRevision?: number): Promise<HistoricalRevision> {
		const directory = join(this.root, "artifacts", id);
		const { revision } = JSON.parse(await readFile(join(directory, "latest.json"), "utf8"));
		const previous: HistoricalRevision = JSON.parse(await readFile(join(directory, `${revision}.json`), "utf8"));
		if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new Error("Fixture conflict");
		return this.seed(id, write, previous);
	}

	private async seed(id: string, write: HistoricalWrite, previous?: HistoricalRevision): Promise<HistoricalRevision> {
		const now = Date.now();
		const value: HistoricalRevision = {
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
			visual: _visual,
			...summary
		} = value;
		await writeFile(join(directory, `${value.revision}.json`), JSON.stringify(value));
		await writeFile(join(directory, "latest.json"), JSON.stringify(summary));
		return value;
	}
}

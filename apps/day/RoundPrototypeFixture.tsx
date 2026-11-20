// Headless test fixture only, never app runtime. No daemon, provider or
// storage. A topic round asking about a prototype, with a scripted artifact
// source: the card names the exact pinned revision and one press reads it once.
import { mount, signal } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { FullArtifact } from "./ArtifactShelf";
import type { ArtifactRow, ArtifactSource, ListResult, ReadResult } from "./artifactReads";
import { RoundPrototype } from "./RoundPrototype";
import { Column, Page, PageFoot, Panel, WindowCanvas } from "./ui";

const reads = signal<string[]>([]);
const item = {
	id: "today-recovery-design",
	title: "Prototype a clear Today update-error experience",
	question: "Which Today layout makes update failures unmistakable?",
	kind: "prototype",
	state: "asking",
	prototype: { sessionId: "chat-proto", artifactId: "variants", revision: 3 },
	prototypeCurrent: true,
	limits: "About $3, with faux/opus.",
};
const page = { explorations: [item] } as unknown as PlanPage;
const source: ArtifactSource = {
	async list(): Promise<ListResult> {
		return { ok: true, list: { rows: [], more: false } };
	},
	async read(row: ArtifactRow): Promise<ReadResult> {
		reads.update((all) => [...all, `${row.sessionId}/${row.artifactId}@${row.revision}`]);
		const text = "export default () => <Text>Variant A</Text>;";
		return {
			status: "shown",
			artifact: {
				version: 1,
				reference: { sourceSessionId: row.sessionId, artifactId: row.artifactId, revision: row.revision ?? 0 },
				metadata: { title: row.title, kind: row.kind },
				rendering: "unsupported",
				content: { state: "text", source: text, containerSha256: "a".repeat(64), containerBytes: text.length },
			},
		};
	},
};

mount(() => (
	<WindowCanvas>
		<Page>
			<Panel>
				<Column>
					<RoundPrototype page={page} source={source} />
				</Column>
			</Panel>
			<PageFoot text={`Reads: [${reads().join(" ")}]`} />
		</Page>
		<FullArtifact />
	</WindowCanvas>
));

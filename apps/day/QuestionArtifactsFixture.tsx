// Headless test fixture only, never app runtime. A question's attached
// mockup, with a scripted artifact source: one press reads it once.
import { mount, signal, Text, View } from "nsh";
import type { DecisionArtifact } from "pilot-day/native";
import type { ArtifactRow, ArtifactSource, ListResult, ReadResult } from "./artifactReads";
import { QuestionArtifacts } from "./QuestionArtifacts";

const reads = signal<string[]>([]);
const artifacts: DecisionArtifact[] = [
	{
		sessionId: "chat-7",
		artifactId: "planning-controls",
		title: "Planning controls mockup",
		kind: "nsh",
		revision: 2,
	},
];
const source: ArtifactSource = {
	async list(): Promise<ListResult> {
		return { ok: true, list: { rows: [], more: false } };
	},
	async read(row: ArtifactRow): Promise<ReadResult> {
		reads.update((all) => [...all, `${row.sessionId}/${row.artifactId}@${row.revision}`]);
		const text = "export default () => <Text>Four situations</Text>;";
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
	<View class="flex-1 gap-4 bg-background p-6">
		<QuestionArtifacts source={source} artifacts={artifacts} />
		<Text>{`Reads: [${reads().join(" ")}]`}</Text>
	</View>
));

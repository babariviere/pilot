// Headless test fixture only, never app runtime. No daemon, provider or
// storage. A scripted artifact source with the connected rules: rows name an
// exact revision, one press reads that revision once, and a refusal shows
// nothing earlier. The project page and one mission's section share rows.
import { keymap, mount, Scroll, signal, Text, View } from "nsh";
import { createShelf, FullArtifact, MissionArtifacts } from "./ArtifactShelf";
import { ArtifactsScreen } from "./ArtifactsScreen";
import { type ArtifactRow, type ArtifactSource, type ListResult, type ReadResult, readRefused } from "./artifactReads";
import { Action } from "./ui";

const NSH = "1b2c3d4e-0000-4000-8000-000000000001";
const HTML = "1b2c3d4e-0000-4000-8000-000000000002";
const IMAGE = "1b2c3d4e-0000-4000-8000-000000000003";
const PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
const SOURCES: Record<string, string> = {
	[`${NSH}@2`]: "export default () => <Text>Revision two</Text>;",
	[`${NSH}@1`]: "export default () => <Text>Revision one</Text>;",
	[`${HTML}@4`]: "<p>Saved page</p>",
	[`${HTML}@3`]: "<p>Before page</p>",
	[`${IMAGE}@1`]: PIXEL,
};
/** A title saved with an older revision, since renamed: each revision shows its own. */
const TITLES: Record<string, string> = { [`${HTML}@3`]: "Old report page" };
const project: ArtifactRow[] = [
	{ sessionId: "chat-a", artifactId: NSH, title: "Timeline", kind: "nsh", revision: 2, updatedAt: 3 },
	{ sessionId: "chat-b", artifactId: HTML, title: "Report page", kind: "html", revision: 4, updatedAt: 2 },
	{ sessionId: "chat-b", artifactId: IMAGE, title: "Screenshot", kind: "image", revision: 1, updatedAt: 1 },
];
const mission: ArtifactRow[] = [
	{ ...project[1], pinned: true, taskId: "t2", taskTitle: "Write the report" },
	{ ...project[0], revision: 1, pinned: true, taskId: "t1", taskTitle: "Draw the timeline" },
	{ ...project[0], pinned: false, taskId: null, taskTitle: null },
];

const reads = signal<string[]>([]);
const page = signal<"project" | "mission">("project");
const opened = signal(0);
const script = { refuseList: false, empty: false, refuseReads: false };

const source: ArtifactSource = {
	async list(missionId?: string): Promise<ListResult> {
		if (script.refuseList) return { ok: false, message: "Pilot could not reach its service." };
		const rows = script.empty ? [] : missionId ? mission : project;
		return { ok: true, list: { rows, more: false } };
	},
	async read(row: ArtifactRow): Promise<ReadResult> {
		reads.update((all) => [...all, `${row.artifactId}@${row.revision}`]);
		if (script.refuseReads) return readRefused("stale");
		const text = SOURCES[`${row.artifactId}@${row.revision}`];
		return {
			status: "shown",
			artifact: {
				version: 1,
				reference: { sourceSessionId: row.sessionId, artifactId: row.artifactId, revision: row.revision ?? 0 },
				metadata: { title: TITLES[`${row.artifactId}@${row.revision}`] ?? row.title, kind: row.kind },
				rendering: "unsupported",
				content: {
					state: row.kind === "image" ? "image" : "text",
					source: text,
					containerSha256: "a".repeat(64),
					containerBytes: text.length,
				},
			},
		};
	},
};

const shelf = createShelf();
/** Reopens the page as if the project changed under it. */
function reopenEmpty() {
	script.empty = true;
	opened.update((n) => n + 1);
}
mount(() => {
	// The full window is a dialog over every control here, so tests reach the page by key.
	keymap.bind("mod+shift+e", reopenEmpty, { when: "always" });
	return (
		<View class="flex-1 bg-background">
			<View class="flex-1">
				<If
					when={page() === "mission"}
					else={
						<Each of={[opened()]} key={(n) => String(n)}>
							{() => <ArtifactsScreen source={source} />}
						</Each>
					}
				>
					<Scroll class="flex-1">
						<View class="w-full max-w-2xl self-center px-6 py-6">
							<MissionArtifacts source={source} shelf={shelf} missionId="m1" />
						</View>
					</Scroll>
				</If>
				<FullArtifact />
			</View>
			<View class="gap-1 border-t border-border px-6 py-3">
				<Text testID="reads">{`Reads: [${reads().join(" ")}]`}</Text>
				<View class="flex-row flex-wrap gap-1">
					<Action label="Mission page" onPress={() => page.set("mission")} />
					<Action label="Refuse reads" onPress={() => (script.refuseReads = true)} />
					<Action label="Allow reads" onPress={() => (script.refuseReads = false)} />
					<Action
						label="Reopen refused"
						onPress={() => {
							script.refuseList = true;
							opened.update((n) => n + 1);
						}}
					/>
					<Action label="Reopen empty" onPress={reopenEmpty} />
				</View>
			</View>
		</View>
	);
});

// Headless test fixture only, never app runtime. No daemon, provider or
// storage. A scripted artifact source with the connected rules: rows name an
// exact revision, one press reads that revision once, and a refusal shows
// nothing earlier. The project page and one mission's section share rows.
import { type JSX, keymap, mount, Scroll, signal, View } from "nsh";
import { createShelf, FullArtifact, MissionArtifacts } from "./ArtifactShelf";
import { ArtifactsScreen } from "./ArtifactsScreen";
import { type ArtifactRow, type ArtifactSource, type ListResult, type ReadResult, readRefused } from "./artifactReads";
import { Block, Button, Buttons, Caption, Column, GridBackdrop, Page, Panel } from "./ui";

const NSH = "1b2c3d4e-0000-4000-8000-000000000001";
const HTML = "1b2c3d4e-0000-4000-8000-000000000002";
const IMAGE = "1b2c3d4e-0000-4000-8000-000000000003";
const SHOT_BEFORE = "1b2c3d4e-0000-4000-8000-000000000004";
const SHOT_AFTER = "1b2c3d4e-0000-4000-8000-000000000005";
const SHOT_NEW = "1b2c3d4e-0000-4000-8000-000000000006";
const PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
const SOURCES: Record<string, string> = {
	[`${NSH}@2`]: "export default () => <Text>Revision two</Text>;",
	[`${NSH}@1`]: "export default () => <Text>Revision one</Text>;",
	[`${HTML}@4`]: "<p>Saved page</p>",
	[`${HTML}@3`]: "<p>Before page</p>",
	[`${IMAGE}@1`]: PIXEL,
	[`${SHOT_BEFORE}@1`]: PIXEL,
	[`${SHOT_AFTER}@2`]: PIXEL,
	[`${SHOT_NEW}@1`]: PIXEL,
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
/** Screens a worker reported, as native folds them: each After row carries its pair. */
const screens: ArtifactRow[] = [
	{
		sessionId: "chat-c",
		artifactId: SHOT_AFTER,
		title: "Today: mission row (After)",
		kind: "image",
		revision: 2,
		updatedAt: 5,
		pair: {
			before: { artifactId: SHOT_BEFORE, revision: 1, title: "Today: mission row (Before)" },
			after: { artifactId: SHOT_AFTER, revision: 2, title: "Today: mission row (After)" },
		},
	},
	{
		sessionId: "chat-c",
		artifactId: SHOT_NEW,
		title: "Settings: spending (After)",
		kind: "image",
		revision: 1,
		updatedAt: 4,
		pair: { before: null, after: { artifactId: SHOT_NEW, revision: 1, title: "Settings: spending (After)" } },
	},
];

const reads = signal<string[]>([]);
const page = signal<"project" | "mission">("project");
const opened = signal(0);
const script = { refuseList: false, empty: false, refuseReads: false, screens: false };

const source: ArtifactSource = {
	async list(missionId?: string): Promise<ListResult> {
		if (script.refuseList) return { ok: false, message: "Pilot could not reach its service." };
		const rows = script.empty ? [] : script.screens ? screens : missionId ? mission : project;
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

// LIBRARY GAP: no part paints a window's canvas (the background colour and GridBackdrop) for a fixture that mounts
// a screen or a control without DayScreen. This local root does what DayScreen's root does.
function FixtureWindow(props: { children?: JSX.Element }) {
	return (
		<View class="flex-1 bg-background">
			<GridBackdrop />
			{props.children}
		</View>
	);
}

mount(() => {
	// The full window is a dialog over every control here, so tests reach the page by key.
	keymap.bind("mod+shift+e", reopenEmpty, { when: "always" });
	return (
		<FixtureWindow>
			<View class="flex-1">
				<If
					when={page() === "mission"}
					else={
						<Each of={[opened()]} key={(n) => String(n)}>
							{() => <ArtifactsScreen source={source} />}
						</Each>
					}
				>
					{/* A mission's artifacts are a Section of the mission's panel. */}
					<Scroll class="flex-1">
						<Page width="form">
							<Panel>
								<Column>
									<MissionArtifacts source={source} shelf={shelf} missionId="m1" />
								</Column>
							</Panel>
						</Page>
					</Scroll>
				</If>
				<FullArtifact />
			</View>
			<Block>
				<Caption testID="reads">{`Reads: [${reads().join(" ")}]`}</Caption>
				<Buttons>
					<Button small label="Mission page" onPress={() => page.set("mission")} />
					<Button small label="Refuse reads" onPress={() => (script.refuseReads = true)} />
					<Button small label="Allow reads" onPress={() => (script.refuseReads = false)} />
					<Button
						small
						label="Reopen refused"
						onPress={() => {
							script.refuseList = true;
							opened.update((n) => n + 1);
						}}
					/>
					<Button small label="Reopen empty" onPress={reopenEmpty} />
					<Button
						small
						label="Reopen with screens"
						onPress={() => {
							script.screens = true;
							opened.update((n) => n + 1);
						}}
					/>
				</Buttons>
			</Block>
		</FixtureWindow>
	);
});

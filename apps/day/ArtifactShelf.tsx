// Saved artifacts as a gallery: one card per artifact with its kind, title
// and exact revision. A mission's overview groups its links by task; the
// project's Artifacts page lists newest first. Each page reads its list once
// when it opens and starts no preview: opening a card reads that revision
// once and shows it below its row, in the app's isolated preview for NSH or
// as plain text otherwise. One artifact shows at a time on a page, and one
// pane at a time in it: comparing a previous version switches Before and
// After in the same place.
// Nothing here is saved, sent or counted as anyone's check.
import { cleanup, effect, type Signal, signal, Text, View, type ViewRef } from "nsh";
import { savedTitle } from "./ArtifactExport";
import { ArtifactBody, ArtifactTools, closeFullFor, InFullNote, inFull, openFull, paneLine } from "./ArtifactViewer";
import type { ArtifactList, ArtifactRow, ArtifactSource, Shown } from "./artifactReads";
import { artifactPreviewsAvailable } from "./bridge";
import { kindName } from "./deliveryView";
import { Action, Field, glide, Notice, Pressable, SectionTitle, TabItem, TabRow } from "./ui";

export { FullArtifact } from "./ArtifactViewer";

/** The artifact open on a page, by its card's key. */
type Opened = Shown & { key: string; generation: number; row: ArtifactRow };

/** What one page's gallery shows. It lives with the page and is never saved. */
export type Shelf = {
	open: Signal<Opened | null>;
	anchors: Map<string, ViewRef>;
	/** Closes the open artifact and focuses its card. False when none is open. */
	hideLast(): boolean;
};

export function createShelf(): Shelf {
	const open = signal<Opened | null>(null);
	const anchors = new Map<string, ViewRef>();
	return {
		open,
		anchors,
		hideLast() {
			const now = open();
			if (!now) return false;
			glide();
			open.set(null);
			anchors.get(now.key)?.focus();
			return true;
		},
	};
}

/** A card's identity on its page: the same revision can be linked to two tasks. */
function rowKey(row: ArtifactRow): string {
	return [row.taskId ?? "", row.sessionId, row.artifactId, row.revision ?? ""].join("/");
}

/** Whether `row` opens in a preview here rather than as text. */
function previews(row: ArtifactRow): boolean {
	return row.kind === "nsh" && artifactPreviewsAvailable();
}

let generations = 0;

/**
 * Opens `row`, reading its exact revision once. What was open before
 * closes; a late answer for a card closed since is dropped.
 */
async function openRow(shelf: Shelf, source: ArtifactSource, row: ArtifactRow) {
	if (row.revision === null) return;
	const key = rowKey(row);
	if (shelf.open()?.key === key && shelf.open()?.state === "reading") return;
	const generation = ++generations;
	const reading: Opened = {
		key,
		title: row.title,
		kind: row.kind,
		pin: { revision: row.revision },
		state: "reading",
		preview: previews(row),
		artifact: null,
		message: "",
		generation,
		row,
	};
	glide();
	shelf.open.set(reading);
	const r = await source.read(row);
	if (shelf.open()?.generation !== generation) return;
	shelf.open.set(
		r.status === "shown"
			? { ...reading, state: "shown", artifact: r.artifact }
			: { ...reading, state: "refused", message: r.message },
	);
}

/** "NSH · revision 3". A mission link without a pin says it is the current one. */
function revisionLine(row: ArtifactRow, inMission: boolean): string {
	if (row.revision === null) return `${kindName(row.kind)} · no saved revision here`;
	const current = inMission && !row.pinned ? " · current" : "";
	return `${kindName(row.kind)} · revision ${row.revision}${current}`;
}

/** One artifact's card. Its thumbnail names the kind; nothing runs until it opens. */
function Card(props: { source: ArtifactSource; shelf: Shelf; row: ArtifactRow; inMission: boolean }) {
	const key = rowKey(props.row);
	const isOpen = () => props.shelf.open()?.key === key;
	const name = () => props.row.title || "the artifact";
	const label = () => {
		if (props.row.revision === null) return `${name()}. No saved revision can be read here.`;
		if (isOpen()) return `Close ${name()}.`;
		return previews(props.row)
			? `Open ${name()}, revision ${props.row.revision}, in its isolated preview. Looking records nothing.`
			: `Show the saved source of ${name()}, revision ${props.row.revision}, as plain text. Looking records nothing.`;
	};
	return (
		<Pressable
			anchor={(node: ViewRef) => props.shelf.anchors.set(key, node)}
			testID={`artifact-card-${key}`}
			accessibilityLabel={label()}
			disabled={props.row.revision === null}
			onPress={() => {
				if (isOpen()) props.shelf.hideLast();
				else void openRow(props.shelf, props.source, props.row);
			}}
			class="group flex-1 gap-2 rounded-xl border p-2 transition duration-150 hover:bg-accent active:bg-accent disabled:opacity-60"
			classList={{ "border-border-strong bg-accent": isOpen(), "border-border": !isOpen() }}
		>
			<View class="h-24 items-center justify-center rounded-lg bg-muted">
				<Text class="text-xs font-semibold tracking-wide text-faint">{kindName(props.row.kind)}</Text>
			</View>
			<View class="gap-0.5 px-1 pb-1">
				<Text class="truncate text-sm text-foreground group-hover:underline">{props.row.title || "Artifact"}</Text>
				<Text class="truncate text-xs text-muted-foreground">{revisionLine(props.row, props.inMission)}</Text>
			</View>
		</Pressable>
	);
}

/**
 * The open artifact, under its row: its preview or saved source, and Close.
 * Compare previous version reads the revision before once; Before and After
 * tabs then switch the one pane, After first. The full window shows the pane
 * on screen and comes back to the same side.
 */
function Viewer(props: { shelf: Shelf; source: ArtifactSource }) {
	const now = () => props.shelf.open() as Opened;
	const before = signal<Shown | null>(null);
	const side = signal<"before" | "after">("after");
	let comparison = 0;
	let openedGeneration = -1;
	effect(() => {
		const generation = props.shelf.open()?.generation ?? -1;
		if (generation === openedGeneration) return;
		openedGeneration = generation;
		comparison++;
		before.set(null);
		side.set("after");
	});
	// Every viewer, also a round's pinned prototype, closes its full window as it goes.
	const shelf = props.shelf;
	cleanup(() => closeFullFor(shelf));
	const compare = async () => {
		const current = now();
		if (current.pin.revision <= 1) return;
		const run = ++comparison;
		const row = { ...current.row, revision: current.pin.revision - 1 };
		const reading: Shown = {
			...current,
			pin: { revision: row.revision },
			state: "reading",
			artifact: null,
			preview: false,
		};
		before.set(reading);
		const result = await props.source.read(row);
		if (run !== comparison || props.shelf.open()?.generation !== current.generation) return;
		before.set(
			result.status === "shown"
				? { ...reading, state: "shown", artifact: result.artifact }
				: { ...reading, state: "refused", message: result.message },
		);
	};
	const toggle = () => {
		glide();
		props.shelf.open.set({ ...now(), preview: !now().preview });
	};
	const stopComparing = () => {
		comparison++;
		before.set(null);
		side.set("after");
	};
	// The one pane: the side chosen, in the viewer's preview or source mode.
	const pane = (): Shown => {
		const b = before();
		return side() === "before" && b ? { ...b, preview: now().preview } : now();
	};
	const full = (back: () => void) => {
		const generation = now().generation;
		const chosen = side();
		const older = before();
		// The same artifact, side and Before read as when it opened, not an equal-looking copy.
		openFull({
			shown: pane(),
			id: shelf,
			side: older ? (chosen === "before" ? "Before" : "After") : undefined,
			live: () => shelf.open()?.generation === generation && side() === chosen && before() === older,
			back,
		});
	};
	return (
		<View testID="artifact-viewer" class="gap-2 pt-1">
			{/* The tabs keep their own width; when the row is narrow, the commands wrap below them, never under them. */}
			<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
				<If when={before()}>
					<View class="flex-row">
						<TabRow>
							<TabItem
								label={`Before · revision ${before()?.pin.revision ?? ""}`}
								selected={side() === "before"}
								testID="artifact-tab-before"
								onPress={() => side.set("before")}
							/>
							<TabItem
								label={`After · revision ${now().pin.revision}`}
								selected={side() === "after"}
								testID="artifact-tab-after"
								onPress={() => side.set("after")}
							/>
						</TabRow>
					</View>
				</If>
				<View class="ml-auto flex-row flex-wrap items-center justify-end gap-1">
					<If when={now().state === "refused"}>
						<Action
							label="Retry read"
							testID="artifact-viewer-retry"
							onPress={() => void openRow(props.shelf, props.source, now().row)}
						/>
					</If>
					<If when={now().state === "shown" && now().pin.revision > 1}>
						<Action
							label={before() ? "Close comparison" : "Compare previous version"}
							testID="artifact-compare"
							onPress={() => {
								if (before()) stopComparing();
								else void compare();
							}}
						/>
					</If>
					<If when={now().kind === "nsh" && artifactPreviewsAvailable() && now().state === "shown"}>
						<Action
							label={now().preview ? "Inspect source" : "Show preview"}
							testID="artifact-viewer-toggle"
							onPress={toggle}
						/>
					</If>
					<ArtifactTools shown={pane()} testID="artifact-viewer" onFull={full} />
					<Action label="Close" testID="artifact-viewer-close" onPress={() => props.shelf.hideLast()} />
				</View>
			</View>
			{/* The pane's own saved title: an older revision keeps the name it was saved with. */}
			<View class="flex-row flex-wrap items-baseline gap-x-2">
				<Text testID="artifact-viewer-title" class="text-sm font-medium text-foreground">
					{savedTitle(pane())}
				</Text>
				<Text class="text-xs text-faint">{paneLine(pane())}</Text>
			</View>
			<If when={!inFull(props.shelf)} else={<InFullNote />}>
				{/* A new artifact or side starts its own pane; a preview there starts again from its saved revision. */}
				<Each of={[`${props.shelf.open()?.generation ?? ""}/${side()}`]} key={String}>
					{/* Comparing, Before and After share one pane of a fixed height. */}
					{() => <ArtifactBody shown={pane()} bounded={!!before()} />}
				</Each>
			</If>
		</View>
	);
}

const COLUMNS = 3;

/** `rows` in runs of three cards, the last run padded so cards keep their width. */
function runs(rows: ArtifactRow[]): ArtifactRow[][] {
	const out: ArtifactRow[][] = [];
	for (let i = 0; i < rows.length; i += COLUMNS) out.push(rows.slice(i, i + COLUMNS));
	return out;
}

function Grid(props: { source: ArtifactSource; shelf: Shelf; rows: ArtifactRow[]; inMission: boolean }) {
	return (
		<View class="gap-3">
			<Each of={runs(props.rows)} key={(run) => run.map(rowKey).join("|")}>
				{(run) => (
					<View class="gap-3">
						<View class="flex-row gap-3">
							<Each of={run()} key={rowKey}>
								{(row) => (
									<Card source={props.source} shelf={props.shelf} row={row()} inMission={props.inMission} />
								)}
							</Each>
							<Each of={Array.from({ length: COLUMNS - run().length }, (_, i) => i)} key={String}>
								{() => <View class="flex-1" />}
							</Each>
						</View>
						<If when={run().some((row) => rowKey(row) === props.shelf.open()?.key)}>
							<Viewer shelf={props.shelf} source={props.source} />
						</If>
					</View>
				)}
			</Each>
		</View>
	);
}

type Group = { id: string; label: string; rows: ArtifactRow[] };

/** A mission's rows by task, in the order of each task's newest link. */
function byTask(rows: ArtifactRow[]): Group[] {
	const groups = new Map<string, Group>();
	for (const row of rows) {
		const id = row.taskId ?? "";
		const label = row.taskId ? (row.taskTitle ?? "A task") : "The mission";
		const group = groups.get(id) ?? { id, label, rows: [] };
		group.rows.push(row);
		groups.set(id, group);
	}
	return [...groups.values()];
}

type Listing = { status: "reading" } | { status: "shown"; list: ArtifactList } | { status: "refused"; message: string };

/** The cards of the project, or of mission `missionId` grouped by task. It reads once when it shows. */
export function ArtifactShelf(props: {
	source: ArtifactSource;
	shelf: Shelf;
	missionId?: string;
	testID: string;
	empty: string;
}) {
	const listing = signal<Listing>({ status: "reading" });
	const query = signal("");
	cleanup(() => {
		props.shelf.open.set(null);
		props.shelf.anchors.clear();
		closeFullFor(props.shelf);
	});
	void props.source.list(props.missionId).then((r) => {
		listing.set(r.ok ? { status: "shown", list: r.list } : { status: "refused", message: r.message });
	});
	const rows = () => {
		const l = listing();
		const q = query().trim().toLocaleLowerCase();
		return l.status === "shown"
			? l.list.rows.filter((r) => !q || `${r.title} ${r.kind} ${r.taskTitle ?? ""}`.toLocaleLowerCase().includes(q))
			: [];
	};
	const groups = () =>
		props.missionId ? byTask(rows()) : rows().length > 0 ? [{ id: "all", label: "", rows: rows() }] : [];
	const listed = () => {
		const l = listing();
		return l.status === "shown" ? l.list : null;
	};
	const refusal = () => {
		const l = listing();
		return l.status === "refused" ? l.message : "";
	};
	return (
		<View testID={props.testID} class="gap-1">
			<If when={listing().status === "shown"}>
				<Field
					label="Search loaded outputs"
					testID="artifact-search"
					value={query()}
					onChange={(value) => {
						props.shelf.hideLast();
						query.set(value);
					}}
				/>
			</If>
			<If when={listing().status === "reading"}>
				<Text class="text-sm text-muted-foreground">Reading saved artifacts…</Text>
			</If>
			<If when={refusal()}>
				<Notice role="alert" text={`${refusal()} This is not the same as having none.`} />
			</If>
			<If when={listed() && rows().length === 0}>
				<Text class="text-sm text-muted-foreground">
					{query().trim() ? "No loaded outputs match this search." : props.empty}
				</Text>
			</If>
			<Each of={groups()} key={(g) => g.id}>
				{(g) => (
					<View class="gap-2 pb-3">
						<If when={g().label}>
							<Text class="pt-2 text-xs text-faint">{g().label}</Text>
						</If>
						<Grid source={props.source} shelf={props.shelf} rows={g().rows} inMission={!!props.missionId} />
					</View>
				)}
			</Each>
			<If when={listed()?.more}>
				<Text class="pt-1 text-xs text-faint">Showing the 100 newest. Older ones stay with their chats.</Text>
			</If>
		</View>
	);
}

/** Exact pinned revisions as cards, such as the prototype a round asks about. Nothing is read until one opens. */
export function PinnedArtifacts(props: { source: ArtifactSource; shelf: Shelf; rows: ArtifactRow[] }) {
	return <Grid source={props.source} shelf={props.shelf} rows={props.rows} inMission={true} />;
}

/** A mission's Artifacts section: what its agents linked, by task. */
export function MissionArtifacts(props: { source: ArtifactSource; shelf: Shelf; missionId: string }) {
	return (
		<View class="gap-1">
			<View class="pb-1">
				<SectionTitle title="Artifacts" />
			</View>
			<ArtifactShelf
				source={props.source}
				shelf={props.shelf}
				missionId={props.missionId}
				testID="mission-artifacts"
				empty="No artifacts are linked to this mission yet."
			/>
		</View>
	);
}

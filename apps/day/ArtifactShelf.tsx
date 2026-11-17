// Saved artifacts as a gallery: one card per artifact with its kind, title
// and exact revision. A mission's overview groups its links by task; the
// project's Artifacts page lists newest first. Each page reads its list once
// when it opens and starts no preview: opening a card reads that revision
// once and shows it below its row, in the app's isolated preview for NSH or
// as plain text otherwise. One artifact shows at a time on a page, and one
// pane at a time in it: comparing a previous version switches Before and
// After in the same place. A screen a worker reported is one card: its After
// and Before captures open together, After first.
// The panel arrives with a short fade and rise and the rows below glide; it
// fades out before it closes, and a new side fades in where the old one was.
// Nothing here is saved, sent or counted as anyone's check.
import { cleanup, effect, type Signal, signal, Text, untracked, View, type ViewRef } from "nsh";
import { savedTitle } from "./ArtifactExport";
import { ArtifactBody, ArtifactTools, closeFullFor, InFullNote, inFull, openFull, paneLine } from "./ArtifactViewer";
import { type ArtifactList, type ArtifactRow, type ArtifactSource, beforeRow, type Shown } from "./artifactReads";
import { artifactPreviewsAvailable } from "./bridge";
import { screenTitle } from "./deliveryScreens";
import { kindName } from "./deliveryView";
import {
	Action,
	createPanelMotion,
	FadeIn,
	Field,
	glide,
	LEAVE_MS,
	Notice,
	Pressable,
	SectionTitle,
	TabItem,
	TabRow,
} from "./ui";

export { FullArtifact } from "./ArtifactViewer";

/** The artifact open on a page, by its card's key. */
type Opened = Shown & { key: string; generation: number; row: ArtifactRow };

/** What one page's gallery shows. It lives with the page and is never saved. */
export type Shelf = {
	open: Signal<Opened | null>;
	/** The generation of the open artifact while its panel fades out, else null: it counts as closed. */
	closing: Signal<number | null>;
	anchors: Map<string, ViewRef>;
	/** Closes the open artifact, after its panel fades out, and focuses its card. False when none is open or it is already closing. */
	hideLast(): boolean;
	/** The open panel's way out, while one is on screen. */
	leave: (() => Promise<void>) | null;
	/** Brings the open panel back when another artifact opens while it leaves. */
	arrive: (() => void) | null;
};

export function createShelf(): Shelf {
	const open = signal<Opened | null>(null);
	const closing = signal<number | null>(null);
	const anchors = new Map<string, ViewRef>();
	const shelf: Shelf = {
		open,
		closing,
		anchors,
		leave: null,
		arrive: null,
		hideLast() {
			const now = open();
			if (!now || closing() === now.generation) return false;
			anchors.get(now.key)?.focus();
			closing.set(now.generation);
			const close = () => {
				// A card opened meanwhile stays open.
				if (open()?.generation !== now.generation) return;
				glide();
				open.set(null);
				closing.set(null);
			};
			const leave = shelf.leave;
			if (!leave) close();
			// A panel that leaves the screen some other way never holds the close.
			else void Promise.race([leave(), new Promise((done) => setTimeout(done, LEAVE_MS + 80))]).then(close);
			return true;
		},
	};
	return shelf;
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
	// Opened again while the panel leaves: it comes back rather than closing.
	if (shelf.closing() !== null) {
		shelf.closing.set(null);
		shelf.arrive?.();
	}
	shelf.open.set(reading);
	const r = await source.read(row);
	if (shelf.open()?.generation !== generation) return;
	// The read's answer changes the panel's size too: it glides rather than jumps.
	glide();
	shelf.open.set(
		r.status === "shown"
			? { ...reading, state: "shown", artifact: r.artifact }
			: { ...reading, state: "refused", message: r.message },
	);
}

/** "NSH · revision 3". A mission link without a pin says it is the current one. A screen says what it compares. */
function revisionLine(row: ArtifactRow, inMission: boolean): string {
	if (row.revision === null) return `${kindName(row.kind)} · no saved revision here`;
	if (row.pair) return row.pair.before ? "Screen · Before and After" : "Screen · new, no Before";
	const current = inMission && !row.pinned ? " · current" : "";
	return `${kindName(row.kind)} · revision ${row.revision}${current}`;
}

/** A card's title: a screen's name without "(After)". */
function cardTitle(row: ArtifactRow): string {
	return row.pair ? screenTitle(row.title) : row.title;
}

/** What a card's thumbnail says. */
function thumbLabel(row: ArtifactRow): string {
	if (!row.pair) return kindName(row.kind);
	return row.pair.before ? "Before / After" : "New screen";
}

/** One artifact's card. Its thumbnail names the kind; nothing runs until it opens. */
function Card(props: { source: ArtifactSource; shelf: Shelf; row: ArtifactRow; inMission: boolean }) {
	const key = rowKey(props.row);
	const isOpen = () => props.shelf.open()?.key === key && props.shelf.closing() === null;
	const name = () => cardTitle(props.row) || "the artifact";
	const label = () => {
		if (props.row.revision === null) return `${name()}. No saved revision can be read here.`;
		if (isOpen()) return `Close ${name()}.`;
		if (props.row.pair?.before) return `Open ${name()}, its Before and After captures. Looking records nothing.`;
		if (props.row.pair) return `Open ${name()}, a new screen's capture. Looking records nothing.`;
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
				<Text class="text-xs font-semibold tracking-wide text-faint">{thumbLabel(props.row)}</Text>
			</View>
			<View class="gap-0.5 px-1 pb-1">
				<Text class="truncate text-sm text-foreground group-hover:underline">
					{cardTitle(props.row) || "Artifact"}
				</Text>
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
	// Every viewer, also a round's pinned prototype, closes its full window as it goes.
	const shelf = props.shelf;
	const panel = createPanelMotion();
	shelf.leave = panel.leave;
	shelf.arrive = panel.arrive;
	cleanup(() => {
		if (shelf.leave === panel.leave) shelf.leave = null;
		if (shelf.arrive === panel.arrive) shelf.arrive = null;
		closeFullFor(shelf);
	});
	/** Reads `row` once as the Before side; a later open or comparison drops a late answer. */
	const readBefore = async (current: Opened, row: ArtifactRow) => {
		if (row.revision === null) return;
		const run = ++comparison;
		const reading: Shown = {
			...current,
			title: row.title,
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
	effect(() => {
		const opened = props.shelf.open();
		const generation = opened?.generation ?? -1;
		if (generation === openedGeneration) return;
		openedGeneration = generation;
		comparison++;
		before.set(null);
		side.set("after");
		// A reported screen opens with both captures: After shown, Before read beside it.
		const pairBefore = opened ? beforeRow(opened.row) : null;
		if (opened && pairBefore) untracked(() => void readBefore(opened, pairBefore));
	});
	const pair = () => !!now().row.pair?.before;
	const compare = async () => {
		const current = now();
		if (current.pin.revision <= 1) return;
		await readBefore(current, { ...current.row, revision: current.pin.revision - 1 });
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
		<View testID="artifact-viewer" class="gap-2 pt-1" style={panel.style}>
			{/* The tabs keep their own width; when the row is narrow, the commands wrap below them, never under them. */}
			<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
				<If when={before()}>
					<View class="flex-row">
						<TabRow>
							<TabItem
								label={pair() ? "Before" : `Before · revision ${before()?.pin.revision ?? ""}`}
								selected={side() === "before"}
								testID="artifact-tab-before"
								onPress={() => side.set("before")}
							/>
							<TabItem
								label={pair() ? "After" : `After · revision ${now().pin.revision}`}
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
					<If when={!now().row.pair && now().state === "shown" && now().pin.revision > 1}>
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
					{() => (
						<FadeIn>
							<ArtifactBody shown={pane()} bounded={!!before()} />
						</FadeIn>
					)}
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
		props.shelf.closing.set(null);
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
			? l.list.rows.filter(
					(r) =>
						!q ||
						`${r.title} ${r.pair?.before?.title ?? ""} ${r.kind} ${r.taskTitle ?? ""}`
							.toLocaleLowerCase()
							.includes(q),
				)
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

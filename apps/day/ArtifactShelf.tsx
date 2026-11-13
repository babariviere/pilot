// Saved artifacts as a gallery: one card per artifact with its kind, title
// and exact revision. A mission's overview groups its links by task; the
// project's Artifacts page lists newest first. Each page reads its list once
// when it opens and starts no preview: opening a card reads that revision
// once and shows it below its row, in the app's isolated preview for NSH or
// as plain text otherwise. One artifact shows at a time on a page.
// Nothing here is saved, sent or counted as anyone's check.
import { type Signal, signal, Text, View, type ViewRef } from "nsh";
import { Button } from "nsh/base";
import { ArtifactPreview } from "./ArtifactPreview";
import type { ArtifactList, ArtifactRow, ArtifactSource, Shown } from "./artifactReads";
import { artifactPreviewsAvailable } from "./bridge";
import { kindName } from "./deliveryView";
import { glide } from "./motion";
import { SourcePanel } from "./SourcePanel";
import { Action, Mark, SectionTitle } from "./ui";

/** The artifact open on a page, by its card's key. */
type Opened = Shown & { key: string; generation: number };

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
		<Button
			ref={(node: ViewRef) => props.shelf.anchors.set(key, node)}
			testID={`artifact-card-${key}`}
			accessibilityLabel={label()}
			disabled={props.row.revision === null}
			onPress={() => {
				if (isOpen()) props.shelf.hideLast();
				else void openRow(props.shelf, props.source, props.row);
			}}
			class="group flex-1 gap-2 rounded-xl border p-2 transition duration-150 hover:bg-accent active:bg-accent disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring/40"
			classList={{ "border-border-strong bg-accent": isOpen(), "border-border": !isOpen() }}
		>
			<View class="h-24 items-center justify-center rounded-lg bg-muted">
				<Text class="text-xs font-semibold tracking-wide text-faint">{kindName(props.row.kind)}</Text>
			</View>
			<View class="gap-0.5 px-1 pb-1">
				<Text class="truncate text-sm text-foreground group-hover:underline">{props.row.title || "Artifact"}</Text>
				<Text class="truncate text-xs text-muted-foreground">{revisionLine(props.row, props.inMission)}</Text>
			</View>
		</Button>
	);
}

/** The open artifact, under its row: its preview or saved source, and Close. */
function Viewer(props: { shelf: Shelf }) {
	const now = () => props.shelf.open() as Opened;
	const toggle = () => {
		glide();
		props.shelf.open.set({ ...now(), preview: !now().preview });
	};
	return (
		<View testID="artifact-viewer" class="gap-2 pt-1">
			<View class="flex-row items-center justify-end gap-1">
				<If when={now().kind === "nsh" && artifactPreviewsAvailable() && now().state === "shown"}>
					<Action
						label={now().preview ? "Inspect source" : "Show preview"}
						testID="artifact-viewer-toggle"
						onPress={toggle}
					/>
				</If>
				<Action label="Close" testID="artifact-viewer-close" onPress={() => props.shelf.hideLast()} />
			</View>
			<If when={now().preview} else={<SourcePanel inspection={now()} />}>
				<ArtifactPreview inspection={now()} />
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
							<Viewer shelf={props.shelf} />
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
	void props.source.list(props.missionId).then((r) => {
		listing.set(r.ok ? { status: "shown", list: r.list } : { status: "refused", message: r.message });
	});
	const rows = () => {
		const l = listing();
		return l.status === "shown" ? l.list.rows : [];
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
			<If when={listing().status === "reading"}>
				<Text class="text-sm text-muted-foreground">Reading saved artifacts…</Text>
			</If>
			<If when={refusal()}>
				<View class="flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
					<Mark kind="unknown" />
					<Text role="alert" class="flex-1 text-sm text-foreground">
						{`${refusal()} This is not the same as having none.`}
					</Text>
				</View>
			</If>
			<If when={listed() && rows().length === 0}>
				<Text class="text-sm text-muted-foreground">{props.empty}</Text>
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

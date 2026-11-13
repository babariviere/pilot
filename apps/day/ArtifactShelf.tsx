// Saved artifacts as rows: title, kind and exact revision, where each came
// from, and its source or preview in place. A mission's overview groups its
// links by task; the project's Artifacts page lists newest first. Each page
// reads its list once when it opens and previews its newest NSH artifact; the
// rest open on a press. The sandbox, not the press, is the safety boundary.
// Nothing here is saved, sent or counted as anyone's check.
import { type Signal, signal, Text, View, type ViewRef } from "nsh";
import { ArtifactPreview } from "./ArtifactPreview";
import { type ArtifactList, type ArtifactRow, type ArtifactSource, MAX_PREVIEWS, type Shown } from "./artifactReads";
import { artifactPreviewsAvailable } from "./bridge";
import { kindName } from "./deliveryView";
import { glide } from "./motion";
import { SourcePanel } from "./SourcePanel";
import { Action, Mark, SectionTitle } from "./ui";

type RowView = Shown & { generation: number };

/** What one page's rows show. It lives with the page and is never saved. */
export type Shelf = {
	views: Signal<Record<string, RowView>>;
	anchors: Map<string, ViewRef>;
	/** Hides the source or preview opened last. False when none shows. */
	hideLast(): boolean;
};

export function createShelf(): Shelf {
	const views = signal<Record<string, RowView>>({});
	const anchors = new Map<string, ViewRef>();
	return {
		views,
		anchors,
		hideLast() {
			const last = Object.entries(views()).sort(([, a], [, b]) => b.generation - a.generation)[0];
			if (!last) return false;
			glide();
			hide(views, last[0]);
			anchors.get(last[0])?.focus();
			return true;
		},
	};
}

/** A row's identity on its page: the same revision can be linked to two tasks. */
function rowKey(row: ArtifactRow): string {
	return [row.taskId ?? "", row.sessionId, row.artifactId, row.revision ?? ""].join("/");
}

function hide(views: Shelf["views"], key: string) {
	if (!views()[key]) return;
	views.update((all) => {
		const next = { ...all };
		delete next[key];
		return next;
	});
}

let generations = 0;

/**
 * Reads `row`'s exact revision once, as text or for its preview. What the
 * row showed before goes first; a late answer for a hidden row is dropped.
 * A preview beyond `MAX_PREVIEWS` closes the page's oldest one.
 */
async function show(shelf: Shelf, source: ArtifactSource, row: ArtifactRow, preview: boolean) {
	if (row.revision === null || (preview && row.kind !== "nsh")) return;
	const key = rowKey(row);
	if (shelf.views()[key]?.state === "reading") return;
	const generation = ++generations;
	const reading: RowView = {
		title: row.title,
		kind: row.kind,
		pin: { revision: row.revision },
		state: "reading",
		preview,
		artifact: null,
		message: "",
		generation,
	};
	glide();
	shelf.views.update((all) => {
		const next = { ...all, [key]: reading };
		if (preview) {
			const open = Object.entries(next)
				.filter(([, v]) => v.preview)
				.sort(([, a], [, b]) => a.generation - b.generation);
			for (const [k] of open.slice(0, Math.max(0, open.length - MAX_PREVIEWS))) delete next[k];
		}
		return next;
	});
	const r = await source.read(row);
	if (shelf.views()[key]?.generation !== generation) return;
	shelf.views.update((all) => ({
		...all,
		[key]:
			r.status === "shown"
				? { ...reading, state: "shown", artifact: r.artifact }
				: { ...reading, state: "refused", message: r.message },
	}));
}

/** "NSH, revision 3". A mission link without a pin says it is the current one. */
function revisionLine(row: ArtifactRow, inMission: boolean): string {
	if (row.revision === null) return `${kindName(row.kind)}, no saved revision here`;
	const current = inMission && !row.pinned ? " · current" : "";
	return `${kindName(row.kind)}, revision ${row.revision}${current}`;
}

function Row(props: { source: ArtifactSource; shelf: Shelf; row: ArtifactRow; inMission: boolean }) {
	const key = rowKey(props.row);
	const mine = () => props.shelf.views()[key] ?? null;
	const reading = () => mine()?.state === "reading";
	const name = () => props.row.title || "the artifact";
	const anchor = (node: ViewRef) => props.shelf.anchors.set(key, node);
	const toggle = (preview: boolean) => {
		if (mine() && !!mine()?.preview === preview) {
			glide();
			hide(props.shelf.views, key);
		} else void show(props.shelf, props.source, props.row, preview);
	};
	return (
		<View class="gap-2 border-t border-border py-2.5">
			<View class="flex-row items-center gap-3">
				<Text class="flex-1 text-sm text-foreground">{props.row.title || "Artifact"}</Text>
				<Text class="text-xs text-muted-foreground">{revisionLine(props.row, props.inMission)}</Text>
				<If when={props.row.revision !== null}>
					<Action
						label={reading() ? "Reading…" : mine() && !mine()?.preview ? "Hide source" : "Inspect source"}
						testID={`artifact-source-${key}`}
						accessibilityLabel={
							mine() && !mine()?.preview
								? `Hide the source of ${name()}.`
								: `Show the saved source of ${name()}, revision ${props.row.revision}, as plain text. Looking records nothing.`
						}
						disabled={reading()}
						anchor={anchor}
						onPress={() => toggle(false)}
					/>
					<If when={props.row.kind === "nsh" && artifactPreviewsAvailable()}>
						<Action
							label={mine()?.preview ? "Hide preview" : "Preview"}
							testID={`artifact-preview-${key}`}
							disabled={reading()}
							anchor={anchor}
							onPress={() => toggle(true)}
						/>
					</If>
				</If>
			</View>
			<If when={mine()}>
				<If when={mine()?.preview} else={<SourcePanel inspection={mine() as RowView} />}>
					<ArtifactPreview inspection={mine() as RowView} />
				</If>
			</If>
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

/**
 * The rows of the project, or of mission `missionId` grouped by task. It
 * reads once when it shows; its newest readable NSH artifact opens in a preview.
 */
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
		if (!r.ok || !artifactPreviewsAvailable()) return;
		const newest = r.list.rows.find((row) => row.kind === "nsh" && row.revision !== null);
		if (newest) void show(props.shelf, props.source, newest, true);
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
					<View>
						<If when={g().label}>
							<Text class="pb-1 pt-3 text-xs text-faint">{g().label}</Text>
						</If>
						<Each of={g().rows} key={rowKey}>
							{(row) => (
								<Row source={props.source} shelf={props.shelf} row={row()} inMission={!!props.missionId} />
							)}
						</Each>
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

// State the Changes screens own: where the user is and which tab shows.
// Rust never sees it until an intent carries it. Keyed by snapshot, so it
// survives list changes and hot updates of the screens.
import { signal } from "nsh";
import { closeMission } from "./view";

/** The Changes list, or one kept snapshot, or null for the other screens. */
export type ChangesRoute = { kind: "list" } | { kind: "change"; snapshotId: string } | null;

/** Where the Changes screens are. Null shows Today, a mission or planning. */
export const changesRoute = signal<ChangesRoute>(null);

/** What a reopened change shows: its exact diff or its saved history. */
export type ChangeTab = "diff" | "history";

/** The tab each reopened change shows, by snapshot. The diff when unset. */
export const changeTabs = signal<Record<string, ChangeTab>>({});
/** The last message an intent returned, by snapshot. */
export const changeMessages = signal<Record<string, string>>({});
/** Whether the snapshot details are open, by snapshot. */
export const detailsOpen = signal<Record<string, boolean>>({});
/** The last message reading more of the list returned. */
export const listMessage = signal("");

/** Opens the list of kept changes. */
export function showChanges() {
	closeMission();
	changesRoute.set({ kind: "list" });
}

/** Only the chosen tab is durable; status and open details are transient. */
export function captureChangesTab(): string {
	const change = changesRoute();
	return change?.kind === "change" ? (changeTabs()[change.snapshotId] ?? "") : "";
}

export function resetChangesView() {
	changeTabs.set({});
	changeMessages.set({});
	detailsOpen.set({});
	changesRoute.set(null);
	listMessage.set("");
}

/** Restoring a saved change performs only its existing passive read. */
export function restoreChangesView(
	view: Pick<import("pilot-day/native").SavedView, "place" | "id" | "tab">,
	changes?: import("./changeFeed").Changes,
) {
	if (view.place === "change" && changes) {
		changesRoute.set({ kind: "change", snapshotId: view.id });
		if (view.tab === "diff" || view.tab === "history") changeTabs.set({ [view.id]: view.tab });
		void changes.feed.open({ snapshotId: view.id });
	} else {
		changesRoute.set(view.place === "changes" && changes ? { kind: "list" } : null);
	}
}

/** Opens one kept snapshot. The screen asks Rust to read it. */
export function showChange(snapshotId: string) {
	changesRoute.set({ kind: "change", snapshotId });
}

/** Goes back from a kept snapshot to the list, or from the list to Today. */
export function backFromChanges() {
	changesRoute.set(changesRoute()?.kind === "change" ? { kind: "list" } : null);
}

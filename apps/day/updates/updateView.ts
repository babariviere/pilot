// View-local state of the update overlay. Saved-window state has its own owner.
import { signal } from "nsh";
import type { Update } from "./updateFeed";

/** The window's update feed, when it has one. */
export const updateEntry = signal<Update | null>(null);
export const updateOpen = signal(false);
export const updateMessage = signal("");
export const updateBusy = signal(false);

/** Covers the current screen without changing it. */
export function showUpdate() {
	updateMessage.set("");
	updateOpen.set(true);
}

export function resetUpdateView() {
	updateOpen.set(false);
	updateMessage.set("");
}

/** Restores visibility last, after the covered screen and its focus exist. */
export function restoreUpdateView(open: boolean) {
	updateOpen.set(open);
}

/** Returns to the covered screen. */
export function closeUpdate() {
	updateOpen.set(false);
}

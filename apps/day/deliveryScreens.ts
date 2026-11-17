// The worker's named screens for one result: each pair's pinned image links,
// as the page shows them. Pure: no reads, no sends.
import { artifactSelection } from "./deliveryArtifact";
import type { ArtifactLink, DeliveredWork } from "./deliveryFeed";

/** One captured screen. `before` undefined: a new screen. null: named, but not linked and pinned here now. */
export type ScreenPair = {
	key: string;
	title: string;
	before: ArtifactLink | null | undefined;
	after: ArtifactLink | null;
};

function pinned(w: DeliveredWork, id: string): ArtifactLink | null {
	const link = w.artifacts.find((a) => a.artifactId === id && a.kind === "image");
	return link && artifactSelection(w, link) ? link : null;
}

/** "Today: mission row (After)" names the screen "Today: mission row". */
export function screenTitle(title: string): string {
	return title.replace(/\s*\((before|after)\)\s*$/i, "").trim() || "Screen";
}

export function screenPairs(w: DeliveredWork): ScreenPair[] {
	const s = w.screens;
	if (!s || !("pairs" in s)) return [];
	return s.pairs.map((p) => {
		const after = pinned(w, p.after);
		return {
			key: p.after,
			title: screenTitle(after?.title ?? ""),
			before: p.before === undefined ? undefined : pinned(w, p.before),
			after,
		};
	});
}

/** Artifacts the page shows under Screens, so Outputs does not open them first as well. */
export function screenIds(w: DeliveredWork): Set<string> {
	const s = w.screens;
	if (!s || !("pairs" in s)) return new Set();
	return new Set(s.pairs.flatMap((p) => (p.before ? [p.before, p.after] : [p.after])));
}

/** The worker's reason for no captures, or "". */
export function noScreens(w: DeliveredWork): string {
	const s = w.screens;
	return s && "none" in s ? s.none : "";
}

/** What one pair row says beside its title. */
export function screenLine(p: ScreenPair): string {
	if (!p.after) return "Not linked to this result now";
	if (p.before === undefined) return "New screen";
	if (p.before === null) return "After only: Before is not linked now";
	return "Before and After";
}

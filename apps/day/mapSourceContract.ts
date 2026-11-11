// Read-only identities and views for canonical map sources. No answer or write intent.
export type MapSourceRequest = {
	missionId: string;
	planRevision: number;
	area: "item" | "fog";
	recordId: string;
	kind: string;
	id: string;
};
export type MapSourceDetail = MapSourceRequest & {
	title: string;
	body: string;
	currentness: "current" | "stale";
	check: string;
	provenance: string[];
	history: string[];
};
export type MapSourceRead = { status: "available"; detail: MapSourceDetail } | { status: "unavailable" };

/** A reply must name the exact reference opened, never another source or mission. */
export function exactSource(request: MapSourceRequest, detail: MapSourceDetail): boolean {
	return ["missionId", "planRevision", "area", "recordId", "kind", "id"].every(
		(key) => request[key as keyof MapSourceRequest] === detail?.[key as keyof MapSourceRequest],
	);
}

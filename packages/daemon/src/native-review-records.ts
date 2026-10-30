/** Strict, selected-comparison-only read admission for dormant related records. */
import { exact, identifier, repositoryIdPattern } from "./jj-ownership-contract.ts";
import { deliveryReference } from "./mission-delivery-evidence.ts";

export function nativeReviewProfile(value: unknown, missionId: string, profileId: string, revision: number): void {
	exact(value, ["version", "id", "missionId", "recorderSessionId", "createdAt", "request", "type", "revision"]);
	for (const id of [value.id, value.recorderSessionId]) identifier(id, /^[a-zA-Z0-9_-]{1,128}$/);
	const request = value.request as { profileId?: unknown; expectedRevision?: unknown };
	if (
		value.version !== 1 ||
		value.type !== "profile" ||
		value.missionId !== missionId ||
		value.revision !== revision ||
		request?.profileId !== profileId ||
		Number(request.expectedRevision) + 1 !== revision ||
		!Number.isSafeInteger(value.createdAt) ||
		Number(value.createdAt) < 0
	)
		throw new Error("Malformed exact review profile");
}

export function nativeReviewRecord(
	kind: "review" | "submission" | "allocation",
	value: unknown,
	missionId: string,
	workerId: string,
	snapshotId: string,
): void {
	const common = ["version", "id", "missionId", "taskId", "createdAt", "request"];
	exact(value, [
		...common,
		...(kind === "review"
			? [
					"type",
					"ownerSessionId",
					"observations",
					"contextFence",
					"producer",
					"independence",
					"humanAuthorship",
					"recorderSessionId",
				]
			: kind === "submission"
				? ["type", "ownerSessionId", "observations", "actorSessionId"]
				: ["recorderSessionId", "historicalTaskAttribution", "scopeCoverage"]),
	]);
	for (const id of [value.id, value.taskId, kind === "submission" ? value.actorSessionId : value.recorderSessionId])
		identifier(id, /^[a-zA-Z0-9_-]{1,128}$/);
	if (
		value.version !== 1 ||
		value.missionId !== missionId ||
		!Number.isSafeInteger(value.createdAt) ||
		Number(value.createdAt) < 0
	)
		throw new Error("Malformed related Review identity");
	if (kind === "allocation") return; // allocationWrite validates its complete selected observation set.
	if (
		value.ownerSessionId !== workerId ||
		!Array.isArray(value.observations) ||
		value.observations.length < 1 ||
		value.observations.length > 100
	)
		throw new Error("Malformed related custody");
	for (const o of value.observations) {
		exact(o, ["reference", "sourceOwnerSessionId", "sha256", "availability"]);
		const ref = deliveryReference(o.reference);
		identifier(o.sha256, repositoryIdPattern);
		if (
			ref.kind !== "snapshot" ||
			ref.snapshotId !== snapshotId ||
			o.sha256 !== snapshotId ||
			o.sourceOwnerSessionId !== workerId ||
			!["retained", "partial", "unavailable"].includes(String(o.availability))
		)
			throw new Error("Unsupported related observation scope");
	}
	if (kind === "review") {
		exact(value.contextFence, ["briefRevision", "decisionEventId", "artifactEventId", "memberEventId"]);
		for (const n of Object.values(value.contextFence))
			if (!Number.isSafeInteger(n) || Number(n) < 0) throw new Error("Malformed review context fence");
	}
}

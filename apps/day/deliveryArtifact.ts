// Inert wire view only. Do not import the daemon's Node/provider type graph into NSH.
import { call, type Refusal } from "./bridge";
import type { ArtifactSelection, CapturedArtifact } from "./deliveryArtifactContract";
import type { DeliveredWork } from "./deliveryContract";

/** One passive read of the displayed exact pin. No fallback to latest, open,
 * evaluation, acceptance or retry. The result is source text, not a preview. */
export async function readDeliveryArtifact(
	window: string,
	shown: DeliveredWork,
	link: DeliveredWork["artifacts"][number],
): Promise<{ ok: true; snapshot: CapturedArtifact } | { ok: false; refusal: Refusal }> {
	if (!shown.deliveryId || !link.revision || shown.subject.kind !== "task")
		return { ok: false, refusal: "unavailable" };
	const request: ArtifactSelection = {
		subject: shown.subject,
		targetId: shown.targetId,
		deliveryId: shown.deliveryId,
		ownerSessionId: shown.ownerSessionId,
		sourceSessionId: link.sessionId,
		artifactId: link.artifactId,
		revision: link.revision,
	};
	const reply = await call<CapturedArtifact>(window, "day.delivery.artifact", request);
	return reply.ok ? { ok: true, snapshot: reply.snapshot } : reply;
}

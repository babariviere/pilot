// Inert wire view only. Do not import the daemon's Node/provider type graph into NSH.
import { call, type Refusal } from "./bridge";
import type { ArtifactSelection, CapturedArtifact } from "./deliveryArtifactContract";
import type { DeliveredWork } from "./deliveryContract";

export type { ArtifactSelection, CapturedArtifact };

/** One artifact linked to a delivered result, as the page shows it. */
export type ArtifactLink = DeliveredWork["artifacts"][number];

// "nsh" is agent-written NSH TSX: its saved source reads like any other text kind. Pilot does not run it here.
const KINDS = new Set(["html", "react", "image", "swiftui", "shader", "visual", "nsh"]);
const REASONS = new Set(["missing", "oversize", "redacted", "unsupported", "invalid"]);

/** The exact pin a press on `link` names, or null when the result cannot name one: a chat, no delivery, no revision. */
export function artifactSelection(shown: DeliveredWork, link: ArtifactLink): ArtifactSelection | null {
	if (!shown.deliveryId || !link.revision || shown.subject.kind !== "task") return null;
	return {
		subject: shown.subject,
		targetId: shown.targetId,
		deliveryId: shown.deliveryId,
		ownerSessionId: shown.ownerSessionId,
		sourceSessionId: link.sessionId,
		artifactId: link.artifactId,
		revision: link.revision,
	};
}

/** Whether two selections name exactly the same pin. */
export function samePin(a: ArtifactSelection, b: ArtifactSelection): boolean {
	const s = a.subject;
	const t = b.subject;
	return (
		s.kind === "task" &&
		t.kind === "task" &&
		s.projectId === t.projectId &&
		s.missionId === t.missionId &&
		s.taskId === t.taskId &&
		a.targetId === b.targetId &&
		a.deliveryId === b.deliveryId &&
		a.ownerSessionId === b.ownerSessionId &&
		a.sourceSessionId === b.sourceSessionId &&
		a.artifactId === b.artifactId &&
		a.revision === b.revision
	);
}

/**
 * The reply, when it is exactly the inert answer for `asked`: the same pin,
 * the linked kind, rendering unsupported and only text or a known reason.
 * Anything else is not shown. Images never carry bytes.
 */
export function capturedOf(x: unknown, asked: ArtifactSelection, kind: string): CapturedArtifact | null {
	const a = x as CapturedArtifact | null;
	if (!a || typeof a !== "object" || a.version !== 1 || a.rendering !== "unsupported") return null;
	if (!a.reference || typeof a.reference !== "object" || !samePin(a.reference, asked)) return null;
	const m = a.metadata;
	if (!m || typeof m.title !== "string" || !KINDS.has(m.kind) || m.kind !== kind) return null;
	const c = a.content;
	if (!c || typeof c !== "object") return null;
	if (c.state === "text") {
		if (m.kind === "image" || typeof c.source !== "string") return null;
		if (typeof c.containerSha256 !== "string" || typeof c.containerBytes !== "number") return null;
		return {
			version: 1,
			reference: asked,
			metadata: { title: m.title, kind: m.kind },
			rendering: "unsupported",
			content: {
				state: "text",
				source: c.source,
				containerSha256: c.containerSha256,
				containerBytes: c.containerBytes,
			},
		};
	}
	if (c.state === "unavailable" && REASONS.has(c.reason)) {
		return {
			version: 1,
			reference: asked,
			metadata: { title: m.title, kind: m.kind },
			rendering: "unsupported",
			content: { state: "unavailable", reason: c.reason },
		};
	}
	return null;
}

/** One passive read of the displayed exact pin. No fallback to latest, open,
 * evaluation, acceptance or retry. The result is source text, not a preview. */
export async function readDeliveryArtifact(
	window: string,
	shown: DeliveredWork,
	link: ArtifactLink,
): Promise<{ ok: true; snapshot: CapturedArtifact } | { ok: false; refusal: Refusal }> {
	const request = artifactSelection(shown, link);
	if (!request) return { ok: false, refusal: "unavailable" };
	const reply = await call<CapturedArtifact>(window, "day.delivery.artifact", request);
	if (!reply.ok) return reply;
	const snapshot = capturedOf(reply.snapshot, request, link.kind);
	return snapshot ? { ok: true, snapshot } : { ok: false, refusal: "invalid" };
}

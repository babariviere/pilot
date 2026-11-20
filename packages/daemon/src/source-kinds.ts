import { createHash } from "node:crypto";
import type { Project, TrackedKind } from "@pilot/protocol";

export const SOURCE_KINDS = ["linear", "slack"] as const satisfies readonly TrackedKind[];

/** A project's source, stored and sent to clients as <projectId>:<kind>. */
export function sourceId(projectId: string, kind: TrackedKind): string {
	return `${projectId}:${kind}`;
}

export function parseSourceId(id: string): { projectId: string; kind: TrackedKind } | undefined {
	const split = id.lastIndexOf(":");
	const kind = id.slice(split + 1);
	if (split < 1 || (kind !== "linear" && kind !== "slack")) return undefined;
	return { projectId: id.slice(0, split), kind };
}

export function sourceLabel(kind: TrackedKind): "Linear" | "Slack" {
	return kind === "linear" ? "Linear" : "Slack";
}

export function isConfigured(project: Project, kind: TrackedKind): boolean {
	return kind === "linear" ? !!project.tracking?.linearTeam : !!project.tracking?.slackChannels.length;
}

/** Saved checkpoints and rows count only while their key matches. */
export function configKey(project: Project, kind: TrackedKind): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				// Slack progress is kept per channel, so editing the list does not restart the others.
				kind === "linear" ? project.tracking?.linearTeam : null,
				kind,
				kind === "linear" ? "linear-mine-cycle-descendants-v1" : "dedicated-v2",
			]),
		)
		.digest("hex");
}

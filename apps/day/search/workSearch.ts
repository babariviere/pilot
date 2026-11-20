import { signal } from "nsh";
import type { KnowledgeDetail } from "../../../packages/protocol/src/knowledge/knowledge";
import { type ArtifactRow, type ReadResult, readRefused, savedOf } from "../artifacts/artifactReads";
import type { VerificationSubject } from "../missions/delivery/deliveryContract";
import { call } from "../sources/bridge";

type Hit = { key: string; title: string; projectId: string; projectName: string };
export type DetailHit = Hit &
	({ kind: "output"; target: ArtifactRow } | { kind: "knowledge"; target: { id: string; revision: number } });
export type SearchHit =
	| DetailHit
	| (Hit & { kind: "mission" | "chat"; target: string })
	| (Hit & { kind: "result"; target: VerificationSubject });
export type WorkSearchPage = {
	projects: { id: string; name: string }[];
	hits: SearchHit[];
	partial: boolean;
	more: boolean;
	nextCursor?: string | null;
};
export interface WorkSearchSource {
	read(query: string, projectId: string | null, cursor?: string): Promise<WorkSearchPage | null>;
	project?(): Promise<string | null | undefined>;
	restoreProject?(projectId: string | null): Promise<boolean>;
	output(hit: Extract<DetailHit, { kind: "output" }>): Promise<ReadResult>;
	knowledge(hit: Extract<DetailHit, { kind: "knowledge" }>): Promise<KnowledgeDetail | null>;
}

export const searchDetail = signal<DetailHit | null>(null);
export const destinationProject = signal<string>("");

export function connectedWorkSearch(window: string): WorkSearchSource {
	return {
		async project() {
			const reply = await call<string | null>(window, "day.navigation.project", {});
			return reply.ok ? reply.snapshot : undefined;
		},
		async restoreProject(projectId) {
			const reply = await call(window, "day.navigation.restore", { projectId });
			return reply.ok;
		},
		async read(query, projectId, cursor) {
			const reply = await call<WorkSearchPage>(window, "day.search.read", { query, projectId, cursor });
			return reply.ok ? reply.snapshot : null;
		},
		async output({ projectId, target: row }) {
			const reply = await call(window, "day.search.output", {
				projectId,
				artifact: { sourceSessionId: row.sessionId, artifactId: row.artifactId, revision: row.revision },
			});
			if (!reply.ok) return readRefused(reply.refusal);
			const artifact = savedOf(reply.snapshot, row);
			return artifact ? { status: "shown", artifact } : readRefused("invalid");
		},
		async knowledge({ projectId, target }) {
			const reply = await call<{ projectId: string; data: KnowledgeDetail }>(window, "day.search.knowledge", {
				projectId,
				...target,
			});
			return reply.ok && reply.snapshot.projectId === projectId ? reply.snapshot.data : null;
		},
	};
}

import type {
	AssistanceRequest,
	AssistanceScope,
	HumanActionCommand,
	HumanActionRecord,
} from "./decision-assistance.ts";
import type { AgentQuestion, SessionSummary } from "./index.ts";
import type { OperationHost } from "./operations.ts";

/** Sent only over the authenticated native boundary. An actor field cannot authenticate a caller. */
export interface NativeAttentionEnvelope {
	version: 1;
	home: OperationHost;
	projectId: string;
}
export interface NativeAttentionQuestion {
	scope: AssistanceScope;
	question: AgentQuestion;
	session: Pick<SessionSummary, "id" | "title" | "missionId" | "inputGeneration">;
}
export interface NativeAttentionRead {
	version: 1;
	projectId: string;
	questions: NativeAttentionQuestion[];
	actions: Array<{ record: HumanActionRecord; authorityDigest: string }>;
	capabilities: { help: "unavailable" | 1; continuation: "unavailable" };
}
export type NativeAttentionRequest = NativeAttentionEnvelope &
	(
		| { kind: "read" }
		| { kind: "action"; authorityDigest: string; command: HumanActionCommand }
		| { kind: "help"; request: AssistanceRequest }
		| { kind: "resource"; expected: Pick<HumanActionRecord, "id" | "revision" | "digest">; authorityDigest: string }
	);

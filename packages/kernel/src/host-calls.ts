/** The tool-facing call functions, each a thin wrapper over the one host call to pilotd. */
import type { ChatReportCall } from "./chat-report-tool.ts";
import type { CoordinatorSources } from "./coordinator-sources.ts";
import type { DiagnosticContextCall } from "./diagnostic-context-tool.ts";
import type { DiagnosticHistoryCall } from "./diagnostic-history-tool.ts";
import type { DiagnosticLogCall } from "./diagnostic-log-tool.ts";
import type { DiagnosticsCall } from "./diagnostics-tool.ts";
import type { InsightsBacklogCall } from "./insights-backlog-tool.ts";
import type { KnowledgeCall } from "./knowledge-tools.ts";
import type { LiveUpdateProposalCall } from "./live-update-tool.ts";
import type { MemoryCall } from "./memory-tools.ts";
import type { MissionCall } from "./mission-tools.ts";
import type { PlanningWorkerReply, PlanningWorkerRequest } from "./planning-worker.ts";
import type { HostCall } from "./protocol.ts";
import type { ReferenceSource } from "./reference-sources.ts";
import type { RepairProposalCall } from "./repair-proposal-tool.ts";
import type { ScreenCall } from "./screen-tools.ts";
import type { SlackStatusCall } from "./slack-status-tool.ts";
import type { ReportSubscriptionLimit } from "./subscription-limit.ts";
import type { AcquireUsageEpoch, PublishUsage } from "./usage-capture.ts";

export function hostCallTools(call: HostCall) {
	return {
		callPlanning: (request: PlanningWorkerRequest, signal?: AbortSignal): Promise<PlanningWorkerReply> =>
			call("planning", { request }, signal),
		guardPlanning: (operationId: string): Promise<void> => call("planning.guard", { operationId }),
		reportUsageHistory: ((row) => call("usage-history", { row })) satisfies PublishUsage,
		acquireUsageEpoch: (() => call("usage-history.epoch", {}, AbortSignal.timeout(100))) satisfies AcquireUsageEpoch,
		reportSubscriptionLimit: ((limit) => call("subscription.limit", { limit })) satisfies ReportSubscriptionLimit,
		publicationSource: (bookmark?: string) => call("publication.source", { bookmark }, AbortSignal.timeout(15_000)),
		callMission: ((action, args) => call("mission", { action, args })) satisfies MissionCall,
		readCoordinatorSources: (signal?: AbortSignal): Promise<CoordinatorSources> => call("source.scope", {}, signal),
		readReferenceSources: (signal?: AbortSignal): Promise<ReferenceSource[]> => call("source.references", {}, signal),
		callMemory: ((action, args, operationId?) => call("memory", { operationId, action, args })) satisfies MemoryCall,
		callKnowledge: ((action, args, operationId?) =>
			call("knowledge", { operationId, action, args })) satisfies KnowledgeCall,
		callInsightsBacklog: ((request) => call("insights.backlog", { request })) satisfies InsightsBacklogCall,
		callLiveUpdateProposal: ((args, operationId) =>
			call("liveUpdate.propose", { operationId, args })) satisfies LiveUpdateProposalCall,
		callSlackStatus: ((args) => call("slack", { args })) satisfies SlackStatusCall,
		callChatReport: ((args) => call("chatReport", { args })) satisfies ChatReportCall,
		callDiagnostics: ((sessionId?, limit?) =>
			call("diagnostics", {
				...(sessionId === undefined ? {} : { sessionId }),
				...(limit === undefined ? {} : { limit }),
			})) satisfies DiagnosticsCall,
		callDiagnosticContext: ((request, signal?) =>
			call("diagnostics.context", { request }, signal)) satisfies DiagnosticContextCall,
		callScreen: ((operation, signal?) => call("screen", { operation }, signal)) satisfies ScreenCall,
		callDiagnosticHistory: ((sessionId, before?, limit?) =>
			call("diagnostics.history", {
				sessionId,
				...(before === undefined ? {} : { before }),
				...(limit === undefined ? {} : { limit }),
			})) satisfies DiagnosticHistoryCall,
		callDiagnosticLogs: ((request, signal?) =>
			call("diagnostics.logs", { request }, signal)) satisfies DiagnosticLogCall,
		callRepairProposal: ((proposal) => call("diagnostics.proposal", { proposal })) satisfies RepairProposalCall,
		readArtifactReference: (id: string, revision?: number) => call("artifact.reference", { id, revision }),
	};
}

export type HostCallTools = ReturnType<typeof hostCallTools>;

import type { ModelOption } from "../runtime/models.ts";
import type { OperationHost } from "../operations/operations.ts";
import type { SessionState } from "../chats/session.ts";
import type { TelemetrySettings } from "../runtime/telemetry.ts";

export interface DiagnosticsPrivacyValue {
	localDiagnostics: boolean;
	localFeatureUsage: boolean;
	remoteOperational: boolean;
	productAnalytics: boolean;
	endpoint?: string;
}

export type DiagnosticsControlsPayload = {
	purpose: "diagnostics-controls";
	binding: string;
} & (
	| { action: "save"; value: DiagnosticsPrivacyValue }
	| { action: "clear"; value: null }
	| { action: "start"; value: { model: string; thinking: string; question: string; focus?: "app" } }
	| { action: "send"; value: { sessionId: string; message: string } }
);

export interface DiagnosticsControlsSnapshot {
	version: 1;
	host: OperationHost;
	settings: TelemetrySettings;
	binding: string;
	models: ModelOption[];
	chats: {
		items: Array<{ sessionId: string; title: string; model?: string; thinking?: string; status: SessionState }>;
		hasMore: boolean;
	};
	retained: string[];
	limits: { endpointBytes: number; payloadBytes: number; messageBytes: number };
}

export type DiagnosticsControlsResult =
	| { action: "save" | "clear"; saved: true; retained: string[] }
	| { action: "start" | "send"; sessionId: string };

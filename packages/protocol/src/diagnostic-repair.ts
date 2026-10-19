import type { DiagnosticTargetReference } from "./index.ts";
import type { OperationHost } from "./operations.ts";

/** Evidence provenance is independent of the registered source project used to repair the application. */
export type DiagnosticEvidenceSubject =
	| { kind: "app"; host: OperationHost }
	| ({ kind: "chat" } & DiagnosticTargetReference);

/** User-confirmed host/path/origin pin. Names and origin matches alone never select a repair checkout. */
export interface DiagnosticRepairProjectBinding {
	schemaVersion: 1;
	id: string;
	revision: number;
	host: OperationHost;
	projectId: string;
	path: string;
	origin: string;
	configuredAt: string;
}

export interface DiagnosticRepairProjectStatus {
	state: "missing" | "available" | "unavailable" | "invalid";
	revision: number;
	binding?: DiagnosticRepairProjectBinding;
	reason?: "storage" | "identity_changed" | "project_missing" | "path_changed" | "origin_changed";
}

/** Native setup only. Exact candidate bytes are reviewed before confirmation; never an agent-supplied path. */
export interface DiagnosticRepairProjectSetup {
	expectedRevision: number;
	host: OperationHost;
	projectId: string;
	path: string;
	origin: string;
}

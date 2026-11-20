import type { DurableOperation } from "@pilot/protocol";

/** Native controls require capability on both writes and receipt reads. Recovery only reports an unknown outcome. */
export interface ControlOperation {
	kind: string;
	unavailable: string;
	outcomeUnknown: string;
	/** Some payloads must be refused before lookup or reservation. */
	validate?(op: DurableOperation): void;
	/** Absent when the owning service is unavailable. */
	admit?(op: DurableOperation, firstEntry: boolean): Promise<unknown>;
	safetyReduction?(op: DurableOperation): boolean;
}

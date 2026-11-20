import type { DurableOperation, OperationReceipt } from "@pilot/protocol";

/** Native controls require capability on both writes and receipt reads. Recovery is lookup-only unless the owner can reconcile the exact saved effect. */
export interface ControlOperation {
	kind: string;
	unavailable: string;
	outcomeUnknown: string;
	/** Some payloads must be refused before lookup or reservation. */
	validate?(op: DurableOperation): void;
	/** Absent when the owning service is unavailable. */
	admit?(op: DurableOperation, firstEntry: boolean): Promise<unknown>;
	/** Override the journal receipt with an exact owner receipt, without entering an effect. */
	lookup?(op: DurableOperation): Promise<OperationReceipt | null>;
	recover?(op: DurableOperation): Promise<unknown>;
	safetyReduction?(op: DurableOperation): boolean;
}

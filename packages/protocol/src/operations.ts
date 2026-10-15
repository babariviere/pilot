/** Immutable transport-independent admission envelope. Persist before exposing it to a courier. */
export interface OperationHost {
	hostId: string;
	daemonId: string;
	lineageId: string;
}
export interface DurableOperation {
	schemaVersion: 1;
	operationId: string;
	producerId: string;
	sequence: number;
	origin: OperationHost;
	destination: OperationHost;
	kind: string;
	targetId: string;
	payload: string;
	payloadHash: string;
	bindingId?: string;
	bindingGeneration?: number;
}
export interface OperationReceipt {
	operationId: string;
	payloadHash: string;
	destination: OperationHost;
	targetId: string;
	state: "pending" | "accepted" | "rejected";
	result?: unknown;
	reason?: string;
}
/** Client-side uncertainty, never a durable rejection or permission for a fresh operation. */
export type OperationDelivery = OperationReceipt | { state: "unknown" };

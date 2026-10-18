import type { ControlHostErrorResponse, OperationHost } from "@pilot/protocol";
import { OperationRejected } from "./operation-journal.ts";

export class ControlHostError extends OperationRejected {
	readonly code: ControlHostErrorResponse["code"];
	readonly status: number;
	constructor(code: ControlHostErrorResponse["code"], message: string, status = 409) {
		super(message, { code, error: message });
		this.code = code;
		this.status = status;
	}
	response(): ControlHostErrorResponse {
		return { code: this.code, error: this.message };
	}
}
export function requireHost(value: unknown): asserts value is OperationHost {
	const host = value as OperationHost;
	if (
		!host ||
		host.hostId !== "daemon" ||
		![host.daemonId, host.lineageId].every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))
	)
		throw new ControlHostError("identity_mismatch", "Expected a normalized installation and lineage pin");
}
export function sameControlHost(a: OperationHost | undefined, b: OperationHost | undefined): boolean {
	return (
		!!a &&
		!!b &&
		a.hostId === "daemon" &&
		b.hostId === "daemon" &&
		a.daemonId === b.daemonId &&
		a.lineageId === b.lineageId
	);
}
export function controlId(value: unknown): asserts value is string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 128 || /[\x00-\x1f]/.test(value))
		throw new ControlHostError("invalid_request", "Invalid Control identifier", 400);
}
export function positive(value: unknown): asserts value is number {
	if (!Number.isSafeInteger(value) || Number(value) < 1)
		throw new ControlHostError("invalid_request", "Expected a positive safe integer", 400);
}
export function strictObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw new ControlHostError("invalid_request", "Unexpected Control payload fields", 400);
}

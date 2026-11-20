/** Shared parsing and admission for native durable intents (settings pages Day confirms with one operation). */
import type { DurableOperation, OperationHost } from "@pilot/protocol";
import { OperationRejected, sameHost } from "../../transport/operations/operation-journal.ts";

/**
 * Parse the common native control envelope. The control still validates its target, binding and action.
 */
export function parseIntent(
	op: DurableOperation,
	host: OperationHost,
	kind: string,
	keys: readonly string[],
	refusal: string,
): Record<string, unknown> {
	let p: unknown;
	try {
		p = JSON.parse(op.payload);
	} catch {
		throw new OperationRejected(refusal);
	}
	if (
		!p ||
		typeof p !== "object" ||
		Array.isArray(p) ||
		Object.keys(p).sort().join() !== [...keys].sort().join() ||
		(p as { purpose?: unknown }).purpose !== kind ||
		op.kind !== kind ||
		!op.origin ||
		!sameHost(op.origin, host)
	)
		throw new OperationRejected(refusal);
	return p as Record<string, unknown>;
}

/**
 * One admission at a time, in order. Re-entry is lookup only: an entered write, sign-in or cancel is never sent
 * again after an uncertain receipt.
 */
export class SerialAdmissions {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly outcomeUnknown: string;
	constructor(outcomeUnknown: string) {
		this.outcomeUnknown = outcomeUnknown;
	}
	admit<T>(firstEntry: boolean, apply: () => Promise<T>): Promise<T> {
		if (!firstEntry) return Promise.reject(new Error(this.outcomeUnknown));
		const work = this.tail.then(apply);
		this.tail = work.catch(() => undefined);
		return work;
	}
}

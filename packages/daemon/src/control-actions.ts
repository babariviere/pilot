import type { ControlMemory } from "./control-memory.ts";
export interface ControlAuditEntry {
	seq: number;
	operationId: string;
	action: string;
	phase: "requested" | "succeeded" | "failed";
	at: number;
	caller: string;
	args: Record<string, unknown>;
	result?: unknown;
}
export class ControlActions {
	private readonly memory: ControlMemory;
	private readonly isControl: (id: string) => boolean;
	private readonly publish: (entry: ControlAuditEntry) => Promise<void>;
	private readonly running = new Map<string, { payload: string; task: Promise<unknown> }>();
	constructor(
		memory: ControlMemory,
		isControl: (id: string) => boolean,
		publish: (entry: ControlAuditEntry) => Promise<void>,
	) {
		this.memory = memory;
		this.isControl = isControl;
		this.publish = publish;
	}
	perform<T>(
		caller: string,
		action: string,
		args: Record<string, unknown>,
		operationId: string,
		work: () => Promise<T>,
	): Promise<T> {
		if (!this.isControl(caller)) return Promise.reject(new Error("Only the control chat may perform global actions"));
		if (typeof operationId !== "string" || !operationId || operationId.length > 256)
			return Promise.reject(new Error("Action requires a stable tool call identity"));
		const key = `${caller}:${operationId}`;
		const payload = JSON.stringify([action, args]);
		const existing = this.running.get(key);
		if (existing)
			return existing.payload === payload
				? (existing.task as Promise<T>)
				: Promise.reject(new Error("Action identity reused with different arguments"));
		if (this.running.size >= 32) return Promise.reject(new Error("Too many control actions"));
		const task = (async () => {
			const prior = await this.memory.auditOperation(key);
			if (prior) {
				if (prior.action !== action || JSON.stringify(prior.args) !== JSON.stringify(args))
					throw new Error("Action identity reused with different arguments");
				if (prior.phase === "succeeded") return prior.result as T;
				throw new Error(
					"This action failed or its outcome is uncertain; inspect the audit before requesting a new action",
				);
			}
			await this.memory.auditAppend({ operationId: key, action, phase: "requested", at: Date.now(), caller, args });
			let result: T;
			try {
				if (!this.isControl(caller)) throw new Error("Control role changed");
				result = await work();
			} catch (error) {
				const entry = await this.memory.auditAppend({
					operationId: key,
					action,
					phase: "failed",
					at: Date.now(),
					caller,
					args,
					result: { error: error instanceof Error ? error.message.slice(0, 500) : "Action failed" },
				});
				await this.publish(entry).catch(() => {});
				throw error;
			}
			result = JSON.parse(JSON.stringify(result ?? null)) as T;
			const entry = await this.memory.auditAppend({
				operationId: key,
				action,
				phase: "succeeded",
				at: Date.now(),
				caller,
				args,
				result,
			});
			await this.publish(entry).catch(() => {});
			return result;
		})().finally(() => {
			this.running.delete(key);
		});
		this.running.set(key, { payload, task });
		return task;
	}
	page(before?: number, limit?: number): Promise<ControlAuditEntry[]> {
		return this.memory.auditPage(before, limit);
	}
	async settled(): Promise<void> {
		await Promise.allSettled([...this.running.values()].map(({ task }) => task));
	}
}

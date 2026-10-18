import type { ControlAuditEntry } from "@pilot/protocol";

export type { ControlAuditEntry } from "@pilot/protocol";

import type { ControlAuthorizationUse } from "./control-authorizations.ts";
import type { ControlMemory } from "./control-memory.ts";
export class ControlActions {
	private readonly memory: ControlMemory;
	private readonly isControl: (id: string) => boolean;
	private readonly publish: (entry: ControlAuditEntry) => Promise<void>;
	private readonly changed: () => void;
	private readonly running = new Map<string, { payload: string; task: Promise<unknown> }>();
	constructor(
		memory: ControlMemory,
		isControl: (id: string) => boolean,
		publish: (entry: ControlAuditEntry) => Promise<void>,
		changed: () => void = () => {},
	) {
		this.memory = memory;
		this.isControl = isControl;
		this.publish = publish;
		this.changed = changed;
	}
	perform<T>(
		caller: string,
		action: string,
		args: Record<string, unknown>,
		operationId: string,
		work: () => Promise<T>,
		admission?: ControlAuthorizationUse,
		onDenied?: (error: unknown) => Promise<void>,
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
			const requested = {
				operationId: key,
				action,
				phase: "requested" as const,
				at: Date.now(),
				caller,
				args,
				...(typeof args.authorizationId === "string" ? { authorizationId: args.authorizationId } : {}),
			};
			try {
				if (admission) await this.memory.authorizationAdmit(requested, admission);
				else await this.memory.auditAppend(requested);
			} catch (error) {
				// Denied requests have no reservation/effect, but their rejection remains inspectable.
				await onDenied?.(error);
				if (admission) {
					const entry = await this.memory.auditAppend({
						...requested,
						phase: "failed",
						result: { error: error instanceof Error ? error.message.slice(0, 500) : "Admission failed" },
					});
					this.changed();
					await this.publish(entry).catch(() => {});
				}
				throw error;
			}
			this.changed();
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
					...(requested.authorizationId ? { authorizationId: requested.authorizationId } : {}),
					result: { error: error instanceof Error ? error.message.slice(0, 500) : "Action failed" },
				});
				this.changed();
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
				...(requested.authorizationId ? { authorizationId: requested.authorizationId } : {}),
				result,
			});
			this.changed();
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

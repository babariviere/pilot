import { performance } from "node:perf_hooks";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const SHELL_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 2_147_483.647;
export const SHELL_STATUS_DETAIL = "pilotShellStatus";

interface ShellDeadlineOptions {
	defaultTimeoutSeconds?: number;
	longRunningMs?: number;
	timeout?(callId: string): void;
	status?(callId: string, text: string): void;
}

/** Keep the SDK's process-group cleanup and wait for it, never race cleanup with a detached result. */
export function shellDeadline(
	execute: ToolDefinition["execute"],
	options: ShellDeadlineOptions = {},
): ToolDefinition["execute"] {
	return async function (this: ToolDefinition, id, input, signal, onUpdate, context) {
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid shell arguments");
		const args = input as Record<string, unknown>;
		const seconds =
			args.timeout === undefined ? (options.defaultTimeoutSeconds ?? SHELL_TIMEOUT_SECONDS) : args.timeout;
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_TIMEOUT_SECONDS)
			throw new Error(`Invalid shell timeout: use seconds greater than 0 and at most ${MAX_TIMEOUT_SECONDS}`);
		signal?.throwIfAborted();
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		const started = performance.now();
		let latest: AgentToolResult<unknown> = { content: [], details: undefined };
		const deadline = setTimeout(() => {
			if (controller.signal.aborted) return;
			try {
				options.timeout?.(id);
			} catch {
				// Evidence publication must never prevent process cleanup.
			}
			controller.abort(
				new DOMException(`Command timed out after ${seconds} seconds. It was not retried.`, "TimeoutError"),
			);
		}, seconds * 1000);
		const status =
			onUpdate || options.status
				? setTimeout(() => {
						if (controller.signal.aborted) return;
						try {
							const text = `Command still running (${Math.floor((performance.now() - started) / 1000)}s elapsed; ${seconds}s deadline). Stop cancels it.`;
							onUpdate?.({
								content: [
									...latest.content,
									{
										type: "text",
										text,
									},
								],
								details: { [SHELL_STATUS_DETAIL]: true },
							});
							options.status?.(id, text);
						} catch {
							// A display-only notice must not fail a running command.
						}
					}, options.longRunningMs ?? 30_000)
				: undefined;
		try {
			// One deadline owner. The SDK's independent timeout would otherwise become an ordinary failure.
			return await execute.call(
				this,
				id,
				{ ...args, timeout: undefined },
				controller.signal,
				onUpdate
					? (update) => {
							latest = update;
							onUpdate(update);
						}
					: undefined,
				context,
			);
		} catch (error) {
			if (controller.signal.aborted && controller.signal.reason?.name === "TimeoutError") {
				// Preserve partial output from the SDK's cancellation error.
				throw new Error(
					`${error instanceof Error ? error.message : "Command stopped"}\n${controller.signal.reason.message}`,
					{ cause: error },
				);
			}
			throw error;
		} finally {
			clearTimeout(deadline);
			clearTimeout(status);
			signal?.removeEventListener("abort", abort);
		}
	};
}

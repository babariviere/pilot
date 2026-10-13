/** Child Pi extension. The parent remains the sole store writer and publication owner. */
import { randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createArtifactTools } from "./artifact-tools.ts";

export default function subagentArtifacts(pi: ExtensionAPI): void {
	if (process.env.PI_CODE_MODE_SUBAGENT !== "1" || !process.env.PILOT_ARTIFACT_PARENT_SESSION_ID || !process.send)
		return;
	const pending = new Map<string, { resolve(result: AgentToolResult<unknown>): void; reject(error: Error): void }>();
	const disconnect = () => {
		for (const call of pending.values()) call.reject(new Error("Parent artifact bridge disconnected"));
	};
	const receive = (message: unknown) => {
		const packet = message as { type?: string; callId?: string; result?: AgentToolResult<unknown>; error?: string };
		if (packet?.type !== "artifact.result" || typeof packet.callId !== "string") return;
		const call = pending.get(packet.callId);
		if (packet.error !== undefined) call?.reject(new Error(packet.error));
		else if (packet.result) call?.resolve(packet.result);
		else call?.reject(new Error("Invalid parent artifact result"));
	};
	const unavailable = async (): Promise<never> => {
		throw new Error("Artifact operations require the parent bridge");
	};
	const [tool] = createArtifactTools({
		store: { create: unavailable, update: unavailable, get: unavailable, list: unavailable },
		ask: true,
		preview: false,
		diagnose: false,
	});
	pi.registerTool({
		...tool!,
		description: `Parent chat artifacts only. list/get/create/update use the parent's store, never other chats or linked foreign references. Updates require expectedRevision; images require inline data URLs.\n${tool!.description}`,
		async execute(_callId, args, signal) {
			signal?.throwIfAborted();
			if (pending.size >= 8) throw new Error("Too many concurrent artifact requests");
			return new Promise((resolve, reject) => {
				const callId = randomUUID();
				const settle = (error?: Error, result?: AgentToolResult<unknown>) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					pending.delete(callId);
					if (error) reject(error);
					else resolve(result!);
				};
				const abort = () => settle(new Error("Artifact request aborted"));
				const timer = setTimeout(() => settle(new Error("Parent artifact request timed out")), 300_000);
				timer.unref();
				pending.set(callId, { resolve: (result) => settle(undefined, result), reject: (error) => settle(error) });
				signal?.addEventListener("abort", abort, { once: true });
				try {
					process.send!({ type: "artifact.call", callId, args }, (error: Error | null) => {
						if (error) settle(error);
					});
				} catch (error) {
					settle(error instanceof Error ? error : new Error(String(error)));
				}
			});
		},
	});
	// Factory registration has no process resources; begin/end them with the session lifecycle.
	pi.on("session_start", () => {
		process.on("message", receive);
		process.on("disconnect", disconnect);
	});
	pi.on("session_shutdown", () => {
		process.off("message", receive);
		process.off("disconnect", disconnect);
		for (const call of pending.values()) call.reject(new Error("Artifact bridge closed"));
	});
}

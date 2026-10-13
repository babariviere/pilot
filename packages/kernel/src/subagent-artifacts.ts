/** Parent-only artifact execution over the subagents extension's supervised IPC/event bridge. */
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import type { ExtensionFactory, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createArtifactTools, type ArtifactToolOptions } from "./artifact-tools.ts";

export const ARTIFACT_CALL_EVENT = "subagents:artifact-call";
export const ARTIFACT_RESULT_EVENT = "subagents:artifact-result";

/** Uses the same tool/get-by-ID implementation as the parent, with foreign-reference fallback disabled. */
export async function executeSubagentArtifact(
	parentSessionId: string,
	cwd: string,
	options: ArtifactToolOptions,
	request: { parentSessionId?: unknown; name?: unknown; callId?: unknown; args?: unknown },
) {
	if (request.parentSessionId !== parentSessionId) throw new Error("Artifact parent session does not match");
	if (
		typeof request.name !== "string" ||
		!request.name.trim() ||
		request.name.length > 128 ||
		/[\x00-\x1f\x7f]/.test(request.name)
	)
		throw new Error("Artifact publication requires a valid subagent name");
	const name = request.name;
	const [tool] = createArtifactTools({
		...options,
		readReference: undefined,
		ask: true,
		preview: false,
		diagnose: false,
		onArtifactPublished: (artifact) => options.onArtifactPublished?.(artifact, name) ?? Promise.resolve(),
	});
	if (!request.args || typeof request.args !== "object" || Array.isArray(request.args))
		throw new Error("Artifact request requires arguments");
	const args = validateToolArguments(tool!, {
		type: "toolCall",
		id: String(request.callId),
		name: "artifact",
		arguments: request.args as Record<string, JsonValue>,
	});
	if (args.action === "update" && args.expectedRevision === undefined)
		throw new Error("Subagent artifact update requires expectedRevision");
	return tool!.execute(String(request.callId), args, undefined, undefined, { cwd } as ExtensionToolContext);
}

export class SubagentArtifactHost {
	readonly #closers = new Set<() => Promise<void>>();
	readonly sessionId: string;
	readonly cwd: string;
	readonly options: ArtifactToolOptions;
	constructor(sessionId: string, cwd: string, options: ArtifactToolOptions) {
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.options = options;
	}
	readonly native: ExtensionFactory = (pi) => {
		let active = true;
		const pending = new Set<Promise<void>>();
		const off = pi.events.on(ARTIFACT_CALL_EVENT, (data) => {
			const request = data as Parameters<typeof executeSubagentArtifact>[3] | undefined;
			if (!active || typeof request?.callId !== "string") return;
			const reply = (result: object) => pi.events.emit(ARTIFACT_RESULT_EVENT, { callId: request.callId, ...result });
			if (pending.size >= 8) {
				reply({ error: "Too many concurrent artifact requests" });
				return;
			}
			const job = executeSubagentArtifact(this.sessionId, this.cwd, this.options, request).then(
				(result) => reply({ result }),
				(error: unknown) => reply({ error: error instanceof Error ? error.message : String(error) }),
			);
			pending.add(job);
			void job.finally(() => pending.delete(job)).catch(() => {});
		});
		const close = async () => {
			active = false;
			off();
			await Promise.allSettled(pending);
		};
		this.#closers.add(close);
		pi.on("session_shutdown", async () => {
			await close();
			this.#closers.delete(close);
		});
	};
	async close(): Promise<void> {
		await Promise.allSettled([...this.#closers].map((close) => close()));
		this.#closers.clear();
	}
}

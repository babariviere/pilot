/** One durable pi session: a Harness root conversation driven by the native Pi kernel. */
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type AgentEventStream,
	type Conversation,
	createRegistry,
	type DocumentWatch,
	type Extension,
	Harness,
	type InboxState,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type Storage,
	watchEvents,
} from "@earendil-works/pi-durable";
import { ArtifactStore } from "@pilot/artifacts";
import type { AgentEvent, DeliveryMode, SessionCompletion, SessionUsage } from "@pilot/protocol";
import { createArtifactTools } from "./artifact-tools.ts";
import { reconcileCompletion, withAttention } from "./attention.ts";
import { NativeAdapter } from "./native-adapter.ts";
import { withPilotPolicy } from "./policy.ts";
import type { KernelSpec } from "./protocol.ts";
import { editQueuedMessage, queueUpdate, watchQueue } from "./queue.ts";
import { openSessionStorage } from "./storage.ts";

const context: Context = BACKGROUND_CONTEXT;

/** Arbitrary native tools are unsafe to rerun after a crash, whatever they claim. */
function replayUnsafe(extension: Extension): Extension {
	return {
		...extension,
		tools: extension.tools?.map((tool) => ({ ...tool, replay: "unsafe", executionMode: "sequential" })),
	};
}

/** The model a session was created with, read before the native kernel opens with host defaults. */
async function pinnedAgent(
	storage: Storage,
): Promise<{ model: ModelRef; thinkingLevel?: ModelThinkingLevel } | undefined> {
	const record = await storage.findDocument(
		{ kind: AgentDoc.definition.kind, scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } },
		"current",
		context,
	);
	if (!record) return undefined;
	const stored = await storage.document(record.id, "current", context);
	const agent = stored?.value as { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } | undefined;
	return agent?.model ? { model: agent.model, thinkingLevel: agent.thinkingLevel } : undefined;
}

export interface KernelSessionHooks {
	onWorking(working: boolean, completion?: SessionCompletion): void;
	onUsageChanged?(usage: SessionUsage): void;
	/** Called after an artifact revision has been committed to the session store. */
	onArtifactsChanged?(): void;
}

export class KernelSession {
	readonly #watches = new Map<string, { events: AgentEventStream; queue: DocumentWatch<InboxState> }>();
	#working = false;
	#completion?: SessionCompletion;
	#closing?: Promise<void>;

	private constructor(
		readonly harness: Harness,
		readonly conversation: Conversation,
		private readonly adapter: NativeAdapter,
		private readonly release: () => void,
		private readonly status: AgentEventStream,
	) {}

	static async open(spec: KernelSpec, hooks: KernelSessionHooks): Promise<KernelSession> {
		const owned = await openSessionStorage(spec.storageDir);
		let adapter: NativeAdapter | undefined;
		let harness: Harness | undefined;
		let artifactConversation: Conversation | undefined;
		try {
			const pinned = await pinnedAgent(owned.storage);
			const artifacts = new ArtifactStore(dirname(spec.storageDir), {
				sessionId: spec.sessionId,
				projectId: spec.projectId,
			});
			adapter = await NativeAdapter.open({
				cwd: spec.cwd,
				agentDir: spec.agentDir,
				trustDirectory: spec.trustDirectory,
				sessionId: spec.sessionId,
				sessionFile: join(spec.storageDir, "native.session"),
				onUsageChanged: hooks.onUsageChanged,
				sessionOptions: {
					customTools: createArtifactTools({
						store: artifacts,
						onArtifactsChanged: hooks.onArtifactsChanged,
						onArtifactPublished: async (artifact) => {
							if (!artifactConversation)
								throw new Error("Artifact publication requires a bound Harness conversation");
							// Passive write admission is legal while tools are running. The Harness places it
							// at its post-tools boundary; direct tx.appendEntry would race a busy conversation.
							await artifactConversation.submit(
								{
									type: "write",
									requestId: `artifact:${artifact.id}:${artifact.revision}`,
									entry: { kind: "pilot.artifact", data: { artifact: { ...artifact } }, model: [] },
								},
								context,
							);
						},
					}),
				},
				model: pinned ? `${pinned.model.provider}/${pinned.model.modelId}` : spec.model,
				thinking: pinned?.thinkingLevel ?? spec.thinking,
			});
			const prepare = (extension: Extension) =>
				withAttention(replayUnsafe(withPilotPolicy(extension, spec.pilot ?? {})));
			const registry = createRegistry();
			registry.install(prepare(adapter.extension));
			harness = await Harness.open(
				owned.storage,
				{ models: adapter.models, registry, settings: { toolExecution: "sequential" } },
				context,
			);
			// The agent applies only on first creation; a reopened session keeps its pinned choices.
			const conversation = await harness.root(context, {
				agent: {
					model: adapter.model,
					thinkingLevel: adapter.thinkingLevel,
					cwd: spec.cwd,
					extensions: [adapter.extension],
					tools: null,
				},
			});
			adapter.onToolsChanged = (extension) => registry.install(prepare(extension));
			artifactConversation = conversation;
			// Bind before resume(), so recovered tool calls cannot race binding.
			adapter.bindHarness(harness, conversation.id);
			const status = await watchEvents(harness, conversation.id, context);
			const session = new KernelSession(harness, conversation, adapter, owned.release, status);
			session.#working = status.snapshot.run !== undefined;
			if (!session.#working) {
				session.#completion = await reconcileCompletion(owned.storage, harness, conversation, context);
			}
			status.start(async (events, deliveryContext) => {
				let working = session.#working;
				let completion = session.#completion;
				for (const event of events) {
					working =
						event.type === "snapshot"
							? event.run !== undefined
							: event.type === "run_start"
								? true
								: event.type === "run_end"
									? false
									: working;
					if (event.type === "run_end" || (event.type === "snapshot" && !working)) {
						completion = await reconcileCompletion(
							owned.storage,
							harness!,
							conversation,
							context,
							event.type === "run_end" ? event.inputs : undefined,
						);
					}
				}
				// A queued follow-up may start in the same commit as the preceding run ends.
				// Only publish attention when the session actually becomes idle.
				if (
					working !== session.#working ||
					(!working && completion?.outcomeAt !== session.#completion?.outcomeAt)
				) {
					session.#working = working;
					session.#completion = working ? undefined : completion;
					hooks.onWorking(working, session.#completion);
				}
				if (
					events.some((event) =>
						["snapshot", "entry_appended", "message_end", "tool_execution_end", "run_end"].includes(event.type),
					)
				) {
					// Display-only failures must not stop the lifecycle monitor or the agent.
					try {
						await session.adapter.refreshUsage(deliveryContext);
					} catch (error) {
						console.warn("pilot: could not refresh context usage", error);
					}
				}
			});
			await adapter.refreshUsage(context);
			harness.resume();
			return session;
		} catch (error) {
			if (harness) await harness.close(context).catch(() => undefined);
			else await owned.storage.close(context).catch(() => undefined);
			await adapter?.close().catch(() => undefined);
			owned.release();
			throw error;
		}
	}

	get model(): string {
		const { provider, modelId } = this.adapter.model;
		return `${provider}/${modelId}`;
	}

	get working(): boolean {
		return this.#working;
	}

	get usage(): SessionUsage {
		return this.adapter.usage.current;
	}

	get completion(): SessionCompletion | undefined {
		return this.#completion;
	}

	/** Durable admission. Retrying the same requestId returns the existing submission. */
	async submit(requestId: string, content: string, mode: DeliveryMode): Promise<void> {
		// Native input handlers (prompt templates, skill commands) expand the text first.
		const prepared = await this.adapter.prepareInput(content);
		await this.conversation.submit({ type: "input", content: prepared, requestId, whenBusy: mode }, context);
	}

	/** Edit in place only if the input is still queued when the commit runs. */
	async editQueuedMessage(submissionId: number, content: string): Promise<void> {
		const prepared = await this.adapter.prepareInput(content);
		await editQueuedMessage(this.harness, this.conversation.id, submissionId, prepared, context);
	}

	/** Withdraw queued input and abort the current run. The conversation stays usable. */
	async abort(): Promise<void> {
		await this.conversation.abort(context, { background: true });
	}

	async watch(watchId: string, listener: (events: AgentEvent[]) => void): Promise<void> {
		if (this.#watches.has(watchId)) return;
		const stream = await watchEvents(this.harness, this.conversation.id, context);
		let queue: DocumentWatch<InboxState>;
		try {
			queue = await watchQueue(this.harness, this.conversation.id, context);
		} catch (error) {
			await stream.stop();
			throw error;
		}
		this.#watches.set(watchId, { events: stream, queue });
		listener([stream.snapshot, queueUpdate(queue.value)]);
		stream.start(async (events) => listener([...events]));
		queue.start(async (inbox) => listener([queueUpdate(inbox)]));
	}

	async unwatch(watchId: string): Promise<void> {
		const stream = this.#watches.get(watchId);
		this.#watches.delete(watchId);
		if (stream) await Promise.all([stream.events.stop(), stream.queue.stop()]);
	}

	/** Pause: pending work stays durable and resumes on the next open. */
	close(): Promise<void> {
		this.#closing ??= (async () => {
			for (const id of [...this.#watches.keys()]) await this.unwatch(id).catch(() => undefined);
			await this.status.stop().catch(() => undefined);
			try {
				await this.harness.close(context);
			} finally {
				try {
					await this.adapter.close();
				} finally {
					this.release();
				}
			}
		})();
		return this.#closing;
	}
}

/** One selectable model, from the user's pi scope. */
export interface ModelOption {
	/** "provider/modelId", the value to send as `model`. */
	id: string;
	provider: string;
	name: string;
	reasoning?: boolean;
	/** Ordered thinking levels supported by this model (non-reasoning models offer only "off"). */
	thinkingLevels?: string[];
	/** Thinking level pinned by the scope pattern ("model:high"). */
	thinking?: string;
	/** Effective thinking for an explicit model in a fresh Build chat at the requested cwd.
	 * Ignores scope pins. Per-model/global settings win; otherwise inherits SDK startup thinking.
	 * Omitted when passive startup metadata is unavailable. Not a running-session switch default. */
	defaultThinking?: string;
	/** Effective omitted-thinking changeModel choice: scope pin, per-model, then global setting.
	 * Omitted when the switch must inherit current session thinking (or metadata is unavailable). */
	modelChangeThinking?: string;
	/** Effective omitted thinking for task-start admission. Only present with purpose=task-start. */
	taskDefaultThinking?: string;
}

/** GET /api/models?projectId=… or ?cwd=…; purpose=task-start applies the task-start price cap. */
export interface ModelList {
	models: ModelOption[];
	/** Task-start maximum catalogue input + output dollars per million tokens. Null blocks new starts. */
	priceCeiling?: { limit: number | null; source: "reference" | "replacement" | "unavailable" };
	/** Raw configured pi default for that directory, not a resolved/validated fallback. */
	defaultModel?: string;
	/** Passive fresh Build Pi startup selection without a request.model/Project.model override,
	 * only when included in models. With purpose=task-start,
	 * the actual admitted default instead. Omitted if unavailable/outside scope/rejected by the cap.
	 * Does not predict extensions, workspace preparation, Ask roles or restored sessions. */
	resolvedDefaultModel?: string;
}

/** POST /api/sessions/:id/model. Returns ChangeModelResponse. Incompatible provider context is
 * rebuilt automatically from durable history in a restorable attempt (reason=model).
 * Only idle, non-archived chats may change. Control changes apply on the next turn. */
export interface ChangeModelRequest {
	/** Exact "provider/modelId" from the scoped model catalog. */
	model: string;
	/** Explicit supported level, overriding the model's scoped default for this chat. */
	thinking?: string;
}

/** POST /api/sessions/:id/continue-model. Returns the same chat or a provider-safe replacement. */
export type ContinueModelRequest = ChangeModelRequest;

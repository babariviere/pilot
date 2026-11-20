/** GET /api/model-scope. Global Pi scope, independent of project overrides.
 * null means the key is absent. [] is retained on read; Pi treats both as all authenticated models.
 */
export interface ModelScope {
	enabledModels: string[] | null;
	allModels: boolean;
	/** SHA-256 of compact JSON: the string "absent" for an absent key, otherwise the literal ordered array. */
	scopeHash: string;
	/** One entry per GLOBAL pattern, in input order. Empty when allModels is true. */
	resolution: ModelScopePatternResolution[];
	/** Authenticated models regardless of scope. First 2048 unique entries, at most 1 MiB encoded. */
	candidates: ModelScopeCandidate[];
	/** Present only with ?projectId (or ?cwd). Read-only project enabledModels; null means no override. */
	projectOverride?: string[] | null;
}

export interface ModelScopeCandidate {
	/** provider/modelId, the same identifier used by /api/models. */
	id: string;
	provider: string;
	name: string;
}

export interface ModelScopePatternResolution {
	pattern: string;
	/** Authenticated provider/modelId references on this host, resolved by Pi. */
	matches: string[];
	/** Present only when no authenticated model matches. Unavailable is not proof of bad credentials. */
	unresolved?: "unknown" | "provider-not-logged-in";
}

/** PUT /api/model-scope requires native host-action capability (x-pilot-github-capability).
 * null removes only the global key. Nonempty arrays: at most 256 patterns, at most 256 UTF-8 bytes each.
 * Literal patterns/order are preserved. [] is rejected. This is never an agent/pilot tool action.
 */
export interface ModelScopeUpdateRequest {
	enabledModels: string[] | null;
	expectedHash: string;
}

/** Value-idempotent retry succeeds even with a stale expectedHash, without writing or resolving models. */
export type ModelScopeUpdateResponse = { changed: false; scopeHash: string } | (ModelScope & { changed: true });

/** HTTP 409. Re-read/reconcile rather than automatically overwriting an external edit. */
export interface ModelScopeConflict {
	error: "scope_conflict";
	scopeHash: string;
	enabledModels: string[] | null;
}

/** Non-conflict errors. settings_unreadable never means an absent/empty scope. */
export interface ModelScopeError {
	error: "read_only" | "settings_unreadable" | "invalid_scope" | "native_action_required" | "model_scope_unavailable";
}

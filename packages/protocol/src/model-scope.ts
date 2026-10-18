/** Host-local Pi enabledModels. null means the global key is absent (all available models).
 * An empty array also means all models, matching Pi. Patterns are never rewritten by resolution.
 */
export interface ModelScope {
	enabledModels: string[] | null;
	/** SHA-256 of JSON.stringify(enabledModels), including array order. Not a hash of the settings file. */
	contentHash: string;
	/** Read-only project enabledModels, or null when the project does not override the global scope. */
	projectOverride: string[] | null;
	/** One result per global pattern, in input order. Empty for null/all. */
	resolution: ModelScopePatternResolution[];
	/** Project pattern results, or null when there is no override. */
	projectResolution: ModelScopePatternResolution[] | null;
	/** False on read-only hosts or when native host-action authorization is unavailable. */
	writable: boolean;
}

export interface ModelScopePatternResolution {
	pattern: string;
	/** Authenticated provider/modelId references on this host. Never model objects or credentials. */
	matchedModelIds: string[];
	/** Set only when no authenticated model matches. Known but unavailable does not prove bad credentials. */
	unresolvedReason: "unknown" | "provider-not-logged-in" | null;
	/** Pi resolver diagnostic codes, without provider errors or configuration details. */
	diagnostics: string[];
}

/** PUT /api/model-scope, native host-action capability required (x-pilot-github-capability).
 * null removes only the global enabledModels key. This is never an agent/pilot tool action.
 */
export interface ModelScopeUpdateRequest {
	enabledModels: string[] | null;
	expectedHash: string;
}

/** HTTP 409. Re-read/reconcile rather than automatically overwriting an external edit. */
export interface ModelScopeConflict {
	currentHash: string;
	current: string[] | null;
}

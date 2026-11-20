/** Metadata-only discovery contract. Auth checks describe configuration, never provider acceptance. */
import type { AnyModel, AuthCheck, ModelsRefreshOptions } from "@earendil-works/pi-ai";

export const CATALOG_FRAME_LIMIT = 8 * 1024 * 1024;
export type CatalogOptions = Pick<ModelsRefreshOptions, "allowNetwork" | "force" | "providers">;
type Metadata<T> = T extends AnyModel
	? Omit<T, "baseUrl" | "headers" | "compat" | "samplingParams" | "samplingParamsByThinkingLevel">
	: never;
export interface CatalogModel {
	model: Metadata<AnyModel>;
	/** Reference to an unrefreshed local model with identical request configuration. Never its contents. */
	transport: string;
}
export interface CatalogProvider {
	id: string;
	models: CatalogModel[];
	/** Operation type + id, after the provider's credential-specific filters. */
	available: string[];
	auth?: Pick<AuthCheck, "type">;
	/** The worker already has these exact builtin/models.json definitions. */
	static?: true;
	/** Restore request configuration locally from models-store.json; discovery remains shared. */
	local?: true;
}
export interface SharedModelCatalog {
	revision: string;
	generation: number;
	providers: CatalogProvider[];
	/** Provider IDs only. Never provider responses or error text, which may contain secrets. */
	errors?: string[];
}
export function modelKey(model: { id: string; type?: string }): string {
	return `${model.type ?? "chat"}/${model.id}`;
}

/** Never spread provider objects or request configuration into an IPC snapshot. */
export function catalogMetadata(model: AnyModel): Metadata<AnyModel> {
	const keys = [
		"id",
		"name",
		"api",
		"provider",
		"type",
		"input",
		"inputLimits",
		"cost",
		"reasoning",
		"thinkingLevelMap",
		"promptCache",
		"contextWindow",
		"maxTokens",
		"output",
	] as const;
	const result: Record<string, unknown> = Object.fromEntries(
		keys.filter((key) => key in model).map((key) => [key, model[key as keyof AnyModel]]),
	);
	const rates = ["input", "output", "cacheRead", "cacheWrite"];
	result.cost = {
		...numbers(model.cost, rates),
		...(model.cost.tiers
			? {
					tiers: model.cost.tiers.map((tier) => numbers(tier, [...rates, "inputTokensAbove"])),
				}
			: {}),
	};
	if (model.inputLimits)
		result.inputLimits = {
			...numbers(model.inputLimits, ["maxRequestBytes"]),
			...(model.inputLimits.images
				? {
						images: {
							...numbers(model.inputLimits.images, ["maxPerMessage", "maxPerRequest"]),
							...(model.inputLimits.images.resize
								? {
										resize: numbers(model.inputLimits.images.resize, [
											"maxWidth",
											"maxHeight",
											"maxBytes",
											"jpegQuality",
										]),
									}
								: {}),
						},
					}
				: {}),
		};
	if ("promptCache" in model && model.promptCache) result.promptCache = numbers(model.promptCache, ["short", "long"]);
	if ("thinkingLevelMap" in model && model.thinkingLevelMap)
		result.thinkingLevelMap = Object.fromEntries(
			["off", "minimal", "low", "medium", "high", "xhigh", "max"]
				.filter((key) => key in model.thinkingLevelMap!)
				.map((key) => [key, model.thinkingLevelMap![key as keyof typeof model.thinkingLevelMap]]),
		);
	return structuredClone(result) as unknown as Metadata<AnyModel>;
}

function numbers(source: object, keys: string[]): Record<string, number> {
	const values = source as Record<string, unknown>;
	return Object.fromEntries(
		keys
			.filter((key) => typeof values[key] === "number" && Number.isFinite(values[key]))
			.map((key) => [key, values[key] as number]),
	);
}

/** Used only inside the host owner to match a local transport template. Never returned over IPC. */
export function catalogTransport(model: AnyModel): string {
	const value = model as AnyModel & Record<string, unknown>;
	return JSON.stringify([
		model.api,
		model.baseUrl,
		model.headers,
		value.compat,
		value.samplingParams,
		value.samplingParamsByThinkingLevel,
	]);
}

export function withCatalogSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

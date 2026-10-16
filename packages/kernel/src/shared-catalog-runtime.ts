/** Pinned Pi 1.1 seam: replace discovery on the inner Models collection, never request/auth execution. */
import { type AnyModel, isModelType, type Models, type Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialClient } from "./credential-client.ts";
import { type CatalogOptions, modelKey, type SharedModelCatalog, withCatalogSignal } from "./shared-model-catalog.ts";

type Collection = Models & { setProvider(provider: Provider): void };

export function useSharedModelCatalog(runtime: ModelRuntime, client: CredentialClient): void {
	const models = (runtime as unknown as { models: Collection }).models;
	if (!models?.setProvider) throw new Error("Unsupported SDK model catalog seam");
	const refresh = models.refresh.bind(models);
	const check = models.checkAuth.bind(models);
	const available = models.getAvailable.bind(models);
	const allAvailable = models.getAllAvailable.bind(models);
	const nativeRefresh = runtime.refresh.bind(runtime);
	const runtimeKeys = new Set<string>();
	const mutating = new Map<string, number>();
	let current: SharedModelCatalog | undefined;
	let pending: Promise<SharedModelCatalog> | undefined;
	let appliedRevision: string | undefined;
	let applying: Promise<unknown> | undefined;
	const hydrated = new WeakMap<Provider, string>();
	const templates = new WeakMap<Provider, Map<string, AnyModel>>();

	async function read(options: CatalogOptions = {}, signal?: AbortSignal) {
		signal?.throwIfAborted();
		// Only plain reads share here. Force/network/provider boundaries belong to the daemon scheduler.
		const plain = !options.force && !options.providers && options.allowNetwork !== true;
		const operation =
			(plain && pending) ||
			client
				.request({
					op: "catalog",
					namespace: "pi",
					key: current?.revision,
					value: {
						allowNetwork: options.allowNetwork,
						force: options.force,
						providers: options.providers,
					},
				})
				.then((value) => ((value as { unchanged?: boolean }).unchanged ? current! : (value as SharedModelCatalog)));
		if (plain && !pending) {
			pending = operation;
			const clear = () => {
				if (pending === operation) pending = undefined;
			};
			void operation.then(clear, clear);
		}
		const snapshot = await withCatalogSignal(operation, signal);
		if (!current || snapshot.generation >= current.generation) current = snapshot;
		return current;
	}
	function shared(id: string) {
		if (runtimeKeys.has(id) || mutating.has(id) || runtime.getRegisteredProviderIds().includes(id)) return undefined;
		if (models.getAllModels(id).some((model) => model.api === "pi-virtual")) return undefined;
		const entry = current?.providers.find((provider) => provider.id === id);
		return entry;
	}
	function hydrate(id: string): void {
		const entry = shared(id),
			provider = models.getProvider(id);
		if (!entry || !provider || entry.static || entry.local) return;
		if (hydrated.get(provider) === current!.revision) return;
		const local =
			templates.get(provider) ?? new Map(models.getAllModels(id).map((model) => [modelKey(model), model]));
		// Transport details (including model-level headers and sampling defaults) never leave this process.
		const all = entry.models.map(({ model, transport }) => {
			const template = local.get(transport);
			if (!template) throw new Error("Shared model transport template missing");
			return {
				...model,
				baseUrl: template.baseUrl,
				headers: template.headers,
				...(isModelType(template, "chat")
					? {
							compat: template.compat,
							samplingParams: template.samplingParams,
							samplingParamsByThinkingLevel: template.samplingParamsByThinkingLevel,
						}
					: {}),
			};
		}) as AnyModel[];
		const replacement: Provider = {
			...provider,
			getModels: () => all.filter((model) => isModelType(model, "chat")),
			getAllModels: () => all,
		};
		hydrated.set(replacement, current!.revision);
		templates.set(replacement, local);
		models.setProvider(replacement);
	}
	models.refresh = async (options = {}) => {
		const snapshot = await read(options, options.signal);
		const selected = models.getProviders().filter(({ id }) => !options.providers || options.providers.includes(id));
		for (const { id } of selected) hydrate(id);
		const [result, restored] = await Promise.all([
			refresh({ ...options, providers: selected.filter(({ id }) => !shared(id)).map(({ id }) => id) }),
			refresh({
				allowNetwork: false,
				signal: options.signal,
				providers: selected.filter(({ id }) => shared(id)?.local).map(({ id }) => id),
			}),
		]);
		appliedRevision = snapshot.revision;
		const errors = new Map([...result.errors, ...restored.errors]);
		for (const id of snapshot.errors ?? [])
			if (shared(id) && selected.some((provider) => provider.id === id))
				errors.set(id, new Error("Shared model discovery failed"));
		return { aborted: result.aborted || restored.aborted, errors };
	};
	models.checkAuth = async (id, options) => {
		options?.signal?.throwIfAborted();
		const entry = shared(id);
		return entry ? entry.auth && { ...entry.auth, source: "shared catalog configuration" } : check(id, options);
	};
	async function choices(all: boolean, id?: string, options?: Parameters<Models["getAvailable"]>[1]) {
		options?.signal?.throwIfAborted();
		const result: AnyModel[] = [];
		for (const provider of models.getProviders()) {
			if (id && provider.id !== id) continue;
			const entry = shared(provider.id);
			if (entry) {
				hydrate(provider.id);
				const allowed = new Set(entry.available);
				result.push(
					...(all ? models.getAllModels(provider.id) : models.getModels(provider.id)).filter((model) =>
						allowed.has(modelKey(model)),
					),
				);
			} else result.push(...(await (all ? allAvailable : available)(provider.id, options)));
		}
		return result;
	}
	models.getAvailable = async (id, options) => choices(false, id, options) as ReturnType<Models["getAvailable"]>;
	models.getAllAvailable = (id, options) => choices(true, id, options);
	// SDK internal snapshot refreshes use the patched collection directly. Public reads first revalidate with the owner.
	for (const name of ["getAvailable", "getAllAvailable", "getAvailableOfType", "checkAuth"] as const) {
		const original = runtime[name].bind(runtime) as (...args: unknown[]) => Promise<unknown>;
		(runtime as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
			const options = args[name === "getAvailableOfType" ? 2 : 1] as { signal?: AbortSignal } | undefined;
			const snapshot = await read({}, options?.signal);
			if (snapshot.revision !== appliedRevision) {
				// Reload worker transport/config too, including newly added providers, without another shared pass.
				applying ??= nativeRefresh({ allowNetwork: false }).finally(() => {
					applying = undefined;
				});
				await withCatalogSignal(applying, options?.signal);
			}
			return original(...args);
		};
	}
	for (const name of ["login", "logout", "setRuntimeApiKey", "removeRuntimeApiKey"] as const) {
		const original = runtime[name].bind(runtime) as (id: string, ...args: unknown[]) => Promise<unknown>;
		(runtime as unknown as Record<string, unknown>)[name] = async (id: string, ...args: unknown[]) => {
			if (name === "setRuntimeApiKey") runtimeKeys.add(id);
			mutating.set(id, (mutating.get(id) ?? 0) + 1);
			try {
				return await original(id, ...args);
			} finally {
				const count = mutating.get(id)! - 1;
				if (count) mutating.set(id, count);
				else mutating.delete(id);
				if (name === "removeRuntimeApiKey") runtimeKeys.delete(id);
			}
		};
	}
}

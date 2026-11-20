/** Pinned SDK compatibility seam. Public ModelRuntime credential injection also covers immutable child adapters. */
import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve } from "node:path";
import {
	type CreateModelRuntimeOptions,
	getAgentDir,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { credentialClient } from "./credential-client.ts";
import { type DayInsightsReservation, installDayInsightsRuntime } from "../insights/day-insights-runtime.ts";
import { installFundingRuntime } from "../funding/funding-runtime.ts";
import { ownModelCatalog } from "../models/model-catalog-owner.ts";
import { readonlyModelsStore } from "../models/readonly-models-store.ts";
import { readonlySettings } from "../models/readonly-settings.ts";
import { useSharedModelCatalog } from "../models/shared-catalog-runtime.ts";

const discoveryOwner = new AsyncLocalStorage<boolean>();
/** Trusted daemon factory. Avoid a recursive request to its own discovery service. */
export function createDiscoveryRuntime(options: CreateModelRuntimeOptions): Promise<ModelRuntime> {
	return discoveryOwner.run(true, () => ModelRuntime.create(options));
}

// Jiti child profiles and native ESM share this SDK class, but not module-local state.
const key = Symbol.for("pilot.credential-broker.hooks.v1");
const sdk = ModelRuntime as typeof ModelRuntime & { [key]?: Promise<void> };
/**
 * The agent directory whose models.json the daemon's shared catalog owns in this process, when a credential endpoint
 * named one. That owner revalidates definitions, credentials and revocation fences on every read.
 */
export function sharedCatalogDir(): string | undefined {
	return process.env.PILOT_SHARED_CATALOG_DIR;
}

export function installCredentialBrokerHooks(options: { descendants?: boolean } = {}): Promise<void> {
	if (options.descendants && process.env.PILOT_REQUIRE_CREDENTIAL_BROKER === "1") {
		const preload = `--import=${new URL("./credential-preload.ts", import.meta.url).href}`;
		if (!process.env.NODE_OPTIONS?.split(/\s+/).includes(preload))
			process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
	}
	sdk[key] ??= (async () => {
		const settings = SettingsManager.create;
		SettingsManager.create = (cwd, agentDir = getAgentDir(), options = {}) =>
			process.env.PILOT_READ_ONLY_CONFIG === "1"
				? readonlySettings(cwd, agentDir, options)
				: settings.call(SettingsManager, cwd, agentDir, options);
		const create = ModelRuntime.create;
		ModelRuntime.create = async (options = {}) => {
			const client = credentialClient();
			const owner = discoveryOwner.getStore();
			if (client && !owner) await client.pi.list(); // No best-effort SDK fallback when the authority is unavailable.
			if (!owner && client && options.credentials && options.credentials !== client.pi)
				throw new Error("Credential broker requires the canonical credential store");
			const sharedDir = sharedCatalogDir();
			const shared =
				!owner &&
				client &&
				sharedDir &&
				!options.modelsStore &&
				!options.modelsStorePath &&
				options.catalogBaseUrl === undefined &&
				options.modelsPath !== null &&
				resolve(options.modelsPath ?? join(getAgentDir(), "models.json")) === join(sharedDir, "models.json");
			// The daemon owns the catalog. A worker reads the published one without the SDK's store
			// lock, which an isolated worker cannot create on a readonly host.
			const sharedStore =
				shared && sharedDir ? readonlyModelsStore(join(sharedDir, "models-store.json")) : undefined;
			const runtime = await create.call(ModelRuntime, {
				...options,
				...(client && !owner ? { credentials: client.pi } : {}),
				...(sharedStore ? { refreshOnCreate: false, modelsStore: sharedStore } : {}),
			});
			if (shared) useSharedModelCatalog(runtime, client);
			ownModelCatalog(runtime);
			if (client?.endpoint.metered) {
				const reserve = async (
					id: string,
					model: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>,
					bound: import("../funding/funding-runtime.ts").FundingBound,
				) =>
					await client.request({
						op: "funding-reserve",
						namespace: "pi",
						key: id,
						value: { provider: model.provider, model: model.id, api: model.api, ...bound },
					});
				const settle = async (id: string, usage: import("@pilot/protocol").FundingTokens) => {
					await client.request({ op: "funding-settle", namespace: "pi", key: id, value: usage });
				};
				if (client.endpoint.insightsMetered)
					installDayInsightsRuntime(runtime, {
						reserve: async (id, model, bound) => (await reserve(id, model, bound)) as DayInsightsReservation,
						settle,
					});
				else
					installFundingRuntime(runtime, {
						reserve: async (id, model, bound) => {
							await reserve(id, model, bound);
						},
						settle,
					});
			}
			if (shared && options.refreshOnCreate !== false) {
				const timed =
					options.allowModelNetwork === true && options.modelRefreshTimeoutMs !== undefined
						? AbortSignal.timeout(options.modelRefreshTimeoutMs)
						: undefined;
				await runtime.refresh({
					allowNetwork: process.env.PI_OFFLINE === undefined && options.allowModelNetwork === true,
					signal: timed ? (options.signal ? AbortSignal.any([options.signal, timed]) : timed) : options.signal,
				});
			}
			if (!client) return runtime;
			const login = runtime.login.bind(runtime);
			runtime.login = (provider, type, interaction, options) =>
				client.transaction("pi", provider, "login", () => login(provider, type, interaction, options));
			return runtime;
		};
		// MCP exposes async server load/save/refresh-lock injection, but synchronous tokens/remove UI
		// methods. Override this pinned class's storage methods, never the transport/provider protocol.
		const module = await import(
			new URL("./extensions/mcp/oauth.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
		);
		const prototype = module.McpOAuthCredentialStore.prototype;
		const forServer = prototype.forServer,
			tokens = prototype.tokens,
			remove = prototype.remove;
		prototype.forServer = function (name: string, url: string) {
			return credentialClient()?.mcpStore(name, url) ?? forServer.call(this, name, url);
		};
		prototype.tokens = function (name: string, url: string) {
			const client = credentialClient();
			return client
				? (
						client.sync({ op: "peek", namespace: "mcp", key: client.mcpKey(name, url) }) as
							| { tokens?: unknown }
							| undefined
					)?.tokens
				: tokens.call(this, name, url);
		};
		prototype.remove = function (name: string, url: string) {
			const client = credentialClient();
			return client
				? client.sync({ op: "delete", namespace: "mcp", key: client.mcpKey(name, url) })
				: remove.call(this, name, url);
		};
	})();
	return sdk[key];
}

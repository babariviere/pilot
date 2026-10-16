/** Pinned SDK compatibility seam. Public ModelRuntime credential injection also covers immutable child adapters. */
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { credentialClient } from "./credential-client.ts";
import { ownModelCatalog } from "./model-catalog-owner.ts";
import { readonlySettings } from "./readonly-settings.ts";

// Jiti child profiles and native ESM share this SDK class, but not module-local state.
const key = Symbol.for("pilot.credential-broker.hooks.v1");
const sdk = ModelRuntime as typeof ModelRuntime & { [key]?: Promise<void> };
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
			if (client) await client.pi.list(); // No best-effort SDK fallback when the authority is unavailable.
			if (client && options.credentials && options.credentials !== client.pi)
				throw new Error("Credential broker requires the canonical credential store");
			const runtime = await create.call(ModelRuntime, client ? { ...options, credentials: client.pi } : options);
			ownModelCatalog(runtime);
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

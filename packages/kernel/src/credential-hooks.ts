/** Pinned SDK compatibility seam. Public ModelRuntime credential injection also covers immutable child adapters. */
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { credentialClient } from "./credential-client.ts";
import { readonlySettings } from "./readonly-settings.ts";

let installed: Promise<void> | undefined;
export function installCredentialBrokerHooks(options: { descendants?: boolean } = {}): Promise<void> {
	if (options.descendants && process.env.PILOT_REQUIRE_CREDENTIAL_BROKER === "1") {
		const preload = `--import=${new URL("./credential-preload.ts", import.meta.url).href}`;
		if (!process.env.NODE_OPTIONS?.split(/\s+/).includes(preload))
			process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
	}
	installed ??= (async () => {
		const settings = SettingsManager.create;
		SettingsManager.create = (cwd, agentDir = getAgentDir(), options = {}) =>
			process.env.PILOT_READ_ONLY_CONFIG === "1"
				? readonlySettings(cwd, agentDir, options)
				: settings.call(SettingsManager, cwd, agentDir, options);
		const create = ModelRuntime.create;
		ModelRuntime.create = async (options = {}) => {
			const client = credentialClient();
			if (!client) return create.call(ModelRuntime, options);
			await client.pi.list(); // No best-effort SDK availability fallback when the authority is unavailable.
			if (options.credentials && options.credentials !== client.pi)
				throw new Error("Credential broker requires the canonical credential store");
			const runtime = await create.call(ModelRuntime, { ...options, credentials: client.pi });
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
	return installed;
}

/** SDK adapters keep OAuth exchanges in the requesting process and serialize only canonical auth state. */
import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import {
	AUTH_FRAME_LIMIT,
	authError,
	CredentialBrokerError,
	CredentialChannel,
	type CredentialEndpoint,
	type CredentialNamespace,
	type CredentialRequest,
	credentialRequest,
} from "./credential-rpc.ts";

export type { CredentialEndpoint } from "./credential-rpc.ts";

type Transaction = { namespace: CredentialNamespace; key: string; value: unknown; changed: boolean };
export class CredentialClient {
	private readonly active = new AsyncLocalStorage<Transaction>();
	private syncWorker?: Worker;
	private running = 0;
	private readonly waiters: Array<() => void> = [];
	readonly endpoint: CredentialEndpoint;
	constructor(endpoint: CredentialEndpoint) {
		this.endpoint = endpoint;
	}
	async request(request: CredentialRequest): Promise<unknown> {
		if (this.waiters.length >= 256) throw authError("busy");
		if (this.running >= 4) await new Promise<void>((resolve) => this.waiters.push(resolve));
		else this.running++;
		try {
			return await credentialRequest(this.endpoint, request);
		} finally {
			const next = this.waiters.shift();
			if (next) next();
			else this.running--;
		}
	}
	sync(request: CredentialRequest): unknown {
		if (!this.syncWorker) {
			this.syncWorker = new Worker(new URL("./credential-sync-worker.ts", import.meta.url));
			this.syncWorker.on("error", () => {
				this.syncWorker = undefined;
			});
		}
		this.syncWorker.unref();
		const shared = new SharedArrayBuffer(AUTH_FRAME_LIMIT + 8);
		const status = new Int32Array(shared, 0, 2);
		this.syncWorker.postMessage({ endpoint: this.endpoint, request, shared });
		Atomics.wait(status, 0, 0, 36_000);
		if (Atomics.load(status, 0) !== 1) throw authError();
		const reply = JSON.parse(Buffer.from(shared, 8, Atomics.load(status, 1)).toString());
		new Uint8Array(shared).fill(0);
		if (!reply.ok) throw authError(reply.code);
		return reply.value;
	}
	current(namespace: CredentialNamespace, key: string): Transaction | undefined {
		const active = this.active.getStore();
		return active?.namespace === namespace && active.key === key ? active : undefined;
	}
	async transaction<T>(
		namespace: CredentialNamespace,
		key: string,
		mode: "refresh" | "login",
		fn: () => Promise<T>,
	): Promise<T> {
		if (this.current(namespace, key)) return fn();
		const channel = new CredentialChannel(this.endpoint);
		try {
			const value = await channel.request({ op: "begin", namespace, key, mode });
			const state: Transaction = { namespace, key, value, changed: false };
			let result: T;
			try {
				result = await this.active.run(state, fn);
			} catch (error) {
				// The pinned SDK cannot exchange a missing credential/refresh grant. A sign-in-required
				// check is not an ambiguous external exchange, so it need not poison a future status read.
				const record = value as { type?: string; tokens?: { refresh_token?: string } } | undefined;
				const canExchange = namespace === "pi" ? record?.type === "oauth" : !!record?.tokens?.refresh_token;
				if (mode === "refresh" && !canExchange && !state.changed)
					await channel.request({ op: "commit", namespace, key, changed: false });
				throw error;
			}
			await channel.request({ op: "commit", namespace, key, value: state.value, changed: state.changed });
			return result;
		} finally {
			channel.close();
		} // Lost/failed exchanges leave a durable uncertainty fence, never an automatic retry.
	}
	readonly pi: CredentialStore = {
		read: async (key, options) => {
			options?.signal?.throwIfAborted();
			const value = (this.current("pi", key)?.value ?? (await this.request({ op: "read", namespace: "pi", key }))) as
				| Credential
				| undefined;
			// Pi normally resolves !commands in AuthStorage.read. Do that here, inside the caller's sandbox.
			if (value?.type === "api_key" && value.key?.startsWith("!")) {
				const module = await import(
					new URL("./core/resolve-config-value.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
				);
				return { ...value, key: module.resolveConfigValue(value.key, value.env) };
			}
			return value;
		},
		list: async (options) => {
			options?.signal?.throwIfAborted();
			return (await this.request({ op: "list", namespace: "pi" })) as CredentialInfo[];
		},
		modify: async (key, fn, options?: AuthOperationOptions) => {
			options?.signal?.throwIfAborted();
			return this.transaction("pi", key, "refresh", async () => {
				const state = this.current("pi", key)!;
				const next = await fn(structuredClone(state.value) as Credential | undefined);
				if (next !== undefined) {
					state.value = next;
					state.changed = true;
				}
				return structuredClone(state.value) as Credential | undefined;
			});
		},
		delete: async (key, options) => {
			options?.signal?.throwIfAborted();
			await this.request({ op: "delete", namespace: "pi", key });
		},
	};
	mcpKey(name: string, url: string): string {
		return `mcp__${name.replaceAll("-", "_")}|${new URL(url)}`;
	}
	mcpStore(name: string, url: string) {
		const key = this.mcpKey(name, url);
		return {
			load: () => {
				const state = this.current("mcp", key);
				return structuredClone(state ? state.value : this.sync({ op: "read", namespace: "mcp", key }));
			},
			save: (value: unknown) => {
				const state = this.current("mcp", key);
				if (!state) throw authError("unauthorized");
				state.value = structuredClone(value);
				state.changed = true;
			},
			withRefreshLock: async <T>(fn: () => Promise<T>) => {
				try {
					return await this.transaction("mcp", key, "refresh", fn);
				} catch (error) {
					if (error instanceof CredentialBrokerError && ["uncertain", "stale"].includes(error.code))
						throw new McpOAuthAuthorizationRequiredError();
					throw error;
				}
			},
		};
	}
	async close(): Promise<void> {
		await this.syncWorker?.terminate();
		this.syncWorker = undefined;
	}
}
const clients = new Map<string, CredentialClient>();
export function credentialClient(): CredentialClient | undefined {
	const socket = process.env.PILOT_CREDENTIAL_SOCKET,
		token = process.env.PILOT_CREDENTIAL_TOKEN;
	if (!socket || !token) {
		if (process.env.PILOT_REQUIRE_CREDENTIAL_BROKER === "1") throw authError();
		return undefined;
	}
	if (!clients.has(token)) clients.set(token, new CredentialClient({ socket, token }));
	return clients.get(token)!;
}
export function credentialEnvironment(endpoint?: CredentialEndpoint): NodeJS.ProcessEnv {
	return {
		PILOT_CREDENTIAL_SOCKET: endpoint?.socket,
		PILOT_CREDENTIAL_TOKEN: endpoint?.token,
		PILOT_REQUIRE_CREDENTIAL_BROKER: endpoint ? "1" : undefined,
		PILOT_SHARED_CATALOG_DIR: endpoint?.catalogAgentDir,
	};
}

import type { McpServerStatus, McpStatus, NeedsYouReason } from "@pilot/protocol";

/** What chat attention needs of the shared MCP status. */
export interface McpStatusSource {
	status(): McpStatus;
	check(server?: string): unknown;
	onChange(listener: (status: McpStatus) => void): () => void;
}

/** Chats reach servers as `mcp__<name>` with dashes as underscores, like pi's mcpNamespace. */
export function mcpNamespace(server: string): string {
	return server.replace(/-/g, "_");
}

const MAX_CHATS = 1_000;

/**
 * Live-only Needs you for chats that reached for an MCP server that needs the user (sign-in, or a server that
 * fails to connect). Attention needs both: this chat used the server, and pilotd's own check agrees the server
 * is the problem. A failed call to a server last seen connected rechecks it first. Clears when the server
 * connects again, the user writes in the chat, or the chat is archived. Never an agent outcome.
 */
export class McpChatAttention {
	/** Chat → servers it is blocked on, in the order they were found, and when the first was found. */
	private readonly blocked = new Map<string, { names: string[]; at: number }>();
	/** Chat → servers whose failed call waits for a recheck, with the time of the call. */
	private readonly suspected = new Map<string, Map<string, number>>();
	private readonly stop: () => void;
	private readonly mcp: McpStatusSource;
	private readonly changed: (sessionId: string) => void;

	constructor(mcp: McpStatusSource, changed: (sessionId: string) => void) {
		this.mcp = mcp;
		this.changed = changed;
		this.stop = mcp.onChange((status) => this.statusChanged(status));
	}

	/** A chat's tool call reached for these namespaces. `failed`: the call itself reported an error. */
	report(sessionId: string, namespaces: string[], failed: boolean): void {
		const servers = this.mcp.status().servers;
		let touched = false;
		for (const namespace of namespaces) {
			const server = servers.find((candidate) => mcpNamespace(candidate.name) === namespace);
			if (!server) continue;
			if (needsUser(server)) touched = this.block(sessionId, server.name) || touched;
			else if (failed && server.state === "connected") {
				// The server may have expired its sign-in since pilotd last checked. Decide after a recheck.
				if (this.suspected.size >= MAX_CHATS && !this.suspected.has(sessionId)) continue;
				const pending = this.suspected.get(sessionId) ?? new Map<string, number>();
				pending.set(server.name, Date.now());
				this.suspected.set(sessionId, pending);
				this.mcp.check(server.name);
			}
		}
		if (touched) this.changed(sessionId);
	}

	/** The user wrote in the chat, or it was archived or deleted. */
	clear(sessionId: string): void {
		this.suspected.delete(sessionId);
		if (this.blocked.delete(sessionId)) this.changed(sessionId);
	}

	attention(sessionId: string): { attentionReason: NeedsYouReason; attentionAt: number } | undefined {
		const blocked = this.blocked.get(sessionId);
		if (!blocked?.names.length) return undefined;
		const { names, at } = blocked;
		const servers = this.mcp.status().servers;
		const first = servers.find((server) => server.name === names[0]);
		const signIn = first?.state === "needs_sign_in";
		const more = names.length > 1 ? ` (+${names.length - 1})` : "";
		return {
			attentionReason: {
				kind: "mcp",
				detail: `${names[0]} ${signIn ? "needs sign-in" : "isn't connecting"}${more}`,
				server: names[0]!,
			},
			attentionAt: at,
		};
	}

	close(): void {
		this.stop();
		this.blocked.clear();
		this.suspected.clear();
	}

	private block(sessionId: string, server: string): boolean {
		const current = this.blocked.get(sessionId);
		if (current?.names.includes(server)) return false;
		if (!current && this.blocked.size >= MAX_CHATS) return false;
		this.blocked.set(sessionId, { names: [...(current?.names ?? []), server], at: current?.at ?? Date.now() });
		return true;
	}

	private statusChanged(status: McpStatus): void {
		const byName = new Map(status.servers.map((server) => [server.name, server]));
		const touched = new Set<string>();
		// Servers that work again (or left mcp.json) release their chats.
		for (const [sessionId, blocked] of this.blocked) {
			const left = blocked.names.filter((name) => {
				const server = byName.get(name);
				return server !== undefined && needsUser(server);
			});
			if (left.length === blocked.names.length) continue;
			if (left.length) this.blocked.set(sessionId, { names: left, at: blocked.at });
			else this.blocked.delete(sessionId);
			touched.add(sessionId);
		}
		// Rechecks that finished after a failed call decide whether that server was the problem.
		for (const [sessionId, pending] of this.suspected) {
			for (const [name, at] of pending) {
				const server = byName.get(name);
				if (!server) {
					pending.delete(name);
					continue;
				}
				if ((server.checkedAt ?? 0) < at) continue;
				pending.delete(name);
				if (needsUser(server) && this.block(sessionId, name)) touched.add(sessionId);
			}
			if (!pending.size) this.suspected.delete(sessionId);
		}
		for (const sessionId of touched) this.changed(sessionId);
	}
}

function needsUser(server: McpServerStatus): boolean {
	return server.state === "needs_sign_in" || server.state === "failed";
}

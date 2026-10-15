/**
 * A hint, never proof: a tool call reached for an MCP server. pilotd compares it with its shared MCP status and
 * asks the user to sign in or fix the server only when that server is the reason the chat could not use it.
 * Reports namespaces (`mcp__<server>` with dashes as underscores), never arguments or results.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const NAMESPACE = /\bmcp__([A-Za-z0-9_]+?)(?=__|\b)/g;
/** One report per namespace and outcome per minute is enough: pilotd keeps the attention until it clears. */
const REPORT_INTERVAL_MS = 60_000;
const MAX_NAMESPACES = 16;

/** MCP namespaces a top-level call reached for: named in a codemode script, or an MCP tool called directly. */
export function mcpNamespaces(toolName: string, input: unknown): string[] {
	const found = new Set<string>();
	const direct = /^mcp__([A-Za-z0-9_]+?)__/.exec(toolName);
	if (direct) found.add(direct[1]!);
	else if (toolName === "codemode") {
		const code = (input as { code?: unknown } | undefined)?.code;
		if (typeof code === "string")
			for (const match of code.slice(0, 256 * 1024).matchAll(NAMESPACE)) {
				found.add(match[1]!);
				if (found.size >= MAX_NAMESPACES) break;
			}
	}
	return [...found];
}

export function mcpActivity(onUsed: (namespaces: string[], failed: boolean) => void): ExtensionFactory {
	return (pi) => {
		const reported = new Map<string, number>();
		pi.on("tool_result", (event) => {
			// Nested calls only run on connected servers; their codemode parent reports the script as a whole.
			if (event.parentToolCallId) return;
			const now = Date.now();
			const fresh = mcpNamespaces(event.toolName, event.input).filter((namespace) => {
				const key = `${namespace}\0${event.isError}`;
				if (now - (reported.get(key) ?? -Infinity) < REPORT_INTERVAL_MS) return false;
				reported.set(key, now);
				return true;
			});
			if (fresh.length) onUsed(fresh, event.isError);
		});
	};
}

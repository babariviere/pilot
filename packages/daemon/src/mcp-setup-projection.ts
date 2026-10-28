import { isIP } from "node:net";
import type { McpSetupEntry, McpShareConfig } from "@pilot/protocol";

export const mcpSetupName = (name: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(name);
export const mcpSetupNamespace = (name: string): string => name.replaceAll("-", "_");
const record = (value: unknown): value is Record<string, unknown> =>
	!!value &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fields = new Set(["type", "url", "command", "args", "env", "headers", "enabled", "exposure", "timeout"]);
const exposures = new Set(["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);

/** Positive, deliberately narrow subset of pinned Pi 1.4 config. Never resolve env or execute commands.
 * Extra fields block the entire entry, rather than stripping authentication/permissions silently.
 * Descriptions and arbitrary URL paths/arguments can themselves contain secrets.
 */
export function projectMcpSetup(name: string, raw: unknown): McpSetupEntry {
	const blocked = (reason: NonNullable<McpSetupEntry["blocked"]>): McpSetupEntry => ({ name, blocked: reason });
	if (!mcpSetupName(name) || !record(raw)) return blocked("invalid_configuration");
	if (Object.keys(raw).some((key) => !fields.has(key))) return blocked("advanced_configuration");
	if (
		(raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.length !== 0)) ||
		[raw.env, raw.headers].some((value) => value !== undefined && (!record(value) || Object.keys(value).length !== 0))
	)
		return blocked("advanced_configuration");
	if (
		(raw.enabled !== undefined && typeof raw.enabled !== "boolean") ||
		(raw.exposure !== undefined && !exposures.has(raw.exposure as string)) ||
		(raw.timeout !== undefined &&
			(typeof raw.timeout !== "number" || !Number.isFinite(raw.timeout) || raw.timeout <= 0 || raw.timeout > 600))
	)
		return blocked("invalid_configuration");
	if (typeof raw.url === "string" && raw.command === undefined) {
		if (raw.type !== undefined && raw.type !== "http" && raw.type !== "streamable-http")
			return blocked("invalid_configuration");
		try {
			const url = new URL(raw.url);
			const host = url.hostname.replace(/\.$/, "");
			if (
				raw.url.length > 2048 ||
				/[\s\\@?#$!]/.test(raw.url) ||
				/[^\x21-\x7e]/.test(raw.url) ||
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				url.port ||
				isIP(host) ||
				!host.includes(".") ||
				!/^[a-z0-9.-]+$/.test(host) ||
				/(?:^|\.)(?:localhost|local|internal)$/.test(host) ||
				!["/", "/mcp", "/mcp/", "/api/mcp", "/v1/mcp"].includes(url.pathname)
			)
				return blocked("unsafe_url");
		} catch {
			return blocked("unsafe_url");
		}
	} else if (typeof raw.command === "string" && raw.url === undefined) {
		if (raw.type !== undefined && raw.type !== "stdio") return blocked("invalid_configuration");
		if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(raw.command)) return blocked("local_command");
	} else return blocked("invalid_configuration");
	return { name, config: structuredClone(raw) as McpShareConfig };
}

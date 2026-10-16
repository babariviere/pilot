import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";

/** Local opt-in only. Never resolved from project settings, replicated state or MCP auto-discovery. */
export interface SlackRemovalRoute {
	server: { url: string; headers: { Authorization: string } };
	enabled?: boolean;
	tool: string;
	dispatcher?: { tool: string; nameKey: string; argumentsKey: string };
}

export function parseSlackRemovalRoute(value: unknown): SlackRemovalRoute {
	const invalid = () => new Error("Invalid Slack eyes removal route");
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	const route = value as Record<string, unknown>;
	const name = (value: unknown): value is string =>
		typeof value === "string" &&
		/^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) &&
		!["__proto__", "prototype", "constructor"].includes(value);
	if (
		Object.keys(route).some((key) => !["server", "enabled", "tool", "dispatcher"].includes(key)) ||
		(route.enabled !== undefined && typeof route.enabled !== "boolean") ||
		!name(route.tool)
	)
		throw invalid();
	const server = route.server as Record<string, unknown> | undefined;
	if (
		!server ||
		typeof server !== "object" ||
		Array.isArray(server) ||
		Object.keys(server).length !== 2 ||
		typeof server.url !== "string" ||
		server.url.length > 2048
	)
		throw invalid();
	let url: URL;
	try {
		url = new URL(server.url);
	} catch {
		throw invalid();
	}
	if (
		url.username ||
		url.password ||
		url.hash ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
	)
		throw invalid();
	const headers = server.headers as Record<string, unknown> | undefined;
	if (
		!headers ||
		typeof headers !== "object" ||
		Array.isArray(headers) ||
		Object.keys(headers).length !== 1 ||
		typeof headers.Authorization !== "string" ||
		headers.Authorization.length > 8192 ||
		/[\r\n]/.test(headers.Authorization) ||
		!/^(?:Bearer \S+|!.+)$/.test(headers.Authorization)
	)
		throw invalid();
	let dispatcher: SlackRemovalRoute["dispatcher"];
	if (route.dispatcher !== undefined) {
		const d = route.dispatcher as Record<string, unknown>;
		if (
			!d ||
			typeof d !== "object" ||
			Array.isArray(d) ||
			Object.keys(d).length !== 3 ||
			!name(d.tool) ||
			!name(d.nameKey) ||
			!name(d.argumentsKey) ||
			d.nameKey === d.argumentsKey
		)
			throw invalid();
		dispatcher = { tool: d.tool, nameKey: d.nameKey, argumentsKey: d.argumentsKey };
	}
	return {
		server: { url: server.url, headers: { Authorization: headers.Authorization } },
		...(route.enabled !== undefined ? { enabled: route.enabled } : {}),
		tool: route.tool,
		...(dispatcher ? { dispatcher } : {}),
	};
}

/** Read afresh per once-only Done attempt, off the daemon loop. No config values enter errors/logs. */
export async function loadSlackRemovalRoute(agentDir: string): Promise<SlackRemovalRoute> {
	let file: FileHandle | undefined;
	try {
		file = await open(join(agentDir, "pilot-tracking.json"), "r");
		const buffer = Buffer.alloc(16 * 1024 + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 16 * 1024) throw new Error();
		return parseSlackRemovalRoute(JSON.parse(buffer.toString("utf8", 0, bytesRead)).slackEyesRemoval);
	} catch {
		throw new Error("Slack eyes removal route is unconfigured or invalid");
	} finally {
		await file?.close();
	}
}

export function slackRemovalCall(route: SlackRemovalRoute, channel: string, ts: string) {
	const args = { channel, ts, name: "eyes" };
	return {
		server: route.server,
		tool: route.dispatcher?.tool ?? route.tool,
		args: route.dispatcher
			? {
					[route.dispatcher.nameKey]: route.tool,
					[route.dispatcher.argumentsKey]: args,
				}
			: args,
	};
}

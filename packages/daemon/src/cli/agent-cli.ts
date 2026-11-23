import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SessionHistoryPage } from "@pilot/protocol";
import type { MissionStore } from "../missions/missions.ts";

export type CliScope = { sessionId: string; projectId: string | null; missionId: string | null };
type Reads = {
	chats(scope: CliScope): Array<{ id: string; title?: string }>;
	history(id: string, before: number, limit: number): Promise<SessionHistoryPage>;
	missions?: MissionStore;
};

export class AgentCliError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const notFound = () => new AgentCliError(404, "Not found in this Pilot session's scope");

/** Live worker credentials. They never resolve to Day authority or generic API calls. */
export class AgentCli {
	port?: () => number | undefined;
	private readonly grants = new Map<string, () => CliScope | undefined>();
	private histories = 0;

	grant(current: () => CliScope | undefined) {
		const port = this.port?.();
		if (!port) return;
		const token = randomBytes(32).toString("hex");
		this.grants.set(token, current);
		return {
			endpoint: {
				port,
				token,
				entry: fileURLToPath(new URL("./cli.ts", import.meta.url)),
				bin: fileURLToPath(new URL("./bin", import.meta.url)),
			},
			revoke: () => this.grants.delete(token),
		};
	}

	async read(method: string | undefined, authorization: string | undefined, url: URL, reads: Reads) {
		if (method !== "GET") throw new AgentCliError(405, "Pilot CLI supports only reads");
		const token = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? "")?.[1];
		const current = token ? this.grants.get(token) : undefined;
		const scope = current?.();
		if (!scope) throw new AgentCliError(401, "Use this command in an active Pilot agent session");
		const parts = url.pathname.split("/").slice(4);
		const historyRoute = parts.length === 2 && parts[0] === "chats";
		if ([...url.searchParams.keys()].some((key) => !historyRoute || (key !== "before" && key !== "limit")))
			throw new AgentCliError(400, "Unexpected Pilot CLI query option");
		if (parts.length === 1) {
			if (parts[0] === "context") return scope;
			if (parts[0] === "chats") return { chats: reads.chats(scope) };
			if (parts[0] === "missions") return { missions: scope.missionId ? [mission(reads.missions, scope)] : [] };
		}
		if (historyRoute && parts[1] === scope.sessionId) {
			const before = integer(url, "before", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
			const limit = integer(url, "limit", 20, 50);
			// The shared cold-history reader also serves Day. Don't let CLI requests fill its queue.
			if (this.histories >= 4) throw new AgentCliError(429, "Four CLI chat reads are already running; try again");
			this.histories++;
			try {
				const page = await reads.history(scope.sessionId, before, limit);
				if (!token || this.grants.get(token) !== current || !current?.())
					throw new AgentCliError(401, "This Pilot agent session is no longer active");
				return transcript(page);
			} finally {
				this.histories--;
			}
		}
		if (parts[0] === "missions" && parts[1] && parts[1] === scope.missionId) {
			const store = reads.missions;
			const detail = mission(store, scope);
			if (parts.length === 2) return detail;
			if (parts.length === 3 && parts[2] === "brief") return { brief: store?.brief(detail.id)?.markdown ?? null };
			if (parts.length === 3 && parts[2] === "tasks") {
				const tasks = store!.tasks(detail.id).map(({ id, number, title, body, status, dependsOn, sessionId }) => ({
					id,
					number,
					title,
					body,
					status,
					dependsOn,
					sessionId,
				}));
				return { tasks };
			}
		}
		throw notFound();
	}
}

function mission(store: MissionStore | undefined, scope: CliScope) {
	const detail = scope.missionId ? store?.get(scope.missionId) : undefined;
	if (!detail || detail.projectId !== scope.projectId) throw notFound();
	const { id, projectId, title, goal, status, briefRevision, tasksDone, tasksTotal } = detail;
	return { id, projectId, title, goal, status, briefRevision, tasksDone, tasksTotal };
}

function integer(url: URL, key: string, fallback: number, max: number) {
	const values = url.searchParams.getAll(key);
	if (!values.length) return fallback;
	const value = Number(values[0]);
	if (values.length !== 1 || !/^\d+$/.test(values[0]!) || !Number.isSafeInteger(value) || value < 1 || value > max)
		throw new AgentCliError(400, `${key} must be an integer from 1 to ${max}`);
	return value;
}

/** A transcript is conversation text, not tool data, reasoning, attachments or replay state. */
function transcript(page: SessionHistoryPage) {
	const messages = page.entries.flatMap((entry) =>
		(entry.model ?? []).flatMap((message) => {
			if (
				!(entry.kind === "pi.user" && message.role === "user") &&
				!(entry.kind === "pi.assistant" && message.role === "assistant")
			)
				return [];
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			if (!text) return [];
			// Keep single messages useful without letting one pasted log dominate agent context.
			return [
				{ id: Number(entry.id), role: message.role, text: text.slice(0, 8_000), truncated: text.length > 8_000 },
			];
		}),
	);
	return {
		messages,
		more: page.more,
		nextBefore: page.more && page.entries.length ? Number(page.entries[0]!.id) : null,
	};
}

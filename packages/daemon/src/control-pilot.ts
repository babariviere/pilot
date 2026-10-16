import type { DashboardTrackedItem, Mission, Project } from "@pilot/protocol";
import type { SessionManager } from "./sessions.ts";

export interface ControlPilotOptions {
	isControl: (id: string) => boolean;
	sessions: Pick<SessionManager, "list" | "get" | "history">;
	/** Cached projections only. These callbacks must not perform storage or network reads. */
	missions: () => Mission[];
	projects: () => Project[];
	linear: (projectId: string) => DashboardTrackedItem[];
}
const short = (text: string | undefined, n = 160) => text?.replace(/[\r\n]/g, " ").slice(0, n);
function string(args: Record<string, unknown>, key: string, required = false): string | undefined {
	const value = args[key];
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > 128)
		throw new Error(`${key} must be a nonempty ID`);
	return value;
}
export class ControlPilot {
	readonly options: ControlPilotOptions;
	constructor(options: ControlPilotOptions) {
		this.options = options;
	}
	async call(caller: string, action: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.options.isControl(caller)) throw new Error("Only the control chat may call pilot");
		if (action === "status") return this.status(args);
		if (action === "read") return this.read(args);
		throw new Error("Unknown pilot action");
	}
	private status(args: Record<string, unknown>) {
		const projectId = string(args, "projectId"),
			missionId = string(args, "missionId");
		const projects = this.options.projects(),
			missions = this.options.missions();
		if (projectId && !projects.some((p) => p.id === projectId)) throw new Error("Unknown project");
		const mission = missionId ? missions.find((m) => m.id === missionId) : undefined;
		if (missionId && !mission) throw new Error("Unknown mission");
		if (projectId && mission && mission.projectId !== projectId)
			throw new Error("Mission belongs to another project");
		const selected = projectId ?? mission?.projectId;
		const chats = this.options.sessions.list({
			archived: "false",
			...(selected ? { projectId: selected } : {}),
			...(missionId ? { missionId } : {}),
		});
		const ms = missions.filter((m) => (!selected || m.projectId === selected) && (!missionId || m.id === missionId));
		const prs = chats.flatMap((chat) =>
			(chat.pullRequests ?? (chat.pullRequest ? [chat.pullRequest] : []))
				.filter((pr) => pr.state === "open" || pr.state === "draft")
				.map((pr) => ({
					sessionId: chat.id,
					url: pr.url,
					title: short(pr.title),
					number: pr.number,
					state: pr.state,
				})),
		);
		const items = projects
			.filter((p) => !selected || p.id === selected)
			.slice(0, 200)
			.flatMap((project) =>
				this.options
					.linear(project.id)
					.filter((item) => !missionId || item.missionId === missionId || item.missionIds?.includes(missionId))
					.map((item) => ({
						projectId: project.id,
						id: item.id,
						identifier: item.externalId,
						title: short(item.title),
						status: short(item.status, 60),
						url: item.url?.slice(0, 2048),
					})),
			);
		const data = {
			untrusted: true,
			source: "daemon-memory",
			projects: projects
				.filter((p) => !selected || p.id === selected)
				.slice(0, 200)
				.map((p) => ({ id: p.id, name: short(p.name, 100) })),
			chats: chats.slice(0, 100).map((chat) => ({
				id: chat.id,
				chatUrl: `pilot://chat/${chat.id}`,
				title: short(chat.title),
				projectId: chat.projectId,
				missionId: chat.missionId,
				state: chat.state,
				working: chat.working,
				outcome: chat.outcome,
				model: chat.model,
			})),
			missions: ms.slice(0, 50).map((m) => ({
				id: m.id,
				projectId: m.projectId,
				title: short(m.title),
				status: m.status,
				tasksDone: m.tasksDone,
				tasksTotal: m.tasksTotal,
				coordinatorSessionId: m.coordinatorSessionId,
			})),
			pullRequests: prs.slice(0, 100),
			linear: items.slice(0, 100),
			totals: { chats: chats.length, missions: ms.length, pullRequests: prs.length, linear: items.length },
			truncated: false,
		};
		const lists = [data.projects, data.chats, data.missions, data.pullRequests, data.linear];
		while (Buffer.byteLength(JSON.stringify(data)) > 24_000) {
			const longest = lists.reduce((a, b) => (a.length > b.length ? a : b));
			longest.pop();
			data.truncated = true;
		}
		data.truncated ||=
			data.chats.length < chats.length ||
			data.missions.length < ms.length ||
			data.pullRequests.length < prs.length ||
			data.linear.length < items.length;
		return data;
	}
	private async read(args: Record<string, unknown>) {
		const id = string(args, "sessionId", true)!;
		const chat = this.options.sessions.get(id);
		if (!chat) throw new Error("Unknown chat");
		if (args.view !== undefined && args.view !== "result" && args.view !== "tail")
			throw new Error("view must be result or tail");
		const limit = args.limit ?? 12;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 40)
			throw new Error("limit must be 1..40");
		// One bounded cold read, never a subscription or worker start. No unbounded backward search.
		const page = await this.options.sessions.history(id, Number.MAX_SAFE_INTEGER, args.view === "tail" ? limit : 64);
		const messages = page.entries.flatMap((entry) =>
			(entry.model ?? []).flatMap((message) => {
				if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return [];
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("\n");
				return text ? [{ role: message.role, text }] : [];
			}),
		);
		const chosen =
			args.view === "tail" ? messages.slice(-limit) : messages.filter((m) => m.role === "assistant").slice(-1);
		let left = 12_000;
		const quoted = chosen
			.toReversed()
			.flatMap((m) => {
				if (!left) return [];
				const text = m.text.slice(-left);
				left -= text.length;
				return [{ role: m.role, text }];
			})
			.reverse();
		return {
			untrusted: true,
			sessionId: id,
			chatUrl: `pilot://chat/${id}`,
			quotedContent: quoted,
			truncated: page.more || chosen.reduce((n, m) => n + m.text.length, 0) > 12_000,
		};
	}
}

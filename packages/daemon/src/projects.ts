/** Projects: named working directories that sessions (and later, triggers) belong to. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Project, ProjectRequest, ProjectTrackingConfig, RemoteBranchList } from "@pilot/protocol";
import { NotFound } from "./errors.ts";
import { listRemoteBranches } from "./workspaces.ts";

export function expandHome(path: string): string {
	return resolve(path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
}

export async function requireDirectory(path: string): Promise<string> {
	const resolved = expandHome(path);
	if (!(await stat(resolved).catch(() => undefined))?.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
	return resolved;
}

export class ProjectStore {
	private projects: Project[] = [];
	private readonly listeners = new Set<(projects: Project[]) => void>();
	private saving: Promise<void> = Promise.resolve();

	private readonly home: string;

	constructor(home: string) {
		this.home = home;
	}

	private get file(): string {
		return join(this.home, "projects.json");
	}

	async load(): Promise<void> {
		await mkdir(this.home, { recursive: true, mode: 0o700 });
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as Project[];
			this.projects = Array.isArray(parsed) ? parsed : [];
			let migrated = false;
			this.projects = this.projects.map((project) => {
				if (!project.tracking || !Object.hasOwn(project.tracking, "mcp")) return project;
				migrated = true;
				return {
					...project,
					tracking: validateTrackingConfig({
						slackChannels: project.tracking.slackChannels,
						linearTeam: project.tracking.linearTeam,
					}),
				};
			});
			if (migrated) await this.persist();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	onChange(listener: (projects: Project[]) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(): Project[] {
		return [...this.projects].sort((a, b) => a.name.localeCompare(b.name));
	}

	get(id: string): Project | undefined {
		return this.projects.find((project) => project.id === id);
	}

	require(id: string): Project {
		const project = this.get(id);
		if (!project) throw new NotFound(`Unknown project: ${id}`);
		return project;
	}

	/** Selectable origin heads. Opt in for Ask or an explicit per-chat clone override on a direct project. */
	async branches(id: string, includeDirect = false): Promise<RemoteBranchList> {
		const project = this.require(id);
		return project.workspace === "direct" && !includeDirect ? { branches: [] } : listRemoteBranches(project.path);
	}

	async create(request: ProjectRequest): Promise<Project> {
		validatePullRequestSetting(request);
		const tracking = request.tracking === undefined ? undefined : validateTrackingConfig(request.tracking);
		if (typeof request.path !== "string" || !request.path.trim()) throw new Error("path is required");
		const path = await requireDirectory(request.path);
		if (this.projects.some((project) => project.path === path)) throw new Error(`A project already uses ${path}`);
		const project: Project = {
			id: randomUUID(),
			name: request.name?.trim() || basename(path),
			path,
			createdAt: Date.now(),
			...(tracking ? { tracking } : {}),
			...(request.model?.trim() ? { model: request.model.trim() } : {}),
			...(request.workspace === "direct" ? { workspace: "direct" } : {}),
			...(request.requirePullRequest !== undefined ? { requirePullRequest: request.requirePullRequest } : {}),
		};
		this.projects.push(project);
		await this.persist();
		return project;
	}

	async update(id: string, request: Partial<ProjectRequest>): Promise<Project> {
		validatePullRequestSetting(request);
		const tracking = request.tracking === undefined ? undefined : validateTrackingConfig(request.tracking);
		const project = this.require(id);
		const next: Project = { ...project };
		if (tracking) next.tracking = tracking;
		if (request.name !== undefined) {
			if (!request.name.trim()) throw new Error("name cannot be empty");
			next.name = request.name.trim();
		}
		if (request.path !== undefined) next.path = await requireDirectory(request.path);
		if (request.model !== undefined) {
			if (request.model?.trim()) next.model = request.model.trim();
			else delete next.model;
		}
		if (request.workspace !== undefined) {
			if (request.workspace === "direct") next.workspace = "direct";
			else delete next.workspace;
		}
		if (request.requirePullRequest !== undefined) next.requirePullRequest = request.requirePullRequest;
		this.projects = this.projects.map((existing) => (existing.id === id ? next : existing));
		await this.persist();
		return next;
	}

	/** Sessions keep their projectId; clients show them as unassigned. */
	async remove(id: string): Promise<void> {
		this.require(id);
		this.projects = this.projects.filter((project) => project.id !== id);
		await this.persist();
	}

	private persist(): Promise<void> {
		const snapshot = `${JSON.stringify(this.projects, null, "\t")}\n`;
		this.saving = this.saving
			.catch(() => undefined)
			.then(async () => {
				const temp = `${this.file}.${randomUUID()}.tmp`;
				await writeFile(temp, snapshot, { mode: 0o600 });
				await rename(temp, this.file);
			});
		const projects = this.list();
		for (const listener of this.listeners) listener(projects);
		return this.saving;
	}
}

function validatePullRequestSetting(request: Partial<ProjectRequest>): void {
	if (request.requirePullRequest !== undefined && typeof request.requirePullRequest !== "boolean")
		throw new Error("requirePullRequest must be a boolean");
}

/** Validate before mutation. Tracking config is replaced, not recursively merged. */
export function validateTrackingConfig(value: unknown): ProjectTrackingConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tracking must be an object");
	const config = value as ProjectTrackingConfig;
	const keys = ["slackChannels", "slackChannelNames", "slackLabels", "linearTeam", "linearTeamName"];
	if (Object.keys(config).some((key) => !keys.includes(key)))
		throw new Error(
			"Tracking supports only slackChannels, slackChannelNames, slackLabels, linearTeam and linearTeamName",
		);
	if (
		!Array.isArray(config.slackChannels) ||
		config.slackChannels.length > 100 ||
		config.slackChannels.some((channel) => typeof channel !== "string" || !channel.trim() || channel.length > 200)
	)
		throw new Error("slackChannels must contain at most 100 non-empty channel names or IDs");
	if (config.linearTeam !== undefined && (typeof config.linearTeam !== "string" || config.linearTeam.length > 200))
		throw new Error("linearTeam must be a string of at most 200 characters");
	if (
		config.linearTeamName !== undefined &&
		(typeof config.linearTeamName !== "string" || config.linearTeamName.length > 200)
	)
		throw new Error("linearTeamName must be a string of at most 200 characters");
	const labels = config.slackLabels;
	if (
		labels !== undefined &&
		(!Array.isArray(labels) ||
			labels.length > 50 ||
			labels.some(
				(label) =>
					!label ||
					typeof label !== "object" ||
					Array.isArray(label) ||
					Object.keys(label).some((key) => !["name", "description", "hideFromInbox"].includes(key)) ||
					typeof label.name !== "string" ||
					!label.name.trim() ||
					label.name.length > 80 ||
					/[\x00-\x1f]/.test(label.name) ||
					typeof label.description !== "string" ||
					label.description.length > 240 ||
					/[\x00-\x1f]/.test(label.description) ||
					(label.hideFromInbox !== undefined && typeof label.hideFromInbox !== "boolean"),
			) ||
			new Set(labels.map((label) => label.name.trim())).size !== labels.length)
	)
		throw new Error("Invalid Slack labels (at most 50 unique names with one-line descriptions)");
	const names = config.slackChannelNames;
	if (
		names !== undefined &&
		(!names ||
			typeof names !== "object" ||
			Array.isArray(names) ||
			Object.keys(names).length > 100 ||
			Object.values(names).some((name) => typeof name !== "string" || name.length > 200))
	)
		throw new Error("slackChannelNames must map channel IDs to names of at most 200 characters");
	const slackChannels = [...new Set(config.slackChannels.map((channel) => channel.trim()))];
	// Names are display-only: keep those of configured channels.
	const slackChannelNames = Object.fromEntries(
		slackChannels.flatMap((channel) => {
			const name = names && Object.hasOwn(names, channel) ? names[channel]!.trim().replace(/^#/, "") : "";
			return name ? [[channel, name]] : [];
		}),
	);
	const linearTeam = config.linearTeam?.trim();
	const result: ProjectTrackingConfig = {
		slackChannels,
		...(labels
			? {
					slackLabels: labels.map((label) => ({
						...label,
						name: label.name.trim(),
						description: label.description.trim(),
					})),
				}
			: {}),
		...(Object.keys(slackChannelNames).length ? { slackChannelNames } : {}),
		...(linearTeam ? { linearTeam } : {}),
		...(linearTeam && config.linearTeamName?.trim() ? { linearTeamName: config.linearTeamName.trim() } : {}),
	};
	return result;
}

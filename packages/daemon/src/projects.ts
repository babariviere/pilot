/** Projects: named working directories that sessions belong to. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type {
	Automation,
	AutomationTrigger,
	Project,
	ProjectAutomations,
	ProjectEnvironment,
	ProjectEnvironmentOverride,
	ProjectGitHubRepository,
	ProjectRequest,
	ProjectTrackingConfig,
	RemoteBranchList,
	SlackProjectLabel,
} from "@pilot/protocol";
import { automationRevision, validateAutomationsUpdate, validateProjectAutomations } from "./automation-definitions.ts";
import {
	applyEnvironmentApprovals,
	effectiveEnvironment,
	validateEnvironmentOverride,
	validateEnvironmentProfile,
	validateProjectEnvironment,
	validateProjectEnvironmentOverride,
} from "./environment-profile.ts";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import { durableJSON } from "./operation-journal.ts";
import { readProjectOrigin } from "./project-origin.ts";
import { localSource } from "./source-copy.ts";
import { listRemoteBranches, type Runner, run } from "./workspaces.ts";

export function expandHome(path: string): string {
	return resolve(path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
}

export async function requireDirectory(path: string): Promise<string> {
	const resolved = expandHome(path);
	if (!(await stat(resolved).catch(() => undefined))?.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
	return resolved;
}

// Each link adds a main-view refresh and a line in agents' reference list; ten covers a service and its shared libraries.
const MAX_LINKED_PROJECTS = 10;

export class ProjectStore {
	private projects: Project[] = [];
	/** Profiles and overrides that failed validation on load, by project. Kept so a later save does not silently drop
	 * a hand edit. */
	private readonly invalid = {
		automations: new Map<string, unknown>(),
		environment: new Map<string, unknown>(),
		environmentOverride: new Map<string, unknown>(),
	};
	private readonly listeners = new Set<(projects: Project[]) => void>();
	private saving: Promise<void> = Promise.resolve();

	private readonly home: string;
	private readonly runner: Runner;

	constructor(home: string, runner: Runner = run) {
		this.home = home;
		this.runner = runner;
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
			this.invalid.automations.clear();
			this.projects = this.projects.map((project) => {
				if (project.automations === undefined) return project;
				try {
					return { ...project, automations: validateProjectAutomations(project.automations) };
				} catch (error) {
					this.invalid.automations.set(project.id, project.automations);
					return {
						...project,
						automations: {
							revision: automationRevision(project.automations),
							items: [],
							error: (error as Error).message,
						},
					};
				}
			});
			const validators = {
				environment: validateProjectEnvironment,
				environmentOverride: validateProjectEnvironmentOverride,
			} as const;
			for (const field of ["environment", "environmentOverride"] as const)
				this.projects = this.projects.map((project) => {
					if (project[field] === undefined) return project;
					try {
						return { ...project, [field]: validators[field](project[field]) };
					} catch (error) {
						// Clients never see an invalid layer; the stored value stays on disk until the user saves a new one.
						console.warn(`pilotd: project ${project.id} ${field} ignored: ${(error as Error).message}`);
						this.invalid[field].set(project.id, project[field]);
						const { [field]: _ignored, ...rest } = project;
						return rest;
					}
				});
			this.projects = this.projects.map((project) => {
				if (!project.tracking) return project;
				// Labels from before effects: hideFromInbox: true becomes hide, every label states its effect.
				if (
					!Object.hasOwn(project.tracking, "mcp") &&
					(project.tracking.slackLabels ?? []).some(
						(label) => Object.hasOwn(label, "hideFromInbox") || !Object.hasOwn(label, "effect"),
					)
				) {
					try {
						const tracking = validateTrackingConfig(project.tracking);
						migrated = true;
						return { ...project, tracking };
					} catch {
						return project;
					}
				}
				if (!Object.hasOwn(project.tracking, "mcp")) return project;
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

	async origin(id: string): Promise<import("@pilot/protocol").ProjectOrigin> {
		return readProjectOrigin(this.require(id).path, this.runner);
	}

	/** Only a user click resolves this. No startup scan, polling, or local-client filesystem access. */
	async github(id: string): Promise<ProjectGitHubRepository> {
		const project = this.require(id);
		try {
			const env = { ...process.env };
			delete env.GH_REPO; // A launcher-wide override must not select another project's repository.
			const raw = await this.runner(
				"gh",
				["repo", "view", "--json", "url", "--jq", ".url"],
				project.path,
				10_000,
				undefined,
				env,
			);
			const url = new URL(raw.trim());
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				!/^\/[^/]+\/[^/]+\/?$/.test(url.pathname)
			)
				throw new Error("Invalid repository URL");
			return { url: url.href };
		} catch {
			throw new ServiceUnavailable(
				"Couldn't find this project's GitHub repository. Check its remotes and GitHub CLI sign-in.",
			);
		}
	}

	async previewLocal(path: string) {
		return localSource(expandHome(path), this.runner);
	}

	/** Register exactly the folder and source policy the user previewed. */
	async createLocal(path: string, digest: string, registration?: Project["registration"]): Promise<Project> {
		const source = await this.previewLocal(path);
		if (source.digest !== digest) throw new Conflict("Source changed. Preview the folder again.");
		return this.create(
			{ path: source.path, ...(source.copy === "folder" ? { workspace: "direct" } : {}) },
			source.copy,
			registration,
		);
	}

	async registration(operationId: string, payloadHash: string): Promise<Project | undefined> {
		await this.saving;
		return this.projects.find(
			(p) => p.registration?.operationId === operationId && p.registration.payloadHash === payloadHash,
		);
	}

	async create(
		request: ProjectRequest,
		sourceCopy?: Project["sourceCopy"],
		registration?: Project["registration"],
	): Promise<Project> {
		if (Object.hasOwn(request, "automations")) throw new Error("Use the native automations endpoint to edit hooks");
		validatePullRequestSetting(request);
		const tracking = request.tracking === undefined ? undefined : validateTrackingConfig(request.tracking);
		if (typeof request.path !== "string" || !request.path.trim()) throw new Error("path is required");
		const path = await requireDirectory(request.path);
		if (this.projects.some((project) => project.path === path)) throw new Conflict(`A project already uses ${path}`);
		const project: Project = {
			id: randomUUID(),
			name: request.name?.trim() || basename(path),
			path,
			createdAt: Date.now(),
			...(sourceCopy ? { sourceCopy } : {}),
			...(registration ? { registration } : {}),
			...(tracking ? { tracking, trackingGeneration: randomUUID() } : {}),
			...(request.model?.trim() ? { model: request.model.trim() } : {}),
			...(request.workspace === "direct" ? { workspace: "direct" } : {}),
			...(request.requirePullRequest !== undefined ? { requirePullRequest: request.requirePullRequest } : {}),
		};
		this.projects.push(project);
		await this.persist();
		return project;
	}

	async update(id: string, request: Partial<ProjectRequest>): Promise<Project> {
		if (Object.hasOwn(request, "automations")) throw new Error("Use the native automations endpoint to edit hooks");
		validatePullRequestSetting(request);
		const tracking = request.tracking === undefined ? undefined : validateTrackingConfig(request.tracking);
		const project = this.require(id);
		const next: Project = { ...project };
		if (
			project.sourceCopy &&
			((request.path !== undefined && request.path !== project.path) ||
				(request.workspace !== undefined &&
					request.workspace !== (project.sourceCopy === "jj" ? "clone" : "direct")))
		)
			throw new Conflict("Local source policy changed. Add and preview the new source instead.");
		if (tracking) {
			next.tracking = tracking;
			if (JSON.stringify(tracking) !== JSON.stringify(project.tracking)) next.trackingGeneration = randomUUID();
		}
		if (request.name !== undefined) {
			if (!request.name.trim()) throw new Error("name cannot be empty");
			next.name = request.name.trim();
		}
		if (request.path !== undefined) next.path = await requireDirectory(request.path);
		if (next.path !== project.path) next.trackingGeneration = randomUUID();
		if (request.model !== undefined) {
			if (request.model?.trim()) next.model = request.model.trim();
			else delete next.model;
		}
		if (request.workspace !== undefined) {
			if (request.workspace === "direct") next.workspace = "direct";
			else delete next.workspace;
		}
		if (request.requirePullRequest !== undefined) next.requirePullRequest = request.requirePullRequest;
		if (request.linkedProjects !== undefined) {
			const linked = this.validateLinkedProjects(id, request.linkedProjects);
			if (linked.length) next.linkedProjects = linked;
			else delete next.linkedProjects;
		}
		// Even a later edit back to identical settings must invalidate an earlier confirmation.
		if (JSON.stringify(next) !== JSON.stringify(project)) next.workflowGeneration = randomUUID();
		this.projects = this.projects.map((existing) => (existing.id === id ? next : existing));
		await this.persist();
		return next;
	}

	/**
	 * The user allows or stops a work profile in this project. The first edit starts from `current`, the profiles
	 * allowed now, and marks the list edited: it is then kept exactly. A Cyber choice also answers Today's Cyber
	 * question. It changes no workflow confirmation: profiles are read again at each start. Whether the profile exists
	 * is the caller's check.
	 */
	async setAllowedProfile(
		id: string,
		profile: string,
		allowed: boolean,
		current: readonly string[],
	): Promise<Project> {
		if (!/^[a-z][a-z0-9-]{0,31}$/.test(profile)) throw new Error("profile must be a work profile ID");
		return this.patchHostFields(id, (p) => {
			const kept = (p.profilesEdited ? (p.allowedProfiles ?? []) : current).filter((x) => x !== profile);
			return {
				...p,
				profilesEdited: true,
				allowedProfiles: allowed ? [...kept, profile] : kept,
				...(profile === "cyber" ? { cyberSuggestionDismissed: true } : {}),
			};
		});
	}

	/** Counts one cyber block in this project's chats. Host-owned, so no workflow confirmation changes. */
	recordCyberBlock(id: string): Promise<Project> {
		return this.patchHostFields(id, (p) => ({ ...p, cyberBlocks: (p.cyberBlocks ?? 0) + 1 }));
	}

	/** The user answered Not now to the Cyber suggestion. Pilot does not ask again for this project. */
	dismissCyberSuggestion(id: string): Promise<Project> {
		return this.patchHostFields(id, (p) => ({ ...p, cyberSuggestionDismissed: true }));
	}

	private async patchHostFields(id: string, change: (project: Project) => Project): Promise<Project> {
		const next = change(this.require(id));
		this.projects = this.projects.map((existing) => (existing.id === id ? next : existing));
		await this.persist();
		return next;
	}

	/** Detached trigger-time snapshot. Invalid saved definitions are never executable. */
	enabledAutomations(id: string, trigger: AutomationTrigger): { revision: number; items: Automation[] } {
		const config = this.require(id).automations;
		return {
			revision: config?.revision ?? 0,
			items: config?.error
				? []
				: structuredClone(config?.items.filter((item) => item.enabled && item.on.includes(trigger)) ?? []),
		};
	}

	async updateAutomations(id: string, value: unknown): Promise<ProjectAutomations> {
		const request = validateAutomationsUpdate(value);
		const project = this.require(id);
		const current = project.automations ?? { revision: 0, items: [] };
		if (request.expectedRevision !== current.revision)
			throw new AutomationsRevisionConflict(structuredClone(current));
		const flows = request.flows ?? current.flows;
		const next = { revision: current.revision + 1, items: request.items, ...(flows !== undefined ? { flows } : {}) };
		this.invalid.automations.delete(id);
		this.projects = this.projects.map((existing) =>
			existing.id === id ? { ...existing, automations: next } : existing,
		);
		await this.persist();
		return structuredClone(next);
	}

	/**
	 * Replace a project's environment profile. expectedRevision is the current revision (0 without a profile).
	 * native: the caller holds the native host-action capability, required to add or change review pins.
	 */
	async updateEnvironment(
		id: string,
		environment: unknown,
		expectedRevision: unknown,
		options: { native: boolean },
	): Promise<ProjectEnvironment> {
		if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new Error("expectedRevision must be a non-negative integer");
		const profile = validateEnvironmentProfile(environment);
		const project = this.require(id);
		const revision = this.layerRevision(project, "environment");
		if (expectedRevision !== revision) throw new EnvironmentRevisionConflict(revision);
		const next: ProjectEnvironment = {
			revision: revision + 1,
			...applyEnvironmentApprovals(project.environment, profile, options.native),
		};
		this.invalid.environment.delete(id);
		this.projects = this.projects.map((existing) =>
			existing.id === id ? { ...existing, environment: next } : existing,
		);
		await this.persist();
		return next;
	}

	/**
	 * Replace this host's override layer. Same revision and review-pin rules as the shared profile; the layer is
	 * never synced. The result must leave a valid effective profile.
	 */
	async updateEnvironmentOverride(
		id: string,
		override: unknown,
		expectedRevision: unknown,
		options: { native: boolean },
	): Promise<ProjectEnvironmentOverride> {
		if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new Error("expectedRevision must be a non-negative integer");
		const layer = validateEnvironmentOverride(override);
		const project = this.require(id);
		const revision = this.layerRevision(project, "environmentOverride");
		if (expectedRevision !== revision) throw new EnvironmentRevisionConflict(revision);
		const next: ProjectEnvironmentOverride = {
			revision: revision + 1,
			...applyEnvironmentApprovals(project.environmentOverride, layer, options.native),
		};
		const effective = validateProjectEnvironment(effectiveEnvironment(project.environment, next));
		const known = new Set([...effective.tools, ...effective.services].map((entry) => entry.id));
		const dangling = next.steps?.find((step) => step.requires.some((id) => !known.has(id)));
		if (dangling) throw new Error(`override step ${dangling.id} requires an unknown tool or service`);
		this.invalid.environmentOverride.delete(id);
		this.projects = this.projects.map((existing) =>
			existing.id === id ? { ...existing, environmentOverride: next } : existing,
		);
		await this.persist();
		return next;
	}

	private layerRevision(project: Project, field: "environment" | "environmentOverride"): number {
		const current = project[field];
		if (current) return current.revision;
		const invalid = (this.invalid[field].get(project.id) as { revision?: unknown } | undefined)?.revision;
		return typeof invalid === "number" && Number.isSafeInteger(invalid) && invalid >= 0 ? invalid : 0;
	}

	/** Sessions keep their projectId; clients show them as unassigned. */
	async remove(id: string): Promise<void> {
		this.require(id);
		this.invalid.automations.delete(id);
		this.invalid.environment.delete(id);
		this.invalid.environmentOverride.delete(id);
		this.projects = this.projects
			.filter((project) => project.id !== id)
			.map((project) => {
				if (!project.linkedProjects?.includes(id)) return project;
				const { linkedProjects, ...rest } = project;
				const kept = linkedProjects.filter((linked) => linked !== id);
				return kept.length ? { ...rest, linkedProjects: kept } : rest;
			});
		await this.persist();
	}

	/** Existing other projects only. Their read-only main views become readable by this project's chats. */
	private validateLinkedProjects(id: string, value: unknown): string[] {
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
			throw new Error("linkedProjects must be a list of project IDs");
		const linked = [...new Set(value as string[])];
		if (linked.length > MAX_LINKED_PROJECTS)
			throw new Conflict(
				`A project links at most ${MAX_LINKED_PROJECTS} projects and this update has ${linked.length}. Unlink one first.`,
			);
		for (const linkedId of linked) {
			if (linkedId === id) throw new Conflict("A project cannot link itself");
			if (!this.get(linkedId)) throw new Conflict(`Unknown project: ${linkedId}`);
		}
		return linked;
	}

	private persist(): Promise<void> {
		const stored = this.projects.map((project) => {
			let result: Record<string, unknown> = project as unknown as Record<string, unknown>;
			if (this.invalid.automations.has(project.id))
				result = { ...result, automations: this.invalid.automations.get(project.id) };
			for (const field of ["environment", "environmentOverride"] as const)
				if (this.invalid[field].has(project.id) && !project[field])
					result = { ...result, [field]: this.invalid[field].get(project.id) };
			return result;
		});
		const snapshot = structuredClone(stored);
		this.saving = this.saving.catch(() => undefined).then(() => durableJSON(this.file, snapshot));
		const projects = this.list();
		for (const listener of this.listeners) listener(projects);
		return this.saving;
	}
}

export class AutomationsRevisionConflict extends Conflict {
	readonly current: ProjectAutomations;
	constructor(current: ProjectAutomations) {
		super("The automations changed. Review the latest version and try again.");
		this.current = current;
	}
}

/** HTTP 409 with the current revision. Clients re-read; they never overwrite automatically. */
export class EnvironmentRevisionConflict extends Conflict {
	readonly revision: number;
	constructor(revision: number) {
		super("The environment profile changed. Review the latest version and try again.");
		this.revision = revision;
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
	const keys = [
		"slackChannels",
		"slackMentionOnlyChannels",
		"slackGroupHandles",
		"slackChannelNames",
		"slackLabels",
		"linearTeam",
		"linearTeamName",
		"linearStateMappings",
	];
	if (Object.keys(config).some((key) => !keys.includes(key)))
		throw new Error(
			"Tracking supports only slackChannels, slackMentionOnlyChannels, slackGroupHandles, slackChannelNames, slackLabels, linearTeam, linearTeamName and linearStateMappings",
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
	const startStates = config.linearStateMappings;
	if (
		startStates !== undefined &&
		(!startStates ||
			typeof startStates !== "object" ||
			Array.isArray(startStates) ||
			Object.entries(startStates).length > 250 ||
			Object.entries(startStates).some(
				([team, mapping]) =>
					!team.trim() ||
					team !== team.trim() ||
					team.length > 200 ||
					!mapping ||
					typeof mapping !== "object" ||
					Array.isArray(mapping) ||
					Object.entries(mapping).some(
						([stage, state]) =>
							!["todo", "inProgress", "inReview", "merged", "deployed", "canceled", "duplicated"].includes(
								stage,
							) ||
							!state ||
							typeof state !== "object" ||
							Array.isArray(state) ||
							Object.keys(state).some((key) => !["id", "name"].includes(key)) ||
							[state.id, state.name].some(
								(value) => typeof value !== "string" || !value.trim() || value.length > 200,
							),
					),
			))
	)
		throw new Error(
			"linearStateMappings must map at most 250 team IDs to Todo, In progress, In review, Merged, Deployed, Canceled and Duplicated state references",
		);
	if (
		labels !== undefined &&
		(!Array.isArray(labels) ||
			labels.length > 50 ||
			labels.some(
				(label) =>
					!label ||
					typeof label !== "object" ||
					Array.isArray(label) ||
					Object.keys(label).some((key) => !["name", "description", "effect", "hideFromInbox"].includes(key)) ||
					typeof label.name !== "string" ||
					!label.name.trim() ||
					label.name.length > 80 ||
					/[\x00-\x1f]/.test(label.name) ||
					typeof label.description !== "string" ||
					label.description.length > 240 ||
					/[\x00-\x1f]/.test(label.description) ||
					(label.effect !== undefined && !["none", "hide", "close"].includes(label.effect)) ||
					(legacyHide(label) !== undefined && typeof legacyHide(label) !== "boolean"),
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
	const mentionOnly = config.slackMentionOnlyChannels;
	if (
		mentionOnly !== undefined &&
		(!Array.isArray(mentionOnly) ||
			mentionOnly.length > 100 ||
			mentionOnly.some((channel) => typeof channel !== "string" || !slackChannels.includes(channel.trim())))
	)
		throw new Error("slackMentionOnlyChannels must contain configured Slack channels only");
	const groups = config.slackGroupHandles;
	if (
		groups !== undefined &&
		(!Array.isArray(groups) ||
			groups.length > 30 ||
			groups.some(
				(handle) =>
					typeof handle !== "string" ||
					!/^@?[a-z0-9][a-z0-9._-]{0,79}$/i.test(handle.trim()) ||
					/^(here|channel|everyone)$/i.test(handle.trim().replace(/^@/, "")),
			))
	)
		throw new Error("slackGroupHandles must contain at most 30 user-group handles, not broadcast mentions");
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
		...(mentionOnly?.length
			? { slackMentionOnlyChannels: [...new Set(mentionOnly.map((channel) => channel.trim()))] }
			: {}),
		...(groups?.length
			? { slackGroupHandles: [...new Set(groups.map((handle) => handle.trim().replace(/^@/, "").toLowerCase()))] }
			: {}),
		...(labels
			? {
					slackLabels: labels.map((label) => ({
						name: label.name.trim(),
						description: label.description.trim(),
						effect: label.effect ?? (legacyHide(label) ? "hide" : "none"),
					})),
				}
			: {}),
		...(Object.keys(slackChannelNames).length ? { slackChannelNames } : {}),
		...(linearTeam ? { linearTeam } : {}),
		...(linearTeam && config.linearTeamName?.trim() ? { linearTeamName: config.linearTeamName.trim() } : {}),
		...(linearTeam && startStates && Object.keys(startStates).length
			? {
					linearStateMappings: Object.fromEntries(
						Object.entries(startStates).map(([team, mapping]) => [
							team,
							Object.fromEntries(
								Object.entries(mapping).map(([stage, state]) => [
									stage,
									{ id: state.id.trim(), name: state.name.trim() },
								]),
							),
						]),
					),
				}
			: {}),
	};
	return result;
}

/** Labels saved before effects existed hid their messages with hideFromInbox: true. */
function legacyHide(label: SlackProjectLabel): unknown {
	return (label as SlackProjectLabel & { hideFromInbox?: unknown }).hideFromInbox;
}

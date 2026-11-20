/** Native-only local registration and explicit GitHub setup/import actions. */
import type { DurableOperation, GitHubSetupAction, Project, WorkProfile } from "@pilot/protocol";
import { Conflict } from "../runtime/contracts/errors.ts";
import { type GitHubImportService, importRepository } from "../sources/github/github-import.ts";
import type { GitHubSetupService } from "../sources/github/github-setup.ts";
import { type OperationJournal, OperationRejected, sameHost } from "../transport/operations/operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import { SetupError } from "../setup/setup-error.ts";
import { allowedProfiles } from "../setup/work-profiles.ts";

export const PROJECT_ACTION = "native-project-action";
function registered(p: Project) {
	return { project: { id: p.id, path: p.path, copy: p.sourceCopy } };
}
type Dependencies = {
	projects: ProjectStore;
	setup: GitHubSetupService;
	imports: GitHubImportService;
	journal: OperationJournal;
	/** Work profiles a project may allow. Absent: projects show no profile choice. */
	profiles?: () => Promise<WorkProfile[]>;
};
/** Cyber blocks in one project before Today asks to allow Cyber there: two, as the user asked. */
const CYBER_SUGGESTION_BLOCKS = 2;
/**
 * Today asks once per project: after two cyber blocks, while Cyber is not allowed there. Not now, or any Cyber tick
 * or untick in the project, answers it for good.
 */
export function suggestCyber(project: Project, profiles: readonly WorkProfile[] | undefined): boolean {
	const cyber = profiles?.find((p) => p.id === "cyber");
	return (
		(project.cyberBlocks ?? 0) >= CYBER_SUGGESTION_BLOCKS &&
		!project.cyberSuggestionDismissed &&
		!!cyber &&
		!allowedProfiles([cyber], project).length
	);
}
export class NativeProjects {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	async read() {
		const { projects, setup, imports } = this.deps;
		// A broken settings file hides the choice; it does not hide the projects.
		const profiles = await this.deps.profiles?.().catch(() => undefined);
		return {
			version: 1,
			projects: projects.list().map((p) => ({
				id: p.id,
				name: p.name,
				path: p.path,
				copy: p.sourceCopy ?? "legacy",
				linked: p.linkedProjects ?? [],
				...(profiles
					? { profiles: allowedProfiles(profiles, p).map((w) => w.id), suggestCyber: suggestCyber(p, profiles) }
					: {}),
				setup:
					p.automations?.items
						.filter((a) => a.on.includes("workspace.created") || a.on.includes("workspace.restored"))
						.map(({ id, name, enabled }) => ({ id, name, enabled })) ?? [],
			})),
			...(profiles ? { profiles: profiles.map(({ id, name, optInOnly }) => ({ id, name, optInOnly })) } : {}),
			github: await setup.status(),
			imports: await imports.list(),
		};
	}
	async preview(path: string) {
		return this.deps.projects.previewLocal(path);
	}
	/** Exact durable domain admissions only. Never clone, register, sign in or resume on lookup. */
	async recover(op: DurableOperation) {
		const p = JSON.parse(op.payload);
		if (
			op.kind !== PROJECT_ACTION ||
			p?.purpose !== PROJECT_ACTION ||
			!sameHost(op.origin, this.deps.journal.destination) ||
			op.targetId !== "projects"
		)
			throw new Error("Unknown project action");
		if (p.action === "add") {
			const project = await this.deps.projects.registration(op.operationId, op.payloadHash);
			if (project) return registered(project);
		}
		if ((p.action === "link" || p.action === "unlink") && typeof p.project === "string") {
			// Linking is a set change: the current list shows whether it took effect. Nothing is replayed.
			const project = this.deps.projects.get(p.project);
			if (project && (project.linkedProjects ?? []).includes(p.linked) === (p.action === "link"))
				return { project: { id: project.id, linked: project.linkedProjects ?? [] } };
		}
		if ((p.action === "allow-profile" || p.action === "stop-profile") && typeof p.project === "string") {
			// Setting a choice: the current project shows whether it took effect. Nothing is replayed.
			const project = this.deps.projects.get(p.project);
			if (project?.profilesEdited && project.allowedProfiles?.includes(p.profile) === (p.action === "allow-profile"))
				return { project: { id: project.id, allowedProfiles: project.allowedProfiles } };
		}
		if (p.action === "cyber-not-now" && typeof p.project === "string") {
			const project = this.deps.projects.get(p.project);
			if (project?.cyberSuggestionDismissed) return { project: { id: project.id, cyberSuggestionDismissed: true } };
		}
		if (p.action === "import") {
			const saved = await this.deps.imports.acceptedStart(op.operationId);
			if (saved && saved.url === importRepository(p.url).url && saved.destination === p.destination)
				return { import: saved };
		}
		throw new Error("Project action outcome is unknown; no effect was replayed");
	}
	async admit(op: DurableOperation, firstEntry: boolean) {
		try {
			return await this.execute(op, firstEntry);
		} catch (error) {
			// These service refusals occur before admission. Storage and post-entry errors stay Unknown.
			if (error instanceof Conflict || error instanceof SetupError) throw new OperationRejected(error.message);
			throw error;
		}
	}
	private async execute(op: DurableOperation, firstEntry: boolean) {
		let p: Record<string, unknown>;
		try {
			p = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid project action");
		}
		if (
			!p ||
			typeof p !== "object" ||
			Array.isArray(p) ||
			p.purpose !== PROJECT_ACTION ||
			op.kind !== PROJECT_ACTION ||
			!sameHost(op.origin, this.deps.journal.destination) ||
			op.targetId !== "projects" ||
			op.bindingGeneration !== 1
		)
			throw new OperationRejected("Invalid native project action");
		const allowed = [
			"purpose",
			"action",
			"path",
			"digest",
			"url",
			"destination",
			"importId",
			"account",
			"fingerprint",
			"project",
			"linked",
			"profile",
		];
		if (
			Object.keys(p).some((k) => !allowed.includes(k)) ||
			Object.entries(p).some(
				([k, v]) => k !== "purpose" && (typeof v !== "string" || v.length > 4096 || v.includes("\0")),
			)
		)
			throw new OperationRejected("Invalid project action fields");
		if (!firstEntry) throw new Error("Project action may have entered; Check only");
		const { projects, setup, imports } = this.deps;
		if (p.action === "add") {
			if (typeof p.path !== "string" || typeof p.digest !== "string")
				throw new OperationRejected("Preview the folder first");
			return registered(
				await projects.createLocal(p.path, p.digest, {
					operationId: op.operationId,
					payloadHash: op.payloadHash,
				}),
			);
		}
		if (p.action === "link" || p.action === "unlink") {
			if (typeof p.project !== "string" || typeof p.linked !== "string")
				throw new OperationRejected("Choose a project to link");
			const source = projects.get(p.project);
			if (!source) throw new OperationRejected("This project was removed. Read again.");
			const current = source.linkedProjects ?? [];
			const next =
				p.action === "link"
					? [...current.filter((id) => id !== p.linked), p.linked]
					: current.filter((id) => id !== p.linked);
			const project = await projects.update(p.project, { linkedProjects: next });
			return { project: { id: project.id, linked: project.linkedProjects ?? [] } };
		}
		if (p.action === "allow-profile" || p.action === "stop-profile") {
			// The user's choice only: Pilot never allows or stops a profile in a project on its own.
			if (typeof p.project !== "string" || typeof p.profile !== "string")
				throw new OperationRejected("Choose a project and a work profile");
			const project = projects.get(p.project);
			if (!project) throw new OperationRejected("This project was removed. Read again.");
			const profiles = (await this.deps.profiles?.()) ?? [];
			if (!profiles.some((w) => w.id === p.profile))
				throw new OperationRejected("This work profile was removed. Read again.");
			const current = allowedProfiles(profiles, project).map((w) => w.id);
			const next = await projects.setAllowedProfile(project.id, p.profile, p.action === "allow-profile", current);
			return { project: { id: next.id, allowedProfiles: next.allowedProfiles } };
		}
		if (p.action === "cyber-not-now") {
			if (typeof p.project !== "string" || !projects.get(p.project))
				throw new OperationRejected("This project was removed. Read again.");
			const project = await projects.dismissCyberSuggestion(p.project);
			return { project: { id: project.id, cyberSuggestionDismissed: true } };
		}
		if (p.action === "import") {
			if (typeof p.url !== "string" || typeof p.destination !== "string")
				throw new OperationRejected("Preview the import first");
			return { import: await imports.start({ id: op.operationId, url: p.url, destination: p.destination }) };
		}
		if (["resume", "confirm_existing", "cancel_import"].includes(p.action as string)) {
			if (typeof p.importId !== "string") throw new OperationRejected("Choose an import");
			return {
				import: await imports.action(p.importId, p.action === "cancel_import" ? "cancel" : (p.action as string)),
			};
		}
		if (
			["verify", "verify_existing", "authorize", "prepare_key", "approve_key", "cancel"].includes(p.action as string)
		) {
			return {
				github: await setup.act({
					id: op.operationId,
					action: p.action as GitHubSetupAction["action"],
					...(typeof p.account === "string" ? { account: p.account } : {}),
					...(typeof p.fingerprint === "string" ? { fingerprint: p.fingerprint } : {}),
				}),
			};
		}
		throw new OperationRejected("Unknown project action");
	}
}

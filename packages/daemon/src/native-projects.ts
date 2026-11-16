/** Native-only local registration and explicit GitHub setup/import actions. */
import type { DurableOperation, GitHubSetupAction, Project } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { type GitHubImportService, importRepository } from "./github-import.ts";
import type { GitHubSetupService } from "./github-setup.ts";
import { type OperationJournal, OperationRejected, sameHost } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import { SetupError } from "./setup.ts";

export const PROJECT_ACTION = "native-project-action";
function registered(p: Project) {
	return { project: { id: p.id, path: p.path, copy: p.sourceCopy } };
}
type Dependencies = {
	projects: ProjectStore;
	setup: GitHubSetupService;
	imports: GitHubImportService;
	journal: OperationJournal;
};
export class NativeProjects {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	async read() {
		const { projects, setup, imports } = this.deps;
		return {
			version: 1,
			projects: projects.list().map((p) => ({
				id: p.id,
				name: p.name,
				path: p.path,
				copy: p.sourceCopy ?? "legacy",
				setup:
					p.automations?.items
						.filter((a) => a.on.includes("workspace.created") || a.on.includes("workspace.restored"))
						.map(({ id, name, enabled }) => ({ id, name, enabled })) ?? [],
			})),
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

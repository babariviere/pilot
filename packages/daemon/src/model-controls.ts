/** Native model settings reuse Pi's catalogue and the credential broker, never a chat. */
import { createHash } from "node:crypto";
import type { DurableOperation, SetupStartRequest, WorkProfile } from "@pilot/protocol";
import type { BackgroundSubscription } from "./background-subscription.ts";
import { Conflict, NotFound } from "./errors.ts";
import { FundingRefused } from "./funding-errors.ts";
import { type ModelDefaults, ModelDefaultsRefused, workProfilesProblem } from "./model-controls-store.ts";
import { ModelScopeConflictError, ModelScopeSettingsError, modelScopeUpdate } from "./model-scope.ts";
import type { ModelCatalog } from "./models.ts";
import { parseIntent, SerialAdmissions } from "./native-intent.ts";
import { type OperationJournal, OperationRejected } from "./operation-journal.ts";
import type { ControlOperation } from "./operations.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";
import type { SetupService } from "./setup.ts";
import { SetupError } from "./setup-error.ts";

export const MODEL_CONTROLS = "model-controls";
const OUTCOME_UNKNOWN = "Model settings outcome unknown; lookup only";
type ProviderSetup = Pick<SetupService, "readiness" | "list" | "start" | "cancel" | "logout">;
export class ModelControls {
	private readonly admissions = new SerialAdmissions(OUTCOME_UNKNOWN);
	private readonly models: ModelCatalog;
	private readonly projects: ProjectStore;
	private readonly setup?: ProviderSetup;
	private readonly sessions?: SessionManager;
	private readonly readOnly: boolean;
	private readonly backgroundSubscription?: BackgroundSubscription;
	constructor(
		models: ModelCatalog,
		projects: ProjectStore,
		setup?: ProviderSetup,
		sessions?: SessionManager,
		readOnly = false,
		backgroundSubscription?: BackgroundSubscription,
	) {
		this.models = models;
		this.projects = projects;
		this.setup = setup;
		this.sessions = sessions;
		this.readOnly = readOnly;
		this.backgroundSubscription = backgroundSubscription;
	}
	async recovery(projectId: string, sessionId: string) {
		const s = this.sessions?.get(sessionId);
		if (!s || s.projectId !== projectId || !s.failedModelSource || s.archivedAt)
			throw new Error("Failed work changed");
		const choices = await this.models.listTaskModels(s.cwd);
		const current = this.sessions?.get(sessionId);
		if (
			!current ||
			current.projectId !== projectId ||
			JSON.stringify(current.failedModelSource) !== JSON.stringify(s.failedModelSource)
		)
			throw new Error("Failed work changed");
		return { sessionId, projectId, source: s.failedModelSource, choices, saved: s.nextAttemptModel ?? null };
	}
	async read(projectId?: string) {
		const project = projectId ? this.projects.require(projectId) : undefined;
		const cwd = project?.path;
		const configuration = await this.models.configurationHash(cwd ?? "~");
		const [defaults, scope, available, task, readiness] = await Promise.all([
			this.models.modelDefaults(),
			this.models.scope(cwd),
			this.models.list(cwd ?? "~"),
			this.models.listTaskModels(cwd ?? "~"),
			this.setup?.readiness(),
		]);
		const failed = projectId
			? (this.sessions?.list({ projectId }).filter((s) => s.failedModelSource && !s.archivedAt) ?? [])
			: [];
		const funding = await this.sessions?.funding?.read(projectId);
		const backgroundSubscription = await this.backgroundSubscription?.read();
		const fundedWork =
			projectId && this.sessions?.funding
				? this.sessions
						.list({ projectId })
						.filter((s) => !s.archivedAt && this.sessions!.fundingRequired(s.id))
						.slice(0, 100)
						.map((s) => ({
							id: s.id,
							title: s.title,
							owner: this.sessions!.fundingOwner(s.id),
							subscription: s.subscriptionPause ?? null,
						}))
				: [];
		if ((await this.models.configurationHash(cwd ?? "~")) !== configuration)
			throw new Error("Model configuration changed during read");
		if (project) {
			const now = this.projects.require(project.id);
			if (
				now.path !== project.path ||
				now.model !== project.model ||
				now.workflowGeneration !== project.workflowGeneration
			)
				throw new Error("Project changed during model settings read");
		}
		const binding = {
			configuration,
			...defaults,
			scopeHash: scope.scopeHash,
			projectOverride: scope.projectOverride,
			projectId: project?.id ?? null,
			path: project?.path ?? null,
			projectModel: project?.model ?? null,
			workflowGeneration: project?.workflowGeneration ?? null,
			fundingRevision: funding?.revision,
			backgroundSubscription,
			fundedWork: fundedWork.map((w) => ({ id: w.id, owner: w.owner, subscription: w.subscription })),
		};
		return {
			version: 1,
			funding,
			backgroundSubscription,
			fundedWork,
			...defaults,
			scope,
			available,
			task,
			project: project
				? {
						id: project.id,
						name: project.name,
						model: project.model ?? null,
						generation: project.workflowGeneration ?? null,
					}
				: null,
			providers: readiness?.providers ?? [],
			runs: this.setup?.list() ?? [],
			failedCount: failed.length,
			// Bound Settings' native row count while preserving the exact total, not an empty/truncated claim.
			failed: failed.slice(0, 100).map((s) => ({ id: s.id, title: s.title, model: s.model ?? null })),
			binding: createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
		};
	}
	/** No replay of an entered write, login, cancel or logout after an uncertain receipt. */
	admit(op: DurableOperation, journal: OperationJournal, firstEntry: boolean): Promise<unknown> {
		return this.admissions.admit(firstEntry, () => this.apply(op, journal));
	}
	private async apply(op: DurableOperation, journal: OperationJournal) {
		const p = parseIntent(
			op,
			journal.destination,
			MODEL_CONTROLS,
			["action", "binding", "projectId", "purpose", "value"],
			"Invalid native model settings intent",
		);
		if (
			(p.projectId !== null && (typeof p.projectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(p.projectId))) ||
			op.targetId !== (p.projectId ?? "global-models")
		)
			throw new OperationRejected("Invalid native model settings intent");
		let read: Awaited<ReturnType<ModelControls["read"]>>;
		try {
			read = await this.read((p.projectId as string | undefined) ?? undefined);
		} catch {
			throw new OperationRejected("AI settings could not be read. Nothing changed.");
		}
		if (read.binding !== p.binding || op.bindingId !== p.binding)
			throw new OperationRejected("Model settings changed. Read again before saving.");
		try {
			switch (p.action) {
				case "background-continue": {
					if (!this.backgroundSubscription || !["anthropic", "openai"].includes(p.value as string))
						throw new OperationRejected("Invalid background subscription hold");
					await this.backgroundSubscription.continueAnyway(
						p.value as "anthropic" | "openai",
						read.backgroundSubscription!,
					);
					break;
				}
				case "funding-settings": {
					if (!this.sessions?.funding || !read.funding) throw new OperationRejected("Funding unavailable");
					await this.sessions.funding.configure(
						read.project?.id,
						read.funding.revision,
						p.value as Pick<
							typeof read.funding,
							"missionDefaultMicros" | "quickFixDefaultMicros" | "dailyMicros"
						>,
					);
					break;
				}
				case "funding-limits": {
					if (!this.sessions?.funding || !read.funding || typeof p.value !== "boolean")
						throw new OperationRejected("Funding unavailable");
					await this.sessions.funding.setEnabled(read.funding.revision, p.value);
					break;
				}
				case "fund-work": {
					const v = p.value as { sessionId: string; amountMicros: number };
					if (
						!this.sessions?.funding ||
						!read.funding ||
						!read.project ||
						!read.fundedWork.some((w) => w.id === v?.sessionId)
					)
						throw new OperationRejected("Work changed");
					const owner = this.sessions.fundingOwner(v.sessionId);
					if (owner.projectId !== read.project.id) throw new OperationRejected("Project changed");
					await this.sessions.funding.fund(owner, read.funding.revision, v.amountMicros);
					break;
				}
				case "continue-anyway": {
					if (
						!this.sessions ||
						typeof p.value !== "string" ||
						!read.project ||
						!read.fundedWork.some((w) => w.id === p.value && w.subscription)
					)
						throw new OperationRejected("Subscription hold changed");
					await this.sessions.forceSubscription(p.value, true);
					break;
				}
				case "scope":
					if (this.readOnly) throw new OperationRejected("Model scope is read only");
					try {
						modelScopeUpdate({ enabledModels: p.value, expectedHash: read.scope.scopeHash });
					} catch {
						throw new OperationRejected("Invalid chosen model list. Nothing changed.");
					}
					await this.models.updateScope(undefined, { enabledModels: p.value, expectedHash: read.scope.scopeHash });
					break;
				case "defaults":
					await this.models.saveDefaults(read.defaultsHash, p.value as ModelDefaults);
					break;
				case "work-profiles": {
					// A profile's model only needs a sign-in, so it is not checked against the chat model list.
					const problem = workProfilesProblem(p.value);
					if (problem) throw new OperationRejected(`${problem}. Nothing changed.`);
					await this.models.saveWorkProfiles(read.defaultsHash, p.value as WorkProfile[]);
					break;
				}
				case "project-model": {
					if (!read.project || (p.value !== null && !read.task.models.some((m) => m.id === p.value)))
						throw new OperationRejected("Choose an eligible project model. Nothing changed.");
					const current = this.projects.require(read.project.id);
					if (
						(current.workflowGeneration ?? null) !== read.project.generation ||
						(current.model ?? null) !== read.project.model
					)
						throw new OperationRejected("Project changed before saving. Nothing changed; read again.");
					// No await between checking this store generation and its synchronous model update.
					await this.projects.update(read.project.id, { model: (p.value as string | null) ?? "" });
					break;
				}
				case "failed-model": {
					const v = p.value as {
						sessionId: string;
						source: { source: "startup" | "outcome"; token: string };
						model: string;
						thinking: string;
					};
					if (!read.project || !this.sessions || !v || typeof v.sessionId !== "string")
						throw new OperationRejected("Invalid failed-chat selection. Nothing changed.");
					let current: Awaited<ReturnType<ModelControls["recovery"]>>;
					try {
						current = await this.recovery(read.project.id, v.sessionId);
					} catch {
						throw new OperationRejected("Failed work or eligible models changed. Nothing changed.");
					}
					if (
						JSON.stringify(current.source) !== JSON.stringify(v.source) ||
						!current.choices.models.some((m) => m.id === v.model && m.thinkingLevels?.includes(v.thinking))
					)
						throw new OperationRejected("Failed work or eligible models changed");
					await this.sessions.saveFailedModel(
						v.sessionId,
						v.source,
						{ model: v.model, thinking: v.thinking },
						{
							list: async (cwd) => {
								let choices: Awaited<ReturnType<ModelCatalog["listTaskModels"]>>;
								try {
									choices = await this.models.listTaskModels(cwd);
								} catch {
									throw new OperationRejected(
										"Eligible replacement models could not be read. Nothing changed.",
									);
								}
								if (!choices.models.some((m) => m.id === v.model && m.thinkingLevels?.includes(v.thinking)))
									throw new OperationRejected("Replacement model eligibility changed. Nothing changed.");
								return choices;
							},
						},
					);
					break;
				}
				case "sign-in": {
					if (!this.setup) throw new OperationRejected("Provider sign-in is unavailable. Nothing started.");
					let run: ReturnType<SetupService["start"]>;
					try {
						run = this.setup.start(p.value as SetupStartRequest);
					} catch (error) {
						if (error instanceof SetupError) throw new OperationRejected(error.message);
						throw error;
					}
					return { action: p.action, run };
				}
				case "cancel":
					if (!this.setup || typeof p.value !== "string")
						throw new OperationRejected("Invalid sign-in run. Nothing cancelled.");
					return { action: p.action, run: await this.setup.cancel(p.value) };
				case "logout":
					if (!this.setup || typeof p.value !== "string")
						throw new OperationRejected("Invalid provider. Nothing signed out.");
					await this.setup.logout(p.value);
					break;
				default:
					throw new OperationRejected("Unknown AI settings action. Nothing changed.");
			}
		} catch (error) {
			// Never persist SDK/provider error bodies, submitted codes or configuration contents.
			if (error instanceof OperationRejected) throw error;
			if (
				error instanceof ModelDefaultsRefused ||
				error instanceof FundingRefused ||
				error instanceof ModelScopeConflictError ||
				(error instanceof ModelScopeSettingsError && !error.mayHaveWritten) ||
				(error instanceof SetupError && error.status === 404) ||
				error instanceof Conflict ||
				error instanceof NotFound
			)
				throw new OperationRejected("AI settings changed or the action was refused. Nothing changed; read again.");
			throw new Error("Model settings action could not be confirmed. Check its receipt; do not resend.");
		}
		return { action: p.action, saved: true };
	}
}

export const modelOperations = (controls: ModelControls, journal: OperationJournal | undefined): ControlOperation => ({
	kind: MODEL_CONTROLS,
	unavailable: "Native model settings unavailable",
	outcomeUnknown: OUTCOME_UNKNOWN,
	admit: journal && ((op, firstEntry) => controls.admit(op, journal, firstEntry)),
});

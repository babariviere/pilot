import { resolve } from "node:path";
import type {
	DurableOperation,
	InsightsLifecycle,
	InsightsWorkspaceOwner,
	InsightsWorkspacePage,
	InsightsWorkspacePreflight,
	InsightsWorkspaceReservePayload,
	InsightsWorkspaceStatus,
	OperationHost,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { resolveInsightsInitialModel } from "./insights-defaults.ts";
import {
	initialInsightsSettings,
	resolveInsightsSettingsModel,
	validateInsightsSettings,
} from "./insights-settings.ts";
import type {
	InsightsWorkspaceAdmission,
	InsightsWorkspaceAuthority,
	InsightsWorkspaceStore,
} from "./insights-workspace-store.ts";
import type { ModelCatalog } from "./models.ts";
import {
	canonicalJSON,
	OperationConflict,
	type OperationJournal,
	OperationRejected,
	payloadHash,
} from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";

export function isInsightsWorkspaceOperation(kind: string): boolean {
	return [
		"insights-workspace-reserve",
		"insights-workspace-state",
		"insights-workspace-settings",
		"insights-workspace-lifecycle",
	].includes(kind);
}
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const uuid = (value: string) => {
	const h = payloadHash(value);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
function exact(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		keys.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))
	)
		throw new Conflict("Invalid exact workspace payload");
	return value as Record<string, unknown>;
}

export interface InsightsWorkspaceDependencies {
	home: string;
	host: OperationHost;
	projects: Pick<ProjectStore, "require">;
	models: Pick<ModelCatalog, "list">;
	store: InsightsWorkspaceStore;
	journal: OperationJournal;
	/** Metadata/storage readiness only. Never inventory source chats or wake workers. */
	legacyGuard(): void;
}

/** Native projections/reservation only. No grant, executor, history or scheduler effect. */
export class InsightsWorkspace {
	private readonly deps: InsightsWorkspaceDependencies;
	constructor(deps: InsightsWorkspaceDependencies) {
		this.deps = deps;
	}
	private authority(projectId: string): InsightsWorkspaceAuthority {
		const project = this.deps.projects.require(projectId);
		const home = resolve(this.deps.home);
		if (home !== this.deps.home || resolve(project.path) !== project.path)
			throw new Conflict("workspace_path_unavailable");
		const context = payloadHash(canonicalJSON([2, home, this.deps.host, project.id, project.path]));
		return {
			home,
			projectPath: project.path,
			owner: {
				schemaVersion: 2,
				workspaceId: uuid(`insights-workspace:${context}`),
				reportSessionId: uuid(`insights-workspace-report:${context}`),
				scheduleId: uuid(`insights-workspace-rule:${context}`),
				projectId,
				expectedHome: { ...this.deps.host },
				context,
			},
		};
	}
	private guard(a: InsightsWorkspaceAuthority): void {
		if (!same(a, this.authority(a.owner.projectId))) throw new Conflict("workspace_identity_changed");
	}
	private async freshGuard(): Promise<() => void> {
		const journalGuard = await this.deps.journal.legacyInsightsGuard();
		const guard = () => {
			journalGuard();
			this.deps.legacyGuard();
			if (this.deps.store.hasLegacyRecords()) throw new Conflict("legacy_transition_required");
		};
		guard();
		return guard;
	}
	/** Legacy entry points consult the same permanent owner fence before journal reservation. */
	assertLegacyAllowed(): void {
		if (this.deps.store.hasOwner(this.deps.home)) throw new Conflict("app_owned_workspace_reserved");
	}
	async status(): Promise<InsightsWorkspaceStatus> {
		try {
			const workspace = await this.deps.store.read(this.deps.home, (a) => this.guard(a));
			if (workspace) return { schemaVersion: 2, state: "present", reason: null, workspace };
			const guard = await this.freshGuard();
			// A new owner between the first read and journal I/O must not look absent.
			const current = await this.deps.store.read(this.deps.home, (a) => this.guard(a));
			guard();
			return { schemaVersion: 2, state: current ? "present" : "absent", reason: null, workspace: current };
		} catch (error) {
			const reason =
				error instanceof Conflict || error instanceof OperationConflict
					? error.message
					: "workspace_storage_unavailable";
			return {
				schemaVersion: 2,
				state: reason === "workspace_storage_unavailable" ? "unavailable" : "blocked",
				reason,
				workspace: null,
			};
		}
	}
	private async lease(): Promise<InsightsWorkspaceAdmission> {
		const snapshot = await this.deps.store.read(this.deps.home, (a) => this.guard(a));
		if (!snapshot) throw new Conflict("workspace_not_reserved");
		const authority = this.authority(snapshot.owner.projectId);
		if (!same(authority.owner, snapshot.owner)) throw new Conflict("workspace_identity_changed");
		return { authority, revision: snapshot.revision, revalidate: () => this.guard(authority) };
	}
	async preflight(projectId?: string, modelId?: string, thinking?: string): Promise<InsightsWorkspacePreflight> {
		const result: InsightsWorkspacePreflight = {
			schemaVersion: 2,
			state: "blocked",
			reason: null,
			projectId: projectId ?? null,
			model: null,
			payload: null,
			workspace: null,
			activationRequired: true,
		};
		const status = await this.status();
		if (status.workspace) {
			return {
				...result,
				projectId: status.workspace.owner.projectId,
				state: "existing",
				workspace: status.workspace,
			};
		}
		if (status.state !== "absent")
			return { ...result, state: status.state === "unavailable" ? "unavailable" : "blocked", reason: status.reason };
		if (!projectId) return { ...result, state: "choice_required", reason: "execution_project_required" };
		try {
			const a = this.authority(projectId);
			const fresh = await this.freshGuard();
			let catalog: Awaited<ReturnType<ModelCatalog["list"]>>;
			try {
				catalog = await this.deps.models.list(a.projectPath);
			} catch {
				return {
					...result,
					state: "unavailable",
					reason: "catalog_unavailable",
					model: { state: "unavailable", reason: "catalog_unavailable" },
				};
			}
			this.guard(a);
			fresh();
			if (this.deps.store.hasOwner(a.home)) throw new Conflict("workspace_changed_refresh");
			const model = modelId
				? resolveInsightsSettingsModel({ kind: "id", value: modelId }, catalog.models)
				: resolveInsightsInitialModel(catalog.models);
			if (model.state !== "available") return { ...result, model, reason: `model_${model.state}` };
			if (
				thinking !== undefined &&
				!catalog.models.find((m) => m.id === model.id)?.thinkingLevels?.includes(thinking)
			)
				throw new Conflict("thinking_unavailable");
			const payload: InsightsWorkspaceReservePayload = {
				schemaVersion: 2,
				owner: a.owner,
				model: model.id,
				...(thinking === undefined ? {} : { thinking }),
				settings: initialInsightsSettings(model.id),
				disclosure: "insights-workspace-reservation-v2",
			};
			return { ...result, state: "ready", model, payload };
		} catch (error) {
			return {
				...result,
				reason:
					error instanceof Conflict || error instanceof NotFound || error instanceof OperationConflict
						? error.message
						: "workspace_storage_unavailable",
			};
		}
	}
	async page(kind: "finding" | "report", cursor: number): Promise<InsightsWorkspacePage> {
		try {
			return await this.deps.store.page(await this.lease(), kind, cursor);
		} catch {
			return {
				schemaVersion: 2,
				state: "unavailable",
				reason: "workspace_records_unavailable",
				workspace: null,
				items: [],
				nextCursor: null,
			};
		}
	}
	async item(kind: "finding" | "report", key: string) {
		return this.deps.store.item(await this.lease(), kind, key);
	}
	async history(kind: "finding" | "report", key: string, cursor: number) {
		return this.deps.store.history(await this.lease(), kind, key, cursor);
	}
	async settings() {
		const lease = await this.lease();
		return {
			schemaVersion: 2,
			workspace: this.deps.store.current(lease.authority),
			record: await this.deps.store.settings(lease),
		};
	}

	/** Only native-gated durable operations reach here. Retained effects remain exact-receipt-only. */
	async admit(op: DurableOperation): Promise<unknown> {
		try {
			if (!isInsightsWorkspaceOperation(op.kind)) throw new Conflict("Unsupported workspace operation");
			const p = JSON.parse(op.payload) as Record<string, unknown>;
			const fields =
				op.kind === "insights-workspace-reserve"
					? ["schemaVersion", "owner", "model", "settings", "disclosure"]
					: op.kind === "insights-workspace-state"
						? ["schemaVersion", "owner", "expectedRevision", "state"]
						: op.kind === "insights-workspace-settings"
							? ["schemaVersion", "owner", "expectedRevision", "settings"]
							: ["schemaVersion", "owner", "key", "expectedRevision", "lifecycle"];
			exact(p, fields, op.kind === "insights-workspace-reserve" ? ["thinking"] : []);
			const owner = exact(p.owner, [
				"schemaVersion",
				"workspaceId",
				"reportSessionId",
				"scheduleId",
				"projectId",
				"expectedHome",
				"context",
			]) as unknown as InsightsWorkspaceOwner;
			if (p.schemaVersion !== 2 || owner.schemaVersion !== 2 || typeof owner.projectId !== "string")
				throw new Conflict("Invalid workspace version/owner");
			const a = this.authority(owner.projectId);
			if (
				!same(a.owner, owner) ||
				op.targetId !== owner.workspaceId ||
				!same(op.destination.daemonId, owner.expectedHome.daemonId) ||
				!same(op.destination.lineageId, owner.expectedHome.lineageId)
			)
				throw new Conflict("workspace_identity_changed");
			const guard = () => this.guard(a);
			const prior = await this.deps.store.exactReceipt(a, op, guard);
			if (prior) return prior;
			if (op.kind === "insights-workspace-reserve") {
				const preview = await this.preflight(owner.projectId, p.model as string, p.thinking as string | undefined);
				if (preview.state !== "ready" || !same(preview.payload, p))
					throw new Conflict(preview.reason ?? "workspace_preflight_changed");
				const fresh = await this.freshGuard();
				return await this.deps.store.reserve(a, op, p.model as string, () => {
					guard();
					fresh();
				});
			}
			if (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number) < 1)
				throw new Conflict("Invalid expected revision");
			const lease = await this.lease();
			if (!same(lease.authority, a)) throw new Conflict("workspace_owner_changed");
			const expectedRevision = p.expectedRevision as number;
			if (op.kind === "insights-workspace-state") {
				if (p.state !== "paused" && p.state !== "revoked") throw new Conflict("Invalid workspace state");
				return await this.deps.store.mutate(lease, op, { kind: "state", state: p.state, expectedRevision });
			}
			if (op.kind === "insights-workspace-settings") {
				const settings = validateInsightsSettings(p.settings);
				const catalog = await this.deps.models.list(a.projectPath);
				guard();
				const model = resolveInsightsSettingsModel(settings.requestedModel, catalog.models);
				if (model.state !== "available") throw new Conflict(`model_${model.state}`);
				for (const id of settings.scope.projects === "admitted" ? [] : settings.scope.projects)
					this.deps.projects.require(id);
				return await this.deps.store.mutate(lease, op, {
					kind: "settings",
					settings,
					model: model.id,
					expectedRevision,
				});
			}
			return await this.deps.store.mutate(lease, op, {
				kind: "lifecycle",
				key: p.key as string,
				lifecycle: p.lifecycle as InsightsLifecycle,
				expectedRevision,
			});
		} catch (error) {
			if (this.deps.store.committed(op))
				throw new Error("Workspace outcome requires exact receipt reconciliation", { cause: error });
			if (
				error instanceof Conflict ||
				error instanceof NotFound ||
				error instanceof OperationConflict ||
				error instanceof SyntaxError
			)
				throw new OperationRejected(error.message);
			throw error; // Durability/lost ACK is Pending, never a false no-effect rejection.
		}
	}
}

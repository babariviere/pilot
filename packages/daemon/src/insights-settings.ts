/** Desired configuration in the existing backlog database, never an activation or permission store. */
import type {
	InsightsInitialModelResolution,
	InsightsReviewSettings,
	InsightsSettingsRecord,
	ModelOption,
	ScheduleRecurrence,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { InsightsAdmission } from "./insights-admission.ts";
import type { InsightsDb } from "./insights-backlog.ts";
import { INSIGHTS_INITIAL_DEFAULTS } from "./insights-defaults.ts";
import { canonicalJSON, OperationRejected, payloadHash } from "./operation-journal.ts";
import { validateRecurrence } from "./schedule-recurrence.ts";

export const INSIGHTS_SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS insights_settings (
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 session_id TEXT PRIMARY KEY, binding TEXT NOT NULL, revision INTEGER NOT NULL,
 settings TEXT NOT NULL, model TEXT NOT NULL
);
`;

function exact(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
	)
		throw new Conflict("Invalid Insights settings fields");
	return value as Record<string, unknown>;
}
function ids(value: unknown, uuid = false): string[] {
	const pattern = uuid ? /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu : /^[A-Za-z0-9_-]{1,128}$/u;
	if (
		!Array.isArray(value) ||
		value.length > 100 ||
		!value.every((v) => typeof v === "string" && pattern.test(v)) ||
		new Set(value).size !== value.length
	)
		throw new Conflict("Invalid Insights source selection");
	return [...value];
}

export function validateInsightsSettings(value: unknown): InsightsReviewSettings {
	const s = exact(value, ["recurrence", "requestedModel", "scope", "bounds", "budget"]);
	const recurrence = exact(s.recurrence, ["every", "weekday", "time", "timeZone"]);
	if (recurrence.every !== "week") throw new Conflict("Insights requires weekly recurrence");
	try {
		validateRecurrence(recurrence);
	} catch {
		throw new Conflict("Invalid Insights recurrence");
	}
	const model = exact(s.requestedModel, ["kind", "value"]);
	if (
		!["id", "name"].includes(model.kind as string) ||
		typeof model.value !== "string" ||
		!model.value.trim() ||
		model.value.length > 512
	)
		throw new Conflict("Invalid requested model");
	const scope = exact(s.scope, [
		"host",
		"projects",
		"includeArchived",
		"excludeProjects",
		"excludeSessions",
		"sourceAccess",
		"coverage",
	]);
	if (
		scope.host !== "local" ||
		scope.sourceAccess !== "read_only" ||
		scope.coverage !== "partial" ||
		typeof scope.includeArchived !== "boolean"
	)
		throw new Conflict("Invalid Insights source scope");
	if (scope.projects !== "admitted") ids(scope.projects);
	ids(scope.excludeProjects);
	ids(scope.excludeSessions, true);
	const bounds = exact(s.bounds, ["inventoryPages", "historyPages", "entriesPerPage"]);
	if (
		!Object.values(bounds).every((v) => Number.isSafeInteger(v) && (v as number) >= 1) ||
		(bounds.inventoryPages as number) > 4 ||
		(bounds.historyPages as number) < 2 ||
		(bounds.historyPages as number) > 8 ||
		(bounds.entriesPerPage as number) > 20
	)
		throw new Conflict("Invalid Insights coverage bounds");
	const budget = exact(s.budget, ["usd", "period", "enforcement", "basis"]);
	if (
		typeof budget.usd !== "number" ||
		!Number.isFinite(budget.usd) ||
		budget.usd <= 0 ||
		budget.usd > 10000 ||
		!["report", "month"].includes(budget.period as string) ||
		budget.enforcement !== "advisory" ||
		!["initial_assumption", "user_choice"].includes(budget.basis as string)
	)
		throw new Conflict("Invalid advisory Insights budget");
	return structuredClone(value) as InsightsReviewSettings;
}

export function initialInsightsSettings(
	model: string,
	recurrence: Readonly<ScheduleRecurrence> = INSIGHTS_INITIAL_DEFAULTS.recurrence,
): InsightsReviewSettings {
	return {
		recurrence: structuredClone(recurrence),
		requestedModel: { kind: "id", value: model },
		scope: { ...INSIGHTS_INITIAL_DEFAULTS.scope, excludeProjects: [], excludeSessions: [] },
		bounds: { ...INSIGHTS_INITIAL_DEFAULTS.bounds },
		budget: { ...INSIGHTS_INITIAL_DEFAULTS.budget },
	};
}

export function resolveInsightsSettingsModel(
	request: InsightsReviewSettings["requestedModel"],
	models: readonly ModelOption[],
): InsightsInitialModelResolution {
	const name = (s: string) => s.trim().replace(/\s+/gu, " ").toLowerCase();
	const ids = [
		...new Set(
			models
				.filter((m) => (request.kind === "id" ? m.id === request.value : name(m.name) === name(request.value)))
				.map((m) => m.id),
		),
	].sort();
	return ids.length === 1
		? { state: "available", id: ids[0]! }
		: ids.length
			? { state: "ambiguous", ids }
			: { state: "unavailable", reason: "not_found" };
}

/** A restriction of existing local discovery, never authority to connect or inspect a new host. */
export function insightsSourceAllowed(
	settings: InsightsReviewSettings,
	source: { id: string; projectId?: string | null; archivedAt?: string | number | null },
): boolean {
	const scope = settings.scope;
	return (
		!scope.excludeSessions.includes(source.id) &&
		(source.archivedAt == null || scope.includeArchived) &&
		(!source.projectId || !scope.excludeProjects.includes(source.projectId)) &&
		(scope.projects === "admitted" || (!!source.projectId && scope.projects.includes(source.projectId)))
	);
}

export class InsightsSettings {
	private readonly db: Pick<InsightsDb, "one" | "all" | "run" | "transaction" | "durable" | "validateMission">;
	constructor(db: Pick<InsightsDb, "one" | "all" | "run" | "transaction" | "durable" | "validateMission">) {
		this.db = db;
	}
	private binding(admission: InsightsAdmission): string {
		admission.revalidate();
		this.db.validateMission(admission.binding.missionId, admission.binding.projectId);
		return payloadHash(canonicalJSON(admission.binding));
	}
	current(admission: InsightsAdmission): InsightsSettingsRecord | null {
		const binding = this.binding(admission);
		const row = this.db.one("SELECT * FROM insights_settings WHERE session_id=?", admission.binding.reportSessionId);
		if (!row) return null;
		if (row.binding !== binding) throw new Conflict("Insights settings binding changed");
		return {
			revision: Number(row.revision),
			settings: validateInsightsSettings(JSON.parse(String(row.settings))),
			model: String(row.model),
		};
	}
	async read(admission: InsightsAdmission): Promise<InsightsSettingsRecord | null> {
		const result = this.current(admission);
		await this.db.durable();
		this.binding(admission);
		return result;
	}
	/** Configuration may not race a preparing, placed or uncertain review. */
	assertIdle(admission: InsightsAdmission): void {
		this.binding(admission);
		if (
			this.db.one(
				"SELECT 1 FROM insights_runs WHERE session_id=? AND state IN ('preparing','ready','sent','unknown','interrupted')",
				admission.binding.reportSessionId,
			)
		)
			throw new Conflict("Review is active or uncertain");
	}
	/** Lookup only. A database commit followed by a lost journal ACK never repeats the save. */
	async receipt(
		admission: InsightsAdmission,
		operationId: string,
		request: unknown,
	): Promise<InsightsSettingsRecord | null> {
		this.current(admission);
		const row = this.db.one(
			"SELECT request_hash,result FROM insights_operations WHERE mission_id=? AND session_id=? AND operation_id=?",
			admission.binding.missionId,
			admission.binding.reportSessionId,
			operationId,
		);
		if (row && row.request_hash !== payloadHash(canonicalJSON(request)))
			throw new Conflict("Insights operation identity changed");
		await this.db.durable();
		this.binding(admission);
		return row ? (JSON.parse(String(row.result)) as InsightsSettingsRecord) : null;
	}
	async save(
		admission: InsightsAdmission,
		operationId: string,
		request: unknown,
		expectedRevision: number,
		settings: InsightsReviewSettings,
		model: string,
		beforeWrite: () => void = () => {},
	): Promise<InsightsSettingsRecord> {
		settings = validateInsightsSettings(settings);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new Conflict("Invalid settings revision");
		let result: InsightsSettingsRecord;
		try {
			result = this.db.transaction(() => {
				const binding = this.binding(admission);
				const oldReceipt = this.db.one(
					"SELECT request_hash,result FROM insights_operations WHERE mission_id=? AND session_id=? AND operation_id=?",
					admission.binding.missionId,
					admission.binding.reportSessionId,
					operationId,
				);
				const digest = payloadHash(canonicalJSON(request));
				if (oldReceipt) {
					if (oldReceipt.request_hash !== digest) throw new Conflict("Insights operation identity changed");
					return JSON.parse(String(oldReceipt.result)) as InsightsSettingsRecord;
				}
				beforeWrite();
				if (
					this.db.one(
						"SELECT 1 FROM insights_runs WHERE session_id=? AND state IN ('preparing','ready','sent','unknown')",
						admission.binding.reportSessionId,
					)
				)
					throw new Conflict("Review is active or uncertain; settings were not changed");
				if ((this.current(admission)?.revision ?? 0) !== expectedRevision)
					throw new Conflict("Insights settings revision changed");
				const result: InsightsSettingsRecord = { revision: expectedRevision + 1, settings, model };
				this.db.run(
					"INSERT INTO insights_settings VALUES (?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,settings=excluded.settings,model=excluded.model",
					admission.binding.missionId,
					admission.binding.reportSessionId,
					binding,
					result.revision,
					JSON.stringify(settings),
					model,
				);
				this.db.run(
					"INSERT INTO insights_operations VALUES (?,?,?,?,?)",
					admission.binding.missionId,
					admission.binding.reportSessionId,
					operationId,
					digest,
					JSON.stringify(result),
				);
				return result;
			});
		} catch (error) {
			// The synchronous transaction rolled back. Only these refusals certify no settings write.
			if (error instanceof Conflict) throw new OperationRejected(error.message);
			throw error;
		}
		await this.db.durable();
		this.binding(admission);
		return result;
	}
	assertDispatch(admission: InsightsAdmission, revision?: number): InsightsSettingsRecord | null {
		const current = this.current(admission);
		if ((current?.revision ?? 0) !== (revision ?? 0))
			throw new Conflict("Insights settings require explicit activation; never replay this occurrence");
		return current;
	}
}

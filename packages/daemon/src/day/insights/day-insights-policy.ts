import type { DayInsightsSettings, InsightsReviewSettings } from "@pilot/protocol";
import { Conflict } from "../../runtime/contracts/errors.ts";
import { INSIGHTS_INITIAL_DEFAULTS, INSIGHTS_THINKING_LEVELS } from "../../insights/insights-defaults.ts";

export function dayInsightsExact(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		keys.some((k) => !Object.hasOwn(value, k)) ||
		Object.keys(value).some((k) => !keys.includes(k) && !optional.includes(k))
	)
		throw new Conflict("day_insights_invalid_fields");
	return value as Record<string, unknown>;
}
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(v);
function ids(v: unknown): string[] {
	if (!Array.isArray(v) || v.length > 256 || !v.every(id) || new Set(v).size !== v.length)
		throw new Conflict("day_insights_invalid_source_ids");
	return v;
}
export function validateDayInsightsSettings(value: unknown): DayInsightsSettings {
	const s = dayInsightsExact(value, ["model", "source", "weekly", "allowance"], ["thinking"]);
	if (
		typeof s.model !== "string" ||
		!s.model.trim() ||
		s.model.length > 512 ||
		(s.thinking !== undefined && !INSIGHTS_THINKING_LEVELS.includes(String(s.thinking)))
	)
		throw new Conflict("day_insights_invalid_model");
	const source = dayInsightsExact(s.source, ["projects", "excludeProjects", "excludeSessions"]);
	const projects = ids(source.projects);
	ids(source.excludeProjects);
	ids(source.excludeSessions);
	if (!projects.length || projects.every((p) => (source.excludeProjects as string[]).includes(p)))
		throw new Conflict("day_insights_source_project_required");
	if (s.weekly !== null) {
		const w = dayInsightsExact(s.weekly, ["day", "time", "timezone"]);
		if (
			!Number.isInteger(w.day) ||
			Number(w.day) < 0 ||
			Number(w.day) > 6 ||
			typeof w.time !== "string" ||
			!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(w.time) ||
			typeof w.timezone !== "string" ||
			w.timezone.length > 100 ||
			(w.timezone !== "UTC" && !w.timezone.includes("/"))
		)
			throw new Conflict("day_insights_invalid_weekly");
		try {
			new Intl.DateTimeFormat("en", { timeZone: w.timezone });
		} catch {
			throw new Conflict("day_insights_invalid_timezone");
		}
	}
	const a = dayInsightsExact(s.allowance, ["perReportMicros", "monthlyMicros", "basis"]);
	if (
		a.basis !== "catalog_estimate" ||
		![a.perReportMicros, a.monthlyMicros].every((v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0)
	)
		throw new Conflict("day_insights_invalid_allowance");
	return structuredClone(value) as DayInsightsSettings;
}

/** Eligibility uses archive time only. Message timestamps are deliberately not accepted. */
export function dayInsightsSourceAllowed(
	settings: DayInsightsSettings,
	source: { id: string; projectId?: string | null; archivedAt?: string | number | null },
	now: number,
): boolean {
	const s = settings.source;
	if (
		!Number.isFinite(now) ||
		!source.projectId ||
		!s.projects.includes(source.projectId) ||
		s.excludeProjects.includes(source.projectId) ||
		s.excludeSessions.includes(source.id)
	)
		return false;
	if (source.archivedAt == null) return true;
	const at = typeof source.archivedAt === "number" ? source.archivedAt : Date.parse(source.archivedAt);
	return Number.isFinite(at) && at <= now && at >= now - 86_400_000;
}

/** Reader compatibility only. Provider admission always uses the separate AND ledger. */
export function dayInsightsReaderSettings(s: DayInsightsSettings): InsightsReviewSettings {
	return {
		recurrence: s.weekly
			? { every: "week", weekday: s.weekly.day || 7, time: s.weekly.time, timeZone: s.weekly.timezone }
			: { every: "week", weekday: 7, time: "00:00", timeZone: "UTC" },
		requestedModel: { kind: "id", value: s.model },
		scope: {
			host: "local",
			projects: s.source.projects,
			excludeProjects: s.source.excludeProjects,
			excludeSessions: s.source.excludeSessions,
			includeArchived: true,
			sourceAccess: "read_only",
			coverage: "partial",
		},
		bounds: { ...INSIGHTS_INITIAL_DEFAULTS.bounds },
		budget: {
			usd: Math.min(10000, s.allowance.perReportMicros / 1000000),
			period: "report",
			enforcement: "advisory",
			basis: "user_choice",
		},
	};
}

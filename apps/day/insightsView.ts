import { signal } from "nsh";

export const insightsOpen = signal(false);
export const insightsTab = signal<"reports" | "findings" | "settings">("reports");
export const insightsSelection = signal<{ kind: "reports" | "findings"; key: string } | null>(null);
export const insightsReview = signal<InsightsReview | null>(null);
export const insightsDraft = signal<InsightsDraft | null>(null);

export type InsightsSettings = {
	projectId: string;
	model: string;
	sourceProjectIds: string[];
	excludeSessionIds: string[];
	perReportUsd: number;
	monthlyUsd: number;
	schedule: { weekday: number; time: string; timeZone: string } | null;
};
export type InsightsDraft = Omit<InsightsSettings, "perReportUsd" | "monthlyUsd"> & {
	perReportUsd: string;
	monthlyUsd: string;
	binding: string;
};

export type InsightsItem = {
	key: string;
	title: string;
	revision: number;
	updatedAt: number;
	lifecycle?: string | null;
};
export type InsightsEvidence = {
	sessionId: string;
	label: string;
	excerpt?: string;
	position?: string;
};
export type InsightsDetail = InsightsItem & {
	markdown?: string;
	evidence?: InsightsEvidence[];
	gaps?: string[];
	coverage?: string;
	progress?: { sources: number; positionedSources: number; unavailableSources: number };
	benefit?: string;
	projectId?: string;
	proposal?: string;
	findingKeys?: string[];
	legacy?: boolean;
};
export type InsightsLegacy = {
	state: "empty" | "available" | "unavailable";
	reports: InsightsDetail[];
	findings: InsightsDetail[];
	more?: boolean;
	nextCursor?: string | null;
};
export type InsightsState = "off" | "enabled" | "paused" | "blocked" | "running";
export type InsightsModel = { id: string; name: string; provider: string };
export type InsightsSnapshot = {
	binding: string;
	draftBinding: string;
	state: InsightsState;
	reason?: string;
	canPause?: boolean;
	canRun?: boolean;
	applied: InsightsSettings | null;
	saved: InsightsSettings | null;
	projects: { id: string; name: string }[];
	models: InsightsModel[];
	nextAt?: number | null;
	allowance?: { reportRemainingUsd: number; monthRemainingUsd: number };
	reports: { items: InsightsItem[]; nextCursor: number | null; unavailable?: boolean };
	findings: { items: InsightsItem[]; nextCursor: number | null; unavailable?: boolean };
	legacy: InsightsLegacy;
};
export type InsightsAction = "setup" | "save" | "apply" | "run" | "pause" | "resume" | "verify" | "ship";
export type InsightsIntent =
	| { action: "setup" | "save" | "apply"; settings: InsightsSettings }
	| { action: "run" | "pause" | "resume" }
	| { action: "verify" | "ship"; key: string; revision: number };
export type InsightsReview = {
	intent: InsightsIntent;
	label: string;
	lines: string[];
	token: string;
};
export interface InsightsControls {
	snapshot(): InsightsSnapshot | null;
	busy(): boolean;
	fresh(): boolean;
	models(projectId: string): Promise<InsightsModel[] | null>;
	message(): string;
	pending(): { id: string; checking: boolean }[];
	read(): Promise<void>;
	more(kind: "reports" | "findings"): Promise<void>;
	moreHistory(): Promise<void>;
	item(kind: "reports" | "findings", key: string): Promise<InsightsDetail | null>;
	prepare(binding: string, intent: InsightsIntent): Promise<InsightsReview | null>;
	confirm(token: string): Promise<boolean>;
	check(id: string): Promise<void>;
}
export function closeInsights() {
	insightsOpen.set(false);
	insightsReview.set(null);
}

/** View-local text only: no review token, execution state, or pending action is restored. */
export function savedInsightsDraft(): string {
	const draft = insightsDraft();
	return draft ? JSON.stringify(draft) : "";
}

export function restoreInsightsDraft(text = "") {
	closeInsights();
	insightsTab.set("reports");
	insightsSelection.set(null);
	insightsDraft.set(null);
	if (!text || text.length > 20_000) return;
	try {
		const d = JSON.parse(text) as Partial<InsightsDraft>;
		if (![d.binding, d.projectId, d.model, d.perReportUsd, d.monthlyUsd].every((v) => typeof v === "string")) return;
		if (
			!d.sourceProjectIds?.every?.((v) => typeof v === "string") ||
			!d.excludeSessionIds?.every?.((v) => typeof v === "string")
		)
			return;
		if (
			d.schedule !== null &&
			(!d.schedule ||
				!Number.isInteger(d.schedule.weekday) ||
				typeof d.schedule.time !== "string" ||
				typeof d.schedule.timeZone !== "string")
		)
			return;
		insightsDraft.set(d as InsightsDraft);
	} catch {
		// A malformed local draft is never used as a settings intent.
	}
}

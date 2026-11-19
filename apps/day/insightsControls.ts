import { signal } from "nsh";
import { AutoCheck } from "./autoCheck";
import { call } from "./bridge";
import { autoRead, staleLine } from "./freshness";
import type {
	InsightsControls,
	InsightsDetail,
	InsightsIntent,
	InsightsLegacy,
	InsightsModel,
	InsightsReview,
	InsightsSnapshot,
} from "./insightsView";

type Kind = "reports" | "findings";
type Page = InsightsSnapshot[Kind];
const MAX_KEPT_ITEMS = 120;

function keepRows<T extends { key: string }>(latest: T[], previous: T[]): T[] {
	const keys = new Set(latest.map((item) => item.key));
	return [...latest, ...previous.filter((item) => !keys.has(item.key))].slice(0, MAX_KEPT_ITEMS);
}

export type ConnectedInsights = InsightsControls & { invalidate(): void; focus(): void; dispose(): void };

export function connectInsights(window: string): ConnectedInsights {
	const snapshot = signal<InsightsSnapshot | null>(null);
	const busy = signal(false);
	const fresh = signal(false);
	const message = signal("");
	const operations = signal<string[]>([]);
	const checkGeneration = signal(0);
	let disposed = false;
	let invalidation = 0;
	let readGeneration = 0;
	let gate = 0;
	let pauseToken: string | null = null;
	let reached = false;
	const first = new Map<Kind, Page>();
	let legacyFirst: InsightsLegacy | null = null;

	const checker = new AutoCheck(
		async (id) => {
			if (!disposed) await check(id);
		},
		() => checkGeneration.update((n) => n + 1),
	);

	function publishPending(value: Record<string, unknown>) {
		const pending = Array.isArray(value.pending)
			? value.pending.flatMap((p) => (typeof p?.id === "string" ? [p.id as string] : []))
			: [];
		operations.set(pending);
		checker.watch(pending);
		checkGeneration.update((n) => n + 1);
	}

	async function read() {
		reached = true;
		const generation = ++readGeneration;
		const rev = invalidation;
		const r = await call<InsightsSnapshot | null>(window, "day.insights.read", {});
		if (disposed || generation !== readGeneration || rev !== invalidation) return false;
		if (!r.ok || !r.snapshot) {
			fresh.set(false);
			if (!snapshot()) message.set("Insights could not be read yet.");
			return false;
		}
		publishPending(r.value);
		const next = r.snapshot;
		const old = snapshot();
		const sameProfile = old && old.draftBinding === next.draftBinding;
		for (const kind of ["reports", "findings"] as const) {
			const page = next[kind];
			const prior = first.get(kind);
			if (sameProfile && page.unavailable && old[kind].items.length) {
				next[kind] = { ...old[kind], unavailable: true };
			} else {
				first.set(kind, page);
				if (sameProfile && prior && !page.unavailable && page.nextCursor !== null) {
					const stable =
						page.items.map((item) => item.key).join("\n") === prior.items.map((item) => item.key).join("\n");
					next[kind] = {
						...page,
						nextCursor: stable ? old[kind].nextCursor : page.nextCursor,
						items: keepRows(page.items, old[kind].items),
					};
				}
			}
		}
		const legacy = next.legacy;
		if (sameProfile && legacy.state === "unavailable" && old.legacy.state === "available") {
			next.legacy = { ...old.legacy, state: "unavailable" };
		} else {
			if (sameProfile && legacy.state === "available" && old.legacy.state === "available" && legacy.nextCursor) {
				next.legacy = {
					...legacy,
					nextCursor: legacyFirst?.nextCursor === legacy.nextCursor ? old.legacy.nextCursor : legacy.nextCursor,
					reports: keepRows(legacy.reports, old.legacy.reports),
					findings: keepRows(legacy.findings, old.legacy.findings),
				};
			}
			legacyFirst = legacy;
		}
		snapshot.set(next);
		if (message() === "Insights could not be read yet.") message.set("");
		fresh.set(true);
		return true;
	}

	const automatic = autoRead(async () => {
		if (!reached || disposed) return "current";
		const epoch = invalidation;
		return (await read()) ? "current" : epoch === invalidation ? "failed" : "raced";
	}, null);

	async function check(id: string) {
		if (!operations().includes(id) || disposed) return;
		const r = await call<InsightsSnapshot | null>(window, "day.insights.check", { id });
		if (disposed) return;
		if (r.ok) {
			publishPending(r.value);
			await read();
		}
	}

	return {
		snapshot,
		fresh: () => fresh() && !disposed,
		busy,
		models: async (projectId) => {
			const binding = snapshot()?.binding;
			if (!binding || disposed) return null;
			const r = await call<{ projectId: string; models: InsightsModel[] } | null>(window, "day.insights.models", {
				binding,
				projectId,
			});
			return r.ok && !disposed && snapshot()?.binding === binding && r.snapshot?.projectId === projectId
				? r.snapshot.models
				: null;
		},
		message: () => message() || (automatic.stale() ? staleLine(automatic.readAt() ?? 0) : ""),
		pending: () => {
			checkGeneration();
			return operations().map((id) => ({ id, checking: checker.checking(id) }));
		},
		read: async () => {
			if (await read()) automatic.current();
			else if (!disposed) automatic.behind();
		},
		more: async (kind: Kind) => {
			const s = snapshot();
			const cursor = s?.[kind].nextCursor;
			if (!s || cursor == null || busy() || disposed) return;
			busy.set(true);
			try {
				const r = await call<Page | null>(window, "day.insights.list", { kind, cursor, binding: s.binding });
				if (snapshot() !== s || disposed) return;
				if (!r.ok || !r.snapshot || r.snapshot.unavailable) {
					message.set("The next page could not be read. The first page is kept.");
					return;
				}
				const byKey = new Map(s[kind].items.map((item) => [item.key, item]));
				for (const item of r.snapshot.items) byKey.set(item.key, item);
				snapshot.set({ ...s, [kind]: { ...r.snapshot, items: [...byKey.values()] } });
			} finally {
				busy.set(false);
			}
		},
		moreHistory: async () => {
			const s = snapshot();
			if (!s?.legacy.nextCursor || busy() || disposed) return;
			busy.set(true);
			try {
				const r = await call<InsightsLegacy | null>(window, "day.insights.history", {
					binding: s.binding,
					cursor: s.legacy.nextCursor,
				});
				if (snapshot() !== s || disposed) return;
				if (!r.ok || !r.snapshot || r.snapshot.state === "unavailable") {
					message.set("The next page of earlier history could not be read. What was already read is kept.");
					return;
				}
				const legacy = r.snapshot;
				const merge = (kind: Kind) =>
					Array.from(new Map([...s.legacy[kind], ...legacy[kind]].map((item) => [item.key, item])).values());
				snapshot.set({ ...s, legacy: { ...legacy, reports: merge("reports"), findings: merge("findings") } });
			} finally {
				busy.set(false);
			}
		},
		item: async (kind, key) => {
			const binding = snapshot()?.binding;
			if (!binding || disposed) return null;
			const r = await call<InsightsDetail | null>(window, "day.insights.item", { kind, key, binding });
			return r.ok && !disposed && snapshot()?.binding === binding ? r.snapshot : null;
		},
		prepare: async (binding: string, intent: InsightsIntent) => {
			const pause = intent.action === "pause" && snapshot()?.canPause === true;
			if (!fresh() || busy() || disposed || (!pause && operations().length) || snapshot()?.binding !== binding)
				return null;
			busy.set(true);
			pauseToken = null;
			const request = ++gate;
			message.set("");
			try {
				const r = await call<InsightsReview | null>(window, "day.insights.prepare", { binding, intent });
				if (disposed || request !== gate) return null;
				if (r.ok && r.snapshot) {
					if (pause && r.snapshot.intent.action === "pause") pauseToken = r.snapshot.token;
					return r.snapshot;
				}
				message.set(
					r.ok && typeof r.value.reason === "string"
						? r.value.reason
						: "Pilot could not review this action. Nothing changed.",
				);
				return null;
			} finally {
				busy.set(false);
			}
		},
		confirm: async (token) => {
			const pause = pauseToken === token && snapshot()?.canPause === true;
			if (!fresh() || busy() || disposed || (!pause && operations().length)) return false;
			pauseToken = null;
			busy.set(true);
			readGeneration++;
			try {
				const r = await call<InsightsSnapshot | null>(window, "day.insights.confirm", { token });
				if (disposed) return false;
				if (!r.ok) {
					fresh.set(false);
					message.set(
						r.refusal === "stale"
							? "The reviewed values changed. Review again; your draft is kept."
							: "The outcome could not be confirmed. Pilot will look for its saved receipt without sending again.",
					);
					await read();
					return false;
				}
				publishPending(r.value);
				const outcome = r.value.outcome as { state?: string; receipt?: { reason?: string } } | undefined;
				const accepted = outcome?.state === "accepted";
				message.set(
					accepted || operations().length
						? ""
						: (outcome?.receipt?.reason ?? "Pilot did not confirm this change."),
				);
				await read();
				return accepted;
			} finally {
				busy.set(false);
			}
		},
		check,
		invalidate() {
			if (disposed || !reached) return;
			invalidation++;
			automatic.behind();
		},
		focus() {
			if (reached && !disposed) automatic.focus();
		},
		dispose() {
			disposed = true;
			gate++;
			automatic.dispose();
			checker.close();
		},
	};
}

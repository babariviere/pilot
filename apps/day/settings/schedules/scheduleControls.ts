// Window-local mirror. Native owns addresses, authority, operation IDs and receipts.
import { signal } from "nsh";
import { AutoCheck } from "../../sources/autoCheck";
import { call } from "../../sources/bridge";
import { scheduleDraft } from "./scheduleDraft";
export type ScheduleRow = {
	id: string;
	revision: number;
	title: string;
	projectId?: string;
	trigger: string;
	state: string;
	atLocal: string;
	expiresLocal: string;
	at?: number;
	timeZone?: string;
	paused?: boolean;
	held: boolean;
	target: { kind: string; sessionId?: string; message?: string; spawn?: { message: string } };
	recurrence?: {
		every: string;
		time: string;
		timeZone: string;
		weekdays?: number[];
		weekday?: number;
		dayOfMonth?: number;
	};
	error?: string;
	notice?: { outcome: string; error?: string };
	insightsEnableOperationId?: string;
	runs?: {
		due: number;
		at: number;
		admittedAt?: number;
		outcome: string;
		late?: boolean;
		count?: number;
		error?: string;
	}[];
};
export type ScheduleSnapshot = {
	draftId: string;
	version: number;
	binding: string;
	page: number;
	enabled: boolean;
	paused: boolean;
	more: boolean;
	schedules: ScheduleRow[];
	projects: { id: string; name: string }[];
	targets: { id: string; title: string; projectId: string; missionId?: string; coordinator?: boolean }[];
	targetsMore: boolean;
	projectsMore?: boolean;
	history: {
		more: boolean;
		items: {
			sessionId: string;
			title: string;
			projectId?: string;
			attempts: number;
			stopped: boolean;
			attention?: string;
			runs?: { name: string; state: string; excerpt: string }[];
			flow?: unknown;
			flowAccounting?: { state: string; currentSessionId: string; unfinishedVisits: number };
			invalidFlow?: boolean;
		}[];
	};
};
export type ScheduleOperation = {
	operationId: string;
	draftId?: string;
	supersedesDraftId?: string;
	pending: boolean;
	state: string;
};
export function submittedScheduleDraft(operations: ScheduleOperation[], id: string): boolean {
	return !!id && operations.some((o) => o.draftId === id || o.supersedesDraftId === id);
}
export interface ScheduleControls {
	blocked(): boolean;
	begin(): void;
	snapshot(): ScheduleSnapshot | null;
	busy(): boolean;
	message(): string;
	operations(): ScheduleOperation[];
	read(page?: number): Promise<void>;
	write(action: "create" | "update" | "cancel", value: unknown, binding: string, draftId?: string): Promise<boolean>;
	check(id: string): Promise<void>;
	/** Stops the automatic lookups. */
	close?(): void;
}
export function connectedScheduleControls(window: string): ScheduleControls {
	const snapshot = signal<ScheduleSnapshot | null>(null),
		busy = signal(false),
		message = signal(""),
		operations = signal<ScheduleOperation[]>([]);
	const blocked = signal(false);
	let lost = false;
	// Unknown saves are looked up by their receipt automatically; Check is the fallback.
	const auto = new AutoCheck(
		(operationId) => controls.check(operationId),
		() => {},
	);
	function receive(r: { snapshot: ScheduleSnapshot | null; value: Record<string, unknown> }) {
		if (r.snapshot) snapshot.set(r.snapshot);
		else if (snapshot()) snapshot.set({ ...snapshot()!, binding: "" });
		operations.set((r.value.operations ?? []) as ScheduleOperation[]);
		auto.watch(
			operations()
				.filter((o) => o.pending)
				.map((o) => o.operationId),
		);
	}
	async function read(page = snapshot()?.page ?? 0) {
		if (busy()) return;
		busy.set(true);
		try {
			const d = scheduleDraft();
			const r = await call<ScheduleSnapshot>(window, "day.schedules.read", {
				page,
				editId: d?.id || null,
				targetId: d?.target || null,
				projectId: d?.project || null,
			});
			if (r.ok) {
				receive(r);
				message.set("");
			} else {
				if (snapshot()) snapshot.set({ ...snapshot()!, binding: "" });
				message.set("Schedules could not be read. Kept data may be out of date; read again before editing.");
			}
		} finally {
			busy.set(false);
		}
	}
	const controls: ScheduleControls = {
		blocked,
		begin() {
			if (!lost && !operations().some((o) => o.pending)) blocked.set(false);
		},
		snapshot,
		busy,
		message,
		operations,
		read,
		async write(action, value, binding, draftId = snapshot()?.draftId) {
			const s = snapshot();
			if (
				!s ||
				!draftId ||
				draftId !== s.draftId ||
				submittedScheduleDraft(operations(), draftId) ||
				busy() ||
				!binding ||
				binding !== s.binding ||
				blocked() ||
				lost ||
				operations().some((o) => o.pending)
			)
				return false;
			busy.set(true);
			try {
				const r = await call<ScheduleSnapshot | null>(window, "day.schedules.write", {
					draftId,
					action,
					value,
					binding,
					page: s.page,
				});
				if (!r.ok) {
					lost = ["lost", "unknown"].includes(r.refusal);
					blocked.set(lost);
					message.set(
						"The save could not be confirmed. Read and Check status; nothing is resent. Your draft stays.",
					);
					return false;
				}
				receive(r);
				const state = (r.value.outcome as { state?: string })?.state;
				message.set(
					state === "accepted"
						? "Saved."
						: state === "rejected"
							? "The service refused this change. Read again; your draft stays."
							: "Delivery is unknown. Check status; do not save again.",
				);
				lost = state !== "accepted" && state !== "rejected";
				blocked.set(lost);
				return state === "accepted";
			} finally {
				busy.set(false);
			}
		},
		async check(operationId) {
			if (busy()) return;
			busy.set(true);
			try {
				const r = await call<ScheduleSnapshot | null>(window, "day.schedules.check", { operationId });
				if (r.ok) {
					receive(r);
					lost = operations().some((o) => o.pending);
					// Keep the submitted draft blocked even after acceptance. Opening a new editor
					// is a fresh user intent; Check must not turn into another Create.
					blocked.set(true);
					message.set("Status read. Nothing was resent. Close this draft before starting another schedule.");
				} else message.set("Status is unavailable. Nothing was resent.");
			} finally {
				busy.set(false);
			}
		},
		close: () => auto.close(),
	};
	return controls;
}

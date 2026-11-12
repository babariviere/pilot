// Transport adapter only. Keeps the existing update screen and VM types.
// Unknown writes are never repeated; the only recovery call is Check.
// A definite refusal is said as it is: nothing was prepared, confirmed or
// sent, and the screen goes back to what it showed. Only a lost or unknown
// answer leaves the run Unknown and Check-only.
import { signal } from "nsh";
import type { ConfirmIntent, IntentOutcome, Prepared, PrepareIntent, ServiceView, UpdateRef } from "pilot-day/native";
import { call, type Refusal, refusalOutcome } from "./bridge";
import type { Update } from "./updateFeed";

/** Refusals after which the root may have entered the effect: Unknown, Check only. */
const UNCERTAIN = new Set<Refusal>(["unknown", "lost", "storage", "invalid"]);

/** What a refused prepare means: it never starts anything. */
function prepareRefusal(refusal: Refusal, revision: number): Prepared {
	const refused = (status: Prepared["status"], message: string): Prepared => ({ status, message, confirmation: null });
	switch (refusal) {
		case "unavailable":
		case "denied":
			return refused("rejected", "This update is not available here. Nothing was prepared or changed.");
		case "unknown":
			return refused(
				"rejected",
				"The last update or registration is not confirmed yet. Check again first; nothing was prepared.",
			);
		case "stale":
			return refused("stale", "This changed since you read it. Check again; nothing was prepared.");
		case "lost":
			return refused("rejected", "Pilot did not hear back, so nothing is shown to confirm. Check again reads it.");
		default:
			return { ...refusalOutcome(refusal, revision), confirmation: null };
	}
}

/** The exact native root's update projection, never mock data. */
export async function connectedUpdates(window: string): Promise<Update | null> {
	const first = await call<ServiceView>(window, "day.update.read", {});
	if (!first.ok) return null;
	const service = signal(first.snapshot);
	const listeners = new Set<(view: ServiceView) => void>();
	let closed = false;
	let awaiting: string | null = null;
	const consumed = new Set<string>();
	const publish = (view: ServiceView) => {
		if (closed) return;
		service.set(view);
		for (const listener of listeners) listener(view);
	};
	/** One exact call. A reply's snapshot is published unless it is older than the run awaited. */
	const send = async (method: string, args: unknown) => {
		const result = await call<ServiceView>(window, method, args);
		if (result.ok) {
			if (!awaiting || result.snapshot.operation === awaiting) publish(result.snapshot);
			if (result.snapshot.operation === awaiting && result.snapshot.run?.phase !== "unknown") awaiting = null;
		}
		return result;
	};
	const outcomeOf = (result: Awaited<ReturnType<typeof send>>): IntentOutcome =>
		result.ok
			? (result.outcome ?? { status: "accepted", revision: service().revision, message: "" })
			: // No retry, refresh mutation, manufactured success or inferred receipt.
				refusalOutcome(result.refusal, service().revision);
	const confirm = async (id: string, intent: ConfirmIntent | UpdateRef, force: boolean): Promise<IntentOutcome> => {
		const current = service();
		const pending = current.pending;
		if (awaiting || consumed.has(id) || pending?.id !== id || (pending.mode === "force") !== force) {
			return {
				status: "stale",
				revision: current.revision,
				message: "This confirmation is no longer available. Check only.",
			};
		}
		consumed.add(id);
		awaiting = id;
		publish({
			...current,
			operation: id,
			pending: null,
			run: {
				kind: pending.kind,
				version: pending.to,
				phase: "unknown",
				steps: [],
				message: force
					? "Waiting for the native accepted-loss record and result."
					: "Waiting for the native save barrier and result.",
				next: "Check only; nothing will be resent.",
			},
		});
		const result = await send(force ? "day.update.forceConfirm" : "day.update.confirm", intent);
		if (!result.ok && !UNCERTAIN.has(result.refusal) && awaiting === id) {
			// Refused before anything was entered: the screen shows what it
			// showed, without the used confirmation. It is never sent again.
			awaiting = null;
			publish({ ...current, pending: null });
			if (result.refusal === "capacity") {
				return {
					status: "rejected",
					revision: current.revision,
					message:
						"Where you are is too large to save, so nothing was paused or updated. Your drafts stay as they are.",
				};
			}
		}
		return outcomeOf(result);
	};
	return {
		service,
		feed: {
			snapshot: () => service(),
			onChange(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			async prepare(intent: PrepareIntent): Promise<Prepared> {
				const result = await send("day.update.prepare", intent);
				if (!result.ok) return prepareRefusal(result.refusal, service().revision);
				const outcome = outcomeOf(result);
				return { status: outcome.status, message: outcome.message, confirmation: result.snapshot.pending ?? null };
			},
			async cancel(intent: UpdateRef): Promise<IntentOutcome> {
				// Cancellation revokes this local confirmation synchronously, even
				// when its native acknowledgement is lost or arrives late.
				consumed.add(intent.id);
				const current = service();
				if (current.pending?.id === intent.id) publish({ ...current, pending: null });
				return outcomeOf(await send("day.update.cancel", intent));
			},
			confirm: (intent: ConfirmIntent) => confirm(intent.confirmation, intent, false),
			forceConfirm: (intent: UpdateRef) => confirm(intent.id, intent, true),
			check: async () => outcomeOf(await send("day.update.check", {})),
			restored: async (intent: UpdateRef) => outcomeOf(await send("day.update.restored", intent)),
		},
		close() {
			closed = true;
			listeners.clear();
		},
	};
}

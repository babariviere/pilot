// Transport adapter only. Keeps the existing Opus update screen and VM types.
// Unknown writes are never repeated; the only recovery call is Check.
import { signal } from "nsh";
import type { ConfirmIntent, IntentOutcome, Prepared, PrepareIntent, ServiceView, UpdateRef } from "pilot-day/native";
import { call, refusalOutcome } from "./bridge";
import type { Update } from "./updateFeed";

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
	const send = async (method: string, args: unknown): Promise<IntentOutcome> => {
		const result = await call<ServiceView>(window, method, args);
		if (result.ok) {
			if (!awaiting || result.snapshot.operation === awaiting) publish(result.snapshot);
			if (result.snapshot.operation === awaiting && result.snapshot.run?.phase !== "unknown") awaiting = null;
			return result.outcome ?? { status: "accepted", revision: service().revision, message: "" };
		}
		const outcome = refusalOutcome(result.refusal, service().revision);
		// No retry, refresh mutation, manufactured success or inferred receipt.
		return outcome;
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
			prepare(intent: PrepareIntent): Prepared {
				void send("day.update.prepare", intent);
				return { status: "accepted", message: "", confirmation: null };
			},
			cancel(intent: UpdateRef): IntentOutcome {
				void send("day.update.cancel", intent);
				return { status: "accepted", revision: service().revision, message: "" };
			},
			confirm: (intent: ConfirmIntent) => {
				const current = service();
				const pending = current.pending;
				if (awaiting || consumed.has(intent.confirmation) || pending?.id !== intent.confirmation) {
					return Promise.resolve({
						status: "stale",
						revision: current.revision,
						message: "This confirmation is no longer available. Check only.",
					});
				}
				consumed.add(intent.confirmation);
				awaiting = intent.confirmation;
				publish({
					...current,
					operation: intent.confirmation,
					pending: null,
					run: {
						kind: pending.kind,
						version: pending.to,
						phase: "unknown",
						steps: [],
						message: "Waiting for the native save barrier and result.",
						next: "Check only; nothing will be resent.",
					},
				});
				return send("day.update.confirm", intent);
			},
			check: () => send("day.update.check", {}),
			restored: (intent: UpdateRef) => send("day.update.restored", intent),
		},
		close() {
			closed = true;
			listeners.clear();
		},
	};
}

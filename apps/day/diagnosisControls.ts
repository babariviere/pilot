// Presentation mirror. Native code owns host identity, queue fencing and durable sends.
import { signal } from "nsh";
import { call } from "./bridge";
import type { ModelChoice } from "./modelControls";
export type Privacy = {
	localDiagnostics: boolean;
	localFeatureUsage: boolean;
	remoteOperational: boolean;
	productAnalytics: boolean;
	endpoint?: string;
};
export type DiagnosisSnapshot = {
	version: number;
	binding: string;
	settings: Privacy;
	models: ModelChoice[];
	chats: { items: { sessionId: string; title: string; status: string }[]; hasMore: boolean };
	retained: string[];
};
export type DiagnosisOperation = {
	operationId: string;
	pending: boolean;
	state: string;
	receipt?: { result?: { sessionId?: string; action?: string } };
};
export interface DiagnosisControls {
	snapshot(): DiagnosisSnapshot | null;
	busy(): boolean;
	message(): string;
	operations(): DiagnosisOperation[];
	read(): Promise<void>;
	/** Whether the last read failed. Pilot then reads again on its own (freshness.ts). */
	readFailed?(): boolean;
	write(
		action: "save" | "clear" | "start" | "send",
		value: unknown,
		binding?: string,
	): Promise<{ accepted: boolean; sessionId?: string }>;
	check(id: string): Promise<void>;
}
export function connectedDiagnosisControls(window: string): DiagnosisControls {
	const snapshot = signal<DiagnosisSnapshot | null>(null),
		busy = signal(false),
		message = signal(""),
		operations = signal<DiagnosisOperation[]>([]),
		readFailed = signal(false);
	let lost = false;
	function receive(r: { snapshot: DiagnosisSnapshot | null; value: Record<string, unknown> }) {
		if (r.snapshot) snapshot.set(r.snapshot);
		else if (snapshot()) snapshot.set({ ...snapshot()!, binding: "" });
		operations.set((r.value.operations ?? []) as DiagnosisOperation[]);
		lost = false;
	}
	async function read() {
		if (busy()) return;
		busy.set(true);
		try {
			const r = await call<DiagnosisSnapshot>(window, "day.diagnosis.read", {});
			readFailed.set(!r.ok);
			if (r.ok) {
				receive(r);
				message.set("");
			} else {
				if (snapshot()) snapshot.set({ ...snapshot()!, binding: "" });
				message.set("Diagnostics settings could not be read. Pilot keeps trying; changes wait until it can.");
			}
		} finally {
			busy.set(false);
		}
	}
	async function write(action: "save" | "clear" | "start" | "send", value: unknown, binding?: string) {
		const s = snapshot();
		const revoke =
			action === "save" &&
			value !== null &&
			typeof value === "object" &&
			Object.keys(value).length === 4 &&
			["localDiagnostics", "localFeatureUsage", "remoteOperational", "productAnalytics"].every(
				(k) => (value as Record<string, unknown>)[k] === false,
			);
		if (busy() || (!revoke && (!s || lost || operations().some((o) => o.pending)))) return { accepted: false };
		busy.set(true);
		try {
			const r = await call<DiagnosisSnapshot | null>(window, "day.diagnosis.write", {
				binding: binding ?? s?.binding ?? "0".repeat(64),
				action,
				value,
			});
			if (!r.ok) {
				lost = ["lost", "unknown"].includes(r.refusal);
				message.set(
					r.refusal === "stale"
						? "This changed. Read again; your draft stays."
						: "The action could not be confirmed. Read again and check its receipt; nothing is resent.",
				);
				return { accepted: false };
			}
			receive(r);
			if (revoke && s && (r.value.outcome as { state?: string })?.state === "accepted")
				snapshot.set({
					...s,
					binding: "",
					settings: {
						localDiagnostics: false,
						localFeatureUsage: false,
						remoteOperational: false,
						productAnalytics: false,
					},
				});
			const o = r.value.outcome as { state?: string; receipt?: { result?: { sessionId?: string } } };
			const accepted = o?.state === "accepted";
			message.set(
				revoke
					? `This app writer: ${r.value.appStopped === true ? "stopped" : "unconfirmed"}. Service revocation: ${accepted ? "saved" : "unconfirmed"}. Read again before new changes. Kept copies remain.`
					: accepted
						? action === "clear"
							? `Service evidence cleared. This app writer: ${r.value.appCleared === true ? "cleared" : "unconfirmed"}. Other copies listed below remain.`
							: action === "save"
								? r.snapshot
									? "Saved. Local collection never enables upload."
									: "Saved, but the current controls could not be read. Read again before new changes."
								: "Sent to the read-only specialist."
						: o?.state === "rejected"
							? "The service refused this action. Read again before a new attempt."
							: "This action is Unknown. Check reads only its receipt; it does not resend.",
			);
			return { accepted, sessionId: o?.receipt?.result?.sessionId };
		} finally {
			busy.set(false);
		}
	}
	async function check(operationId: string) {
		if (busy()) return;
		busy.set(true);
		try {
			const r = await call<DiagnosisSnapshot | null>(window, "day.diagnosis.check", { operationId });
			if (r.ok) {
				receive(r);
				message.set(
					"Receipt checked without resending. App-writer clearing is not established by a service receipt.",
				);
			} else message.set("The receipt is still unavailable. Nothing was resent.");
		} finally {
			busy.set(false);
		}
	}
	return { snapshot, busy, message, operations, read, readFailed, write, check };
}

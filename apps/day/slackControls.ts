// Native code owns project authority, command IDs and the durable ledger.
import { signal } from "nsh";
import { AutoCheck } from "./autoCheck";
import { call } from "./bridge";
export type ReportEvidence = { value: string; evidence: string };
export type ReportDetails = {
	client: ReportEvidence | null;
	reporter: ReportEvidence | null;
	issue: ReportEvidence | null;
};
export type SlackReport = {
	id: string;
	revision: number;
	triageState: "new" | "later" | "discarded";
	projectId: string;
	title: string;
	url: string;
	caseId?: string;
	sessionId?: string;
	missionId?: string;
	startOperationId?: string;
	metadata: { author?: string; details?: ReportDetails; channelName?: string };
	slack?: {
		type: string;
		severity: string;
		label: string | null;
		status: string;
		overrides: { details?: Partial<ReportDetails>; status?: string };
	};
};
export type SlackReports = {
	items: SlackReport[];
	groups: { id: string; name: string; description: string }[];
	total: number;
	complete: boolean;
	offset?: number;
	more?: boolean;
	digest: string;
};
export type SlackSnapshot = {
	version: number;
	projectId: string;
	projectName: string;
	binding: string;
	config: { channels: string[]; mentionOnly: string[]; groups: string[] };
	source: { status: string; lastPolledAt?: number; nextPollAt?: number; error?: string };
	channels: { id: string; pulledAt?: number; failedAt?: number; hasMore?: boolean }[];
	reports?: SlackReports;
	labels?: { name: string; description: string; effect?: string }[];
	canOpenUrl?: boolean;
};
export interface SlackControls {
	snapshot(): SlackSnapshot | null;
	busy(): boolean;
	message(): string;
	unknown(): { operationId: string }[];
	read(offset?: number): Promise<void>;
	/** Whether the last read failed. Pilot then reads again on its own (freshness.ts). */
	readFailed?(): boolean;
	write(action: "save" | "import" | "report" | "group", value: unknown, binding: string): Promise<boolean>;
	check(id: string): Promise<void>;
	setAside(id: string): Promise<void>;
	/** Stops the automatic lookups. */
	close?(): void;
	open?(itemId: string, digest: string, binding: string): Promise<void>;
}
export function connectedSlackControls(window: string, changed: () => void): SlackControls {
	const snapshot = signal<SlackSnapshot | null>(null),
		busy = signal(false),
		message = signal(""),
		unknown = signal<{ operationId: string }[]>([]),
		readFailed = signal(false);
	let again = false;
	// Unknown actions are looked up by their receipt automatically; Check is the fallback.
	const auto = new AutoCheck(
		(operationId) => request("check", { operationId }).then(() => undefined),
		() => {},
	);
	async function request(name: string, args: unknown): Promise<boolean> {
		if (busy()) {
			if (name === "read") again = true;
			return false;
		}
		busy.set(true);
		try {
			const r = await call<SlackSnapshot | null>(window, `day.slack.${name}`, args);
			if (name === "read") readFailed.set(!r.ok);
			if (!r.ok) {
				message.set(
					name === "read"
						? snapshot()
							? ""
							: "Slack could not be read yet. Pilot keeps trying."
						: r.refusal === "stale"
							? "Project settings changed. Read again; your draft stays."
							: "Could not confirm this action. Read again and check its receipt. Nothing is sent again.",
				);
				if (name === "write") again = true;
				return false;
			}
			if (r.snapshot) snapshot.set(r.snapshot);
			unknown.set((r.value.operations ?? []) as { operationId: string }[]);
			auto.watch(unknown().map((o) => o.operationId));
			const outcome = r.value.outcome as
				| { state?: string; receipt?: { reason?: string; result?: { action?: string } } }
				| undefined;
			if (name === "read") message.set("");
			else
				message.set(
					outcome?.state === "opened"
						? ""
						: outcome?.state === "accepted"
							? outcome.receipt?.result?.action === "import"
								? "Message saved to Today. No channel was added."
								: ["report", "group"].includes(outcome.receipt?.result?.action ?? "")
									? "Report changes saved."
									: r.snapshot
										? "Tracking saved."
										: "Tracking saved. Read again for current settings."
							: outcome?.state === "rejected"
								? (outcome.receipt?.reason ?? "Nothing changed. Read again before trying a new action.")
								: outcome?.state === "set-aside"
									? "Unknown set aside. It may already have saved. Nothing was retried."
									: "This action is Unknown. Check status only reads its receipt.",
				);
			if (outcome?.state === "accepted") changed();
			return outcome?.state === "accepted" && !!r.snapshot;
		} finally {
			busy.set(false);
			if (again) {
				again = false;
				void request("read", { offset: snapshot()?.reports?.offset ?? 0 });
			}
		}
	}
	return {
		snapshot,
		busy,
		message,
		unknown,
		readFailed,
		read: async (offset = snapshot()?.reports?.offset ?? 0) => {
			await request("read", { offset });
		},
		write: async (action, value, binding) =>
			!snapshot() || unknown().length > 0 ? false : request("write", { action, value, binding }),
		check: async (operationId) => {
			await request("check", { operationId });
		},
		setAside: async (operationId) => {
			await request("setAside", { operationId });
		},
		open: async (itemId, digest, binding) => {
			await request("write", {
				action: "open",
				value: { itemId, digest, offset: snapshot()?.reports?.offset ?? 0 },
				binding,
			});
		},
		close: () => auto.close(),
	};
}

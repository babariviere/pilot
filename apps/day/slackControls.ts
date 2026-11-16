// Native code owns project authority, command IDs and the durable ledger.
import { signal } from "nsh";
import { call } from "./bridge";
export type SlackSnapshot = {
	version: number;
	projectId: string;
	projectName: string;
	binding: string;
	config: { channels: string[]; mentionOnly: string[]; groups: string[] };
	source: { status: string; lastPolledAt?: number; nextPollAt?: number; error?: string };
	channels: { id: string; pulledAt?: number; failedAt?: number; hasMore?: boolean }[];
};
export interface SlackControls {
	snapshot(): SlackSnapshot | null;
	busy(): boolean;
	message(): string;
	unknown(): { operationId: string }[];
	read(): Promise<void>;
	write(action: "save" | "import", value: unknown, binding: string): Promise<boolean>;
	check(id: string): Promise<void>;
	setAside(id: string): Promise<void>;
}
export function connectedSlackControls(window: string, changed: () => void): SlackControls {
	const snapshot = signal<SlackSnapshot | null>(null),
		busy = signal(false),
		message = signal(""),
		unknown = signal<{ operationId: string }[]>([]);
	let again = false;
	async function request(name: string, args: unknown): Promise<boolean> {
		if (busy()) {
			if (name === "read") again = true;
			return false;
		}
		busy.set(true);
		try {
			const r = await call<SlackSnapshot | null>(window, `day.slack.${name}`, args);
			if (!r.ok) {
				message.set(
					name === "read"
						? "Slack settings could not be read. The last report stays visible."
						: r.refusal === "stale"
							? "Project settings changed. Read again; your draft stays."
							: "Could not confirm this action. Read again and check its receipt. Nothing is sent again.",
				);
				if (name === "write") again = true;
				return false;
			}
			if (r.snapshot) snapshot.set(r.snapshot);
			unknown.set((r.value.operations ?? []) as { operationId: string }[]);
			const outcome = r.value.outcome as
				| { state?: string; receipt?: { reason?: string; result?: { action?: string } } }
				| undefined;
			if (name === "read") message.set("");
			else
				message.set(
					outcome?.state === "accepted"
						? outcome.receipt?.result?.action === "import"
							? "Message saved to Today. No channel was added."
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
				void request("read", {});
			}
		}
	}
	return {
		snapshot,
		busy,
		message,
		unknown,
		read: async () => {
			await request("read", {});
		},
		write: async (action, value, binding) =>
			!snapshot() || unknown().length > 0 ? false : request("write", { action, value, binding }),
		check: async (operationId) => {
			await request("check", { operationId });
		},
		setAside: async (operationId) => {
			await request("setAside", { operationId });
		},
	};
}

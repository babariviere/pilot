// Window-local presentation mirror. Native code owns configuration and command identities.
import { signal } from "nsh";
import { call } from "./bridge";

export type DatabaseConnection = {
	host: string;
	port: string;
	database: string;
	user: string;
	hasCredentials: boolean;
	tlsWarning?: string;
	tlsException?: { name: string; mode: "plaintext" | "unverified" };
};
export type DatabaseGrant = {
	env: string;
	mode: "read" | "write";
	scope?: string;
	provider?: string;
	destination?: string;
};
export type DatabaseSnapshot = {
	version: number;
	binding: string;
	projectId: string;
	settings: {
		revision: string;
		environments: { name: string; read?: DatabaseConnection; write?: DatabaseConnection }[];
	};
	agents: {
		id: string;
		title: string;
		provider: string;
		eligible: boolean;
		grants: DatabaseGrant[];
		request: (DatabaseGrant & { id: string }) | null;
	}[];
};
export interface DatabaseControls {
	snapshot(): DatabaseSnapshot | null;
	busy(): boolean;
	current(): boolean;
	message(): string;
	unknown(): { operationId: string }[];
	read(): Promise<void>;
	refresh(): Promise<void>;
	write(action: "edit" | "test" | "decide" | "revoke", value: unknown, binding?: string): Promise<boolean>;
	check(id: string): Promise<void>;
}
export function connectedDatabaseControls(window: string): DatabaseControls {
	const snapshot = signal<DatabaseSnapshot | null>(null);
	const busy = signal(false);
	const current = signal(false);
	const message = signal("");
	const unknown = signal<{ operationId: string }[]>([]);
	let again: "read" | "refresh" | null = null;
	async function request(name: string, args: unknown): Promise<boolean> {
		if (busy()) {
			if (name === "refresh") again = "refresh";
			else if (name === "read" && !again) again = "read";
			return false;
		}
		busy.set(true);
		try {
			const r = await call<DatabaseSnapshot | null>(window, `day.databases.${name}`, args);
			if (!r.ok) {
				current.set(false);
				message.set(
					name === "read"
						? "Database settings could not be read. Read again; the last report stays visible."
						: r.refusal === "stale"
							? "Database settings changed. Read again; your draft stays."
							: "Could not confirm this action. Read again and check its receipt. Nothing is sent again.",
				);
				// Read only: collect the native journal after a lost mutation reply.
				if (name === "write" && !again) again = "read";
				return false;
			}
			if (r.snapshot) snapshot.set(r.snapshot);
			current.set(r.value.current === true);
			unknown.set((r.value.operations ?? []) as { operationId: string }[]);
			const outcome = r.value.outcome as
				| {
						state?: string;
						receipt?: { reason?: string; result?: { test?: { connected: boolean; message: string } } };
				  }
				| undefined;
			if (name === "read" || name === "refresh")
				message.set(current() ? "" : "Database access is from an earlier read. Read again before deciding.");
			if (name !== "read" && name !== "refresh")
				message.set(
					outcome?.state === "accepted"
						? (outcome.receipt?.result?.test?.message ?? "Confirmed.")
						: outcome?.state === "rejected"
							? (outcome.receipt?.reason ?? "Nothing changed. Read again before trying a new action.")
							: "This action is Unknown. Check status only reads its receipt.",
				);
			return outcome?.state === "accepted";
		} finally {
			busy.set(false);
			if (again) {
				const next = again;
				again = null;
				void request(next, {});
			}
		}
	}
	return {
		snapshot,
		busy,
		current,
		message,
		unknown,
		read: async () => {
			await request("read", {});
		},
		refresh: async () => {
			await request("refresh", {});
		},
		write: async (action, value, binding) => {
			const s = snapshot();
			if (!s || !current() || (unknown().length > 0 && action !== "revoke")) return false;
			return request("write", { action, value, binding: binding ?? s.binding });
		},
		check: async (operationId) => {
			await request("check", { operationId });
		},
	};
}

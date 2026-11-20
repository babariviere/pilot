// Window-local presentation mirror. Native code owns configuration and command identities.
import { signal } from "nsh";
import { AutoCheck } from "../../sources/autoCheck";
import { call } from "../../sources/bridge";

export type ConnectionSnapshot = {
	version: number;
	binding: string;
	readOnly: boolean;
	setup: {
		entries: {
			name: string;
			config?: { url?: string; command?: string };
			blocked?: string;
			dependencyAvailable?: boolean;
		}[];
		invalidNames: number;
	};
	status: { checking: boolean; configProblems?: number; servers: ConnectionServer[] } | null;
};
export type ConnectionServer = {
	name: string;
	state: string;
	tools?: number;
	problem?: string;
	checkedAt?: number;
	canSignIn?: boolean;
	signIn?: { state: string; startedAt: number; error?: string };
};
export interface ConnectionControls {
	snapshot(): ConnectionSnapshot | null;
	busy(): boolean;
	message(): string;
	unknown(): { operationId: string }[];
	read(): Promise<void>;
	probe(): Promise<void>;
	write(action: "add" | "sign-in" | "cancel", value: unknown, binding?: string): Promise<boolean>;
	check(id: string): Promise<void>;
	/** Stops the automatic lookups. */
	close?(): void;
}
export function connectedConnectionControls(window: string): ConnectionControls {
	const snapshot = signal<ConnectionSnapshot | null>(null);
	const busy = signal(false);
	const message = signal("");
	const unknown = signal<{ operationId: string }[]>([]);
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
			const r = await call<ConnectionSnapshot | null>(window, `day.connections.${name}`, args);
			if (!r.ok) {
				message.set(
					name === "read"
						? "Connections could not be read. Read again; the last report stays visible."
						: name === "probe"
							? "Could not confirm the connection check. Read again for the latest report."
							: r.refusal === "stale"
								? "Connections changed. Read again; your draft stays."
								: "Could not confirm this action. Read again and check its receipt. Nothing is sent again.",
				);
				// Read only: collect the native journal after a lost mutation reply.
				if (name === "write") again = true;
				return false;
			}
			if (r.snapshot) snapshot.set(r.snapshot);
			unknown.set((r.value.operations ?? []) as { operationId: string }[]);
			auto.watch(unknown().map((o) => o.operationId));
			const outcome = r.value.outcome as { state?: string } | undefined;
			if (name === "read") message.set("");
			if (name !== "read")
				message.set(
					outcome?.state === "accepted"
						? "Confirmed."
						: outcome?.state === "rejected"
							? "Nothing changed. Read again before trying a new action."
							: name === "probe"
								? snapshot()?.status?.checking
									? "Checking connections…"
									: "The service is not running a check. Read again for the latest report."
								: "This action is Unknown. Check status only reads its receipt.",
				);
			return outcome?.state === "accepted";
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
		probe: async () => {
			await request("probe", {});
		},
		write: async (action, value, binding) => {
			const s = snapshot();
			if (!s || (unknown().length > 0 && action !== "cancel")) return false;
			return request("write", { action, value, binding: binding ?? s.binding });
		},
		check: async (operationId) => {
			await request("check", { operationId });
		},
		close: () => auto.close(),
	};
}

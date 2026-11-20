/** Native connection setup. Reuses Pi's additive writer and shared cached checks. */
import { createHash } from "node:crypto";
import type { DurableOperation } from "@pilot/protocol";
import { NotFound } from "./errors.ts";
import { McpSetupError, type McpSetupStore } from "./mcp-setup.ts";
import { mcpSetupName } from "./mcp-setup-projection.ts";
import { type McpStatusService, SignInUnavailable } from "./mcp-status.ts";
import { parseIntent, SerialAdmissions } from "./native-intent.ts";
import { type OperationJournal, OperationRejected } from "./operation-journal.ts";
import type { ControlOperation } from "./operations.ts";

export const CONNECTION_CONTROLS = "connection-controls";
const OUTCOME_UNKNOWN = "Connection outcome unknown; lookup only";
export class ConnectionControls {
	private readonly admissions = new SerialAdmissions(OUTCOME_UNKNOWN);
	private readonly store: McpSetupStore;
	private readonly mcp?: McpStatusService;
	private readonly readOnly: boolean;
	constructor(store: McpSetupStore, mcp?: McpStatusService, readOnly = false) {
		this.store = store;
		this.mcp = mcp;
		this.readOnly = readOnly;
	}
	async read() {
		const setup = await this.store.read();
		const status = this.mcp?.status() ?? null;
		// Checks may update counts/timing without invalidating a displayed setup. Authentication attempts do fence it.
		const binding = createHash("sha256")
			.update(
				JSON.stringify({
					revision: setup.revision,
					attempts: status?.servers.map((s) => [s.name, s.canSignIn, s.signIn]),
				}),
			)
			.digest("hex");
		return { version: 1, binding, setup, status, readOnly: this.readOnly };
	}
	admit(op: DurableOperation, journal: OperationJournal, firstEntry: boolean): Promise<unknown> {
		return this.admissions.admit(firstEntry, () => this.apply(op, journal));
	}
	private async apply(op: DurableOperation, journal: OperationJournal) {
		const p = parseIntent(
			op,
			journal.destination,
			CONNECTION_CONTROLS,
			["action", "binding", "purpose", "value"],
			"Invalid connection intent",
		);
		if (op.targetId !== "global-connections") throw new OperationRejected("Invalid connection intent");
		let current: Awaited<ReturnType<ConnectionControls["read"]>>;
		try {
			current = await this.read();
		} catch {
			throw new OperationRejected("Connections could not be read. Nothing changed.");
		}
		if (p.binding !== current.binding || op.bindingId !== p.binding)
			throw new OperationRejected("Connections changed. Read again.");
		try {
			if (p.action === "add") {
				if (this.readOnly) throw new OperationRejected("Connection setup is read only");
				// Validate again in the store. No replacement or export of advanced fields.
				await this.store.apply({ expectedRevision: current.setup.revision, entries: [p.value] });
				this.mcp?.check();
				return { action: p.action, saved: true };
			}
			if (!this.mcp) throw new OperationRejected("Connection checks are unavailable");
			const v = p.value as { server?: unknown; expectedStartedAt?: unknown };
			if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.server !== "string" || !mcpSetupName(v.server))
				throw new OperationRejected("Invalid connection action");
			if (p.action === "sign-in" && Object.keys(v).join() === "server") {
				const run = this.mcp.signIn(v.server);
				return { action: p.action, server: v.server, run };
			}
			if (
				p.action === "cancel" &&
				Object.keys(v).sort().join() === "expectedStartedAt,server" &&
				typeof v.expectedStartedAt === "number" &&
				Number.isFinite(v.expectedStartedAt)
			) {
				const run = this.mcp.cancelSignIn(v.server, v.expectedStartedAt);
				return { action: p.action, server: v.server, run: run ?? null };
			}
			throw new OperationRejected("Invalid connection action");
		} catch (e) {
			if (
				(e instanceof McpSetupError && e.status !== 503) ||
				e instanceof SignInUnavailable ||
				e instanceof NotFound
			)
				throw new OperationRejected("Connection changed or setup is unsupported. Read again.");
			throw e;
		}
	}
}

export const connectionOperations = (
	controls: ConnectionControls,
	journal: OperationJournal | undefined,
): ControlOperation => ({
	kind: CONNECTION_CONTROLS,
	unavailable: "Native connections unavailable",
	outcomeUnknown: OUTCOME_UNKNOWN,
	admit: journal && ((op, firstEntry) => controls.admit(op, journal, firstEntry)),
});

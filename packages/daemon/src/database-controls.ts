/** Native-only database setup and scoped approvals. Entered commands are lookup-only after interruption. */
import type { DurableOperation } from "@pilot/protocol";
import { DatabaseSettingsError } from "./databases.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import type { SessionManager } from "./sessions.ts";

export const DATABASE_CONTROLS = "database-controls";
/** Native journals never contain passwords or connection parameters. Advanced credentials stay in database.json. */
export function safeDatabaseUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2048) return false;
	try {
		const u = new URL(value);
		return ["postgres:", "postgresql:"].includes(u.protocol) && !!u.hostname && !u.password && !u.search && !u.hash;
	} catch {
		return false;
	}
}
export class DatabaseControls {
	private pending: Promise<unknown> = Promise.resolve();
	private readonly sessions: SessionManager;
	constructor(sessions: SessionManager) {
		this.sessions = sessions;
	}
	async read(projectId: string) {
		const data = await this.sessions.databaseControls(projectId);
		return { version: 1, projectId, ...data, binding: payloadHash(canonicalJSON(data)) };
	}
	admit(op: DurableOperation, journal: OperationJournal, firstEntry: boolean): Promise<unknown> {
		if (!firstEntry) return Promise.reject(new Error("Database outcome unknown; lookup only"));
		const work = this.pending.then(() => this.apply(op, journal));
		this.pending = work.catch(() => undefined);
		return work;
	}
	private async apply(op: DurableOperation, journal: OperationJournal) {
		let p: { purpose: string; projectId: string; binding: string; action: string; value: Record<string, unknown> };
		try {
			p = JSON.parse(op.payload);
			if (
				!p ||
				Object.keys(p).sort().join() !== "action,binding,projectId,purpose,value" ||
				p.purpose !== DATABASE_CONTROLS ||
				op.kind !== DATABASE_CONTROLS ||
				op.targetId !== p.projectId ||
				op.bindingGeneration !== 1 ||
				!sameHost(op.origin, journal.destination)
			)
				throw new Error();
		} catch {
			throw new OperationRejected("Invalid database intent");
		}
		const current = await this.read(p.projectId);
		if (p.binding !== current.binding || op.bindingId !== p.binding)
			throw new OperationRejected("Database settings or agent access changed. Read again.");
		const v = p.value;
		if (!v || typeof v !== "object" || Array.isArray(v)) throw new OperationRejected("Invalid database action");
		if (p.action === "save") {
			if (!Array.isArray(v.environments) || Object.keys(v).join() !== "environments")
				throw new OperationRejected("Invalid database settings");
			for (const env of v.environments)
				for (const mode of ["read", "write"]) {
					if (env?.[mode]?.url !== undefined && !safeDatabaseUrl(env[mode].url))
						throw new OperationRejected(
							"Use a URL without credentials or parameters. Advanced credentials stay in database.json.",
						);
				}
			try {
				await this.sessions.updateProjectDatabases(p.projectId, {
					revision: current.settings.revision,
					environments: v.environments,
				});
			} catch (error) {
				if (error instanceof DatabaseSettingsError && error.status < 500)
					throw new OperationRejected(error.message);
				throw error;
			}
		} else if (p.action === "test") {
			if (
				Object.keys(v).sort().join() !== "env,mode" ||
				typeof v.env !== "string" ||
				(v.mode !== "read" && v.mode !== "write")
			)
				throw new OperationRejected("Invalid connection test");
			try {
				await this.sessions.testProjectDatabase(p.projectId, v.env, v.mode, current.settings.revision);
				return {
					action: p.action,
					projectId: p.projectId,
					confirmed: true,
					test: { connected: true, message: "Connection authenticated. No SQL was run." },
				};
			} catch (error) {
				if (error instanceof DatabaseSettingsError) throw new OperationRejected(error.message);
				return {
					action: p.action,
					projectId: p.projectId,
					confirmed: true,
					test: {
						connected: false,
						message: "Connection test failed. Check the endpoint, credentials and TLS settings. No SQL was run.",
					},
				};
			}
		} else if (p.action === "decide" || p.action === "revoke") {
			const agent = current.agents.find((a) => a.id === v.agentId);
			if (!agent) throw new OperationRejected("Agent access is no longer available");
			if (p.action === "decide") {
				if (!agent.eligible) throw new OperationRejected("Agent is not eligible for a new approval");
				if (
					Object.keys(v).sort().join() !== "agentId,allow,requestId" ||
					typeof v.allow !== "boolean" ||
					v.requestId !== agent.request?.id
				)
					throw new OperationRejected("Approval is no longer pending");
				await this.sessions.decideDatabaseAccess(agent.id, agent.request!.id, v.allow);
			} else {
				if (
					Object.keys(v).sort().join() !== "agentId,env,mode" ||
					typeof v.env !== "string" ||
					typeof v.mode !== "string"
				)
					throw new OperationRejected("Invalid revocation");
				await this.sessions.revokeDatabaseAccess(agent.id, v.env, v.mode);
			}
		} else throw new OperationRejected("Invalid database action");
		return { action: p.action, projectId: p.projectId, confirmed: true };
	}
}

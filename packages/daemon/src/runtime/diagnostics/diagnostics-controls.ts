/** Native, explicit diagnostics actions. Uncertain effects are lookup-only. */
import { createHash } from "node:crypto";
import type {
	DiagnosticsControlsPayload,
	DiagnosticsControlsSnapshot,
	DurableOperation,
	OperationHost,
} from "@pilot/protocol";
import { validateOtlpEndpoint } from "@pilot/telemetry";
import { canonicalJSON } from "../contracts/canonical.ts";
import type { ModelCatalog } from "../../models/models.ts";
import { OperationRejected, sameHost } from "../../transport/operations/operation-journal.ts";
import type { ControlOperation } from "../../transport/operations/operations.ts";
import type { SessionManager } from "../../sessions/sessions.ts";
import type { TelemetrySettingsService } from "../telemetry/telemetry-settings.ts";

export const DIAGNOSTICS_CONTROLS = "diagnostics-controls";
const OUTCOME_UNKNOWN = "Diagnostics outcome unknown; lookup only";
export const DIAGNOSTICS_RETAINED = [
	"Service stdout and stderr are kept independently.",
	"OS logs are kept independently.",
	"Manual exports and agent history are not deleted.",
	"GPUI writers apply their own controls independently; their files are not confirmed cleared here.",
	"The Day app clears its own writer separately; this service receipt does not confirm app files were cleared.",
	"Already uploaded remote data is not deleted.",
	"Durable operation intents and receipts keep submitted questions and settings; Clear does not delete them.",
];
const limits = { endpointBytes: 512, payloadBytes: 20000, messageBytes: 16000 };
const hash = (value: unknown) => createHash("sha256").update(canonicalJSON(value)).digest("hex");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string" && !!v.trim() && Buffer.byteLength(v) <= limits.messageBytes;

/** Strict before journaling: do not persist arbitrary collector paths, credentials, or headers. */
export function validateDiagnosticsIntent(op: DurableOperation, host: OperationHost): DiagnosticsControlsPayload {
	try {
		if (
			!record(op) ||
			Object.keys(op).sort().join() !==
				"bindingGeneration,bindingId,destination,kind,operationId,origin,payload,payloadHash,producerId,schemaVersion,sequence,targetId" ||
			!record(op.origin) ||
			Object.keys(op.origin).sort().join() !== "daemonId,hostId,lineageId" ||
			!record(op.destination) ||
			Object.keys(op.destination).sort().join() !== "daemonId,hostId,lineageId"
		)
			throw new Error();
		if (typeof op.payload !== "string" || Buffer.byteLength(op.payload) > limits.payloadBytes) throw new Error();
		const p = JSON.parse(op.payload);
		if (
			!record(p) ||
			Object.keys(p).sort().join() !== "action,binding,purpose,value" ||
			p.purpose !== DIAGNOSTICS_CONTROLS ||
			op.kind !== DIAGNOSTICS_CONTROLS ||
			op.targetId !== "global-diagnostics" ||
			!op.origin ||
			!sameHost(op.origin, host) ||
			canonicalJSON(op.destination) !== canonicalJSON(host) ||
			typeof p.binding !== "string" ||
			!/^[a-f0-9]{64}$/.test(p.binding) ||
			op.bindingId !== p.binding ||
			op.bindingGeneration !== 1
		)
			throw new Error();
		const v = p.value;
		if (p.action === "clear") {
			if (v !== null) throw new Error();
		} else if (p.action === "save") {
			if (
				!record(v) ||
				Object.keys(v).some(
					(k) =>
						![
							"localDiagnostics",
							"localFeatureUsage",
							"remoteOperational",
							"productAnalytics",
							"endpoint",
						].includes(k),
				) ||
				![v.localDiagnostics, v.localFeatureUsage, v.remoteOperational, v.productAnalytics].every(
					(b) => typeof b === "boolean",
				)
			)
				throw new Error();
			if (v.endpoint !== undefined) {
				if (
					typeof v.endpoint !== "string" ||
					Buffer.byteLength(v.endpoint) > limits.endpointBytes ||
					v.endpoint !== v.endpoint.trim()
				)
					throw new Error();
				const normalized = validateOtlpEndpoint(v.endpoint);
				// Reject encoded, normalized traversal and arbitrary secret-bearing paths too.
				if (
					!/^https?:\/\/[^/?#\\]+(?:\/|\/v1\/traces)?$/.test(v.endpoint) ||
					new URL(normalized).pathname !== "/v1/traces"
				)
					throw new Error();
			}
			if (v.remoteOperational && !v.endpoint) throw new Error();
		} else if (p.action === "start") {
			if (
				!record(v) ||
				Object.keys(v).some((k) => !["model", "thinking", "question", "focus"].includes(k)) ||
				!text(v.question) ||
				typeof v.model !== "string" ||
				v.model.length > 256 ||
				typeof v.thinking !== "string" ||
				v.thinking.length > 32 ||
				(v.focus !== undefined && v.focus !== "app")
			)
				throw new Error();
		} else if (p.action === "send") {
			if (
				!record(v) ||
				Object.keys(v).sort().join() !== "message,sessionId" ||
				!text(v.message) ||
				typeof v.sessionId !== "string" ||
				!/^[A-Za-z0-9_-]{1,128}$/.test(v.sessionId)
			)
				throw new Error();
		} else throw new Error();
		if ((p.action === "save" || p.action === "clear") && Buffer.byteLength(op.payload) > 2048) throw new Error();
		return p as DiagnosticsControlsPayload;
	} catch {
		throw new OperationRejected("Invalid native diagnostics intent. Nothing changed.");
	}
}

/** A reduction grants nothing; stale settings/catalogue state must not prevent stopping collection. */
export function isDiagnosticsRevocation(op: DurableOperation): boolean {
	try {
		const p = JSON.parse(op.payload);
		return (
			p.purpose === DIAGNOSTICS_CONTROLS &&
			p.action === "save" &&
			canonicalJSON(p.value) ===
				canonicalJSON({
					localDiagnostics: false,
					localFeatureUsage: false,
					remoteOperational: false,
					productAnalytics: false,
				})
		);
	} catch {
		return false;
	}
}

export class DiagnosticsControls {
	private pending: Promise<unknown> = Promise.resolve();
	private readonly telemetry: TelemetrySettingsService;
	private readonly models: Pick<ModelCatalog, "listTaskModels">;
	private readonly sessions: Pick<SessionManager, "list" | "spawnDurable" | "sendDurable" | "clearDiagnostics">;
	private readonly home: string;
	private readonly host: OperationHost;
	private readonly flush: () => Promise<void>;
	private readonly clearEvidence: () => Promise<void>;
	constructor(
		telemetry: TelemetrySettingsService,
		models: Pick<ModelCatalog, "listTaskModels">,
		sessions: Pick<SessionManager, "list" | "spawnDurable" | "sendDurable" | "clearDiagnostics">,
		home: string,
		host: OperationHost,
		flush: () => Promise<void>,
		clearEvidence: () => Promise<void>,
	) {
		this.telemetry = telemetry;
		this.models = models;
		this.sessions = sessions;
		this.home = home;
		this.host = host;
		this.flush = flush;
		this.clearEvidence = clearEvidence;
	}
	private chats() {
		return this.sessions
			.list({})
			.filter(
				(s) =>
					!s.archivedAt &&
					s.role === "diagnostics" &&
					s.diagnosticScope === "app" &&
					!!s.diagnosticHost &&
					sameHost(s.diagnosticHost, this.host),
			);
	}
	async read(): Promise<DiagnosticsControlsSnapshot> {
		// Catalogue failure must not block privacy revocation. Empty choices never admit a start.
		const models = await this.models.listTaskModels(this.home).then(
			(list) => list.models,
			() => [],
		);
		const settings = this.telemetry.settings();
		const all = this.chats();
		const chats = {
			items: all
				.slice(0, 100)
				.map((s) => ({ sessionId: s.id, title: s.title, model: s.model, thinking: s.thinking, status: s.state })),
			hasMore: all.length > 100,
		};
		return {
			version: 1,
			host: this.host,
			settings,
			models,
			chats,
			binding: hash({
				host: this.host,
				settings,
				models,
				chats: all.map((s) => ({ id: s.id, model: s.model, thinking: s.thinking })),
			}),
			retained: DIAGNOSTICS_RETAINED,
			limits,
		};
	}
	admit(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (!firstEntry) return Promise.reject(new Error(OUTCOME_UNKNOWN));
		if (isDiagnosticsRevocation(op)) {
			validateDiagnosticsIntent(op, this.host);
			// Independent from catalogue/start waits. update increments its revision before
			// any await; older reads and queued enables cannot restore their old grant.
			return this.telemetry.update(JSON.parse(op.payload).value).then(
				() => ({ action: "save", saved: true, retained: DIAGNOSTICS_RETAINED }),
				() => {
					throw new Error("Privacy revocation could not be confirmed. Look up its receipt.");
				},
			);
		}
		const revision = this.telemetry.privacyRevision;
		const work = this.pending
			.then(() => this.apply(op, revision))
			.catch((error) => {
				if (error instanceof OperationRejected) throw error;
				throw new Error("Diagnostics action could not be confirmed. Look up its receipt; do not resend.");
			});
		this.pending = work.catch(() => undefined);
		return work;
	}
	private async apply(op: DurableOperation, revision: number) {
		const p = validateDiagnosticsIntent(op, this.host);
		const snapshot = await this.read();
		if (
			revision !== this.telemetry.privacyRevision ||
			p.binding !== snapshot.binding ||
			canonicalJSON(snapshot.settings) !== canonicalJSON(this.telemetry.settings())
		)
			throw new OperationRejected("Diagnostics settings or chats changed. Read again.");
		if (p.action === "start") {
			if (!snapshot.models.some((m) => m.id === p.value.model && m.thinkingLevels?.includes(p.value.thinking)))
				throw new OperationRejected("Choose an eligible diagnostics model and thinking level. Nothing started.");
			const idHash = hash(op.operationId);
			const sessionId = `${idHash.slice(0, 8)}-${idHash.slice(8, 12)}-4${idHash.slice(13, 16)}-8${idHash.slice(17, 20)}-${idHash.slice(20, 32)}`;
			const session = await this.sessions.spawnDurable(
				{
					role: "diagnostics",
					mode: "ask",
					diagnosticScope: "app",
					diagnosticHost: this.host,
					model: p.value.model,
					thinking: p.value.thinking,
					message: p.value.question,
					diagnosticTitleFromReply: true,
				},
				sessionId,
				op.operationId,
			);
			return { action: p.action, sessionId: session.id };
		}
		if (p.action === "send") {
			if (!this.chats().some((s) => s.id === p.value.sessionId))
				throw new OperationRejected("Diagnostics chat scope changed. Nothing sent.");
			await this.sessions.sendDurable(p.value.sessionId, p.value.message, "followUp", op.operationId);
			return { action: p.action, sessionId: p.value.sessionId };
		}
		if (p.action === "save") {
			await this.telemetry.update(p.value);
			await this.flush();
		} else {
			await this.telemetry.clearNextDiagnostics();
			await this.sessions.clearDiagnostics();
			await this.telemetry.featureUsage.clear();
			await this.clearEvidence();
		}
		return { action: p.action, saved: true, retained: DIAGNOSTICS_RETAINED };
	}
}

export const diagnosticsOperations = (
	controls: DiagnosticsControls | undefined,
	host: OperationHost | undefined,
): ControlOperation => ({
	kind: DIAGNOSTICS_CONTROLS,
	unavailable: "Native diagnostics unavailable",
	outcomeUnknown: OUTCOME_UNKNOWN,
	validate: host
		? (op) => {
				try {
					validateDiagnosticsIntent(op, host);
				} catch {
					throw new Error("Invalid native diagnostics intent");
				}
			}
		: undefined,
	admit: controls && ((op, firstEntry) => controls.admit(op, firstEntry)),
	safetyReduction: isDiagnosticsRevocation,
});

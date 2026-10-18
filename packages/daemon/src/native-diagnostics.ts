/** Private, bounded native crash/hang and setup metadata synchronized by the local macOS app. */
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DevboxSetupDiagnosticEvidence, NativeDiagnosticEvidence, NativeDiagnosticsBatch } from "@pilot/protocol";
import { Conflict } from "./errors.ts";

export const NATIVE_DIAGNOSTICS_FILE = "native-diagnostics.json";
export const MAX_NATIVE_DIAGNOSTICS = 32;
export const MAX_NATIVE_DIAGNOSTIC_BYTES = 32 * 1024;
const REF = /^diagnostic:v1:native:[0-9a-f]{24}$/;
const SETUP_REF = /^diagnostic:v1:setup:[0-9a-f]{24}$/;
const ATTEMPT_REF = /^diagnostic:v1:setup-attempt:[0-9a-f]{24}$/;
const ALLOWED_BATCH_KEYS = new Set(["schemaVersion", "evidence", "dropped"]);
const ALLOWED_EVIDENCE_KEYS = new Set([
	"ref",
	"source",
	"at",
	"kind",
	"reason",
	"windowMs",
	"releaseRelation",
	"durationMs",
]);
const ALLOWED_SETUP_KEYS = new Set([
	"ref",
	"attemptRef",
	"sequence",
	"source",
	"at",
	"kind",
	"stage",
	"outcome",
	"reason",
]);
const SETUP_STAGES = new Set([
	"configuration",
	"package",
	"ssh_transport",
	"remote_bootstrap",
	"remote_handshake",
	"enrollment",
	"adoption",
]);
const SETUP_OUTCOMES = new Set(["started", "succeeded", "failed", "cancelled"]);
const SETUP_REASONS = new Set([
	"invalid_configuration",
	"package_unavailable",
	"package_untrusted",
	"ssh_timeout",
	"ssh_launch_failed",
	"ssh_transport_unknown",
	"remote_prerequisite",
	"remote_setup",
	"remote_identity",
	"identity_changed",
	"incompatible",
	"sandbox_unavailable",
	"handshake_rejected",
	"enrollment_failed",
	"adoption_failed",
	"cancelled",
	"unknown",
]);

function keys(value: Record<string, unknown>, allowed: Set<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

export function parseNativeDiagnostics(value: unknown): NativeDiagnosticsBatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Conflict("Invalid native diagnostics");
	const batch = value as Record<string, unknown>;
	if (
		!keys(batch, ALLOWED_BATCH_KEYS) ||
		batch.schemaVersion !== 1 ||
		!Array.isArray(batch.evidence) ||
		batch.evidence.length > MAX_NATIVE_DIAGNOSTICS ||
		!Number.isSafeInteger(batch.dropped) ||
		(batch.dropped as number) < 0 ||
		(batch.dropped as number) > 1_000_000
	)
		throw new Conflict("Invalid native diagnostics");
	const refs = new Set<string>();
	const setupSequences = new Set<string>();
	const evidence = batch.evidence.map((value): NativeDiagnosticEvidence | DevboxSetupDiagnosticEvidence => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Conflict("Invalid native evidence");
		const record = value as Record<string, unknown>;
		const kind = record.kind;
		const date = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
		if (kind === "devbox.setup") {
			const setupSequence = `${record.attemptRef}:${record.sequence}`;
			if (
				!keys(record, ALLOWED_SETUP_KEYS) ||
				typeof record.ref !== "string" ||
				!SETUP_REF.test(record.ref) ||
				refs.has(record.ref) ||
				typeof record.attemptRef !== "string" ||
				!ATTEMPT_REF.test(record.attemptRef) ||
				!Number.isSafeInteger(record.sequence) ||
				(record.sequence as number) < 0 ||
				(record.sequence as number) > 31 ||
				record.source !== "app" ||
				!Number.isFinite(date) ||
				new Date(date).toISOString() !== record.at ||
				!SETUP_STAGES.has(record.stage as string) ||
				!SETUP_OUTCOMES.has(record.outcome as string) ||
				(record.reason !== undefined && !SETUP_REASONS.has(record.reason as string)) ||
				(["started", "succeeded"].includes(record.outcome as string) && record.reason !== undefined) ||
				(record.outcome === "failed" && (record.reason === undefined || record.reason === "cancelled")) ||
				(record.outcome === "cancelled" && record.reason !== "cancelled") ||
				setupSequences.has(setupSequence)
			)
				throw new Conflict("Invalid setup evidence");
			refs.add(record.ref);
			setupSequences.add(setupSequence);
			return record as unknown as DevboxSetupDiagnosticEvidence;
		}
		const duration = record.durationMs;
		const window = record.windowMs;
		if (
			!keys(record, ALLOWED_EVIDENCE_KEYS) ||
			typeof record.ref !== "string" ||
			!REF.test(record.ref) ||
			refs.has(record.ref) ||
			record.source !== "os" ||
			(kind !== "native.crash" && kind !== "native.hang") ||
			!Number.isFinite(date) ||
			new Date(date).toISOString() !== record.at ||
			typeof window !== "number" ||
			!Number.isFinite(window) ||
			window < 0 ||
			window > 7 * 24 * 60 * 60 * 1_000 ||
			(record.releaseRelation !== "current" && record.releaseRelation !== "other_or_unknown") ||
			(kind === "native.crash" && (record.reason !== "process_exit" || duration !== undefined)) ||
			(kind === "native.hang" &&
				(record.reason !== "unresponsive" ||
					typeof duration !== "number" ||
					!Number.isFinite(duration) ||
					duration < 0 ||
					duration > 86_400_000))
		)
			throw new Conflict("Invalid native evidence");
		refs.add(record.ref);
		return record as unknown as NativeDiagnosticEvidence;
	});
	const parsed = { schemaVersion: 1 as const, evidence, dropped: batch.dropped as number };
	if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_NATIVE_DIAGNOSTIC_BYTES)
		throw new Conflict("Native diagnostics are too large");
	return parsed;
}

export class NativeDiagnosticsStore {
	readonly file: string;
	private enabled = true;
	private pending: Promise<void> = Promise.resolve();

	constructor(home: string) {
		this.file = join(home, NATIVE_DIAGNOSTICS_FILE);
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	async replace(value: unknown): Promise<void> {
		const batch = parseNativeDiagnostics(value);
		const work = this.pending.then(async () => {
			if (!this.enabled) return;
			await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
			const temporary = `${this.file}.${process.pid}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(batch), { mode: 0o600 });
				await chmod(temporary, 0o600);
				await rename(temporary, this.file);
				await chmod(this.file, 0o600);
			} finally {
				await rm(temporary, { force: true }).catch(() => undefined);
			}
		});
		this.pending = work.catch(() => undefined);
		await work;
	}

	async clear(): Promise<void> {
		const work = this.pending.then(() => rm(this.file, { force: true }));
		this.pending = work.catch(() => undefined);
		await work;
	}
}

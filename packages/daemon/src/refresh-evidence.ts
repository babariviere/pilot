/** Private bounded recent observations. Never restores scheduler state or executes a job. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { OperationHost } from "@pilot/protocol";

export const REFRESH_EVIDENCE_BYTES = 256 * 1024;
export const REFRESH_EVIDENCE_ENTRIES = 128;
export const REFRESH_EVIDENCE_AGE_MS = 7 * 86400_000;
type Value = Record<string, unknown>;
export interface RefreshEvidenceInput {
	ref: string;
	type: "source" | "job";
	value: Value;
}
interface Entry extends RefreshEvidenceInput {
	at: number;
	processRef: string;
	processStartedAt: number;
}
const stages = ["discovery", "classification", "commit", "waiting_replies", "reaction_reads", "parent_headers"];
const jobStages = [
	"issue",
	"states",
	"configuration",
	"prepare",
	"write",
	"confirm",
	"cancellation",
	"lookup",
	"reserve",
	"classification",
	"commit",
	"remove_eyes",
	"eligibility",
];
const outcomes = ["success", "partial", "failure", "budget_limited", "cancelled"];
const jobOutcomes = ["success", "no_work", "skipped", "partial", "failure", "cancelled", "backoff"];
const reasons = [
	"sign_in",
	"provider_rate_limit",
	"local_classification_budget",
	"local_read_budget",
	"channel_read",
	"classification_failed",
	"classifier_unavailable",
	"batch_limit",
	"timeout",
	"config_changed",
	"stopped",
	"delivery_deferred",
	"read_failed",
	"unknown",
	"access_denied",
	"not_found",
	"configuration",
	"transport",
	"rate_limited",
	"invalid_response",
	"write_failed",
	"remote_error",
	"shared_slot_capacity",
	"eligibility",
	"cooldown",
	"superseded",
];
function object(value: unknown): value is Value {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function closed(value: Value, fields: string[]): boolean {
	return Object.keys(value).every((key) => fields.includes(key));
}
function numbers(value: Value, fields: string[]): boolean {
	return fields.every(
		(key) =>
			value[key] === undefined ||
			(Number.isSafeInteger(value[key]) && (value[key] as number) >= 0 && (value[key] as number) <= 9e15),
	);
}
function choice(value: unknown, values: string[]): boolean {
	return value === undefined || (typeof value === "string" && values.includes(value));
}
const hex = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Strict before-disk and after-load sanitizer. No arbitrary keys, text, identifiers or error payloads. */
export function validRefreshValue(type: "source" | "job", value: unknown): value is Value {
	if (!object(value)) return false;
	if (type === "source") {
		const numeric = ["lastAttemptAt", "lastStartedAt", "lastCompletedAt", "lastCommittedAt", "returnedItems"];
		if (
			!closed(value, [...numeric, "outcome", "reason", "stages"]) ||
			!numbers(value, numeric) ||
			value.lastAttemptAt === undefined ||
			value.lastStartedAt === undefined ||
			(value.returnedItems !== undefined && (value.returnedItems as number) > 1_000_000) ||
			!choice(value.outcome, outcomes) ||
			!choice(value.reason, reasons.slice(0, 14)) ||
			!Array.isArray(value.stages) ||
			value.stages.length > 6
		)
			return false;
		return (
			new Set(value.stages.map((s) => s?.stage)).size === value.stages.length &&
			value.stages.every((stage) => {
				const counts = ["channelIndex", "count", "requested", "readAttempts", "cacheHits"];
				const times = ["lastStartedAt", "lastCompletedAt", "lastSucceededAt"];
				return (
					object(stage) &&
					typeof stage.stage === "string" &&
					stages.includes(stage.stage) &&
					closed(stage, ["stage", ...counts, ...times, "outcome", "reason"]) &&
					numbers(stage, [...counts, ...times]) &&
					counts.every((key) => stage[key] === undefined || (stage[key] as number) <= 1_000_000) &&
					choice(stage.outcome, outcomes) &&
					choice(stage.reason, reasons.slice(0, 14))
				);
			})
		);
	}
	const times = ["queuedAt", "nextDueAt", "startedAt", "completedAt", "stageStartedAt", "stageCompletedAt"];
	const counts = ["readCalls", "writeCalls", "count"];
	if (
		!closed(value, [
			"job",
			"kind",
			"queued",
			...times,
			...counts,
			"stage",
			"outcome",
			"reason",
			"failure",
			"recent",
		]) ||
		!choice(value.job, [
			"linked_linear_sync",
			"manual_lookup",
			"slack_done_write",
			"triage_rebuild",
			"linear_parent_header",
		]) ||
		!value.job ||
		!choice(value.kind, ["slack", "linear"]) ||
		!value.kind ||
		!numbers(value, [...times, ...counts]) ||
		counts.some((key) => value[key] !== undefined && (value[key] as number) > 1_000_000) ||
		(value.queued !== undefined && typeof value.queued !== "boolean") ||
		!choice(value.stage, jobStages) ||
		!choice(value.outcome, jobOutcomes) ||
		!choice(value.reason, reasons)
	)
		return false;
	if (
		value.failure !== undefined &&
		(!object(value.failure) ||
			!closed(value.failure, ["stage", "category"]) ||
			!jobStages.includes(value.failure.stage as string) ||
			!reasons.includes(value.failure.category as string))
	)
		return false;
	return (
		value.recent === undefined ||
		(Array.isArray(value.recent) &&
			value.recent.length <= 4 &&
			value.recent.every(
				(row) =>
					object(row) &&
					closed(row, ["at", "outcome", "reason", "stage", ...counts]) &&
					numbers(row, ["at", ...counts]) &&
					row.at !== undefined &&
					row.outcome !== undefined &&
					choice(row.outcome, jobOutcomes) &&
					choice(row.reason, reasons) &&
					choice(row.stage, jobStages) &&
					counts.every((key) => row[key] === undefined || (row[key] as number) <= 1_000_000),
			))
	);
}

/** Do not renew old completion details just because a newer attempt is being saved. */
function freshValue(type: "source" | "job", value: Value, now: number): Value {
	const safe = structuredClone(value),
		cutoff = now - REFRESH_EVIDENCE_AGE_MS;
	if (Array.isArray(safe.recent))
		safe.recent = safe.recent.filter(
			(row) => object(row) && typeof row.at === "number" && row.at >= cutoff && row.at <= now,
		);
	if (type === "source") {
		if (typeof safe.lastCompletedAt === "number" && safe.lastCompletedAt < cutoff) {
			delete safe.lastCompletedAt;
			delete safe.outcome;
			delete safe.reason;
		}
		if (typeof safe.lastCommittedAt === "number" && safe.lastCommittedAt < cutoff) {
			delete safe.lastCommittedAt;
			delete safe.returnedItems;
		}
		if (Array.isArray(safe.stages))
			safe.stages = safe.stages
				.map((stage) => {
					if (!object(stage)) return stage;
					if (typeof stage.lastCompletedAt === "number" && stage.lastCompletedAt < cutoff)
						for (const key of [
							"lastCompletedAt",
							"outcome",
							"reason",
							"count",
							"requested",
							"readAttempts",
							"cacheHits",
							"channelIndex",
						])
							delete stage[key];
					for (const key of ["lastStartedAt", "lastSucceededAt"])
						if (typeof stage[key] === "number" && (stage[key] as number) < cutoff) delete stage[key];
					return stage;
				})
				.filter(
					(stage) =>
						object(stage) &&
						(stage.lastStartedAt !== undefined ||
							stage.lastCompletedAt !== undefined ||
							stage.lastSucceededAt !== undefined),
				);
	}
	return safe;
}

export class RefreshEvidenceStore {
	private readonly directory: string;
	private readonly file: string;
	private readonly temporary: string;
	private readonly hostHash: string;
	readonly processRef = randomUUID();
	readonly processStartedAt: number;
	private enabled: boolean;
	private revision = 0;
	private entries: Entry[] = [];
	private collect?: () => RefreshEvidenceInput[];
	private dirty = false;
	private timer?: ReturnType<typeof setTimeout>;
	private expiry?: ReturnType<typeof setInterval>;
	private writing?: Promise<void>;
	private clearing?: Promise<void>;
	private error?: "read_failed" | "write_failed" | "unsafe_source" | "corrupt" | "version";
	private blocked = false;
	private closed = false;
	private dropped = 0;
	private savedAt?: number;
	private readonly now: () => number;
	private readonly beforeCommit?: () => Promise<void>;
	constructor(options: {
		directory: string;
		host: OperationHost;
		enabled: boolean;
		now?: () => number;
		beforeCommit?: () => Promise<void>;
	}) {
		this.directory = options.directory;
		this.file = join(options.directory, "refresh-health.json");
		this.temporary = join(options.directory, ".refresh-health.tmp");
		this.hostHash = createHash("sha256")
			.update(JSON.stringify([options.host.hostId, options.host.daemonId, options.host.lineageId]))
			.digest("hex");
		this.enabled = options.enabled;
		this.now = options.now ?? Date.now;
		this.processStartedAt = this.now();
		this.beforeCommit = options.beforeCommit;
	}
	ref(type: "source" | "job", id: string, key: string): string {
		return createHash("sha256")
			.update(JSON.stringify([this.hostHash, type, id, key]))
			.digest("hex");
	}
	coverage() {
		return {
			enabled: this.enabled,
			version: 1,
			retentionMs: REFRESH_EVIDENCE_AGE_MS,
			entryLimit: REFRESH_EVIDENCE_ENTRIES,
			byteLimit: REFRESH_EVIDENCE_BYTES,
			processesPerKey: 2,
			dropped: this.dropped,
			error: this.error,
			lastSavedAt: this.savedAt,
			provenance: "previous_process_observations_never_current_liveness",
		};
	}
	private async root(create = false): Promise<void> {
		if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const stat = await lstat(this.directory);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid?.() ||
			stat.mode & 0o077 ||
			(await realpath(this.directory)) !== this.directory
		)
			throw new Error("Unsafe evidence root");
	}
	private async source(read = true) {
		await this.root();
		const file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			if (
				!stat.isFile() ||
				stat.uid !== process.getuid?.() ||
				stat.mode & 0o077 ||
				(read && stat.size > REFRESH_EVIDENCE_BYTES)
			)
				throw new Error("Unsafe evidence file");
			if (!read) return "";
			const bytes = Buffer.alloc(REFRESH_EVIDENCE_BYTES + 1),
				result = await file.read(bytes, 0, bytes.length, 0);
			if (result.bytesRead > REFRESH_EVIDENCE_BYTES) throw new Error("Oversized evidence file");
			return bytes.subarray(0, result.bytesRead).toString("utf8");
		} finally {
			await file.close();
		}
	}
	private async removeStaging(): Promise<void> {
		try {
			const stat = await lstat(this.temporary);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
				throw new Error("Unsafe staging file");
			await rm(this.temporary);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	async load(): Promise<void> {
		if (this.closed) return;
		const revision = this.revision;
		if (!this.enabled) {
			await this.clear().catch(() => undefined);
			return;
		}
		try {
			await this.root();
			await this.removeStaging();
			const value = JSON.parse(await this.source());
			if (revision !== this.revision || this.closed) return;
			if (value.schemaVersion !== 1) {
				this.error = "version";
				this.blocked = true;
				return;
			}
			if (
				!object(value) ||
				!closed(value, ["schemaVersion", "host", "entries"]) ||
				value.host !== this.hostHash ||
				!Array.isArray(value.entries) ||
				value.entries.length > REFRESH_EVIDENCE_ENTRIES
			) {
				this.error = "corrupt";
				return;
			}
			const entries = value.entries as Entry[];
			if (
				!entries.every((row) => this.valid(row)) ||
				new Set(entries.map((row) => `${row.ref}:${row.processRef}`)).size !== entries.length
			) {
				this.error = "corrupt";
				return;
			}
			this.entries = entries.filter((row) => this.current(row));
		} catch (error) {
			if (revision === this.revision && (error as NodeJS.ErrnoException).code !== "ENOENT")
				this.error = "read_failed";
		}
		if (this.closed) return;
		this.expiry ??= setInterval(() => {
			if (this.enabled && this.entries.some((row) => !this.current(row)) && this.collect)
				this.schedule(this.collect);
		}, 3_600_000);
		this.expiry.unref();
	}
	private current(row: Entry): boolean {
		return row.at <= this.now() && row.at >= this.now() - REFRESH_EVIDENCE_AGE_MS;
	}
	private valid(row: Entry): boolean {
		return (
			object(row) &&
			closed(row as unknown as Value, ["ref", "type", "value", "at", "processRef", "processStartedAt"]) &&
			hex(row.ref) &&
			["source", "job"].includes(row.type) &&
			/^[0-9a-f-]{36}$/.test(row.processRef) &&
			numbers(row as unknown as Value, ["at", "processStartedAt"]) &&
			row.at !== undefined &&
			row.processStartedAt !== undefined &&
			validRefreshValue(row.type, row.value)
		);
	}
	read(ref: string) {
		if (!this.enabled) return;
		const row = this.entries
			.filter((row) => row.ref === ref && row.processRef !== this.processRef && this.current(row))
			.sort((a, b) => b.at - a.at)[0];
		if (!row) return;
		const observation = freshValue(row.type, row.value, this.now());
		const start = (observation.startedAt ?? observation.lastStartedAt) as number | undefined;
		const complete = (observation.completedAt ?? observation.lastCompletedAt) as number | undefined;
		const interrupted =
			observation.queued === true || (start !== undefined && (complete === undefined || complete < start));
		const previousDueAt = observation.nextDueAt;
		delete observation.nextDueAt;
		delete observation.queued;
		return {
			recordedAt: row.at,
			processStartedAt: row.processStartedAt,
			state: interrupted ? "interrupted_unknown" : "historical_observation",
			provenance: "previous_process_not_current_liveness",
			previousDueAt,
			observation,
		};
	}
	schedule(collect: () => RefreshEvidenceInput[]): void {
		if (this.closed) return;
		this.collect = collect;
		if (!this.enabled || this.blocked) return;
		this.dirty = true;
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			void this.flush().catch(() => {
				this.error = "write_failed";
			});
		}, 1000);
		this.timer.unref();
	}
	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		if (!enabled) void this.clear().catch(() => undefined);
		else if (this.collect) this.schedule(this.collect);
	}
	async flush(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		await this.clearing;
		if (this.writing) {
			await this.writing;
			if (this.dirty) await this.flush();
			return;
		}
		if (!this.enabled || !this.dirty || this.blocked || !this.collect) return;
		this.dirty = false;
		const revision = this.revision;
		this.writing = this.save(revision)
			.catch(() => {
				this.error = "write_failed";
			})
			.finally(() => {
				this.writing = undefined;
			});
		await this.writing;
		if (this.dirty) await this.flush();
	}
	private async save(revision: number): Promise<void> {
		const now = this.now();
		const inputs = this.collect!();
		this.dropped = Math.min(1_000_000, this.dropped + Math.max(0, inputs.length - REFRESH_EVIDENCE_ENTRIES));
		const rows = inputs
			.slice(0, REFRESH_EVIDENCE_ENTRIES)
			.filter((row) => hex(row.ref) && validRefreshValue(row.type, row.value))
			.map((row) => ({ ...row, value: freshValue(row.type, row.value, now) }));
		let next = this.entries
			.filter((row) => this.current(row))
			.map((row) => ({ ...row, value: freshValue(row.type, row.value, now) }));
		for (const row of rows) {
			next = next.filter((old) => !(old.ref === row.ref && old.processRef === this.processRef));
			const dates =
				row.type === "source"
					? [row.value.lastAttemptAt, row.value.lastCompletedAt, row.value.lastCommittedAt]
					: [
							row.value.queuedAt,
							row.value.startedAt,
							row.value.completedAt,
							row.value.stageStartedAt,
							row.value.stageCompletedAt,
						];
			const at = Math.max(0, ...dates.filter((value): value is number => typeof value === "number" && value <= now));
			if (at >= now - REFRESH_EVIDENCE_AGE_MS)
				next.push({ ...row, at, processRef: this.processRef, processStartedAt: this.processStartedAt });
		}
		next.sort(
			(a, b) => b.at - a.at || Number(b.processRef === this.processRef) - Number(a.processRef === this.processRef),
		);
		const perKey = new Map<string, number>();
		next = next.filter((row) => {
			const n = (perKey.get(row.ref) ?? 0) + 1;
			perKey.set(row.ref, n);
			return n <= 2;
		});
		this.dropped = Math.min(1_000_000, this.dropped + Math.max(0, next.length - REFRESH_EVIDENCE_ENTRIES));
		next = next.slice(0, REFRESH_EVIDENCE_ENTRIES);
		const prefix = `{"schemaVersion":1,"host":"${this.hostHash}","entries":[`;
		const serialized: string[] = [];
		let bytes = Buffer.byteLength(prefix) + 2;
		for (const row of next) {
			const text = JSON.stringify(row),
				size = Buffer.byteLength(text) + (serialized.length ? 1 : 0);
			if (bytes + size > REFRESH_EVIDENCE_BYTES) break;
			serialized.push(text);
			bytes += size;
		}
		this.dropped = Math.min(1_000_000, this.dropped + next.length - serialized.length);
		next = next.slice(0, serialized.length);
		const text = `${prefix}${serialized.join(",")}]}`;
		await this.root(true);
		try {
			await this.source(false);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const temporary = this.temporary;
		await this.removeStaging();
		try {
			const file = await open(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await file.writeFile(text);
				await file.sync();
			} finally {
				await file.close();
			}
			await this.beforeCommit?.();
			if (revision !== this.revision || !this.enabled) return;
			await rename(temporary, this.file);
			const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			if (revision === this.revision) {
				this.entries = next;
				this.error = undefined;
				this.savedAt = now;
			}
		} finally {
			await rm(temporary, { force: true });
		}
	}
	async clear(): Promise<void> {
		this.revision++;
		this.entries = [];
		this.dirty = false;
		this.blocked = false;
		this.dropped = 0;
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.clearing) return this.clearing;
		this.clearing = (async () => {
			await this.writing;
			try {
				await this.root();
				await this.removeStaging();
				try {
					await this.source(false);
					await rm(this.file, { force: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
				this.error = undefined;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					this.error = "unsafe_source";
					throw new Error("Could not clear retained refresh evidence");
				}
				this.error = undefined;
			}
		})().finally(() => {
			this.clearing = undefined;
		});
		return this.clearing;
	}
	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.expiry);
		await this.flush();
	}
}

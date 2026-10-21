/** Bounded numeric source evidence. Independent I/O failures must not fail Harness storage. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { UsageObservation } from "@pilot/protocol";

export type CaptureJournalState = {
	schemaVersion: 1;
	sourceId: string;
	parent: UsageObservation["parent"] | null;
	revision: number;
	rows: { row: UsageObservation; settled: boolean; pendingTaskId?: number }[];
};
const MAX_BYTES = 132 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = new Set([
	"schemaVersion",
	"generation",
	"sourceId",
	"operationId",
	"revision",
	"kind",
	"scope",
	"observedAt",
	"completedAt",
	"coverage",
	"purpose",
	"attribution",
	"physicalModel",
	"virtualModel",
	"virtualRevision",
	"parent",
	"tokens",
	"cost",
	"activity",
	"requests",
	"providerAttempts",
	"retries",
	"durationMs",
	"outcome",
]);

function fields(value: unknown, allowed: readonly string[]): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => allowed.includes(key))
	);
}
function sourceRecord(row: UsageObservation): boolean {
	return (
		fields(row, [...FIELDS]) &&
		(row.attribution === undefined ||
			(fields(row.attribution, ["projectId", "chatId", "attemptId", "runId", "mission"]) &&
				(row.attribution.mission === undefined ||
					fields(row.attribution.mission, ["homeId", "lineageId", "missionId"])))) &&
		(row.tokens === undefined ||
			fields(row.tokens, ["input", "output", "cacheRead", "cacheWrite", "reasoning", "reasoningStatus"])) &&
		(row.cost === undefined ||
			fields(row.cost, [
				"estimateStatus",
				"estimatedUsdMicros",
				"pricingRevision",
				"billedStatus",
				"billedUsdMicros",
				"subscriptionCoverage",
			])) &&
		(row.parent === undefined || fields(row.parent, ["sourceId", "operationId"])) &&
		[row.physicalModel, row.virtualModel].every(
			(model) => model === undefined || fields(model, ["provider", "model"]),
		)
	);
}

export class CaptureJournal {
	private state: CaptureJournalState;
	private tail: Promise<unknown> = Promise.resolve();
	private disabled = false;
	private closed = false;
	private readonly file?: string;
	constructor(file?: string, parent?: UsageObservation["parent"]) {
		this.file = file;
		this.state = {
			schemaVersion: 1,
			sourceId: randomUUID(),
			parent: parent ? structuredClone(parent) : null,
			revision: 0,
			rows: [],
		};
	}
	async load(): Promise<void> {
		if (!this.file) return;
		try {
			const fd = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const stat = await fd.stat();
				if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid capture source");
				const buffer = Buffer.alloc(MAX_BYTES + 1);
				const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
				if (bytesRead > MAX_BYTES) throw new Error("Invalid capture source");
				const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
				if (
					!fields(value, ["schemaVersion", "sourceId", "parent", "revision", "rows"]) ||
					value.schemaVersion !== 1 ||
					!UUID.test(value.sourceId) ||
					(value.parent !== null &&
						(!fields(value.parent, ["sourceId", "operationId"]) ||
							!UUID.test(value.parent.sourceId) ||
							typeof value.parent.operationId !== "string" ||
							!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(value.parent.operationId))) ||
					!Number.isSafeInteger(value.revision) ||
					value.revision < 0 ||
					!Array.isArray(value.rows) ||
					value.rows.length > 32
				)
					throw new Error("Invalid capture source");
				for (const item of value.rows) {
					if (
						typeof item.settled !== "boolean" ||
						!item.row ||
						!fields(item, ["row", "settled", "pendingTaskId"]) ||
						(item.pendingTaskId !== undefined &&
							(!Number.isSafeInteger(item.pendingTaskId) || item.pendingTaskId < 1)) ||
						!sourceRecord(item.row) ||
						Buffer.byteLength(JSON.stringify(item.row)) > 4096
					)
						throw new Error("Invalid capture source");
					// The daemon's strict allowlist validates every record before accounting ingress.
					if (item.row.sourceId !== value.sourceId || !UUID.test(item.row.generation))
						throw new Error("Invalid capture source");
				}
				this.state = value;
			} finally {
				await fd.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.disabled = true;
		}
	}
	async snapshot(): Promise<CaptureJournalState> {
		await this.tail;
		return structuredClone(this.state);
	}
	update<T>(change: (state: CaptureJournalState) => T): Promise<T | undefined> {
		if (this.closed) return Promise.resolve(undefined);
		const next = this.tail.then(async () => {
			if (this.disabled || this.closed) return;
			const state = structuredClone(this.state);
			const result = change(state);
			const json = JSON.stringify(state);
			if (
				state.rows.length > 32 ||
				Buffer.byteLength(json) > MAX_BYTES ||
				state.rows.some(({ row }) => Buffer.byteLength(JSON.stringify(row)) > 4096)
			)
				return;
			if (json === JSON.stringify(this.state)) return result;
			if (this.file) await this.save(json);
			this.state = state;
			return result;
		});
		this.tail = next.catch(() => undefined);
		return next.catch(() => undefined);
	}
	async close(): Promise<void> {
		this.closed = true;
		await this.tail;
	}
	private async save(json: string): Promise<void> {
		const directory = dirname(this.file!);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		// One source owner (the runtime's existing storage lease), one bounded crash remnant.
		const temporary = `${this.file}.pending`;
		try {
			const fd = await open(temporary, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			try {
				const stat = await fd.stat();
				if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid capture source");
				await fd.chmod(0o600);
				await fd.truncate(0);
				await fd.writeFile(json);
				await fd.sync();
			} finally {
				await fd.close();
			}
			await rename(temporary, this.file!);
			const parent = await open(directory, constants.O_RDONLY);
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}
}

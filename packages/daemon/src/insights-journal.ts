import {
	canonicalJSON,
	type JournalObservation,
	OperationConflict,
	type OperationJournal,
	payloadHash,
} from "./operation-journal.ts";

const isLegacyOperation = (kind: string) => kind.startsWith("insights-") && !kind.startsWith("insights-workspace-");

/** An absent chat needs affirmative retirement evidence. No other legacy operation may have entered. */
function revokedMissingChat(entries: JournalObservation[]): boolean {
	if (entries.length !== 2) return false;
	const create = entries.find((r) => r.operation.kind === "insights-create");
	const revoke = entries.find((r) => r.operation.kind === "insights-revoke");
	if (!create || !revoke) return false;
	const a = create.operation;
	const b = revoke.operation;
	if (a.producerId !== b.producerId || canonicalJSON(a.origin) !== canonicalJSON(b.origin) || a.sequence >= b.sequence)
		return false;
	try {
		const { expectedRevision } = JSON.parse(b.payload);
		return (
			Number.isSafeInteger(expectedRevision) &&
			expectedRevision >= 1 &&
			canonicalJSON(create.receipt.result) === canonicalJSON({ sessionId: a.targetId }) &&
			canonicalJSON(revoke.receipt.result) ===
				canonicalJSON({ sessionId: b.targetId, revision: expectedRevision + 1 })
		);
	} catch {
		return false;
	}
}

/** Insights migration policy over the journal's serialized records and synchronous reservation fence. */
export class InsightsJournal {
	private readonly journal: OperationJournal;
	constructor(journal: OperationJournal) {
		this.journal = journal;
	}
	/** Bounded private projection for one replacement. Never expose operation payloads to clients. */
	async replacementReferences(projectId: string, missionId: string, oldId: string, excludeId?: string) {
		return this.journal.readRecords(({ records }) => {
			const items: import("@pilot/protocol").InsightsReplacementReference[] = [];
			let qualified = false;
			const qualifications: Array<{ context: unknown; home: unknown }> = [];
			for (const { operation: op, receipt } of records) {
				if (op.operationId === excludeId || receipt.state === "rejected") continue;
				if (op.targetId !== oldId && !op.kind.startsWith("insights-")) continue;
				let p: Record<string, unknown> | undefined;
				try {
					if (op.kind.startsWith("insights-")) p = JSON.parse(op.payload);
				} catch {
					/* Unparseable target intent still fences. */
				}
				// Marker-less contenders have entered no effect. The synchronous scope owner and
				// durable CAS choose one. Passive preview still refuses these pending contenders.
				if (
					excludeId &&
					op.kind === "insights-replace" &&
					p?.oldSessionId === oldId &&
					receipt.state === "pending" &&
					receipt.result === undefined
				)
					continue;
				const scope = op.kind.startsWith("insights-") && p?.projectId === projectId && p?.missionId === missionId;
				if (op.targetId !== oldId && !scope) continue;
				if (items.length === 32) return { items, overflow: true, qualified, qualifications };
				items.push({
					operationId: op.operationId,
					kind: op.kind,
					targetId: op.targetId,
					state: receipt.state,
					payloadHash: op.payloadHash,
				});
				if (
					scope &&
					op.targetId === oldId &&
					receipt.state === "accepted" &&
					(op.kind === "insights-enable" || (op.kind === "insights-replace" && p?.successorSessionId === oldId))
				) {
					qualified = true;
					qualifications.push({ context: p!.context, home: p!.expectedHome });
				}
			}
			return { items, overflow: false, qualified, qualifications };
		});
	}
	/** Retained intent is a refusal fence, not proof a resource still exists or a grant remains valid. */
	async legacyTransitionCapture(projectId: string, missionId: string, oldId: string) {
		const select = await this.journal.openReader(({ records: entries, failed, pendingKinds }) => {
			if (failed || [...pendingKinds].some(isLegacyOperation))
				throw new OperationConflict("legacy_journal_busy_or_unavailable");
			const records: JournalObservation[] = [];
			for (const record of entries) {
				const { operation: op, receipt } = record;
				if (receipt.state === "rejected" || op.kind.startsWith("insights-workspace-")) continue;
				if (op.targetId !== oldId) {
					if (op.kind.startsWith("insights-"))
						throw new OperationConflict("other_legacy_operation_requires_combined_recovery");
					continue;
				}
				if (records.length === 32) throw new OperationConflict("legacy_operation_snapshot_capacity");
				records.push(record);
			}
			records.sort((a, b) =>
				a.operation.operationId < b.operation.operationId
					? -1
					: a.operation.operationId > b.operation.operationId
						? 1
						: 0,
			);
			return records.map((record) => ({
				operationId: record.operation.operationId,
				original: record.original(),
			}));
		});
		const envelopes = select(),
			digest = payloadHash(JSON.stringify(envelopes));
		const guard = () => {
			if (payloadHash(JSON.stringify(select())) !== digest)
				throw new OperationConflict("legacy_operations_changed_during_transition");
		};
		const references = await this.replacementReferences(projectId, missionId, oldId);
		guard();
		return { envelopes, references, hash: digest, guard };
	}
	/** Archived receipts never grant permission. This only refuses later unqualified legacy effects. */
	async transferredLegacyGuard(allowed: Array<{ operationId: string; original: string }>, oldIds: string[]) {
		const originals = new Map(allowed.map((entry) => [entry.operationId, entry.original]));
		return this.journal.openReader(({ records, failed, pendingKinds }) => {
			if (failed || [...pendingKinds].some(isLegacyOperation))
				throw new OperationConflict("legacy_journal_busy_or_unavailable");
			for (const record of records) {
				if (record.operation.kind.startsWith("insights-workspace-") || record.receipt.state === "rejected")
					continue;
				if (!record.operation.kind.startsWith("insights-") && !oldIds.includes(record.operation.targetId)) continue;
				if (
					!originals.has(record.operation.operationId) ||
					originals.get(record.operation.operationId) !== record.original()
				)
					throw new OperationConflict("unexpected_legacy_operation_after_transfer");
			}
		});
	}
	/** Retained intent is a refusal fence, not proof a resource still exists or a grant remains valid. */
	async freshDayExecutionGuard(knownReports: string[], proveAbsent?: (id: string) => Promise<() => void>) {
		const read = await this.journal.openReader(({ records, failed, pendingKinds }) => {
			if (failed || [...pendingKinds].some(isLegacyOperation))
				throw new OperationConflict("legacy_journal_busy_or_unavailable");
			const missing = new Map<string, JournalObservation[]>();
			for (const entry of records) {
				const { operation: op, receipt } = entry;
				if (!isLegacyOperation(op.kind) || receipt.state === "rejected") continue;
				if (receipt.state === "pending") throw new OperationConflict("legacy_execution_not_proven_quiescent");
				if (knownReports.includes(op.targetId)) continue;
				const group = missing.get(op.targetId) ?? [];
				group.push(entry);
				missing.set(op.targetId, group);
			}
			if (missing.size > 64 || (missing.size && !proveAbsent))
				throw new OperationConflict("legacy_execution_not_proven_quiescent");
			for (const entries of missing.values())
				if (!revokedMissingChat(entries)) throw new OperationConflict("legacy_execution_not_proven_quiescent");
			return missing;
		});
		const original = read();
		const guards = new Map<string, () => void>();
		for (const id of original.keys()) guards.set(id, await proveAbsent!(id));
		return () => {
			const current = read();
			if (original.size !== current.size) throw new OperationConflict("legacy_execution_not_proven_quiescent");
			for (const [id, entries] of original) {
				const now = current.get(id);
				if (!now || entries.some((entry) => !now.some((r) => r.original() === entry.original())))
					throw new OperationConflict("legacy_execution_not_proven_quiescent");
				guards.get(id)!();
			}
		};
	}
	async legacyInsightsGuard(): Promise<() => void> {
		// Check live reservations synchronously again at the owner transaction boundary.
		// A prior absent observation is never authority to ignore a later v1 reservation.
		return this.journal.openReader(({ records, failed, pendingKinds }) => {
			if (failed) throw new OperationConflict("Insights journal is unavailable");
			if ([...pendingKinds].some(isLegacyOperation)) throw new OperationConflict("insights_journal_busy_refresh");
			for (const { operation, receipt } of records)
				if (
					operation.kind.startsWith("insights-") &&
					!operation.kind.startsWith("insights-workspace-") &&
					receipt.state !== "rejected"
				)
					throw new OperationConflict("legacy_transition_required");
		});
	}
}

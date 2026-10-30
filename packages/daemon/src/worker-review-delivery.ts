/** Lifecycle-owned, bounded drain. Review GETs never call this writer. */
import type { JjOwnershipStore } from "./jj-ownership.ts";
import type { JjDeliveryFailure, JjOwnershipBinding } from "./jj-ownership-contract.ts";
import type { ReviewSnapshotStore } from "./review-snapshots.ts";

export class WorkerReviewDelivery {
	private readonly active = new Map<string, { work: Promise<void>; again: boolean }>();
	private tail: Promise<void> = Promise.resolve();
	private closing = false;
	private readonly ledger: Pick<JjOwnershipStore, "deliveries" | "get" | "settleDelivery">;
	private readonly snapshots: Pick<ReviewSnapshotStore, "capture">;
	constructor(
		ledger: Pick<JjOwnershipStore, "deliveries" | "get" | "settleDelivery">,
		snapshots: Pick<ReviewSnapshotStore, "capture">,
	) {
		this.ledger = ledger;
		this.snapshots = snapshots;
	}

	checkpoint(
		id: string,
		admit: () => Promise<JjOwnershipBinding | undefined>,
		observe: () => Promise<void>,
	): Promise<void> {
		const prior = this.active.get(id);
		if (prior) {
			prior.again = true;
			return prior.work;
		}
		if (this.closing || this.active.size >= 8)
			return Promise.reject(new Error("Worker review checkpoint busy or closed"));
		const entry = { work: Promise.resolve(), again: false };
		const pass = async () => {
			const binding = await admit();
			if (!binding || this.closing) return;
			await observe(); // Observation and exact requests commit together before cursor advancement.
			const check = async () => {
				if (this.closing || JSON.stringify(await admit()) !== JSON.stringify(binding))
					throw new Error("Worker review custody changed");
			};
			await check();
			// At most four comparisons per lifecycle event; remaining work stays visibly pending.
			for (const request of await this.ledger.deliveries(binding)) {
				try {
					const checkOwner = async () => {
						await check();
						const owner = (await this.ledger.get(request.repositoryId, request.changeId)).ownership;
						if (
							request.repositoryId !== binding.repositoryId ||
							owner.status !== "owned" ||
							JSON.stringify(owner.binding) !== JSON.stringify(binding)
						)
							throw new Error("Worker review ownership unavailable");
						await check();
					};
					await checkOwner();
					const saved = await this.snapshots.capture(request);
					await checkOwner();
					await this.ledger.settleDelivery(binding, request, false);
					console.info(
						`pilotd: worker review retained (worker=${binding.sessionId}, request=${request.requestId}, snapshot=${saved.snapshotId}, status=${saved.manifest.status})`,
					);
				} catch (error) {
					// No raw provider/path error is stored or exposed. The exact request remains retryable.
					await this.ledger.settleDelivery(binding, request, true, failureKind(error));
					console.warn(
						`pilotd: worker review capture failed (worker=${binding.sessionId}, request=${request.requestId}, reason=${failureKind(error)})`,
					);
				}
			}
		};
		const work = this.tail
			.then(async () => {
				do {
					entry.again = false;
					await pass();
				} while (entry.again && !this.closing);
			})
			.finally(() => this.active.delete(id));
		this.tail = work.catch(() => undefined);
		entry.work = work;
		this.active.set(id, entry);
		return work;
	}
	async close(): Promise<void> {
		this.closing = true;
		await this.tail;
	}
}

function failureKind(error: unknown): JjDeliveryFailure {
	const message = error instanceof Error ? error.message : "";
	if (/custody|ownership/i.test(message)) return "custody-unavailable";
	if (/busy/i.test(message)) return "store-busy";
	if (/quota|full/i.test(message)) return "retention-quota";
	if (/abort|interrupt|timed out|closed/i.test(message)) return "interrupted";
	if (/conflicted/i.test(message)) return "conflicted";
	if (/repository|revision|object|operation|conflict/i.test(message)) return "pinned-source-unavailable";
	return "capture-failed";
}

/** Lossless completion REFERENCES only, not MissionReviewResult, Pass or gate evidence. */
import { canonicalJSON } from "./operation-journal.ts";
import type { RetainedReviewProducerClaim, RetainedReviewTargetClaim } from "./retained-review-linkage-contract.ts";
import type { MissionDbPort } from "./mission-database.ts";

export const RETAINED_PROJECTION_SCHEMA = `CREATE TABLE IF NOT EXISTS retained_review_projections (
 operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL
);`;
export interface RetainedRunProjection {
	version: 1;
	kind: "retained-run-reference";
	operationId: string;
	target: RetainedReviewTargetClaim;
	producer: RetainedReviewProducerClaim;
	consentOperationId: string;
}
export class RetainedReviewProjections {
	private readonly port: MissionDbPort;
	constructor(port: MissionDbPort) {
		this.port = port;
	}
	async record(value: RetainedRunProjection, revalidate: () => void): Promise<RetainedRunProjection> {
		const pinned = structuredClone(value),
			body = canonicalJSON(pinned);
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(pinned.operationId) || Buffer.byteLength(body) > 64 * 1024)
			throw new Error("Invalid retained projection identity/size");
		this.port.transaction(() => {
			revalidate();
			const row = this.port.one(
				"SELECT record FROM retained_review_projections WHERE operation_id=? OR run_id=?",
				pinned.operationId,
				pinned.producer.runId,
			);
			if (row) {
				if (row.record !== body) throw new Error("Immutable retained projection conflict");
				return;
			}
			this.port.run(
				"INSERT INTO retained_review_projections VALUES(?,?,?)",
				pinned.operationId,
				pinned.producer.runId,
				body,
			);
		});
		await this.port.durable();
		revalidate();
		return pinned;
	}
}

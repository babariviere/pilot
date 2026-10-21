import type { MissionAction, MissionContext } from "@pilot/kernel";
import type { ArtifactRevision, DelegationGrant, OperationHost } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { MissionStore } from "./missions.ts";

export const isRetiredDevboxOperation = (kind: string): boolean =>
	kind.startsWith("share-") || kind.startsWith("control.");

/** Compatibility boundary only. No replication, subscriptions, recovery or remote execution. */
export interface LegacyExecutionRecord {
	grant: DelegationGrant;
	operationId: string;
	state: "accepted" | "cancel_requested" | "sealed";
	sequence: number;
}
export interface LegacySessionOwnership {
	membership(sessionId: string): LegacyExecutionRecord | undefined;
	assertAdmission(sessionId: string): void;
	assertCreate(sessionId: string, operationId: string): void;
	assertRunnable(sessionId: string): Promise<void>;
	readArtifact(sessionId: string, artifactId: string, revision?: number): Promise<Omit<ArtifactRevision, "html">>;
	memoryCall(
		sessionId: string,
		action: "wake" | "recall" | "zoom" | "note",
		args: Record<string, unknown>,
	): Promise<unknown>;
}
export interface LegacyMissionOwnership {
	readonly host: OperationHost;
	membership(sessionId: string): LegacyExecutionRecord | undefined;
	context(sessionId: string): MissionContext | undefined;
	missionCall(sessionId: string, action: MissionAction, args: Record<string, unknown>): Promise<unknown>;
	remoteOccupied(missionId: string): boolean;
	missionAllocations(missionId: string): unknown[];
}

/** Read old ownership records without releasing grants, replaying work or treating replicas as Local. */
export class RetiredDevboxes implements LegacySessionOwnership, LegacyMissionOwnership {
	readonly host: OperationHost;
	private readonly store: Pick<MissionStore, "sharingGet" | "sharedMissionGrants" | "sharingList">;
	constructor(host: OperationHost, store: Pick<MissionStore, "sharingGet" | "sharedMissionGrants" | "sharingList">) {
		this.host = host;
		this.store = store;
	}

	membership(sessionId: string): LegacyExecutionRecord | undefined {
		const entry = this.store.sharingGet<{ scope: string; id: string }>("execution-session", sessionId);
		if (!entry) return undefined;
		if (typeof entry.scope !== "string" || typeof entry.id !== "string") this.unavailable();
		const execution = this.store.sharingGet<LegacyExecutionRecord>(entry.scope, entry.id);
		if (!execution) this.unavailable();
		return execution;
	}

	assertAdmission(sessionId: string): void {
		if (this.membership(sessionId)) this.unavailable();
	}

	assertCreate(sessionId: string, _operationId: string): void {
		this.assertAdmission(sessionId);
	}

	async assertRunnable(sessionId: string): Promise<void> {
		this.assertAdmission(sessionId);
	}

	context: LegacyMissionOwnership["context"] = () => this.unavailable();
	missionCall: LegacyMissionOwnership["missionCall"] = async () => this.unavailable();
	memoryCall: LegacySessionOwnership["memoryCall"] = async () => this.unavailable();
	readArtifact: LegacySessionOwnership["readArtifact"] = async () => this.unavailable();

	remoteOccupied(missionId: string): boolean {
		return this.store.sharedMissionGrants(missionId).some((grant) => grant.state !== "sealed");
	}

	missionAllocations(missionId: string): unknown[] {
		return this.store.sharedMissionGrants(missionId).map((grant) => ({
			grant,
			lastKnown: this.store.sharingGet("remote-projection", grant.delegationId),
			artifacts: this.store.sharingList(`remote-artifacts:${grant.delegationId}`),
			ownershipOccupied: grant.state !== "sealed",
			availability: "remote-devboxes-retired",
		}));
	}

	private unavailable(): never {
		throw new Conflict(
			"Remote devboxes are retired. Stored history and ownership are retained; work is not moved to Local.",
		);
	}
}

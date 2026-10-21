import type { OperationHost } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import type { SharedContextService } from "./shared-context.ts";

/** Compatibility boundary only. No replication, subscriptions, recovery or remote execution. */
export type SessionSharedContext = Pick<
	SharedContextService,
	"membership" | "assertAdmission" | "assertCreate" | "assertRunnable" | "readArtifact" | "memoryCall"
>;
export type MissionSharedContext = Pick<
	SharedContextService,
	"host" | "membership" | "context" | "missionCall" | "remoteOccupied" | "missionAllocations"
>;

/** Read old ownership records without releasing grants, replaying work or treating replicas as Local. */
export class RetiredDevboxes implements SessionSharedContext, MissionSharedContext {
	readonly host: OperationHost;
	private readonly store: Pick<MissionStore, "sharingGet" | "sharedMissionGrants" | "sharingList">;
	constructor(host: OperationHost, store: Pick<MissionStore, "sharingGet" | "sharedMissionGrants" | "sharingList">) {
		this.host = host;
		this.store = store;
	}

	membership(sessionId: string): ReturnType<SharedContextService["membership"]> {
		const entry = this.store.sharingGet<{ scope: string; id: string }>("execution-session", sessionId);
		if (!entry) return undefined;
		if (typeof entry.scope !== "string" || typeof entry.id !== "string") this.unavailable();
		const execution = this.store.sharingGet<ReturnType<SharedContextService["membership"]>>(entry.scope, entry.id);
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

	context: SharedContextService["context"] = () => this.unavailable();
	missionCall: SharedContextService["missionCall"] = async () => this.unavailable();
	memoryCall: SharedContextService["memoryCall"] = async () => this.unavailable();
	readArtifact: SharedContextService["readArtifact"] = async () => this.unavailable();

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

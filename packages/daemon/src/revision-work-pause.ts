import { Conflict } from "./errors.ts";
import type { MissionResumeFence } from "./lifecycle-checkpoint.ts";
import type { MissionPauseParticipants } from "./mission-controls.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON } from "./operation-journal.ts";

export interface RevisionWorkPause {
	version: 1;
	operationId: string;
	missionId: string;
	proposalId: string;
	digest: string;
	source: string;
	taskIds: string[];
	/** Saved before the first checkpoint. A missing old binding never grants Resume. */
	ownership: ReturnType<typeof revisionPauseOwnership>;
	fence: MissionResumeFence;
	state: "entered" | "paused" | "unknown" | "resuming" | "resumed";
	resumeOperationId?: string;
	resumeSource?: string;
	resumeOwners?: { sessionId: string; ownerId: string }[];
	reason?: string;
	members: { sessionId: string; state: "pending" | "paused" | "held" | "unknown" | "resumed" }[];
}

function revisionPauseOwnership(
	store: MissionStore,
	participants: MissionPauseParticipants,
	missionId: string,
	sessionIds: string[],
) {
	const owners = [...new Set(sessionIds.map((id) => participants.missionWorkOwner(id)))].sort();
	const identity = (id: string) => {
		const session = participants.get(id);
		return { projectId: session?.projectId ?? null, createdAt: session?.createdAt ?? null };
	};
	return {
		projectId: store.require(missionId).projectId,
		members: sessionIds.map((sessionId) => {
			const ownerId = participants.missionWorkOwner(sessionId);
			return {
				sessionId,
				ownerId,
				session: identity(sessionId),
				owner: identity(ownerId),
				membership: store.membership(ownerId) ?? null,
				memberFence: store.interviewOwnerFence(missionId, ownerId),
			};
		}),
		tasks: store.pauseTaskOwnership(missionId, owners),
		flowSessions: participants
			.missionWorkSessions(missionId)
			.filter((id) => owners.includes(participants.missionWorkOwner(id)))
			.sort(),
	};
}

export function revisionPauseOwnershipMatches(
	store: MissionStore,
	participants: MissionPauseParticipants,
	record: RevisionWorkPause,
): boolean {
	return (
		!!record.ownership &&
		canonicalJSON(record.ownership) ===
			canonicalJSON(
				revisionPauseOwnership(
					store,
					participants,
					record.missionId,
					record.members.map((m) => m.sessionId),
				),
			)
	);
}

/** Exact scope is saved before interruption. No global control or inferred idle acknowledgement. */
export async function pauseRevisionWork(
	store: MissionStore,
	participants: MissionPauseParticipants,
	missionId: string,
	input: { operationId: string; proposalId: string; digest: string; source: string },
): Promise<RevisionWorkPause> {
	const previous = store.controls.revisionPause(input.operationId);
	if (previous) {
		if (
			previous.missionId !== missionId ||
			previous.proposalId !== input.proposalId ||
			previous.digest !== input.digest ||
			previous.source !== input.source
		)
			throw new Conflict("Revision Pause identity changed");
		await store.durable();
		return previous; // Never re-enter an interrupted checkpoint.
	}
	const proposal = store.revisions.get(missionId, input.proposalId);
	if (
		proposal.digest !== input.digest ||
		proposal.source !== input.source ||
		proposal.confirmation ||
		store.revisions.source(missionId) !== input.source
	)
		throw new Conflict("Exact current pending revision required");
	const control = store.controls.fenceCurrent(missionId);
	if (control.held) throw new Conflict("Existing mission Pause must remain independent");
	if (store.controls.revisionPauses(missionId).some((p) => p.state !== "resumed" && p.members.length))
		throw new Conflict("Existing revision checkpoint needs inspection before another Pause");
	const roots = store.revisionAffectedSessions(missionId, proposal.delta);
	const inventory = () =>
		[
			...new Set([
				...roots,
				...participants
					.missionWorkSessions(missionId)
					.filter((id) => roots.includes(participants.missionWorkOwner(id))),
			]),
		].sort();
	const all = inventory();
	if (all.length > 128) throw new Conflict("Revision Pause inventory exceeds 128");
	const record: RevisionWorkPause = {
		version: 1,
		...input,
		missionId,
		taskIds: store.revisionAffectedTasks(missionId, proposal.delta),
		ownership: revisionPauseOwnership(store, participants, missionId, all),
		fence: {
			missionId,
			pauseGeneration: control.pauseGeneration,
			stopGeneration: control.stopGeneration,
			held: true,
		},
		state: "entered",
		members: all.map((sessionId) => ({ sessionId, state: "pending" })),
	};
	await store.controls.writeRevisionPause(record);
	await store.durable();
	const check = () => {
		const now = store.controls.fenceCurrent(missionId);
		if (
			now.held ||
			now.stopGeneration !== record.fence.stopGeneration ||
			now.pauseGeneration !== record.fence.pauseGeneration ||
			store.revisions.source(missionId) !== input.source ||
			!revisionPauseOwnershipMatches(store, participants, record) ||
			canonicalJSON(inventory()) !== canonicalJSON(all) ||
			canonicalJSON(store.revisionAffectedSessions(missionId, proposal.delta)) !== canonicalJSON(roots)
		)
			throw new Conflict("Revision checkpoint source changed");
	};
	try {
		for (const member of record.members) {
			check();
			member.state = await participants.checkpointMission(member.sessionId, input.operationId, record.fence);
			await store.controls.writeRevisionPause(record);
			await store.durable();
		}
		check();
		record.state = "paused";
	} catch (error) {
		record.state = "unknown";
		record.reason = String(error).slice(0, 500);
		for (const member of record.members) if (member.state === "pending") member.state = "unknown";
	}
	await store.controls.writeRevisionPause(record);
	await store.durable();
	return record;
}

/** Explicit release of this exact checkpoint only. Uncertain checkpoints never resume. */
export async function resumeRevisionWork(
	store: MissionStore,
	participants: MissionPauseParticipants,
	missionId: string,
	input: { operationId: string; pauseOperationId: string; source: string },
): Promise<RevisionWorkPause> {
	const record = store.controls.revisionPause(input.pauseOperationId);
	if (!record || record.missionId !== missionId) throw new Conflict("Unknown revision Pause");
	if (record.resumeOperationId) {
		if (record.resumeOperationId !== input.operationId) throw new Conflict("Resume already entered; lookup only");
		await store.durable();
		return record;
	}
	const control = store.controls.fenceCurrent(missionId);
	if (
		record.state !== "paused" ||
		!revisionPauseOwnershipMatches(store, participants, record) ||
		control.held ||
		control.stopGeneration !== record.fence.stopGeneration ||
		control.pauseGeneration !== record.fence.pauseGeneration ||
		store.revisions.source(missionId) !== input.source ||
		store.require(missionId).status !== "active"
	)
		throw new Conflict("Revision Resume source or checkpoint changed");
	const check = () => {
		const now = store.controls.fenceCurrent(missionId);
		if (
			now.held ||
			now.stopGeneration !== record.fence.stopGeneration ||
			now.pauseGeneration !== record.fence.pauseGeneration ||
			store.require(missionId).status !== "active" ||
			store.revisions.source(missionId) !== input.source ||
			!revisionPauseOwnershipMatches(store, participants, record)
		)
			throw new Conflict("Revision Resume source or ownership changed");
	};
	record.resumeOperationId = input.operationId;
	record.resumeSource = input.source;
	record.resumeOwners = record.members.map((m) => ({
		sessionId: m.sessionId,
		ownerId: participants.missionWorkOwner(m.sessionId),
	}));
	record.state = "resuming";
	await store.controls.writeRevisionPause(record);
	await store.durable();
	try {
		check();
		for (const member of record.members) {
			check();
			if (member.state === "paused")
				member.state = await participants.resumeMission(member.sessionId, record.operationId, record.fence, check);
			check();
			await store.controls.writeRevisionPause(record);
			await store.durable();
			check();
		}
		check();
		record.state = "resumed";
		await store.controls.writeRevisionPause(record);
		await store.durable();
		check();
		return record;
	} catch (error) {
		record.state = "unknown";
		record.reason = String(error).slice(0, 500);
	}
	await store.controls.writeRevisionPause(record);
	await store.durable();
	return record;
}

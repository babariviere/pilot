/** Reuses the Local app's existing retained-reader access, never grants source access. */
import type { ReviewDispositionTarget } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import { ReviewRequests } from "./review-requests.ts";
import type { SessionManager } from "./sessions.ts";

export function retainedFeedbackReader(
	store: MissionStore,
	sessions: SessionManager,
	projects: ProjectStore,
	target: Pick<ReviewDispositionTarget, "projectId" | "sessionId" | "snapshotId">,
) {
	const member = store.membership(target.sessionId),
		missionId = member?.missionId;
	const memberFence = canonicalJSON(member ?? null);
	const contextFence = missionId ? canonicalJSON(store.allocationContextFence(missionId)) : null;
	const authorize = () => {
		projects.require(target.projectId);
		const session = sessions.get(target.sessionId);
		if (
			!session ||
			session.projectId !== target.projectId ||
			canonicalJSON(store.membership(target.sessionId) ?? null) !== memberFence ||
			(missionId &&
				(store.require(missionId).projectId !== target.projectId ||
					canonicalJSON(store.allocationContextFence(missionId)) !== contextFence))
		)
			throw new Conflict("Current retained feedback access changed");
	};
	authorize();
	return sessions.nativeReviewReader(target.sessionId, missionId, target.projectId, authorize, true);
}
export function optionalReviewRequests(store: MissionStore, sessions: SessionManager, projects: ProjectStore) {
	return new ReviewRequests({
		store: store.reviewRequests,
		authorize(actor, target) {
			const read = () => {
				const project = projects.require(target.projectId),
					session = sessions.get(target.sessionId);
				if (!session || session.projectId !== project.id) throw new Conflict("Review source access unavailable");
				const member = store.membership(target.sessionId);
				const context = member ? store.allocationContextFence(member.missionId) : null;
				if (member && store.require(member.missionId).projectId !== target.projectId)
					throw new Conflict("Review source project changed");
				if (actor.kind === "native-user") return canonicalJSON({ project, member, context });
				const coordinator = sessions.get(actor.sessionId),
					cm = store.membership(actor.sessionId);
				const mission = store.require(actor.missionId);
				if (
					!coordinator ||
					coordinator.archivedAt ||
					coordinator.projectId !== target.projectId ||
					!cm?.active ||
					cm.missionId !== actor.missionId ||
					!member?.active ||
					member.missionId !== actor.missionId ||
					mission.status !== "active" ||
					mission.projectId !== target.projectId ||
					mission.coordinatorSessionId !== actor.sessionId
				)
					throw new Conflict("Only the current same-project coordinator may suggest review of its member");
				return canonicalJSON({
					project,
					member,
					context,
					cm,
					coordinator: { id: coordinator.id, projectId: coordinator.projectId, mode: coordinator.mode },
					coordinatorId: mission.coordinatorSessionId,
				});
			};
			const observed = read();
			return {
				revalidate() {
					if (read() !== observed) throw new Conflict("Review request authority changed");
				},
			};
		},
		async qualify(target) {
			const reader = retainedFeedbackReader(store, sessions, projects, target);
			const qualified = await reader.qualify(target);
			const comparison = await reader.comparison(target.snapshotId);
			qualified.revalidate();
			return { ...qualified, comparison };
		},
	});
}

import type { MissionContext } from "@pilot/kernel";
import { MissionService } from "../mission-service.ts";
import { MissionStore } from "../missions.ts";
import type { ProjectStore } from "../projects.ts";
import type { SessionManager } from "../sessions.ts";

/** In-memory store and synchronous context sink only. No workers, timers, providers or real profile. */
export function missionContextFixture(taskCount = 480, memberCount = 400) {
	const store = new MissionStore(":memory:");
	const members = Array.from({ length: memberCount }, (_, i) => `member-${i}`);
	const { id } = store.create({
		projectId: "fixture",
		title: "Synthetic mission",
		tasks: Array.from({ length: taskCount }, (_, i) => ({ title: `Task ${i}`, body: "x".repeat(4000) })),
	});
	for (const member of members) store.join(member, id);
	store.update(id, { coordinatorSessionId: members[0] });
	for (let i = 0; i < 60; i++) store.addDecision(id, `Decision ${i}: ${"x".repeat(400)}`, {}, "all");
	for (let i = 0; i < 400; i++)
		store.linkArtifact(id, {
			artifactId: `artifact-${i}`,
			sessionId: members[0]!,
			title: `Image ${i}`,
			kind: "image",
		});
	const delivered = new Map<string, MissionContext | undefined>();
	const sessions = {
		setMissionBridge: () => {},
		onChange: () => () => {},
		refreshMissionPullRequests: () => {},
		requestMainRefresh: () => {},
		missionChanged: (member: string, context: MissionContext | undefined) => delivered.set(member, context),
	} as unknown as SessionManager;
	const service = new MissionService(store, sessions, {} as ProjectStore);
	return { store, id, members, delivered, sessions, service };
}

/** Exact subject of delivered work; Node-free for native clients. */
export type VerificationSubject =
	| { kind: "task"; projectId: string; missionId: string; taskId: string }
	| { kind: "chat"; projectId: string; sessionId: string };

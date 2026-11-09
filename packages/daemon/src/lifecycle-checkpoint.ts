import { isAbsolute, normalize } from "node:path";
import type { RuntimeBuild } from "./runtime-owner.ts";

/** Process-captured runtime identity, not a hello response or native management permission. */
export interface LifecycleRuntime {
	runtimeRoot: string;
	build: RuntimeBuild;
}

export interface LifecycleRuntimeIdentity {
	boot: string;
	host?: { daemonId: string; lineageId: string };
	build: RuntimeBuild | null;
	runtimeRoot?: string;
}

/** Owned by the mission pause service, not by the upgrade controller. */
export interface MissionResumeFence {
	missionId: string;
	pauseGeneration: number;
	stopGeneration: number;
	held: boolean;
}

export function matchingMissionResumeFence(saved: MissionResumeFence, current: MissionResumeFence): boolean {
	return (
		!saved.held &&
		!current.held &&
		saved.missionId === current.missionId &&
		saved.pauseGeneration === current.pauseGeneration &&
		saved.stopGeneration === current.stopGeneration
	);
}

const buildKeys = ["arch", "node", "platform", "protocol", "schema", "source", "version"] as const;

export function validLifecycleRuntime(value: unknown): value is LifecycleRuntime {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as LifecycleRuntime;
	const build = candidate.build;
	return (
		Object.keys(candidate).sort().join() === "build,runtimeRoot" &&
		typeof candidate.runtimeRoot === "string" &&
		candidate.runtimeRoot.length <= 4096 &&
		!candidate.runtimeRoot.includes("\0") &&
		isAbsolute(candidate.runtimeRoot) &&
		normalize(candidate.runtimeRoot) === candidate.runtimeRoot &&
		!!build &&
		typeof build === "object" &&
		Object.keys(build).sort().join() === buildKeys.join() &&
		build.schema === 1 &&
		build.protocol === 1 &&
		typeof build.source === "string" &&
		/^[a-f0-9]{40}$/.test(build.source) &&
		[build.arch, build.node, build.platform, build.version].every(
			(part) => typeof part === "string" && part.length > 0 && part.length <= 128,
		)
	);
}

export function matchingRuntime(left: LifecycleRuntime, right: LifecycleRuntime): boolean {
	return left.runtimeRoot === right.runtimeRoot && buildKeys.every((key) => left.build[key] === right.build[key]);
}

/** Private upgrade ownership. These records are not service replacement or resume receipts. */
export interface LifecycleCheckpoint {
	schema: 1;
	operationId: string;
	purpose: "daemon-upgrade" | "daemon-stop" | "daemon-restart";
	incarnation: string;
	conversationId?: string;
	originBoot?: string;
	host?: { daemonId: string; lineageId: string };
	replacement?: LifecycleRuntime;
	sessionCreatedAt: number;
	inputGeneration: number;
	inputControlRevision: number;
	mission?: MissionResumeFence;
	prior: {
		working: boolean;
		updatePaused: boolean;
		sleepPaused: boolean;
		inputsPaused: boolean;
		subscriptionPaused: boolean;
	};
	/** Durable child identities, never the display-only summaries returned to clients. */
	children: { name: string; storage: string; conversationId?: string; state: string }[];
	/** Final child inventory is distinct from independent jobs/OS-child census and close ACK. */
	childrenConfirmed?: true;
	census?: { jobs: number; hasChildren: boolean };
	/** Set only after final child inventory, clear independent census, close ACK and worker exit. */
	quiescent?: true;
	/** A later user Stop must finish its exact cancellation before fresh input can clear ownership. */
	stopAcknowledged?: true;
	phase: "checkpointing" | "checkpointed" | "resume-admitted" | "resume-acknowledged" | "unknown" | "stopped";
}

/** Compare user intent, not just a boolean update marker or a PID. */
export function matchingCheckpoint(
	checkpoint: LifecycleCheckpoint,
	current: { createdAt: number; inputGeneration?: number; inputControlRevision?: number },
): boolean {
	return (
		checkpoint.sessionCreatedAt === current.createdAt &&
		checkpoint.inputGeneration === (current.inputGeneration ?? 0) &&
		checkpoint.inputControlRevision === (current.inputControlRevision ?? 0)
	);
}

/** An entered resume with no durable ACK is inspect-only after restart. */
export function checkpointRecoveryHeld(checkpoint: LifecycleCheckpoint): boolean {
	return (
		checkpoint.phase === "checkpointing" ||
		checkpoint.phase === "resume-admitted" ||
		checkpoint.phase === "unknown" ||
		(checkpoint.phase === "stopped" && !checkpoint.quiescent)
	);
}

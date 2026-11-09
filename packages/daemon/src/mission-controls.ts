import type { MissionControlCommand, MissionControlOperation } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { MissionResumeFence } from "./lifecycle-checkpoint.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

export interface MissionPauseParticipants {
	missionWorkMission?(sessionId: string): string | undefined;
	missionWorkSessions?(missionId: string): string[];
	missionWorkBelongs?(sessionId: string, missionId: string): boolean;
	checkpointMission(sessionId: string, operationId: string, fence: MissionResumeFence): Promise<"paused" | "held">;
	resumeMission(sessionId: string, operationId: string, fence: MissionResumeFence): Promise<"resumed" | "held">;
}

export function parseMissionControl(
	value: unknown,
	home?: { daemonId: string; lineageId: string },
): MissionControlCommand {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected mission control confirmation");
	const v = value as MissionControlCommand;
	const keys =
		v.action === "resume"
			? "action,coordinatorSessionId,expectedRevision,home,operationId,pauseOperationId,projectId,version"
			: "action,coordinatorSessionId,expectedRevision,home,operationId,projectId,version";
	if (
		Object.keys(v).sort().join() !== keys ||
		v.version !== 1 ||
		!["pause", "resume"].includes(v.action) ||
		!uuid(v.operationId) ||
		(v.action === "resume" && !uuid(v.pauseOperationId)) ||
		typeof v.projectId !== "string" ||
		!v.projectId ||
		v.projectId.length > 128 ||
		(v.coordinatorSessionId !== null && !uuid(v.coordinatorSessionId)) ||
		!Number.isSafeInteger(v.expectedRevision) ||
		v.expectedRevision < 0 ||
		!v.home ||
		Object.keys(v.home).sort().join() !== "daemonId,lineageId"
	)
		throw new Error("Invalid mission control confirmation");
	if (!home || v.home.daemonId !== home.daemonId || v.home.lineageId !== home.lineageId)
		throw new Conflict("The confirmed mission home changed");
	return structuredClone(v);
}

const uuid = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** No timers, Stop substitution or inferred acknowledgements. Recovery is lookup-only. */
export class MissionControls {
	private readonly store: MissionStore;
	private readonly participants: MissionPauseParticipants;
	private readonly active = new Set<string>();
	private drainSchedules: (missionId: string) => Promise<void> = async () => {
		throw new Error("Mission schedule fence is unavailable");
	};
	private drainExternal: (missionId: string) => Promise<void> = async () => {};
	setExternalDrain(drain: (missionId: string) => Promise<void>): void {
		this.drainExternal = drain;
	}
	setScheduleDrain(drain: (missionId: string) => Promise<void>): void {
		this.drainSchedules = drain;
	}
	constructor(store: MissionStore, participants: MissionPauseParticipants) {
		this.store = store;
		this.participants = participants;
	}
	fence(sessionId: string): MissionResumeFence | null {
		const membership = this.store.membership(sessionId);
		if (!membership) return null;
		this.store.require(membership.missionId);
		const { missionId, pauseGeneration, stopGeneration, held } = this.store.controls.fenceCurrent(
			membership.missionId,
		);
		return { missionId, pauseGeneration, stopGeneration, held };
	}
	assertOpen(missionId: string): void {
		this.store.require(missionId);
		if (this.store.controls.current(missionId).held) throw new Conflict("Mission work is paused");
	}
	private ownerFence(missionId: string): string {
		const mission = this.store.require(missionId),
			context = this.store.allocationContextFence(missionId);
		return payloadHash(
			canonicalJSON({
				projectId: mission.projectId,
				coordinatorSessionId: mission.coordinatorSessionId ?? null,
				createdAt: mission.createdAt,
				memberEventId: context.memberEventId,
				coordinatorEventId: context.coordinatorEventId,
				workSessions: this.inventory(missionId),
			}),
		);
	}
	private inventory(missionId: string): string[] {
		return [
			...new Set([...this.store.members(missionId), ...(this.participants.missionWorkSessions?.(missionId) ?? [])]),
		].sort();
	}
	/** A released Resume may wait for another owner's quota/sleep/input hold. No new input. */
	resumeAuthorized(sessionId: string, pauseOperationId: string): boolean {
		try {
			const membership = this.store.membership(sessionId);
			const missionId = membership?.missionId ?? this.participants.missionWorkMission?.(sessionId);
			if (!missionId || this.store.require(missionId).status !== "active") return false;
			const current = this.store.controls.fenceCurrent(missionId);
			const record = current.operationId ? this.store.controls.operation(current.operationId) : undefined;
			return (
				!!record &&
				!current.held &&
				current.state === "running" &&
				record.state === "acknowledged" &&
				record.command.action === "resume" &&
				record.command.pauseOperationId === pauseOperationId &&
				current.pauseGeneration === record.control.pauseGeneration &&
				current.stopGeneration === record.control.stopGeneration &&
				record.ownerFence === this.ownerFence(missionId) &&
				record.members.some((member) => member.sessionId === sessionId && member.state === "held")
			);
		} catch {
			return false;
		}
	}
	/** Historical status never changes controls or re-enters any participant. */
	async lookup(missionId: string, operationId: string): Promise<MissionControlOperation | undefined> {
		await this.store.durable();
		const record = this.store.controls.operation(operationId);
		if (record && record.missionId !== missionId) throw new Conflict("Control operation belongs to another mission");
		return record?.state === "entered" && !this.active.has(operationId) ? { ...record, state: "unknown" } : record;
	}
	async execute(missionId: string, command: MissionControlCommand): Promise<MissionControlOperation> {
		command = structuredClone(command);
		const retry = this.store.controls.operation(command.operationId);
		if (retry) {
			if (retry.missionId !== missionId || canonicalJSON(retry.command) !== canonicalJSON(command))
				throw new Conflict("Control operation identity reused");
			return (await this.lookup(missionId, command.operationId))!;
		}
		this.active.add(command.operationId);
		try {
			return await this.executeNew(missionId, command);
		} finally {
			this.active.delete(command.operationId);
		}
	}
	private async executeNew(missionId: string, command: MissionControlCommand): Promise<MissionControlOperation> {
		const mission = this.store.require(missionId);
		if (
			mission.status !== "active" ||
			mission.projectId !== command.projectId ||
			(mission.coordinatorSessionId ?? null) !== command.coordinatorSessionId
		)
			throw new Conflict("Mission control owner changed");
		const prior = this.store.controls.current(missionId);
		if (prior.version !== 1) throw new Conflict("Mission control version is unavailable");
		if (prior.revision !== command.expectedRevision) throw new Conflict("Mission controls changed");
		let members = this.inventory(missionId);
		if (members.length > 128) throw new Conflict("Mission member inventory exceeds 128");
		if (command.action === "pause") {
			if (prior.held) throw new Conflict("A prior mission pause still holds work");
		} else {
			const pause = this.store.controls.operation(command.pauseOperationId!);
			if (
				!pause ||
				pause.missionId !== missionId ||
				pause.state !== "acknowledged" ||
				pause.command.action !== "pause" ||
				prior.state !== "paused" ||
				prior.pauseOperationId !== pause.command.operationId
			)
				throw new Conflict("Resume needs an exact acknowledged Pause");
			if (canonicalJSON(members) !== canonicalJSON(pause.members.map((m) => m.sessionId).sort()))
				throw new Conflict("Mission membership changed since Pause");
			if (
				pause.command.coordinatorSessionId !== command.coordinatorSessionId ||
				pause.command.projectId !== command.projectId ||
				pause.ownerFence !== this.ownerFence(missionId)
			)
				throw new Conflict("Pause owner changed");
			members = pause.members.filter((m) => m.state === "paused").map((m) => m.sessionId);
		}
		const record: MissionControlOperation = {
			version: 1,
			missionId,
			command,
			ownerFence: this.ownerFence(missionId),
			state: "entered",
			control: {
				...prior,
				revision: prior.revision + 1,
				held: true,
				state: command.action === "pause" ? "pausing" : "resuming",
				operationId: command.operationId,
				pauseOperationId: command.action === "pause" ? command.operationId : command.pauseOperationId,
				pauseGeneration: prior.pauseGeneration + (command.action === "pause" ? 1 : 0),
			},
			members: members.map((sessionId) => ({ sessionId, state: "pending" })),
		};
		// Fence synchronously, then save the entire inventory before any interruption.
		this.store.controls.write(record, prior.revision);
		await this.store.durable();
		const fence: MissionResumeFence = {
			missionId,
			pauseGeneration: record.control.pauseGeneration,
			stopGeneration: record.control.stopGeneration,
			held: true,
		};
		const owner = () => {
			const now = this.store.require(missionId),
				control = this.store.controls.current(missionId);
			if (
				now.status !== "active" ||
				now.projectId !== command.projectId ||
				(now.coordinatorSessionId ?? null) !== command.coordinatorSessionId ||
				control.operationId !== command.operationId ||
				control.pauseGeneration !== fence.pauseGeneration ||
				control.stopGeneration !== fence.stopGeneration ||
				record.ownerFence !== this.ownerFence(missionId) ||
				!control.held
			)
				throw new Conflict("Mission control authority changed");
		};
		const persist = async () => {
			const current = this.store.controls.current(missionId);
			if (current.operationId !== command.operationId) throw new Conflict("Mission control operation changed");
			record.control.revision = current.revision + 1;
			record.control.stopGeneration = current.stopGeneration;
			this.store.controls.write(record, current.revision);
			await this.store.durable();
		};
		try {
			for (const drain of [this.drainSchedules, this.drainExternal]) {
				try {
					await drain(missionId);
				} catch (error) {
					record.issues ??= [];
					record.issues.push(String(error).slice(0, 500));
				}
			}
			owner();
			for (const member of record.members) {
				owner();
				if (
					this.store.missionOf(member.sessionId) !== missionId &&
					!this.participants.missionWorkBelongs?.(member.sessionId, missionId)
				)
					throw new Conflict("Mission member moved");
				member.state = "entered";
				await persist();
				owner();
				try {
					member.state =
						command.action === "pause"
							? await this.participants.checkpointMission(member.sessionId, command.operationId, fence)
							: await this.participants.resumeMission(member.sessionId, command.pauseOperationId!, fence);
				} catch (error) {
					member.state = "unknown";
					member.reason = String(error).slice(0, 500);
				}
				await persist();
			}
			owner();
			if (record.issues?.length || record.members.some((m) => m.state === "unknown"))
				throw new Conflict("Some mission work needs inspection");
			record.state = "acknowledged";
			record.control.state = command.action === "pause" ? "paused" : "running";
			record.control.held = command.action === "pause";
			await persist();
		} catch (error) {
			record.state = "unknown";
			record.control.state = command.action === "pause" ? "pausing" : "unknown";
			record.control.held = true;
			for (const member of record.members)
				if (member.state === "entered" || member.state === "pending") {
					member.state = "unknown";
					member.reason = String(error).slice(0, 500);
				}
			await persist();
		}
		return structuredClone(record);
	}
}

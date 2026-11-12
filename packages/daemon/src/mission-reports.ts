import type { MissionReport, MissionReportView, MissionReportWrite } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

/** Reports describe an agent's assessment, never observed progress or accepted delivery. */
export class MissionReports {
	private readonly store: MissionStore;
	constructor(store: MissionStore) {
		this.store = store;
	}
	source(missionId: string, sessionId: string, taskId: string) {
		const mission = this.store.require(missionId),
			task = this.store.task(missionId, taskId);
		if (
			mission.status !== "active" ||
			this.store.missionOf(sessionId) !== missionId ||
			task.sessionId !== sessionId ||
			task.status === "done" ||
			task.status === "dropped"
		)
			throw new Conflict("Report needs the current task owner");
		if (task.assignment && task.assignment.version !== 1)
			throw new Conflict("Report assignment version is unavailable");
		const source = payloadHash(
			canonicalJSON({
				missionId,
				projectId: mission.projectId,
				sessionId,
				coordinatorSessionId: mission.coordinatorSessionId ?? null,
				taskId,
				assignment: task.assignment ?? null,
				definitionRevision: this.store.sharedDefinitionRevision(taskId),
				taskEvent: this.store.activity(missionId, { kind: "task", taskId, limit: 1 })[0]?.id ?? 0,
				context: this.store.allocationContextFence(missionId),
				controls: this.store.controls.current(missionId),
			}),
		);
		const latest = this.store.controls.latestReport(missionId, taskId);
		return { version: 1 as const, missionId, taskId, source, expectedPreviousId: latest?.write.reportId ?? null };
	}
	async write(
		missionId: string,
		sessionId: string,
		value: unknown,
		authorize: () => void = () => {},
	): Promise<MissionReport> {
		authorize();
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected report");
		const write = structuredClone(value) as MissionReportWrite;
		const text = (value: unknown, max: number) =>
			typeof value === "string" && value.length <= max && value.trim().length > 0;
		if (
			Object.keys(write)
				.filter((key) => key !== "delivery")
				.sort()
				.join() !== "evidence,expectedPreviousId,movement,nextStep,reportId,source,summary,taskId,version" ||
			write.version !== 1 ||
			!text(write.reportId, 128) ||
			!text(write.taskId, 128) ||
			!/^[a-f0-9]{64}$/.test(write.source) ||
			(write.expectedPreviousId !== null && !text(write.expectedPreviousId, 128)) ||
			!["moving", "not_moving", "unknown"].includes(write.movement) ||
			!text(write.summary, 2000) ||
			!text(write.nextStep, 1000) ||
			!Array.isArray(write.evidence) ||
			write.evidence.length > 16 ||
			write.evidence.some((item) => !text(item, 1000))
		)
			throw new Error("Invalid versioned mission report");
		if ("delivery" in write) {
			const delivery = write.delivery;
			if (
				!delivery ||
				typeof delivery !== "object" ||
				Array.isArray(delivery) ||
				Object.keys(delivery).sort().join() !== "checks,commit,issues" ||
				!text(delivery.commit, 40) ||
				!/^[a-f0-9]{40}$/.test(delivery.commit) ||
				!text(delivery.checks, 2000) ||
				typeof delivery.issues !== "string" ||
				delivery.issues.length > 1000
			)
				throw new Error("Invalid scoped delivery facts");
		}
		const retry = () => {
			authorize();
			const saved = this.store.controls.report(write.reportId);
			if (!saved) return undefined;
			if (
				saved.missionId !== missionId ||
				saved.sessionId !== sessionId ||
				canonicalJSON(saved.write) !== canonicalJSON(write)
			)
				throw new Conflict("Report identity reused");
			// A historical ACK is not current authority to read another member's retained bytes.
			if (this.store.missionOf(sessionId) !== missionId) throw new Conflict("Report membership changed");
			return saved;
		};
		if (retry()) {
			await this.store.durable();
			return retry()!;
		}
		await this.store.durable();
		authorize();
		// Another exact call may have committed while this call crossed the barrier.
		const concurrent = retry();
		if (concurrent) {
			await this.store.durable();
			return retry()!;
		}
		const current = this.source(missionId, sessionId, write.taskId);
		if (current.source !== write.source || current.expectedPreviousId !== write.expectedPreviousId)
			throw new Conflict("Report source or predecessor changed");
		if (this.store.controls.current(missionId).held) throw new Conflict("Mission work is paused");
		const mission = this.store.require(missionId),
			reportedAt = Date.now();
		const report: MissionReport = {
			version: 1,
			missionId,
			projectId: mission.projectId,
			sessionId,
			coordinatorSessionId: mission.coordinatorSessionId ?? null,
			reportedAt,
			validUntil: reportedAt + 24 * 60 * 60 * 1000,
			write,
		};
		this.store.controls.insertReport(report);
		await this.store.durable();
		return retry()!;
	}
	latest(missionId: string): MissionReport[] {
		return [
			...new Map(this.store.controls.reports(missionId).map((report) => [report.write.taskId, report])).values(),
		];
	}
	/** One task's current report for coordinator reconciliation, not acceptance. */
	viewTaskNow(missionId: string, taskId: string, now = Date.now()): MissionReportView | undefined {
		const report = this.store.controls.latestReport(missionId, taskId);
		if (!report) return undefined;
		let currentness: MissionReportView["currentness"] = "stale";
		try {
			if (
				report.version === 1 &&
				report.write.version === 1 &&
				now < report.validUntil &&
				this.source(missionId, report.sessionId, taskId).source === report.write.source
			)
				currentness = "current";
		} catch {
			/* A stale owner/assignment never becomes current through lookup. */
		}
		return { report, currentness, provenance: "agent_report" };
	}
	async views(missionId: string, now = Date.now()): Promise<MissionReportView[]> {
		await this.store.durable();
		return this.viewsNow(missionId, now);
	}
	/** Caller crosses the durable barrier, then builds all related projections without I/O. */
	viewsNow(missionId: string, now = Date.now()): MissionReportView[] {
		const mission = this.store.require(missionId),
			tasks = this.store.reportSourceTasks(missionId),
			members = new Set(this.store.members(missionId)),
			context = this.store.allocationContextFence(missionId),
			controls = this.store.controls.current(missionId);
		return this.latest(missionId).map((report) => {
			let currentness: MissionReportView["currentness"] = "unavailable";
			try {
				const task = tasks.get(report.write.taskId);
				if (
					!task ||
					task.status === "done" ||
					task.status === "dropped" ||
					task.sessionId !== report.sessionId ||
					!members.has(report.sessionId) ||
					mission.status !== "active"
				)
					return { report, currentness: "stale", provenance: "agent_report" };
				const source = payloadHash(
					canonicalJSON({
						missionId,
						projectId: mission.projectId,
						sessionId: report.sessionId,
						coordinatorSessionId: mission.coordinatorSessionId ?? null,
						taskId: report.write.taskId,
						assignment: task.assignment ?? null,
						definitionRevision: task.definitionRevision,
						taskEvent: task.taskEvent,
						context,
						controls,
					}),
				);
				currentness =
					report.version === 1 &&
					report.write.version === 1 &&
					(!task.assignment || task.assignment.version === 1) &&
					now < report.validUntil &&
					source === report.write.source
						? "current"
						: "stale";
			} catch (error) {
				if (error instanceof Conflict) currentness = "stale";
			}
			return { report, currentness, provenance: "agent_report" };
		});
	}
}

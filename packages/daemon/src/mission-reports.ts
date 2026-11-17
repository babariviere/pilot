import type { MissionDeliveryScreens, MissionReport, MissionReportView, MissionReportWrite } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

/** Shape only: 1 to 8 pairs of distinct artifact IDs, each with an After, or a short reason for no captures. */
function checkScreenShape(screens: unknown, text: (value: unknown, max: number) => boolean): void {
	if (!screens || typeof screens !== "object" || Array.isArray(screens)) throw new Error("Invalid delivery screens");
	const keys = Object.keys(screens).join();
	if (keys === "none" && text((screens as { none: unknown }).none, 500)) return;
	const pairs = (screens as { pairs?: unknown }).pairs;
	if (
		keys !== "pairs" ||
		!Array.isArray(pairs) ||
		pairs.length < 1 ||
		pairs.length > 8 ||
		pairs.some(
			(pair) =>
				!pair ||
				typeof pair !== "object" ||
				Array.isArray(pair) ||
				Object.keys(pair).some((key) => key !== "before" && key !== "after") ||
				!text(pair.after, 128) ||
				("before" in pair && !text(pair.before, 128)),
		)
	)
		throw new Error("Invalid delivery screens");
	const ids = screenIds(screens as MissionDeliveryScreens);
	if (new Set(ids).size !== ids.length) throw new Error("Invalid delivery screens");
}

function screenIds(screens: MissionDeliveryScreens): string[] {
	return "pairs" in screens
		? screens.pairs.flatMap((pair) => (pair.before ? [pair.before, pair.after] : [pair.after]))
		: [];
}

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
				Object.keys(delivery)
					.filter((key) => key !== "screens" && key !== "commit")
					.sort()
					.join() !== "checks,issues" ||
				// No commit: the task changed no code (a decision, a mockup or research).
				("commit" in delivery && (!text(delivery.commit, 40) || !/^[a-f0-9]{40}$/.test(delivery.commit!))) ||
				!text(delivery.checks, 2000) ||
				typeof delivery.issues !== "string" ||
				delivery.issues.length > 1000
			)
				throw new Error("Invalid scoped delivery facts");
			if ("screens" in delivery) checkScreenShape(delivery.screens, text);
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
		// Checked for new reports only: an exact retry keeps its receipt after a later unlink.
		if (write.delivery?.screens) this.checkScreens(missionId, sessionId, write.taskId, write.delivery.screens);
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
	/** Screens name image artifacts this worker attached to this task, pinned so the result page can read them. */
	private checkScreens(missionId: string, sessionId: string, taskId: string, screens: MissionDeliveryScreens): void {
		const task = this.store.resolveTask(missionId, taskId).id;
		for (const id of screenIds(screens)) {
			const attached = this.store
				.artifactReferences(missionId, id)
				.some(
					(link) =>
						link.taskId === task &&
						link.sessionId === sessionId &&
						link.kind === "image" &&
						link.revision !== undefined,
				);
			if (!attached)
				throw new Error(
					`Delivery screen ${id} must be an image artifact you attached to this task with artifactRevision`,
				);
		}
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

/** Native schedule edits use the existing durable journal. Recovery is lookup-only. */
import { createHash } from "node:crypto";
import type { DurableOperation, OperationHost, SchedulePatch, ScheduleRequest } from "@pilot/protocol";
import { canonicalJSON, OperationRejected, sameHost } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import { RecurrenceCalendar, validateRecurrence } from "./schedule-recurrence.ts";
import type { ScheduleService } from "./schedules.ts";
import type { SessionManager } from "./sessions.ts";

export const SCHEDULE_CONTROLS = "schedule-controls";
type Intent = {
	purpose: typeof SCHEDULE_CONTROLS;
	binding: string;
	draftId: string;
	page: number;
	action: "create" | "update" | "cancel";
	value: Record<string, unknown>;
};
export function validateScheduleIntent(op: DurableOperation, host: OperationHost): Intent {
	try {
		const p = JSON.parse(op.payload);
		if (
			op.kind !== SCHEDULE_CONTROLS ||
			op.targetId !== "global-schedules" ||
			!sameHost(op.origin, host) ||
			canonicalJSON(op.destination) !== canonicalJSON(host) ||
			op.bindingGeneration !== 1 ||
			Buffer.byteLength(op.payload) > 24000 ||
			Object.keys(p).sort().join() !== "action,binding,draftId,page,purpose,value" ||
			typeof p.draftId !== "string" ||
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.draftId) ||
			p.purpose !== SCHEDULE_CONTROLS ||
			!/^[a-f0-9]{64}$/.test(p.binding) ||
			op.bindingId !== p.binding ||
			!Number.isSafeInteger(p.page) ||
			p.page < 0 ||
			!["create", "update", "cancel"].includes(p.action) ||
			!p.value ||
			typeof p.value !== "object" ||
			Array.isArray(p.value)
		)
			throw new Error();
		const v = p.value;
		if (
			p.action !== "create" &&
			(typeof v.id !== "string" ||
				!/^[A-Za-z0-9_-]{1,128}$/.test(v.id) ||
				!Number.isSafeInteger(v.expectedRevision) ||
				v.expectedRevision < 1)
		)
			throw new Error();
		if (p.action === "cancel" && Object.keys(v).sort().join() !== "expectedRevision,id") throw new Error();
		if (p.action !== "cancel") {
			const allowed = [
				"id",
				"expectedRevision",
				"title",
				"trigger",
				"at",
				"expiresAt",
				"atLocal",
				"expiresLocal",
				"timeZone",
				"recurrence",
				"target",
				"paused",
			];
			if (Object.keys(v).some((k) => !allowed.includes(k))) throw new Error();
			// No raw cwd, foreign host, or caller-supplied spawn authority in the native editor.
			if (v.target !== undefined) {
				const target = v.target;
				if (
					target.kind !== "message" ||
					Object.keys(target).sort().join() !== "kind,message,sessionId" ||
					typeof target.message !== "string" ||
					!target.message.trim() ||
					target.message.length > 8000 ||
					typeof target.sessionId !== "string"
				)
					throw new Error();
			}
		}
		return p;
	} catch {
		throw new OperationRejected("Invalid schedule intent. Nothing changed.");
	}
}
export class ScheduleControls {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly schedules: ScheduleService;
	private readonly sessions: Pick<SessionManager, "list" | "automationHistory">;
	private readonly projects: Pick<ProjectStore, "list">;
	private readonly host: OperationHost;
	constructor(
		schedules: ScheduleService,
		sessions: Pick<SessionManager, "list" | "automationHistory">,
		projects: Pick<ProjectStore, "list">,
		host: OperationHost,
	) {
		this.schedules = schedules;
		this.sessions = sessions;
		this.projects = projects;
		this.host = host;
	}
	read(page = 0, pins: { editId?: string; targetId?: string; projectId?: string } = {}) {
		if (!Number.isSafeInteger(page) || page < 0) throw new OperationRejected("Invalid schedule page");
		for (const id of Object.values(pins))
			if (id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(id))
				throw new OperationRejected("Invalid schedule selection");
		const { items: schedules, index: rows, total } = this.schedules.controlPage(page);
		if (pins.editId && !schedules.some((r) => r.id === pins.editId) && rows.some((r) => r.id === pins.editId))
			schedules.push(this.schedules.require(pins.editId));
		const projects = this.projects.list().map((p) => ({ id: p.id, name: p.name }));
		const targets = this.sessions
			.list({})
			.filter((s) => !s.archivedAt && s.projectId && s.role === undefined)
			.map((s) => ({
				id: s.id,
				title: s.title,
				projectId: s.projectId,
				missionId: s.missionId,
				coordinator: s.activeMissionCoordinator,
			}));
		const controls = this.schedules.controls();
		const binding = createHash("sha256")
			.update(canonicalJSON({ host: this.host, page, rows, projects, targets, controls }))
			.digest("hex");
		// Twenty definitions plus one pinned editor fit below the native 16 MiB response limit.
		const visible = schedules;
		const targetIds = new Set(visible.flatMap((s) => (s.target.kind === "message" ? [s.target.sessionId] : [])));
		if (pins.targetId) targetIds.add(pins.targetId);
		const projectIds = new Set(visible.map((s) => s.projectId));
		if (pins.projectId) projectIds.add(pins.projectId);
		for (const target of targets) if (targetIds.has(target.id)) projectIds.add(target.projectId);
		return {
			version: 1,
			host: this.host,
			binding,
			page,
			...controls,
			schedules: visible.map((s) => {
				const calendar = new RecurrenceCalendar({
					every: "day",
					time: "00:00",
					timeZone: s.recurrence?.timeZone ?? s.timeZone ?? "UTC",
				});
				const wall = (n: number | undefined) =>
					n === undefined ? "" : new Date(calendar.local(n)).toISOString().slice(0, 16);
				return { ...s, held: this.schedules.held(s), atLocal: wall(s.at), expiresLocal: wall(s.expiresAt) };
			}),
			more: total > (page + 1) * 20,
			// Page lightweight choices too. Include the shown rows' exact targets for editing.
			projects: projects.filter((p, i) => (i >= page * 100 && i < (page + 1) * 100) || projectIds.has(p.id)),
			projectsMore: projects.length > (page + 1) * 100,
			targets: targets.filter((t, i) => (i >= page * 100 && i < (page + 1) * 100) || targetIds.has(t.id)),
			targetsMore: targets.length > (page + 1) * 100,
			history: this.sessions.automationHistory(page),
		};
	}
	admit(op: DurableOperation, firstEntry: boolean) {
		if (!firstEntry) return Promise.reject(new Error("Schedule outcome unknown; lookup only"));
		const work = this.tail.then(async () => {
			const p = validateScheduleIntent(op, this.host);
			const snapshot = this.read(p.page, {
				editId: typeof p.value.id === "string" ? p.value.id : undefined,
				targetId: (p.value.target as { sessionId?: string } | undefined)?.sessionId,
			});
			if (p.binding !== snapshot.binding) throw new OperationRejected("Schedules or targets changed. Read again.");
			const v = { ...p.value };
			if (v.atLocal !== undefined || v.expiresLocal !== undefined) {
				try {
					const calendar = new RecurrenceCalendar(
						validateRecurrence({ every: "day", time: "00:00", timeZone: v.timeZone }),
					);
					for (const [local, field] of [
						["atLocal", "at"],
						["expiresLocal", "expiresAt"],
					]) {
						const text = v[local!];
						if (text !== undefined && text !== "") {
							if (
								typeof text !== "string" ||
								!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(text) ||
								new Date(text + "Z").toISOString().slice(0, 16) !== text
							)
								throw new Error();
							v[field!] = calendar.instant(Date.parse(text + "Z"));
						}
						delete v[local!];
					}
				} catch {
					throw new OperationRejected("Enter valid local dates and a time zone");
				}
			}
			if (v.target && !snapshot.targets.some((t) => t.id === (v.target as { sessionId: string }).sessionId))
				throw new OperationRejected("Target is no longer eligible");
			const expectedHome = { daemonId: this.host.daemonId, lineageId: this.host.lineageId };
			if (p.action === "create") {
				const row = await this.schedules.create({ ...v, expectedHome } as unknown as ScheduleRequest);
				return { action: p.action, scheduleId: row.id, revision: row.revision };
			}
			const row = snapshot.schedules.find((r) => r.id === v.id && r.revision === v.expectedRevision);
			if (!row) throw new OperationRejected("Schedule changed or is not on this page");
			if (row.insightsEnableOperationId) throw new OperationRejected("Use Insights settings for this rule");
			if (p.action === "cancel") {
				if (row.state !== "pending")
					throw new OperationRejected("Only pending schedules can be cancelled. History stays.");
				await this.schedules.remove(row.id, row.revision);
				return { action: p.action, scheduleId: row.id };
			}
			const { id: _id, ...patch } = v;
			const updated = await this.schedules.update(row.id, { ...patch, expectedHome } as SchedulePatch);
			return { action: p.action, scheduleId: row.id, revision: updated.revision };
		});
		this.tail = work.catch(() => {});
		return work;
	}
}

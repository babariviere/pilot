// Test-only schedules. No host, provider, worker or storage.
import { signal } from "nsh";
import type { ScheduleControls, ScheduleOperation, ScheduleSnapshot } from "./scheduleControls";
export function scriptedSchedules() {
	const snapshot = signal<ScheduleSnapshot | null>({
		draftId: "b39c2068-6b29-4557-a046-f8a6a17b0e44",
		version: 1,
		binding: "a".repeat(64),
		page: 0,
		enabled: false,
		paused: false,
		more: false,
		projects: [{ id: "p", name: "Website" }],
		targets: [{ id: "agent", title: "Website refresh coordinator", projectId: "p", coordinator: true }],
		targetsMore: false,
		schedules: [
			{
				id: "row",
				revision: 1,
				title: "Check deployment progress",
				projectId: "p",
				trigger: "at",
				state: "pending",
				at: 1794992400000,
				atLocal: "2026-11-18T09:00",
				expiresLocal: "2026-11-18T12:00",
				timeZone: "UTC",
				held: true,
				target: { kind: "message", sessionId: "agent", message: "Check the deployment and remaining blockers." },
			},
		],
		history: {
			more: false,
			items: [
				{
					sessionId: "agent",
					title: "Deployment checks",
					projectId: "p",
					attempts: 2,
					stopped: true,
					attention: "Repair stopped: agent made no progress",
					runs: [{ name: "Smoke test", state: "failed", excerpt: "Deployment did not become healthy." }],
				},
			],
		},
	});
	const busy = signal(false),
		message = signal(""),
		operations = signal<ScheduleOperation[]>([]),
		writes = signal(0),
		checks = signal(0),
		reads = signal(0),
		many = signal(false),
		lastTarget = signal(""),
		unknown = signal(false);
	const controls: ScheduleControls = {
		blocked: () => operations().some((o) => o.pending),
		begin() {},
		snapshot,
		busy,
		message,
		operations,
		async read(page = 0) {
			reads.set(reads() + 1);
			if (many())
				snapshot.set({
					...snapshot()!,
					page,
					binding: String(page).repeat(64),
					draftId: `page-${page}-${reads()}`,
					targets: [
						{ id: "agent", title: "Website refresh coordinator", projectId: "p" },
						...(page ? [{ id: "second", title: "Agent on another page", projectId: "p" }] : []),
					],
					targetsMore: page === 0,
				});
		},
		async write(action, value) {
			writes.set(writes() + 1);
			if (unknown()) {
				unknown.set(false);
				operations.set([{ operationId: "pending", state: "unknown", pending: true }]);
				message.set("Delivery is unknown. Check status; do not save again.");
				return false;
			}
			const v = value as { paused?: boolean; target?: { sessionId: string } };
			lastTarget.set(v.target?.sessionId ?? "");
			if (action === "update")
				snapshot.set({
					...snapshot()!,
					schedules: snapshot()!.schedules.map((r) => ({
						...r,
						revision: r.revision + 1,
						paused: v.paused ?? r.paused,
					})),
				});
			message.set("Saved.");
			return true;
		},
		async check() {
			checks.set(checks() + 1);
			message.set("Status read. Nothing was resent.");
		},
	};
	return { controls, snapshot, busy, message, operations, writes, checks, reads, many, lastTarget, unknown };
}

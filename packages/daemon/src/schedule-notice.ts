import type { DashboardNeedsYouItem, DashboardScheduledItem } from "@pilot/protocol";
import { reasonLine } from "./needs-you-reason.ts";

/** Small, prompt-free projection shared by project dashboards and the cross-project Inbox. */
export function scheduleNotice(item: DashboardScheduledItem): DashboardNeedsYouItem | undefined {
	const run = item.notice;
	if (item.trigger !== "recurring" || !run) return undefined;
	let reason: string;
	const late = (run.outcome === "started" || run.outcome === "sent") && run.late;
	if (late) {
		const zone = item.recurrence?.timeZone ?? "UTC";
		const date = new Intl.DateTimeFormat("en-GB", {
			timeZone: zone,
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		const time = new Intl.DateTimeFormat("en-GB", {
			timeZone: zone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		reason = `Ran late · due ${date.format(run.due)}, started ${time.format(run.at)}`;
	} else if (run.outcome === "skipped_running") reason = "Skipped: the previous run is still working";
	else if (run.outcome === "missed")
		reason = `Missed ${run.count ?? 1} ${(run.count ?? 1) === 1 ? "run" : "runs"}: Pilot was off, asleep or offline`;
	else if (run.outcome === "failed")
		reason = `Failed to ${item.kind === "message" ? "send" : "start"}: ${reasonLine(run.error) ?? "Check the schedule and its chat"}`;
	else return undefined;
	const detail = reasonLine(reason)!;
	return {
		kind: "scheduled_notice",
		id: `scheduled:${item.id}`,
		scheduledId: item.id,
		title: item.title,
		reason: detail,
		at: run.at,
		attentionReason: { kind: run.outcome === "failed" ? "couldnt_start" : "schedule", detail },
		scheduleRun: structuredClone(run),
		...(item.recurrence ? { scheduleTimeZone: item.recurrence.timeZone } : {}),
		...(run.sessionId ? { sessionId: run.sessionId } : {}),
		...(late ? { countsInBadge: false as const } : {}),
	};
}

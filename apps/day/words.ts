// Words and marks for missions, reports and controls. One place, so Today
// and the mission overview say the same thing about the same state.
import type { ControlView, Freshness, MemberState, MissionRow, ReportLine, TaskStatus } from "pilot-day/native";
import type { MarkKind } from "./ui";

/** The words beside a mission's mark. */
export function stateWord(row: MissionRow): string {
	switch (row.state) {
		case "moving":
			return "Moving";
		case "notMoving":
			return "Not moving";
		case "unreported":
			if (!row.report) return "No report yet";
			if (row.report.currentness === "stale") return "Old report";
			if (row.report.currentness === "unavailable") return "Report unavailable";
			return "Movement unclear";
		case "waiting":
			return "Waiting for you";
		case "stuck":
			return "Stuck";
		case "unconfirmed":
			return "Unconfirmed";
		case "pausing":
			return "Pausing";
		case "paused":
			return "Paused";
		case "resuming":
			return "Resuming";
	}
}

/** A mission's mark. */
export function stateMark(row: Pick<MissionRow, "state" | "report">): MarkKind {
	switch (row.state) {
		case "moving":
		case "resuming":
			return "moving";
		case "notMoving":
			return "still";
		case "unreported":
			return row.report?.currentness === "stale" ? "oldReport" : "unreported";
		case "waiting":
			return "needs";
		case "stuck":
			return "failed";
		case "unconfirmed":
			return "unknown";
		case "pausing":
		case "paused":
			return "paused";
	}
}

/** Whether a mission's words ask for attention, and how. */
export function stateTone(row: MissionRow): "needs" | "failed" | "quiet" {
	if (row.state === "waiting" || row.state === "unconfirmed" || row.control.needsLook) return "needs";
	if (row.state === "stuck") return "failed";
	return "quiet";
}

/** One sentence about the mission's control, or "" when it runs normally. */
export function controlLine(control: ControlView): string {
	const verb = control.asked === "resume" ? "resume" : "pause";
	switch (control.delivery) {
		case "sending":
			return control.asked === "resume"
				? "Starting the paused work again."
				: "Stopping work at safe points. Not paused yet.";
		case "unknown":
			return `Pilot asked to ${verb} but heard nothing back. It will not ask again until it checks.`;
		case "checking":
			return "Checking. This only reads; it changes nothing.";
		default:
			break;
	}
	switch (control.state) {
		case "pausing":
			return control.needsLook
				? "Pausing did not finish everywhere. Some work needs a look."
				: "Stopping work at safe points. Not paused yet.";
		case "paused":
			return "Paused. Nothing in it runs until you resume it.";
		case "resuming":
			return "Starting the paused work again.";
		case "unknown":
			return control.needsLook
				? "Resuming did not finish everywhere. Some work needs a look."
				: "Pilot cannot tell whether this mission is paused.";
		default:
			return control.needsLook ? "The last pause or resume did not finish everywhere." : "";
	}
}

function chats(n: number): string {
	return n === 1 ? "One chat" : `${n} chats`;
}

/** The mission's line: its control, else its report, else why there is none. */
export function rowLine(row: MissionRow): string {
	const control = controlLine(row.control);
	if (control) return control;
	if (row.line) return row.line;
	if (!row.report) return row.working > 0 ? `No report yet. ${chats(row.working)} working.` : "No report yet.";
	return "";
}

/** Who reported, how long ago, and whether it still holds. */
export function provenance(report: ReportLine): string {
	const who = report.byCoordinator ? "coordinator" : "agent";
	switch (report.currentness) {
		case "current":
			return `${who === "coordinator" ? "Coordinator" : "Agent"} report · ${report.age}`;
		case "stale":
			return `Old ${who} report · ${report.age}`;
		case "unavailable":
			return "Report could not be checked";
	}
}

/** A task's status, in words. */
export function taskWord(status: TaskStatus): string {
	switch (status) {
		case "todo":
			return "To do";
		case "inProgress":
			return "In progress";
		case "blocked":
			return "Blocked";
		case "inReview":
			return "In review";
		case "delegated":
			return "Delegated";
		case "done":
			return "Done";
		case "unknown":
			return "Status unknown";
	}
}

/** Where a member chat is in the last Pause or Resume. */
export function memberWord(state: MemberState): string {
	switch (state) {
		case "pending":
			return "Not reached yet";
		case "entered":
			return "In progress";
		case "paused":
			return "Paused";
		case "resumed":
			return "Resumed";
		case "held":
			return "Held";
		case "unknown":
			return "Did not confirm";
	}
}

/** One sentence about a read that is not live, or "" while it is. */
export function freshnessLine(freshness: Freshness): string {
	switch (freshness.state) {
		case "stale":
			return `Showing what Pilot read ${freshness.age}. ${freshness.reason}`.trim();
		case "offline":
			return `Offline. ${freshness.reason} Showing what Pilot read ${freshness.age}.`.replace("  ", " ");
		default:
			return "";
	}
}

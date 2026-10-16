import type { MissionResource } from "@pilot/protocol";
import type { MissionStore } from "./missions.ts";

/** Sync owns remote status, manual pauses, freshness, and accepted contributor scope. */
export type LinearClosingGuard = (
	missionId: string,
	resourceId: string,
) => Promise<{ allowed: boolean; reason?: string }>;
export const unavailableClosingGuard: LinearClosingGuard = async () => ({
	allowed: false,
	reason: "Live Linear safeguards are unavailable",
});

export function ticketScope(detail: ReturnType<MissionStore["linearPrScope"]>): string {
	return JSON.stringify([
		detail.mission.status,
		detail.tasks.map((task) => [task.id, task.status]),
		detail.resources
			.filter((ref) => ref.kind === "linear.issue" || ref.kind === "github.pr")
			.map((ref) => {
				// Optional until the sync service is installed. Exclude observation timestamps.
				const sync = Reflect.get(ref, "linearSync") as Record<string, unknown> | undefined;
				return [
					ref.id,
					ref.taskId,
					ref.linearKey,
					ref.linearRole,
					ref.relationship,
					ref.pullRequest?.state,
					sync?.state,
					sync?.reason,
					sync?.observedStateId,
					sync?.issueId,
				];
			}),
	]);
}

export async function linearPrGuidance(
	store: MissionStore,
	missionId: string,
	taskId: string,
	guard: LinearClosingGuard,
) {
	const detail = store.linearPrScope(missionId);
	const task = detail.tasks.find((task) => task.id === taskId);
	if (!task) throw new Error("Task not found");
	const scope = ticketScope(detail);
	const links = detail.resources.filter((ref) => ref.taskId === taskId && ref.kind === "linear.issue");
	const keys = new Set(links.map((ref) => ref.linearKey));
	// Detaching this task must not make an existing closing directive invisible to checks.
	links.push(...detail.resources.filter((ref) => ref.linearRole === "managed" && !keys.has(ref.linearKey)));
	if (links.length > 40) throw new Error("Too many ticket links for one PR check; reduce scope or check manually");
	const tickets = [];
	for (const ref of links) {
		const manager = detail.resources.find(
			(item) => item.linearRole === "managed" && item.linearKey === ref.linearKey,
		);
		const others = detail.resources.filter(
			(item) => item.linearRole === "contribution" && item.linearKey === ref.linearKey && item.taskId !== taskId,
		);
		const unfinished = others.flatMap((item) => {
			const task = detail.tasks.find((task) => task.id === item.taskId);
			return task?.status === "done" ? [] : [task?.number ?? item.taskId];
		});
		let reason =
			ref.linearRole !== "contribution"
				? ref.linearRole === "reference"
					? "Reference-only link"
					: "No explicit task contribution"
				: !manager
					? "No managing ticket"
					: detail.mission.status !== "active"
						? "Mission is not active"
						: ["dropped", "delegated"].includes(task.status)
							? "Task is dropped or delegated"
							: unfinished.length
								? `Other contributors are not Done: ${unfinished.map((number) => `#${number}`).join(", ")}`
								: undefined;
		if (!reason) {
			try {
				const live = await guard(missionId, manager!.id);
				if (!live.allowed)
					reason = live.reason ?? "Linear synchronization is paused, terminal, stale or unavailable";
			} catch {
				reason = "Could not verify live Linear safeguards";
			}
		}
		const changed = ticketScope(store.linearPrScope(missionId)) !== scope;
		if (changed) reason = "Tasks or links changed during the check; recheck before editing the PR";
		const allowed = !reason;
		tickets.push({
			resourceId: ref.id,
			linearKey: ref.linearKey,
			identifier: ref.externalId,
			url: ref.url,
			closingAllowed: allowed,
			reason,
			directive: `${allowed ? "Closes" : "Related to"} ${ref.externalId ?? ref.url}`,
		});
	}
	return {
		task: task.number,
		tickets,
		note: "Recheck before creating/editing a PR and after task/link changes. Only the final contributor may close, when every other contributor is Done and live safeguards allow. Related to is relation-only; refs/contributes to may still trigger status changes. Avoid ticket IDs in earlier branch names and commit messages. Never silently edit a PR. Linear integration automations are independent of local mappings and pauses.",
	};
}

/** Linear's full documented closing-keyword set, not only GitHub's Fixes/Closes subset. */
const closing =
	/\b(?:clos(?:e|es|ed|ing)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing)|complet(?:e|es|ed|ing)|implement(?:s|ed|ing)?|linear\s+issue)\b\s*:?\s*/gi;
export function closingMentions(text: string, ref: Pick<MissionResource, "externalId" | "url">): boolean {
	return !!ref.externalId && closingIssueIds(text).has(ref.externalId.toUpperCase());
}

export function closingIssueIds(text: string): Set<string> {
	const ids = new Set<string>();
	// Each keyword introduces issue tokens, not arbitrary later prose. No repeated whole-line scans.
	const token =
		/^(?:\[[^\]\n]{1,500}\]\(https?:\/\/linear\.app\/[^\s)]+\)|https?:\/\/linear\.app\/[^\s,)]+|[a-z0-9]+-[1-9]\d*\b)/i;
	for (const match of text.matchAll(closing)) {
		let rest = text.slice(match.index! + match[0].length);
		for (;;) {
			const item = token.exec(rest);
			if (!item) break;
			const id = /\/issue\/([a-z0-9]+-[1-9]\d*)\b/i.exec(item[0]) ?? /\b([a-z0-9]+-[1-9]\d*)\b/i.exec(item[0]);
			if (id) ids.add(id[1]!.toUpperCase());
			rest = rest.slice(item[0].length);
			const separator = /^(?:\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+|\s+)/i.exec(rest);
			if (!separator) break;
			rest = rest.slice(separator[0].length);
		}
	}
	return ids;
}

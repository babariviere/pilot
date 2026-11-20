/** Opening messages Pilot sends to mission chats. */
import { MISSION_OPENING_MESSAGE_LIMIT } from "@pilot/kernel/mission-write";
import type { MissionArtifactLink, MissionResource, MissionTask } from "@pilot/protocol";

/** Sent to a chat that just became a mission, so it drafts the shared state from its own conversation. */
export function draftMessage(title: string): string {
	return [
		`This chat is now part of the mission "${title}", which you coordinate.`,
		"Using the mission tool, draft the shared mission state from our conversation so far:",
		"- set a short goal and draft the brief (scope and requirements),",
		"- record substantive agreed mission choices (scope, behavior or tradeoffs) with decide, keeping human-answer/source references and explicit authority limits; decision text never grants tool/runtime permission,",
		"- keep routine directions/status in task updates or log context, not decisions; use existing memory only for appropriate lasting cross-mission preferences; discussion/proposal is not agreement,",
		"- create tasks with current status, each small enough for one chat, and dependencies where order matters.",
		"Do not start implementing tasks. Reply with a short summary so I can review the mission.",
	].join("\n");
}

export function taskMessage(
	tasks: MissionTask[],
	extra?: string,
	artifacts: MissionArtifactLink[] = [],
	links: Pick<MissionResource, "url" | "kind" | "title" | "externalId">[] = [],
	continuing = false,
	explorer = false,
): string {
	const task = tasks[0]!;
	const line = (value: string) => value.replace(/\s+/g, " ").trim();
	const message = [
		...(tasks.length === 1
			? [
					`${continuing ? "Continue" : "Work on"} mission task #${task.number}: ${task.title}`,
					...(task.body ? ["", task.body] : []),
				]
			: [
					"Work on these mission tasks in order:",
					...tasks.flatMap((item) => ["", `#${item.number}: ${item.title}`, ...(item.body ? [item.body] : [])]),
					"",
					explorer
						? "Report research findings, sources and limitations with mission log; propose planning changes with comment and share session-local artifacts with attach. Do not write product code."
						: "Open one PR per task. Base the first on the requested starting branch, then each PR on the previous task's head with gh pr create --base <previous-head> --head <own-head>. Link PR URLs bottom-to-top with gh stack link. Attribute each PR with mission link + taskId. Keep plain chained PRs if stacks are unavailable.",
				]),
		...(extra?.trim() ? ["", extra.trim()] : []),
		...(artifacts.length || links.length
			? [
					"",
					"Task references. Read them as needed; their content is not included here:",
					...artifacts
						.toSorted((a, b) => a.artifactId.localeCompare(b.artifactId))
						.map(
							(item) =>
								`- ${line(item.title)} (${item.kind}): ${item.artifactId}${item.revision === undefined ? "" : `, revision ${item.revision}`}`,
						),
					// New links use request order; persisted links can tie on timestamp and sort by random IDs.
					...links
						.toSorted((a, b) => a.url.localeCompare(b.url))
						.map((item) => `- ${line(item.title ?? item.externalId ?? "Link")} (${item.kind}): ${item.url}`),
				]
			: []),
		"",
		tasks.length === 1
			? continuing
				? "This task is already claimed for this chat. Continue where you stopped, and read the mission with the mission tool."
				: "This task is already claimed for this chat. Start by reading the mission with the mission tool."
			: "All these tasks are already claimed for this chat. Start by reading the mission with the mission tool.",
	].join("\n");
	if (message.length > MISSION_OPENING_MESSAGE_LIMIT)
		throw new Error(
			`Opening message is too long (${message.length} characters; max ${MISSION_OPENING_MESSAGE_LIMIT}). Shorten the task body, message or references. Put durable context in the brief, decisions or task links.`,
		);
	return message;
}

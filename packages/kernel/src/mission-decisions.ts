import type { MissionContext } from "./policy.ts";

export type AcknowledgedDecision = Pick<
	NonNullable<MissionContext["decisionState"]>[number],
	"number" | "text" | "audience" | "replacement" | "withdrawn"
>;

/** Compare live snapshots, never the deliberately frozen prompt. */
export function decisionNotice(
	previous: MissionContext,
	current: MissionContext,
	ownAdditions: ReadonlyMap<string, AcknowledgedDecision> = new Map(),
): { summary: string; detail: string } | undefined {
	const before = previous.decisionState;
	const after = current.decisionState;
	if (!before || !after)
		return {
			summary: "Mission decisions changed",
			detail:
				'Mission decisions changed. Read mission({action: "decisions"}); current decisions supersede earlier prompt text.',
		};
	const old = new Map(before.map((decision) => [decision.id, decision]));
	const changes: Array<{ summary: string; detail: string }> = [];
	const quote = (text: string) =>
		text
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n");
	for (const decision of after) {
		const prior = old.get(decision.id);
		old.delete(decision.id);
		const label = `D${decision.number}`;
		const own = ownAdditions.get(decision.id);
		const acknowledged =
			own?.number === decision.number &&
			own.text === decision.text &&
			own.audience === decision.audience &&
			own.replacement?.id === decision.replacement?.id &&
			own.replacement?.number === decision.replacement?.number &&
			own.replacement?.at === decision.replacement?.at &&
			own.withdrawn?.at === decision.withdrawn?.at &&
			own.withdrawn?.reason === decision.withdrawn?.reason &&
			own.withdrawn?.proposalId === decision.withdrawn?.proposalId;
		if (!prior) {
			if (acknowledged) continue;
			changes.push({
				summary: decision.withdrawn
					? `${label} withdrawn (no longer binding)`
					: decision.replacement
						? `${label} replaced by D${decision.replacement.number} (no longer binding)`
						: `${label} added: ${decision.text}`,
				detail: `### ${label} ${decision.withdrawn ? `withdrawn (no longer binding)\n\nReason:\n${quote(decision.withdrawn.reason)}` : decision.replacement ? `replaced by D${decision.replacement.number} (no longer binding)` : "added"}\n\n${quote(decision.text)}`,
			});
			continue;
		}
		const details: string[] = [];
		const replaced = prior.replacement?.id !== decision.replacement?.id;
		const withdrawn =
			prior.withdrawn?.at !== decision.withdrawn?.at ||
			prior.withdrawn?.reason !== decision.withdrawn?.reason ||
			prior.withdrawn?.proposalId !== decision.withdrawn?.proposalId;
		const ownRetirement = ((replaced && decision.replacement) || (withdrawn && decision.withdrawn)) && acknowledged;
		if (prior.text !== decision.text)
			details.push(`Before:\n${quote(prior.text)}\n\nAfter:\n${quote(decision.text)}`);
		if (prior.audience !== decision.audience) details.push(`Audience: ${prior.audience} → ${decision.audience}`);
		if (prior.selected !== decision.selected && !ownRetirement)
			details.push(
				`Prompt selection: ${prior.selected ? "included" : "not included"} → ${decision.selected ? "included" : "not included"}`,
			);
		if ((replaced || details.length) && !ownRetirement && decision.replacement)
			details.unshift(
				`Replaced by D${decision.replacement.number}. ${label} is no longer binding. Historical task pins are unchanged; read the replacement separately within its own audience.`,
			);
		if ((withdrawn || details.length) && !ownRetirement && decision.withdrawn)
			details.unshift(
				`Withdrawn. ${label} is no longer binding. Historical text and task pins are unchanged.\n\nReason:\n${quote(decision.withdrawn.reason)}`,
			);
		if (details.length)
			changes.push({
				summary: decision.withdrawn
					? `${label} withdrawn (no longer binding)`
					: decision.replacement
						? `${label} replaced by D${decision.replacement.number} (no longer binding)`
						: `${label} updated: ${decision.text}`,
				detail: `### ${label} updated\n\n${prior.text === decision.text ? `${quote(decision.text)}\n\n` : ""}${details.join("\n\n")}`,
			});
	}
	for (const decision of old.values())
		changes.push({
			summary: `D${decision.number} removed: ${decision.text}`,
			detail: `### D${decision.number} removed\n\n${quote(decision.text)}`,
		});
	if (!changes.length) return undefined;
	const excerpt = changes[0]!.summary.replace(/\s+/g, " ").trim();
	const summary = `Mission decisions changed: ${excerpt.length > 120 ? `${excerpt.slice(0, 119)}…` : excerpt}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ""}`;
	return {
		summary,
		detail: `Mission decisions changed.\n\n${changes.map((change) => change.detail).join("\n\n")}\n\nRead mission({action: "decisions"}); current decisions supersede earlier prompt text.`,
	};
}

import type { MissionContext } from "./policy.ts";

/** Compare live snapshots, never the deliberately frozen prompt. */
export function decisionNotice(
	previous: MissionContext,
	current: MissionContext,
	ownAdditions: ReadonlyMap<string, { number: number; text: string; audience: string }> = new Map(),
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
		if (!prior) {
			const own = ownAdditions.get(decision.id);
			if (own && own.number === decision.number && own.text === decision.text && own.audience === decision.audience)
				continue;
			changes.push({
				summary: `${label} added: ${decision.text}`,
				detail: `### ${label} added\n\n${quote(decision.text)}`,
			});
			continue;
		}
		const details: string[] = [];
		if (prior.text !== decision.text)
			details.push(`Before:\n${quote(prior.text)}\n\nAfter:\n${quote(decision.text)}`);
		if (prior.audience !== decision.audience) details.push(`Audience: ${prior.audience} → ${decision.audience}`);
		if (prior.selected !== decision.selected)
			details.push(
				`Prompt selection: ${prior.selected ? "included" : "not included"} → ${decision.selected ? "included" : "not included"}`,
			);
		if (details.length)
			changes.push({
				summary: `${label} updated: ${decision.text}`,
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

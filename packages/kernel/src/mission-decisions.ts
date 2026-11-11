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
): { summary: string; detail: string; urgent: boolean; decisionIds: string[] } | undefined {
	const before = previous.decisionState;
	const after = current.decisionState;
	if (
		!before &&
		!after &&
		previous.decisionVersion === current.decisionVersion &&
		JSON.stringify(previous.decisions) === JSON.stringify(current.decisions)
	)
		return undefined;
	if (!before || !after)
		return {
			urgent: true,
			decisionIds: [],
			summary: "Mission decisions changed",
			detail:
				'Mission decisions changed. Read mission({action: "decisions"}); current decisions supersede earlier prompt text.',
		};
	const old = new Map(before.map((decision) => [decision.id, decision]));
	const routed = !!(previous.decisionRoutes || current.decisionRoutes);
	const route = (context: MissionContext, decision: NonNullable<typeof before>[number]) =>
		context.decisionRoutes?.[decision.id] ??
		(!routed ||
		decision.selected ||
		decision.audience === "all" ||
		(decision.audience === "coordinator" && context.coordinator === "self")
			? "relevant"
			: "unrelated");
	let urgent = !routed;
	let unknown = false;
	const changes: Array<{ id: string; summary: string; detail: string }> = [];
	const quote = (text: string) =>
		text
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n");
	for (const decision of after) {
		const prior = old.get(decision.id);
		old.delete(decision.id);
		const routing = route(current, decision);
		const priorRouting = prior ? route(previous, prior) : "unrelated";
		if (routing === "unrelated" && priorRouting === "unrelated") continue;
		// Reassignment/unpinning alone must not send the former owner's now-unrelated guidance.
		if (
			routing === "unrelated" &&
			prior &&
			JSON.stringify([prior.text, prior.audience, prior.replacement, prior.withdrawn]) ===
				JSON.stringify([decision.text, decision.audience, decision.replacement, decision.withdrawn])
		)
			continue;
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
			unknown ||= routing === "unknown";
			urgent ||= decision.audience === "all" || (routing === "relevant" && decision.audience !== "coordinator");
			changes.push({
				id: decision.id,
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
		if (routing !== priorRouting && routing !== "unrelated" && prior.selected === decision.selected)
			details.push(`Notice routing: ${priorRouting} → ${routing}`);
		if ((replaced || details.length) && !ownRetirement && decision.replacement)
			details.unshift(
				`Replaced by D${decision.replacement.number}. ${label} is no longer binding. Historical task pins are unchanged; read the replacement separately within its own audience.`,
			);
		if ((withdrawn || details.length) && !ownRetirement && decision.withdrawn)
			details.unshift(
				`Withdrawn. ${label} is no longer binding. Historical text and task pins are unchanged.\n\nReason:\n${quote(decision.withdrawn.reason)}`,
			);
		if (details.length) {
			unknown ||= routing === "unknown" || priorRouting === "unknown";
			// Known guidance edits/retirements and newly assigned context cannot wait behind a batch.
			urgent ||= routing === "relevant" || priorRouting === "relevant" || priorRouting === "unknown";
			changes.push({
				id: decision.id,
				summary: decision.withdrawn
					? `${label} withdrawn (no longer binding)`
					: decision.replacement
						? `${label} replaced by D${decision.replacement.number} (no longer binding)`
						: `${label} updated: ${decision.text}`,
				detail: `### ${label} updated\n\n${prior.text === decision.text ? `${quote(decision.text)}\n\n` : ""}${details.join("\n\n")}`,
			});
		}
	}
	for (const decision of old.values()) {
		const routing = route(previous, decision);
		if (routing === "unrelated") continue;
		unknown ||= routing === "unknown";
		urgent = true;
		changes.push({
			id: decision.id,
			summary: `D${decision.number} removed: ${decision.text}`,
			detail: `### D${decision.number} removed\n\n${quote(decision.text)}`,
		});
	}
	if (!changes.length) return undefined;
	const excerpt = changes[0]!.summary.replace(/\s+/g, " ").trim();
	const summary = `Mission decisions changed: ${excerpt.length > 120 ? `${excerpt.slice(0, 119)}…` : excerpt}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ""}`;
	return {
		urgent,
		decisionIds: changes.map((change) => change.id),
		summary,
		detail: `Mission decisions changed.${unknown ? "\n\nUncertain relevance: coordinator must route unassociated guidance before potentially conflicting work continues. No worker was started to classify it." : ""}\n\n${changes.map((change) => change.detail).join("\n\n")}\n\nRead mission({action: "decisions"}); current decisions supersede earlier prompt text. Delivery is not proof that guidance was applied and grants no new authority.`,
	};
}

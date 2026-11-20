import { computed, untracked } from "nsh";
import type { PlanRow } from "pilot-day/native";
import type { Day } from "./day";
import { openPlannerInterview } from "./planView";
import { todayProject } from "./todayScope";
import { Button, Caption, Row, RowDetail } from "./ui";
import { placeRow, todayPlace } from "./view";

type Request = { projectId: string; project: string; plan: PlanRow };
const anchorId = (mission: string) => `answer-planner-interview-${mission}`;

/** The project list and inventory name the scope together; never join with an older own-project list. */
export function plannerInterviews(day: Day) {
	const snapshot = () => {
		const s = day.scope?.view().snapshot;
		return s?.scope === todayProject() ? s : null;
	};
	const projects = () => snapshot()?.projects.filter((p) => p.selected && p.canOpenPlanning !== false) ?? [];
	const rows = computed(() => {
		const byMission = new Map<string, Request>();
		for (const p of projects()) {
			for (const plan of p.planning?.plans ?? []) {
				if (plan.stage === "questions" && plan.identity)
					byMission.set(plan.missionId, { projectId: p.id, project: p.name, plan });
			}
		}
		return [...byMission.values()];
	});
	const known = () =>
		!day.scope ||
		(!day.scope.incomplete() &&
			snapshot()?.catalogComplete === true &&
			projects().every((p) => p.planning?.availability === "live"));
	// Returning after submission or access loss must not leave a latent focus request for a later round.
	untracked(() => {
		if (
			todayPlace.row?.startsWith("answer-planner-interview-") &&
			!rows().some((row) => anchorId(row.plan.missionId) === todayPlace.row)
		)
			todayPlace.row = null;
	});
	return { rows, known };
}

export type PlannerInterviews = ReturnType<typeof plannerInterviews>;

/**
 * The interview is its own request, not a decision, plan approval, or work item: one row each, queued under the
 * question in front, with its one way in. Put it inside `Rows`.
 */
export function PlannerInterviewCards(props: { interviews: PlannerInterviews }) {
	return (
		<Each of={props.interviews.rows()} key={(r) => r.plan.missionId}>
			{(r) => {
				const mission = r().plan.missionId;
				const id = anchorId(mission);
				const place = placeRow(id, () => openPlannerInterview(mission, r().projectId));
				const pending = () => {
					const n = r().plan.pendingQuestions;
					return n == null
						? ""
						: n === 0
							? "Answers saved. Submit to finish."
							: `${n} ${n === 1 ? "question" : "questions"} pending.`;
				};
				return (
					<Row
						testID={`planner-interview-${mission}`}
						mark="needs"
						title={r().plan.title}
						meta="Planner needs your answers"
						detail={
							<RowDetail>
								<Caption tone="faint">
									{[
										`${r().project} · Mission planning.`,
										pending(),
										"Your saved draft stays in the interview.",
									]
										.filter(Boolean)
										.join(" ")}
								</Caption>
							</RowDetail>
						}
						trailing={
							<Button
								small
								label="Answer interview →"
								testID={id}
								anchor={place.anchor}
								accessibilityLabel={`Answer interview for ${r().plan.title} in ${r().project}`}
								onPress={place.press}
							/>
						}
					/>
				);
			}}
		</Each>
	);
}

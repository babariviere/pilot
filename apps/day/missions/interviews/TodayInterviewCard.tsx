import { cleanup, effect, signal, type ViewRef } from "nsh";
import { anchors, dataSource, focusFront, holdFront } from "../../app/view";
import { laterDecision } from "../../today/commands";
import { InterviewCard as LocalInterviewCard } from "./InterviewCard";
import { ScopedQuestion } from "./ScopedQuestion";

export function TodayInterview(props: Parameters<typeof LocalInterviewCard>[0]) {
	return (
		<If when={dataSource() === "pilot" && !!props.day.today().project} else={<LocalInterviewCard {...props} />}>
			<Each of={[props.day.today().project]} key={(id) => id}>
				{(id) => <TodayInterviewCard {...props} projectId={id()} />}
			</Each>
		</If>
	);
}

function TodayInterviewCard(props: Parameters<typeof LocalInterviewCard>[0] & { projectId: string }) {
	const id = props.decision.id;
	const primary = signal<ViewRef | null>(null);
	anchors.set(id, () => primary() ?? undefined);
	effect(() => {
		if (focusFront() && props.keyboardActive && primary()) {
			primary()?.focus();
			focusFront.set(false);
		}
	});
	cleanup(() => anchors.delete(id));
	return (
		<ScopedQuestion
			place={{
				projectId: props.projectId,
				projectName: "",
				decisionId: id,
				interviewRoundId: props.decision.interviewRoundId ?? undefined,
			}}
			inline={{
				get keyboardActive() {
					return props.keyboardActive;
				},
				anchor: (node) => primary.set(node),
				onFocus: () => holdFront(id),
				legacyDraftText: props.decision.draft.text,
				get onLater() {
					return props.later ? () => laterDecision(props.day, props.decision) : undefined;
				},
			}}
			onBack={() => {}}
			onAnswered={() => {
				focusFront.set(true);
				void props.day.feed.pulse();
			}}
		/>
	);
}

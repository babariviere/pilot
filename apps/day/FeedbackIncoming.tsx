// Feedback attention in Today's New section. Reading and Later send no work intent.
import { Keyboard, signal, Text, View } from "nsh";
import { Button, Collapsible } from "nsh/base";
import type { Day } from "./day";
import { FeedbackRow } from "./FeedbackRow";
import type { FeedbackItem } from "./feedbackFeed";
import { chatState, clip, questionOf, stepsOf } from "./feedbackSteps";
import { dayOf, feedbackLater } from "./feedbackView";
import { todayProject } from "./todayScope";
import { Action, Mark } from "./ui";

/** A new question or triage replaces an earlier Later. */
export function feedbackAttention(item: FeedbackItem): string | null {
	const s = stepsOf(item);
	if (s.resolved || !s.triage) return null;
	const q = questionOf(s.triage);
	if (q) return `${item.id}/${s.triage.operationId}/${q.id}`;
	return chatState(s.triage) === "done" ? `${item.id}/${s.triage.operationId}/done` : null;
}

export function incomingFeedback(day: Day): FeedbackItem[] {
	return (day.feedback?.view().items ?? []).filter((item) => {
		const triage = stepsOf(item).triage;
		return !!feedbackAttention(item) && (todayProject() === "all" || triage?.projectId === todayProject());
	});
}

export function newFeedback(day: Day): FeedbackItem[] {
	return incomingFeedback(day).filter((item) => !feedbackLater().includes(feedbackAttention(item)!));
}

export function FeedbackIncoming(props: { day: Day }) {
	const open = signal<string | null>(null);
	const laterOpen = signal(false);
	const mirror = props.day.feedback;
	if (!mirror) return null;
	const v = () => mirror.view();
	const kept = () => incomingFeedback(props.day).filter((i) => feedbackLater().includes(feedbackAttention(i)!));
	const defer = (item: FeedbackItem, later: boolean) => {
		const key = feedbackAttention(item);
		if (!key) return;
		Keyboard.dismiss();
		feedbackLater.update((all) => [...all.filter((k) => !k.startsWith(`${item.id}/`)), ...(later ? [key] : [])]);
		open.set(null);
	};
	return (
		<View testID="incoming-feedback" class="gap-1">
			<If when={v().reason}>
				<Text class="text-sm text-muted-foreground">{v().reason}</Text>
			</If>
			<Each of={newFeedback(props.day)} key={(i) => i.id}>
				{(item) => (
					<Collapsible
						open={open() === item().id}
						class="border-t border-border"
						content={
							<FeedbackRow day={props.day} mirror={mirror} item={item()} when={dayOf(item().recordedAt)} />
						}
					>
						<View class="flex-row items-center gap-2.5 py-2.5">
							<Mark kind={questionOf(stepsOf(item()).triage) ? "needs" : "new"} />
							<View class="min-w-0 flex-1">
								<Button
									testID={`feedback-new-${item().id}`}
									accessibilityLabel={`${clip(item().text, 100)}. Feedback. ${questionOf(stepsOf(item()).triage) ? "The triage asks" : "Triage finished"}. Show or hide details.`}
									class="min-h-8 flex-row items-center rounded-lg px-3 py-1 transition duration-150 hover:bg-accent active:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
									onPress={() => {
										Keyboard.dismiss();
										const opening = open() !== item().id;
										open.set(opening ? item().id : null);
										if (opening) void mirror.source.readProjects();
									}}
								>
									<Text class="min-w-0 shrink text-sm text-muted-foreground">{clip(item().text, 100)}</Text>
								</Button>
								<Text class="text-xs text-faint">
									{questionOf(stepsOf(item()).triage)
										? "Feedback · The triage asks"
										: "Feedback · Triage finished"}
								</Text>
							</View>
							<Action label="Later" testID={`feedback-later-${item().id}`} onPress={() => defer(item(), true)} />
						</View>
					</Collapsible>
				)}
			</Each>
			<If when={kept().length > 0}>
				<View class="gap-1 pt-3">
					<Action
						label={`Later · Feedback ${kept().length}`}
						testID="feedback-later-show"
						onPress={() => laterOpen.set(!laterOpen())}
					/>
					<If when={laterOpen()}>
						<Each of={kept()} key={(i) => i.id}>
							{(item) => (
								<View class="flex-row items-center gap-2.5 border-t border-border py-2.5">
									<Text class="min-w-0 flex-1 text-sm text-foreground">{clip(item().text, 100)}</Text>
									<Action
										label="Bring back"
										testID={`feedback-bring-back-${item().id}`}
										onPress={() => defer(item(), false)}
									/>
								</View>
							)}
						</Each>
					</If>
				</View>
			</If>
			<If when={v().more}>
				<Text class="text-xs text-faint">Earlier feedback has not been read yet.</Text>
				<Action
					label="Read earlier feedback"
					testID="incoming-feedback-more"
					onPress={() => void mirror.source.more()}
				/>
			</If>
		</View>
	);
}

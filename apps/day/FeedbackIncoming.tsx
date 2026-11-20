// Feedback attention in Today's Needs you queue. Reading and Later send no work intent.
import { effect, Keyboard, signal, View } from "nsh";
import type { Day } from "./day";
import { FeedbackRow } from "./FeedbackRow";
import type { FeedbackItem } from "./feedbackFeed";
import { askingOf, chatState, clip, stepsOf } from "./feedbackSteps";
import { dayOf, feedbackLater } from "./feedbackView";
import { todayProject } from "./todayScope";
import { Block, Button, Buttons, EmptyLine, Link, Row, Rows } from "./ui";

/** User-selected feedback can come forward without answering the current chat question. */
export const feedbackFocus = signal<string | null>(null);

/** A new question, triage or prototype result replaces an earlier Later. */
export function feedbackAttention(item: FeedbackItem): string | null {
	const s = stepsOf(item);
	if (s.resolved || !s.triage) return null;
	const asking = askingOf(s);
	if (asking) return `${item.id}/${asking.step.operationId}/${asking.question.id}`;
	// After a prototype starts, its result needs the user, not the triage's proposal.
	const lead = s.prototype ?? s.triage;
	const digest = lead.proposal?.digest;
	const state = chatState(lead);
	if (["failed", "stopped", "missing"].includes(state)) return `${item.id}/${lead.operationId}/${state}`;
	return state === "done" ? `${item.id}/${lead.operationId}/${digest ? `done-${digest}` : "done"}` : null;
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

export function FeedbackIncoming(props: { day: Day; active?: boolean }) {
	const laterOpen = signal(false);
	const mirror = props.day.feedback;
	if (!mirror) return null;
	const v = () => mirror.view();
	const pending = () => newFeedback(props.day);
	const first = () =>
		props.active === false ? null : (pending().find((i) => i.id === feedbackFocus()) ?? pending()[0] ?? null);
	const kept = () => incomingFeedback(props.day).filter((i) => feedbackLater().includes(feedbackAttention(i)!));
	let askedProjects = false;
	effect(() => {
		if (first() && !v().projects && !askedProjects) {
			askedProjects = true;
			void mirror.source.readProjects();
		}
	});
	const defer = (item: FeedbackItem, later: boolean) => {
		const key = feedbackAttention(item);
		if (!key) return;
		Keyboard.dismiss();
		feedbackFocus.set(null);
		feedbackLater.update((all) => [...all.filter((k) => !k.startsWith(`${item.id}/`)), ...(later ? [key] : [])]);
	};
	return (
		<View testID="incoming-feedback">
			{/* Only a read that never worked says so here; the Feedback page carries the old-data warning. */}
			<If when={v().reason && v().availability !== "live"}>
				<EmptyLine text={v().reason} />
			</If>
			<Each of={first() ? [first()!] : []} key={(i) => i.id}>
				{(item) => (
					<Block gap={3}>
						<FeedbackRow
							day={props.day}
							mirror={mirror}
							item={item()}
							when={dayOf(item().recordedAt)}
							routeKey="today"
						/>
						<Buttons>
							<Button label="Later" testID={`feedback-later-${item().id}`} onPress={() => defer(item(), true)} />
						</Buttons>
					</Block>
				)}
			</Each>
			<Rows>
				<Each of={pending().filter((i) => i.id !== first()?.id)} key={(i) => i.id}>
					{(item) => (
						<Row
							mark={askingOf(stepsOf(item())) ? "needs" : "new"}
							title={`Up next: Feedback · ${clip(item().text, 100)}`}
							testID={`feedback-new-${item().id}`}
							onPress={() => {
								Keyboard.dismiss();
								feedbackFocus.set(item().id);
							}}
						/>
					)}
				</Each>
			</Rows>
			<If when={kept().length > 0}>
				<Block>
					<Link
						label={`Later · Feedback ${kept().length}`}
						testID="feedback-later-show"
						onPress={() => laterOpen.set(!laterOpen())}
					/>
				</Block>
				<If when={laterOpen()}>
					<Rows>
						<Each of={kept()} key={(i) => i.id}>
							{(item) => (
								<Row
									title={clip(item().text, 100)}
									trailing={
										<Button
											small
											label="Bring back"
											testID={`feedback-bring-back-${item().id}`}
											onPress={() => defer(item(), false)}
										/>
									}
								/>
							)}
						</Each>
					</Rows>
				</If>
			</If>
			<If when={v().more}>
				<EmptyLine text="Earlier feedback has not been read yet." />
				<Block>
					<Link
						label="Read earlier feedback"
						testID="incoming-feedback-more"
						onPress={() => void mirror.source.more()}
					/>
				</Block>
			</If>
		</View>
	);
}

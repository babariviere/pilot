import { cleanup, keymap, Scroll, signal } from "nsh";
import type { Decision, IntentOutcome } from "pilot-day/native";
import { call, windowId } from "../../sources/bridge";
import {
	Block,
	Body,
	Button,
	Buttons,
	Caption,
	Column,
	KeyHints,
	Link,
	Option,
	Options,
	Page,
	PageHead,
	Panel,
	Question,
	Row,
	Rows,
	Section,
	Spacer,
	TextField,
} from "../../ui";
import { ScopedInterviewCard } from "./InterviewCard";

type Selector = { projectId: string; decisionId: string; interviewRoundId?: string };
type Target = { selector: Selector; pin: string };
type Answer = { picks: string[]; text: string };
type Reply =
	| { state: "ready"; target: Target; decision: Decision }
	| { state: "unknown" | "accepted" | "not-sent" | "rejected"; operationId: string }
	| { state: "saved" };
type Command =
	| { kind: "open"; selector: Selector }
	| { kind: "save" | "send"; target: Target; answer: Answer }
	| { kind: "recover"; target: Target }
	| { kind: "check"; selector: Selector; operationId: string };

export const scopedQuestion = signal<(Selector & { projectName: string }) | null>(null);
const kept = new Map<string, { target: Target; answer: Answer }>();
const draftVersion = signal(0);

async function request(args: Command): Promise<Reply | null> {
	const window = windowId();
	if (!window) return null;
	const reply = await call<Reply>(window, "day.attention.scoped", args);
	return reply.ok ? reply.snapshot : null;
}

export function captureScopedDrafts(): string[] {
	return [...kept.values()].map((draft) => JSON.stringify(draft));
}

export function restoreScopedDrafts(drafts: string[] = []) {
	scopedQuestion.set(null);
	kept.clear();
	for (const raw of drafts) {
		try {
			const draft = JSON.parse(raw);
			const target = draft?.target;
			const answer = draft?.answer;
			if (
				typeof target?.pin === "string" &&
				/^[a-f\d]{64}$/.test(target.pin) &&
				typeof target.selector?.projectId === "string" &&
				typeof target.selector?.decisionId === "string" &&
				typeof answer?.text === "string" &&
				Array.isArray(answer.picks) &&
				answer.picks.every((id: unknown) => typeof id === "string")
			)
				kept.set(target.pin, { target, answer });
		} catch {
			/* Earlier or unreadable drafts do not identify a question. */
		}
	}
	draftVersion.update((v) => v + 1);
}

/** Older question revisions may no longer open. The user can still copy or discard their own words. */
export function ScopedAnswerDrafts() {
	const drafts = () => {
		draftVersion();
		return [...kept.values()];
	};
	return (
		<If when={drafts().length > 0}>
			<Section title="Unsent answers from other projects" count={drafts().length}>
				<Rows>
					<Each of={drafts()} key={(draft) => draft.target.pin}>
						{(draft) => (
							<Row
								title={draft().answer.text || "Unsent choice"}
								wrap
								selectable
								trailing={
									<Button
										small
										label="Discard draft"
										onPress={() => {
											kept.delete(draft().target.pin);
											draftVersion.update((v) => v + 1);
										}}
									/>
								}
							/>
						)}
					</Each>
				</Rows>
			</Section>
		</If>
	);
}

export function ScopedQuestion(props: {
	place: Selector & { projectName: string };
	onBack: () => void;
	onAnswered: () => void;
}) {
	const selector = {
		projectId: props.place.projectId,
		decisionId: props.place.decisionId,
		interviewRoundId: props.place.interviewRoundId,
	};
	const card = signal<Extract<Reply, { state: "ready" }> | null>(null);
	const answer = signal<Answer>({ picks: [], text: "" });
	const unresolved = signal("");
	const checking = signal(false);
	const busy = signal(false);
	const message = signal("");
	let active = true;
	cleanup(() => {
		active = false;
	});
	const enter = (reply: Reply | null) => {
		if (!active) return;
		switch (reply?.state) {
			case "ready": {
				card.set(reply);
				const d = reply.decision.draft;
				answer.set(kept.get(reply.target.pin)?.answer ?? { picks: d.pick ? [d.pick] : d.picks, text: d.text });
				checking.set(false);
				message.set("");
				break;
			}
			case "unknown":
				unresolved.set(reply.operationId);
				checking.set(true);
				message.set("Pilot could not confirm your answer. Check only. It will not send again.");
				break;
			case "accepted":
				if (card()) kept.delete(card()!.target.pin);
				card.set(null);
				unresolved.set("");
				checking.set(false);
				message.set("Answer sent.");
				props.onAnswered();
				break;
			case "not-sent":
			case "rejected":
				unresolved.set("");
				checking.set(false);
				message.set("The answer was not sent. Your draft is kept.");
				break;
			default:
				message.set("Pilot could not read this question. It may have changed.");
		}
	};
	async function run(command: Command) {
		if (busy()) return null;
		busy.set(true);
		const reply = await request(command);
		if (!active) return null;
		busy.set(false);
		if (!reply && (command.kind === "send" || command.kind === "check" || command.kind === "recover")) {
			checking.set(true);
			message.set("Pilot could not confirm your answer. Check only. It will not send again.");
			return null;
		}
		if (command.kind === "send" && reply?.state === "unknown") kept.delete(command.target.pin);
		enter(reply);
		return reply;
	}
	const read = () => void run({ kind: "open", selector });
	const edit = (next: Answer) => {
		const current = card();
		if (!current || checking()) return;
		answer.set(next);
		if (next.text || next.picks.length) kept.set(current.target.pin, { target: current.target, answer: next });
		else kept.delete(current.target.pin);
	};
	const send = () => {
		const current = card();
		if (!selector.interviewRoundId && current && !checking() && (answer().picks.length || answer().text.trim()))
			void run({ kind: "send", target: current.target, answer: answer() });
	};
	const commitKeys = keymap.label("mod+enter");
	keymap.bind("mod+enter", send, { when: "always" });
	keymap.bind(
		"escape",
		() => {
			if (!busy()) props.onBack();
		},
		{ when: "always" },
	);
	read();
	return (
		<Scroll class="flex-1">
			<Page>
				<PageHead
					pre={<Caption>{props.place.projectName}</Caption>}
					title={card()?.decision.title ?? "Agent question"}
					text={card()?.decision.reason || card()?.decision.context || ""}
				/>
				<Panel>
					<Column>
						<Section title="Needs you">
							<If when={selector.interviewRoundId && card() && !checking()}>
								<Each of={card() ? [card()!] : []} key={(row) => row.target.pin}>
									{(row) => (
										<ScopedInterviewCard
											decision={row().decision}
											identity={row().target.pin}
											draftText={answer().text}
											keyboardActive={!busy()}
											draftMessage={message()}
											onSave={(text) => edit({ picks: [], text })}
											onSubmit={async (text): Promise<IntentOutcome> => {
												const reply = await run({
													kind: "send",
													target: row().target,
													answer: { picks: [], text },
												});
												return {
													status:
														reply?.state === "accepted"
															? "accepted"
															: checking()
																? "unknown"
																: "rejected",
													revision: row().decision.revision,
													message: message(),
												};
											}}
											onCheck={() => void run({ kind: "recover", target: row().target })}
										/>
									)}
								</Each>
							</If>
							<If when={!selector.interviewRoundId && card() && !checking()}>
								<Question
									title="Your answer"
									foot={
										<>
											<Button
												kind="primary"
												label="Send answer"
												shortcut={commitKeys}
												disabled={busy() || (!answer().picks.length && !answer().text.trim())}
												onPress={send}
											/>
											<Spacer />
											<KeyHints hints={[[commitKeys, "Send answer"]]} />
										</>
									}
								>
									<Options multiple={card()?.decision.multiple === true}>
										<Each of={card()?.decision.options ?? []} key={(option) => option.id}>
											{(option) => {
												const id = () => option().id;
												const picked = () => answer().picks.includes(id());
												const choose = () =>
													edit({
														...answer(),
														picks: card()?.decision.multiple
															? picked()
																? answer().picks.filter((i) => i !== id())
																: [...answer().picks, id()]
															: [id()],
													});
												return (
													<Option
														multiple={card()?.decision.multiple === true}
														title={option().label}
														checked={picked()}
														disabled={busy()}
														onChange={choose}
													/>
												);
											}}
										</Each>
									</Options>
									<TextField
										accessibilityLabel="Your answer"
										placeholder="Answer in your own words"
										multiline
										rows={3}
										value={answer().text}
										disabled={busy()}
										onChange={({ value }) => edit({ ...answer(), text: value })}
									/>
								</Question>
							</If>
							<If
								when={message() || busy() || checking() || (!card() && !busy() && message() !== "Answer sent.")}
							>
								<Block>
									<If when={message() || busy()}>
										<Body tone="muted">{busy() ? "Working…" : message()}</Body>
									</If>
									<If when={checking()}>
										<Buttons>
											<Button
												label="Check answer"
												disabled={busy()}
												onPress={() =>
													unresolved()
														? void run({ kind: "check", selector, operationId: unresolved() })
														: card()
															? void run({ kind: "recover", target: card()!.target })
															: read()
												}
											/>
										</Buttons>
									</If>
									<If when={!card() && !checking() && !busy() && message() !== "Answer sent."}>
										<Link label="Read again" onPress={read} />
									</If>
								</Block>
							</If>
						</Section>
					</Column>
				</Panel>
			</Page>
		</Scroll>
	);
}

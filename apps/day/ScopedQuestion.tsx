import { cleanup, keymap, Scroll, signal, Text, View } from "nsh";
import type { Decision, IntentOutcome } from "pilot-day/native";
import { call, windowId } from "./bridge";
import { ScopedInterviewCard } from "./InterviewCard";
import { Action, CheckboxRow, Page, PageTitle, RadioList, RadioRow, TextField } from "./ui";

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
			<View class="gap-2">
				<Text class="text-sm font-semibold text-foreground">Unsent answers from other projects</Text>
				<Each of={drafts()} key={(draft) => draft.target.pin}>
					{(draft) => (
						<View class="gap-2 border-b border-border py-2">
							<View selectable>
								<Text class="text-sm text-muted-foreground">{draft().answer.text || "Unsent choice"}</Text>
							</View>
							<View class="flex-row">
								<Action
									label="Discard draft"
									onPress={() => {
										kept.delete(draft().target.pin);
										draftVersion.update((v) => v + 1);
									}}
								/>
							</View>
						</View>
					)}
				</Each>
			</View>
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
		<Scroll class="flex-1 bg-background">
			<Page gap={8}>
				<View class="gap-2">
					<Text class="text-xs text-muted-foreground">{props.place.projectName}</Text>
					<PageTitle title={card()?.decision.title ?? "Agent question"} />
					<Text class="text-sm text-muted-foreground">
						{card()?.decision.reason || card()?.decision.context || ""}
					</Text>
				</View>
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
									const reply = await run({ kind: "send", target: row().target, answer: { picks: [], text } });
									return {
										status: reply?.state === "accepted" ? "accepted" : checking() ? "unknown" : "rejected",
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
					<RadioList>
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
									<If
										when={card()?.decision.multiple}
										else={
											<RadioRow
												label={option().label}
												checked={picked()}
												disabled={busy()}
												onChange={choose}
											/>
										}
									>
										<CheckboxRow
											label={option().label}
											checked={picked()}
											disabled={busy()}
											onChange={choose}
										/>
									</If>
								);
							}}
						</Each>
					</RadioList>
					<TextField
						accessibilityLabel="Your answer"
						placeholder="Answer in your own words"
						multiline
						rows={3}
						value={answer().text}
						disabled={busy()}
						onChange={({ value }) => edit({ ...answer(), text: value })}
					/>
					<View class="flex-row gap-2">
						<Action
							label="Send answer"
							variant="primary"
							shortcut={commitKeys}
							disabled={busy() || (!answer().picks.length && !answer().text.trim())}
							onPress={send}
						/>
					</View>
				</If>
				<If when={message() || busy()}>
					<Text class="text-sm text-muted-foreground">{busy() ? "Working…" : message()}</Text>
				</If>
				<If when={checking()}>
					<Action
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
				</If>
				<If when={!card() && !checking() && !busy() && message() !== "Answer sent."}>
					<Action label="Read again" onPress={read} />
				</If>
			</Page>
		</Scroll>
	);
}

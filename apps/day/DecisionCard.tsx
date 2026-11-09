// The decision in front: what Pilot asks, help to decide, the choices, and
// where the answer is. Rust decides every state change; this card sends
// intents (commands.ts) and shows the outcome Rust publishes. Help (simpler
// words, context, a chart and questions) never picks, sends or approves.
import { cleanup, effect, keymap, signal, Text, View, type ViewRef } from "nsh";
import { Input, Radio, RadioGroup } from "nsh/base";
import type { Answer, Decision } from "pilot-day/native";
import {
	ask,
	checkAnswer,
	checkDecision,
	commitLabel,
	decide,
	laterDecision,
	needsCheck,
	toggleHelp,
} from "./commands";
import type { Day } from "./day";
import { Action, Bars, EvidenceChip, HelpChip, InlineAction, Mark, type MarkKind } from "./ui";
import {
	anchors,
	asking,
	chosen,
	drafts,
	focusFront,
	focusInput,
	helpOpen,
	messages,
	pick,
	pickChanged,
	setFor,
} from "./view";

/** The keystroke of the card's one commit, as the platform writes it. */
export const COMMIT_KEY = keymap.label("mod+enter");

/** The mark a decision shows. */
export function decisionMark(decision: Decision): MarkKind {
	if (decision.kind === "unknown" || decision.delivery === "unknown") return "unknown";
	if (decision.kind === "failure") return "failed";
	if (decision.kind === "review") return "ready";
	return "needs";
}

/** One sentence about where the user's answer is, or nothing while idle. */
function deliveryLine(decision: Decision): string {
	switch (decision.delivery) {
		case "sending":
			return "Sending your answer…";
		case "checking":
			return "Checking. This only reads; it changes nothing.";
		case "unknown":
			return decision.kind === "unknown"
				? ""
				: "Pilot sent your answer but heard nothing back. It will not send it again until it checks.";
		default:
			return "";
	}
}

/** One question and where its answer is. */
function AnswerLine(props: { day: Day; decision: Decision; answer: Answer }) {
	const a = () => props.answer;
	return (
		<View class="gap-1">
			<Text class="text-sm text-muted-foreground">{a().question}</Text>
			<If when={a().state === "ready"}>
				<Text class="text-sm text-foreground">{a().answer}</Text>
				<If when={a().earlier}>
					<Text class="text-xs text-faint">Asked about an earlier version of this decision.</Text>
				</If>
			</If>
			<If when={a().state === "asking"}>
				<Text class="text-sm text-faint">Pilot is writing an answer…</Text>
			</If>
			<If when={a().state === "checking"}>
				<Text class="text-sm text-faint">Checking. This only reads; it asks nothing again.</Text>
			</If>
			<If when={a().state === "unknown"}>
				<View class="flex-row flex-wrap items-baseline gap-x-1.5">
					<Text class="text-sm text-needs-ink">
						No answer came back. Pilot will not ask again until it checks.
					</Text>
					<InlineAction
						testID="check-answer"
						label="Check again"
						onPress={() => void checkAnswer(props.day, props.decision, a())}
					/>
				</View>
			</If>
		</View>
	);
}

/** The decision `props.decision`, `props.index` of `props.count` waiting. */
export function DecisionCard(props: { day: Day; decision: Decision; index: number; count: number; later: boolean }) {
	const d = () => props.decision;
	const id = props.decision.id;
	const idle = () => d().delivery === "idle";
	const radios = new Map<string, ViewRef>();
	let firstChip: ViewRef | undefined;
	const input = signal<ViewRef | null>(null);
	let stopEscape: (() => void) | null = null;

	// The keyboard focus lands on the chosen option, else on the first help.
	anchors.set(id, () => radios.get(chosen(d())) ?? firstChip);
	cleanup(() => {
		anchors.delete(id);
		stopEscape?.();
	});
	effect(() => {
		if (!focusFront()) return;
		const anchor = anchors.get(id)?.();
		if (anchor) {
			anchor.focus();
			focusFront.set(false);
		}
	});
	effect(() => {
		const field = input();
		if (focusInput() === id && field) {
			field.focus();
			focusInput.set(null);
		}
	});
	// Escape leaves the question, keeps its draft and returns to the card.
	const leaveQuestion = () => {
		input()?.blur();
		anchors.get(id)?.()?.focus();
	};

	return (
		<View testID="decision" class="gap-4 rounded-2xl border border-border-strong bg-card px-6 py-6">
			<View class="gap-2">
				<Text role="header" class="text-xl font-semibold leading-snug text-card-foreground">
					{d().title}
				</Text>
				<View class="flex-row flex-wrap items-center gap-1.5">
					<Mark kind={decisionMark(d())} />
					<Text
						class="text-xs"
						classList={{
							"text-needs-ink": decisionMark(d()) === "needs" || decisionMark(d()) === "unknown",
							"text-failed-ink": decisionMark(d()) === "failed",
							"text-ok-ink": decisionMark(d()) === "ready",
						}}
					>
						{d().reason}
					</Text>
					<Text class="text-xs text-muted-foreground">{`· ${d().missionTitle} · ${d().effort}`}</Text>
					<View class="flex-1" />
					<If when={props.count > 1}>
						<Text class="text-xs text-faint">{`${props.index + 1} of ${props.count}`}</Text>
					</If>
				</View>
			</View>

			<Text class="text-sm leading-relaxed text-card-foreground">
				{helpOpen(id, "simpler") ? d().simpler : d().context}
			</Text>

			<View class="flex-row flex-wrap gap-1.5">
				<HelpChip
					label="Say it simpler"
					shortcut="S"
					anchor={(node) => {
						firstChip = node;
					}}
					pressed={helpOpen(id, "simpler")}
					onChange={() => toggleHelp(d(), "simpler")}
				/>
				<HelpChip
					label="More context"
					shortcut="C"
					pressed={helpOpen(id, "more")}
					onChange={() => toggleHelp(d(), "more")}
				/>
				<If when={d().visual}>
					<HelpChip
						label="Show me"
						shortcut="V"
						pressed={helpOpen(id, "visual")}
						onChange={() => toggleHelp(d(), "visual")}
					/>
				</If>
				<HelpChip
					label="Ask a question"
					shortcut="Q"
					pressed={helpOpen(id, "ask")}
					onChange={() => toggleHelp(d(), "ask")}
				/>
				<If when={d().details}>
					<HelpChip
						label="What was pushed"
						pressed={helpOpen(id, "details")}
						onChange={() => toggleHelp(d(), "details")}
					/>
				</If>
			</View>

			<If when={helpOpen(id, "more")}>
				<View class="gap-1.5 rounded-xl bg-muted px-4 py-3">
					<Each of={d().more} key={(line) => line}>
						{(line) => <Text class="text-sm text-foreground">{line()}</Text>}
					</Each>
				</View>
			</If>

			<If when={helpOpen(id, "visual") && d().visual}>
				<View testID="visual" class="gap-3 rounded-xl bg-muted px-4 py-3">
					<Text class="text-sm text-foreground">{d().visual?.explanation ?? ""}</Text>
					<Bars bars={d().visual?.bars ?? []} />
					<Text class="text-xs text-faint">{`From ${d().visual?.source ?? ""}. It explains; it does not answer for you.`}</Text>
				</View>
			</If>

			<If when={helpOpen(id, "details") && d().details}>
				<View class="rounded-xl bg-muted px-4 py-3">
					<Text class="text-sm text-foreground">{d().details ?? ""}</Text>
				</View>
			</If>

			<If when={helpOpen(id, "ask")}>
				<View class="gap-3 rounded-xl bg-muted px-4 py-3">
					<Each of={d().answers} key={(a) => a.id}>
						{(a) => <AnswerLine day={props.day} decision={d()} answer={a()} />}
					</Each>
					<View class="flex-row items-center gap-2">
						<Input
							testID="question"
							ref={(node) => input.set(node)}
							value={drafts()[id] ?? ""}
							onChange={({ value }) => setFor(drafts, id, value)}
							onSubmit={() => void ask(props.day, d())}
							onFocus={() => {
								stopEscape?.();
								stopEscape = keymap.bind("escape", leaveQuestion, { when: "always" });
							}}
							onBlur={() => {
								stopEscape?.();
								stopEscape = null;
							}}
							submitBehavior="submit"
							placeholder="Ask about this decision"
							class="min-h-8 flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary"
						/>
						<Action
							label={asking()[id] ? "Asking…" : "Ask"}
							disabled={asking()[id] === true}
							onPress={() => void ask(props.day, d())}
						/>
					</View>
					<Text class="text-xs text-faint">Questions help you decide. They never answer for you.</Text>
				</View>
			</If>

			<If when={d().tried.length > 0}>
				<View class="gap-1 pl-1">
					<Each of={d().tried} key={(line) => line}>
						{(line) => <Text class="text-xs text-muted-foreground">{`• ${line()}`}</Text>}
					</Each>
				</View>
			</If>

			<Text class="text-xs leading-relaxed text-muted-foreground">{d().boundary}</Text>

			<If when={d().options.length > 1}>
				<RadioGroup class="gap-1">
					<Each of={d().options} key={(o) => o.id}>
						{(o) => (
							<Radio
								ref={(node) => radios.set(o().id, node)}
								checked={chosen(d()) === o().id}
								disabled={!idle()}
								onChange={() => pick(d(), o().id)}
								class="group flex-row gap-3 rounded-xl px-3 py-2.5 checked:bg-selection hover:bg-accent checked:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
							>
								<View class="mt-0.5 size-4 items-center justify-center rounded-full border border-input group-checked:border-primary">
									<View class="size-2 rounded-full group-checked:bg-primary" />
								</View>
								<View class="flex-1 gap-0.5">
									<View class="flex-row flex-wrap items-baseline gap-2">
										<Text class="text-sm font-medium text-card-foreground">{o().label}</Text>
										<If when={o().recommended}>
											<Text class="text-xs text-muted-foreground">Recommended</Text>
										</If>
									</View>
									<Text class="text-xs text-muted-foreground">{o().detail}</Text>
								</View>
							</Radio>
						)}
					</Each>
				</RadioGroup>
			</If>

			<If when={pickChanged(d())}>
				<Text role="alert" class="text-sm text-needs-ink">
					This decision changed after you picked. Read it again and pick an answer.
				</Text>
			</If>
			<If when={deliveryLine(d())}>
				<Text role="alert" class="text-sm text-muted-foreground">
					{deliveryLine(d())}
				</Text>
			</If>
			<If when={messages()[id]}>
				<Text role="alert" class="text-sm text-needs-ink">
					{messages()[id] ?? ""}
				</Text>
			</If>

			<View class="flex-row flex-wrap items-center gap-2">
				<If
					when={needsCheck(d())}
					else={
						<Action
							primary
							label={commitLabel(d())}
							shortcut={COMMIT_KEY}
							disabled={!idle() || chosen(d()) === ""}
							onPress={() => void decide(props.day, d())}
						/>
					}
				>
					<Action
						primary
						label="Check again"
						shortcut={COMMIT_KEY}
						disabled={d().delivery === "checking"}
						onPress={() => void checkDecision(props.day, d())}
					/>
				</If>
				<If when={props.later}>
					<Action label="Later" shortcut="L" disabled={!idle()} onPress={() => laterDecision(props.day, d())} />
				</If>
				<View class="flex-1" />
				<Text class="text-xs text-faint">{`${COMMIT_KEY} ${commitLabel(d())} · J K next · S C Q help`}</Text>
			</View>

			<If when={d().evidence.length > 0}>
				<View class="flex-row flex-wrap gap-1.5">
					<Each of={d().evidence} key={(e) => e.label}>
						{(e) => <EvidenceChip evidence={e()} />}
					</Each>
				</View>
			</If>
		</View>
	);
}

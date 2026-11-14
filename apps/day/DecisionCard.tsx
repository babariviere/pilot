// The decision in front: what Pilot asks, help to decide, the choices, and
// where the answer is. Rust decides every state change; this card sends
// intents (commands.ts) and shows the outcome Rust publishes. Help (simpler
// words, context, a chart and questions) never picks, sends or approves.
// Help that Pilot cannot write here is said once and not offered. An
// agent's question also takes the user's own words; picks and words are
// kept as drafts for the revision shown. A question that takes several
// answers shows checkboxes and sends every option picked. Later is kept
// with the draft; the chat still waits.
import { cleanup, effect, keymap, signal, Text, View, type ViewRef } from "nsh";
import { Checkbox, Input, Radio, RadioGroup } from "nsh/base";
import type { Answer, Decision, DecisionOption } from "pilot-day/native";
import {
	ask,
	canSend,
	checkAnswer,
	checkDecision,
	choose,
	commitLabel,
	decide,
	laterDecision,
	needsCheck,
	saveDecisionDraft,
	toggleHelp,
} from "./commands";
import type { Day } from "./day";
import { keepField } from "./kept";
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
	pickChanged,
	picked,
	questionText,
	replies,
	replyTarget,
	replyText,
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

/** An option's label, its Suggested or Recommended mark and its one-line consequence. */
function OptionText(props: { decision: Decision; option: DecisionOption }) {
	const o = () => props.option;
	return (
		// min-w-0 lets a long label wrap inside the card instead of running past it.
		<View class="min-w-0 flex-1 gap-0.5">
			<Text class="text-sm font-medium text-card-foreground">{o().label}</Text>
			<If when={o().recommended}>
				<Text class="text-xs text-muted-foreground">{props.decision.reply ? "Suggested" : "Recommended"}</Text>
			</If>
			<If when={o().detail}>
				<Text class="text-xs text-muted-foreground">{o().detail}</Text>
			</If>
		</View>
	);
}

/** How many options are picked on a question that takes several, in a few words. */
function pickedLine(decision: Decision): string {
	const n = picked(decision).length;
	if (n === 0) return "Pick any that apply.";
	return n === 1 ? "1 picked" : `${n} picked`;
}

/** The decision `props.decision`, `props.index` of `props.count` waiting. */
export function DecisionCard(props: { day: Day; decision: Decision; index: number; count: number; later: boolean }) {
	const d = () => props.decision;
	const id = props.decision.id;
	const idle = () => d().delivery === "idle";
	const radios = new Map<string, ViewRef>();
	let firstChip: ViewRef | undefined;
	let laterButton: ViewRef | undefined;
	let commitButton: ViewRef | undefined;
	const input = signal<ViewRef | null>(null);
	const replyInput = signal<ViewRef | null>(null);
	// The question and own-words fields keep their focus and selection for an update's saved view.
	const questionField = keepField(
		`question:${id}`,
		() => "today",
		() => questionText(d()),
		(node) => input.set(node),
	);
	const replyField = keepField(
		`reply:${id}`,
		() => "today",
		() => replyText(d()),
		(node) => replyInput.set(node),
	);
	let stopEscape: (() => void) | null = null;

	// The keyboard focus lands on the chosen option, else on the first help,
	// else on the first option or a button; never in a text field.
	anchors.set(
		id,
		() => radios.get(chosen(d())) ?? firstChip ?? radios.get(d().options[0]?.id ?? "") ?? laterButton ?? commitButton,
	);
	cleanup(() => {
		anchors.delete(id);
		stopEscape?.();
		// Leaving the card saves its words now rather than after the pause.
		props.day.feed.flushDrafts();
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
	effect(() => {
		const field = replyInput();
		if (focusInput() === replyTarget(id) && field) {
			field.focus();
			focusInput.set(null);
		}
	});
	// Escape leaves a field, keeps its draft and returns to the card.
	const leaveField = () => {
		input()?.blur();
		replyInput()?.blur();
		anchors.get(id)?.()?.focus();
	};
	const bindEscape = () => {
		stopEscape?.();
		stopEscape = keymap.bind("escape", leaveField, { when: "always" });
	};
	const unbindEscape = () => {
		stopEscape?.();
		stopEscape = null;
		props.day.feed.flushDrafts();
	};
	const meta = () =>
		[d().missionTitle, d().effort]
			.filter(Boolean)
			.map((part) => `· ${part}`)
			.join(" ");
	const showOptions = () => d().options.length > (d().reply ? 0 : 1);
	const keyHints = () =>
		[
			`${COMMIT_KEY} ${commitLabel(d())}`,
			"J K next",
			d().multiple ? "1–9 pick any" : "",
			d().helpUnavailable ? "" : "S C Q help",
			d().reply ? "0 own words" : "",
		]
			.filter(Boolean)
			.join(" · ");

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
					<Text class="text-xs text-muted-foreground">{meta()}</Text>
					<View class="flex-1" />
					<If when={d().draft.later}>
						<Text testID="put-off" class="text-xs text-faint">
							Put off. The chat still waits.
						</Text>
					</If>
					<If when={props.count > 1}>
						<Text class="text-xs text-faint">{`${props.index + 1} of ${props.count}`}</Text>
					</If>
				</View>
			</View>

			<If when={(helpOpen(id, "simpler") && d().simpler) || d().context}>
				<Text class="text-sm leading-relaxed text-card-foreground">
					{helpOpen(id, "simpler") && d().simpler ? d().simpler : d().context}
				</Text>
			</If>

			<If
				when={d().helpUnavailable}
				else={
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
						<If when={d().more.length > 0}>
							<HelpChip
								label="More context"
								shortcut="C"
								pressed={helpOpen(id, "more")}
								onChange={() => toggleHelp(d(), "more")}
							/>
						</If>
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
				}
			>
				<Text testID="help-unavailable" class="text-xs text-faint">
					{d().helpUnavailable ?? ""}
				</Text>
			</If>

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

			<If when={helpOpen(id, "ask") && !d().helpUnavailable}>
				<View class="gap-3 rounded-xl bg-muted px-4 py-3">
					<Each of={d().answers} key={(a) => a.id}>
						{(a) => <AnswerLine day={props.day} decision={d()} answer={a()} />}
					</Each>
					<View class="flex-row items-center gap-2">
						<Input
							testID="question"
							ref={questionField.ref}
							value={questionText(d())}
							onChange={({ value }) => {
								setFor(drafts, id, value);
								saveDecisionDraft(props.day, d());
							}}
							onSubmit={() => void ask(props.day, d())}
							onFocus={() => {
								questionField.focus();
								bindEscape();
							}}
							onSelectionChange={questionField.select}
							onBlur={unbindEscape}
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

			<If when={showOptions() && d().multiple}>
				<View class="gap-1">
					<Text testID="picked" class="px-3 text-xs text-muted-foreground">
						{pickedLine(d())}
					</Text>
					<Each of={d().options} key={(o) => o.id}>
						{(o) => (
							<Checkbox
								ref={(node) => radios.set(o().id, node)}
								checked={picked(d()).includes(o().id)}
								disabled={!idle()}
								onChange={() => choose(props.day, d(), o().id)}
								class="flex-row gap-3 rounded-xl px-3 py-2.5 checked:bg-selection hover:bg-accent checked:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
								indicatorClass="mt-0.5 size-4 items-center justify-center rounded border border-input checked:border-primary checked:bg-primary"
								indicator={
									<If when={picked(d()).includes(o().id)}>
										<View class="size-2 rounded-sm bg-primary-foreground" />
									</If>
								}
							>
								<OptionText decision={d()} option={o()} />
							</Checkbox>
						)}
					</Each>
				</View>
			</If>

			<If when={showOptions() && !d().multiple}>
				<RadioGroup class="gap-1">
					<Each of={d().options} key={(o) => o.id}>
						{(o) => (
							<Radio
								ref={(node) => radios.set(o().id, node)}
								checked={chosen(d()) === o().id}
								disabled={!idle()}
								onChange={() => choose(props.day, d(), o().id)}
								class="group flex-row gap-3 rounded-xl px-3 py-2.5 checked:bg-selection hover:bg-accent checked:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
							>
								<View class="mt-0.5 size-4 items-center justify-center rounded-full border border-input group-checked:border-primary">
									<View class="size-2 rounded-full group-checked:bg-primary" />
								</View>
								<OptionText decision={d()} option={o()} />
							</Radio>
						)}
					</Each>
				</RadioGroup>
			</If>

			<If when={d().reply}>
				<Input
					testID="reply"
					ref={replyField.ref}
					value={replyText(d())}
					disabled={!idle()}
					onChange={({ value }) => {
						setFor(replies, id, value);
						saveDecisionDraft(props.day, d());
					}}
					onFocus={() => {
						replyField.focus();
						bindEscape();
					}}
					onSelectionChange={replyField.select}
					onBlur={unbindEscape}
					placeholder={d().options.length > 0 ? "Add detail, or answer in your own words" : "Your answer"}
					class="min-h-8 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary"
				/>
			</If>

			<If when={d().draft.unsaved}>
				<Text role="alert" class="text-sm text-needs-ink">
					Pilot could not save this draft. It stays here; copy it before you close Pilot.
				</Text>
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
							anchor={(node) => {
								commitButton = node;
							}}
							disabled={!idle() || !canSend(d())}
							onPress={() => void decide(props.day, d())}
						/>
					}
				>
					<Action
						primary
						label="Check again"
						shortcut={COMMIT_KEY}
						anchor={(node) => {
							commitButton = node;
						}}
						disabled={d().delivery === "checking"}
						onPress={() => void checkDecision(props.day, d())}
					/>
				</If>
				<If when={props.later}>
					<Action
						label="Later"
						shortcut="L"
						anchor={(node) => {
							laterButton = node;
						}}
						disabled={!idle()}
						onPress={() => laterDecision(props.day, d())}
					/>
				</If>
				<View class="flex-1" />
				<Text class="text-xs text-faint">{keyHints()}</Text>
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

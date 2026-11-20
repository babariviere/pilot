// The decision in front: what Pilot asks, help to decide, the choices, and
// where the answer is. Rust decides every state change; this card sends
// intents (commands.ts) and shows the outcome Rust publishes. Help (simpler
// words, context, a chart and questions) never picks, sends or approves.
// Help that Pilot cannot write here is said once and not offered. An
// agent's question also takes the user's own words; picks and words are
// kept as drafts for the revision shown. A question that takes several
// answers shows checkboxes and sends every option picked. Later is kept
// with the draft; the chat still waits.
import { cleanup, effect, keymap, signal, View, type ViewRef } from "nsh";
import type { Answer, Decision, DecisionOption } from "pilot-day/native";
import type { ArtifactSource } from "./artifactReads";
import { openChat } from "./chatView";
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
import { todayRequests } from "./Incoming";
import { InterviewCard } from "./InterviewCard";
import { keepField } from "./kept";
import { QuestionArtifacts } from "./QuestionArtifacts";
import { todayResults } from "./ToCheck";
import {
	Bars,
	Body,
	Button,
	Caption,
	Chip,
	Chips,
	EvidenceChip,
	KeyHints,
	Link,
	type MarkKind,
	Option,
	Options,
	Question,
	Quote,
	Spacer,
	State,
	TextField,
} from "./ui";
import {
	anchors,
	asking,
	chosen,
	drafts,
	focusFront,
	focusInput,
	front,
	helpOpen,
	holdFront,
	messages,
	openMission,
	pickChanged,
	picked,
	placeRow,
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
	if (decision.kind === "unknown" || decision.delivery === "unknown") return "unconfirmed";
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
			return "Checking that your answer arrived…";
		case "unknown":
			return decision.kind === "unknown"
				? ""
				: "Pilot could not confirm your answer yet. It will not send it again. Check again only reads.";
		default:
			return "";
	}
}

/** One question and where its answer is. */
function AnswerLine(props: { day: Day; decision: Decision; answer: Answer }) {
	const a = () => props.answer;
	return (
		<View class="gap-0.5">
			<Body tone="muted">{a().question}</Body>
			<If when={a().state === "ready"}>
				<Body>{a().answer}</Body>
				<If when={a().earlier}>
					<Caption tone="faint">Asked about an earlier version of this decision.</Caption>
				</If>
			</If>
			<If when={a().state === "asking"}>
				<Body tone="faint">Pilot is writing an answer…</Body>
			</If>
			<If when={a().state === "checking"}>
				<Body tone="faint">Checking. This only reads; it asks nothing again.</Body>
			</If>
			<If when={a().state === "unknown"}>
				<Body tone="needs">No answer came back. Pilot will not ask again until it checks.</Body>
				<Link
					testID="check-answer"
					label="Check again"
					onPress={() => void checkAnswer(props.day, props.decision, a())}
				/>
			</If>
		</View>
	);
}

/** An option's tag: Suggested for an agent's suggestion, Recommended for a coordinator's. */
function optionTag(decision: Decision, option: DecisionOption): string | undefined {
	if (!option.recommended) return undefined;
	return decision.reply ? "Suggested" : "Recommended";
}

/** How many options are picked on a question that takes several, in a few words. */
function pickedLine(decision: Decision): string {
	const n = picked(decision).length;
	if (n === 0) return "Pick any that apply.";
	return n === 1 ? "1 picked" : `${n} picked`;
}

/** The decision `props.decision`, `props.index` of `props.count` waiting. */
function OrdinaryDecisionCard(props: { day: Day; decision: Decision; index: number; count: number; later: boolean }) {
	const d = () => props.decision;
	const id = props.decision.id;
	const hasSource = () => d().reply && !!d().requestSessionId;
	const missionLink = `decision-mission-${id}`;
	const chatLink = `decision-chat-${id}`;
	const mission = placeRow(missionLink, () => {
		holdFront(id);
		openMission(d().missionId);
	});
	const chat = placeRow(chatLink, () => {
		const sessionId = d().requestSessionId;
		if (!sessionId) return;
		holdFront(id);
		openChat(sessionId, "Today");
	});
	const chatLabel = () => `Chat: ${d().requestSessionTitle || "Title unavailable"}`;
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
		// Answering this card keeps it in front while it waits.
		holdFront(id);
		stopEscape?.();
		stopEscape = keymap.bind("escape", leaveField, { when: "always" });
	};
	const unbindEscape = () => {
		stopEscape?.();
		stopEscape = null;
		props.day.feed.flushDrafts();
	};
	const meta = () =>
		[hasSource() ? "" : d().missionTitle, d().effort]
			.filter(Boolean)
			.map((part) => `· ${part}`)
			.join(" ");
	const showOptions = () => d().options.length > (d().reply ? 0 : 1);
	const keyHints = (): [string, string][] =>
		(
			[
				[COMMIT_KEY, commitLabel(d())],
				["J K", "next"],
				d().multiple ? ["1–9", "pick any"] : null,
				d().helpUnavailable ? null : ["S C Q", "help"],
				d().reply ? ["0", "own words"] : null,
			] as ([string, string] | null)[]
		).filter((h): h is [string, string] => h !== null);

	return (
		<Question
			testID="decision"
			title={d().title}
			position={props.count > 1 ? `${props.index + 1} of ${props.count}` : undefined}
			meta={
				<>
					<State kind={decisionMark(d())} label={d().reason} plain />
					<Caption>{meta()}</Caption>
					<If when={d().draft.later}>
						<Caption testID="put-off" tone="faint">
							Put off. The chat still waits.
						</Caption>
					</If>
				</>
			}
			foot={
				<>
					<If
						when={needsCheck(d())}
						else={
							<Button
								kind="primary"
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
						{/* Pilot checks by itself first; the button is the fallback after its tries. */}
						<If when={d().delivery === "unknown"}>
							<Button
								kind="primary"
								label="Check again"
								shortcut={COMMIT_KEY}
								anchor={(node) => {
									commitButton = node;
								}}
								onPress={() => void checkDecision(props.day, d())}
							/>
						</If>
					</If>
					<If when={props.later}>
						<Button
							label="Later"
							shortcut="L"
							anchor={(node) => {
								laterButton = node;
							}}
							disabled={!idle()}
							onPress={() => laterDecision(props.day, d())}
						/>
					</If>
					<Spacer />
					<KeyHints hints={keyHints()} />
				</>
			}
		>
			<If when={hasSource()}>
				<View testID="decision-source" class="flex-row flex-wrap items-center gap-x-1.5 gap-y-1">
					<If when={d().missionId}>
						<Link
							label={`Mission: ${d().missionTitle || "Title unavailable"}`}
							testID={missionLink}
							anchor={mission.anchor}
							onPress={mission.press}
						/>
						<Caption>·</Caption>
					</If>
					<If when={props.day.chat} else={<Caption>{chatLabel()}</Caption>}>
						<Link label={chatLabel()} testID={chatLink} anchor={chat.anchor} onPress={chat.press} />
					</If>
				</View>
			</If>

			<If when={(helpOpen(id, "simpler") && d().simpler) || d().context}>
				<Body measure>{helpOpen(id, "simpler") && d().simpler ? d().simpler : d().context}</Body>
			</If>
			<If when={props.day.artifacts && d().artifacts.length > 0}>
				<QuestionArtifacts source={props.day.artifacts as ArtifactSource} artifacts={d().artifacts} />
			</If>

			<If
				when={d().helpUnavailable}
				else={
					<Chips>
						<Chip
							label="Say it simpler"
							shortcut="S"
							anchor={(node) => {
								firstChip = node;
							}}
							pressed={helpOpen(id, "simpler")}
							onChange={() => toggleHelp(d(), "simpler")}
						/>
						<If when={d().more.length > 0}>
							<Chip
								label="More context"
								shortcut="C"
								pressed={helpOpen(id, "more")}
								onChange={() => toggleHelp(d(), "more")}
							/>
						</If>
						<If when={d().visual}>
							<Chip
								label="Show me"
								shortcut="V"
								pressed={helpOpen(id, "visual")}
								onChange={() => toggleHelp(d(), "visual")}
							/>
						</If>
						<Chip
							label="Ask a question"
							shortcut="Q"
							pressed={helpOpen(id, "ask")}
							onChange={() => toggleHelp(d(), "ask")}
						/>
						<If when={d().details}>
							<Chip
								label="What was pushed"
								pressed={helpOpen(id, "details")}
								onChange={() => toggleHelp(d(), "details")}
							/>
						</If>
					</Chips>
				}
			>
				<If
					when={d().canClarify}
					else={
						<Caption testID="help-unavailable" tone="faint">
							{d().helpUnavailable ?? ""}
						</Caption>
					}
				>
					<Chips>
						<Chip label="Ask a question" pressed={helpOpen(id, "ask")} onChange={() => toggleHelp(d(), "ask")} />
					</Chips>
				</If>
			</If>

			<If when={helpOpen(id, "more")}>
				<Quote>
					<Each of={d().more} key={(line) => line}>
						{(line) => <Body>{line()}</Body>}
					</Each>
				</Quote>
			</If>

			<If when={helpOpen(id, "visual") && d().visual}>
				<Quote testID="visual">
					<Body>{d().visual?.explanation ?? ""}</Body>
					<Bars bars={d().visual?.bars ?? []} />
					<Caption tone="faint">{`From ${d().visual?.source ?? ""}. It explains; it does not answer for you.`}</Caption>
				</Quote>
			</If>

			<If when={helpOpen(id, "details") && d().details}>
				<Quote text={d().details ?? ""} />
			</If>

			<If when={helpOpen(id, "ask") && (!d().helpUnavailable || d().canClarify)}>
				<Quote>
					<Each of={d().answers} key={(a) => a.id}>
						{(a) => <AnswerLine day={props.day} decision={d()} answer={a()} />}
					</Each>
					<View class="flex-row items-center gap-2">
						<TextField
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
							class="flex-1"
						/>
						<Button
							label={asking()[id] ? "Asking…" : "Ask"}
							disabled={asking()[id] === true}
							onPress={() => void ask(props.day, d())}
						/>
					</View>
					<Caption tone="faint">
						{d().canClarify
							? "Clarification keeps this request open until you answer. It uses the same agent and cost controls, with no tools or work continuation."
							: "Questions help you decide. They never answer for you."}
					</Caption>
				</Quote>
			</If>

			<If when={d().tried.length > 0}>
				<View class="gap-0.5">
					<Each of={d().tried} key={(line) => line}>
						{(line) => <Caption>{`• ${line()}`}</Caption>}
					</Each>
				</View>
			</If>

			<Caption>{d().boundary}</Caption>

			<If when={showOptions() && d().multiple}>
				<View class="gap-1">
					<Caption testID="picked">{pickedLine(d())}</Caption>
					<Options multiple>
						<Each of={d().options} key={(o) => o.id}>
							{(o) => (
								<Option
									multiple
									title={o().label}
									tag={optionTag(d(), o())}
									hint={o().detail || undefined}
									anchor={(node) => radios.set(o().id, node)}
									checked={picked(d()).includes(o().id)}
									disabled={!idle()}
									onChange={() => choose(props.day, d(), o().id)}
								/>
							)}
						</Each>
					</Options>
				</View>
			</If>

			<If when={showOptions() && !d().multiple}>
				<Options>
					<Each of={d().options} key={(o) => o.id}>
						{(o) => (
							<Option
								title={o().label}
								tag={optionTag(d(), o())}
								hint={o().detail || undefined}
								anchor={(node) => radios.set(o().id, node)}
								checked={chosen(d()) === o().id}
								disabled={!idle()}
								onChange={() => choose(props.day, d(), o().id)}
							/>
						)}
					</Each>
				</Options>
			</If>

			<If when={d().reply}>
				<TextField
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
				/>
			</If>

			<If when={d().draft.unsaved}>
				<Body role="alert" tone="needs">
					Pilot could not save this draft. It stays here; copy it before you close Pilot.
				</Body>
			</If>
			<If when={pickChanged(d())}>
				<Body role="alert" tone="needs">
					This decision changed after you picked. Read it again and pick an answer.
				</Body>
			</If>
			<If when={deliveryLine(d())}>
				<Body role="alert" tone="muted">
					{deliveryLine(d())}
				</Body>
			</If>
			<If when={messages()[id]}>
				<Body role="alert" tone="needs">
					{messages()[id] ?? ""}
				</Body>
			</If>

			<If when={d().evidence.length > 0}>
				<Chips>
					<Each of={d().evidence} key={(e) => e.label}>
						{(e) => <EvidenceChip evidence={e()} />}
					</Each>
				</Chips>
			</If>
		</Question>
	);
}

/** A new immutable round gets its own local draft state. */
export function DecisionCard(props: { day: Day; decision: Decision; index: number; count: number; later: boolean }) {
	return (
		<Each of={[props.decision]} key={(d) => `${d.id}:${d.interviewRoundId ?? "ordinary"}`}>
			{(d) => (
				<If when={d().interviewRoundId} else={<OrdinaryDecisionCard {...props} decision={d()} />}>
					<InterviewCard
						{...props}
						decision={d()}
						keyboardActive={
							front(props.day.today(), todayResults(props.day), todayRequests(props.day))?.id === d().id
						}
					/>
				</If>
			)}
		</Each>
	);
}

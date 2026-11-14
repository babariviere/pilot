// One saved piece of feedback and the user's steps on it: the agent's
// triage and proposal, a small fix, a linked mission, and the user's own
// resolved mark. Every command here is one explicit step sent once; none
// follows from another. A proposal is the agent's; nothing in it starts,
// links or resolves anything until the user presses its command.
// A triage that asks the user something shows its exact question here, with
// its suggestions and a field for the user's own words. The answer is kept
// as an unsent draft until the user sends it; it goes to that triage chat
// once and only clarifies: it starts no fix and approves no proposal.
import { type JSX, Text, View } from "nsh";
import { Input, Toggle } from "nsh/base";
import type { Day } from "./day";
import {
	type FeedbackItem,
	type FeedbackMirror,
	type FeedbackView,
	MAX_ANSWER_LENGTH,
	type StepIntent,
	type StepResult,
	type UserFeedbackProposal,
	type UserFeedbackQuestion,
} from "./feedbackFeed";
import {
	answerKey,
	answerMessage,
	type ChatStep,
	chatLine,
	chatState,
	clip,
	missionDraft,
	missionLine,
	proposalOf,
	questionOf,
	running,
	stepsOf,
} from "./feedbackSteps";
import {
	answerDrafts,
	closeFeedback,
	feedbackProject,
	setAnswerDraft,
	setStepMessage,
	stepMessages,
} from "./feedbackView";
import { keepField } from "./kept";
import { glide } from "./motion";
import { goalDraft, openNew } from "./planView";
import { Action, Mark, Picker } from "./ui";
import { openMission } from "./view";

/** A chat's address, for the user to open it in Pilot. */
function ChatLink(props: { step: ChatStep }) {
	return (
		<View selectable>
			<Text class="text-xs text-faint">{`${props.step.kind === "triage" ? "Triage" : "Fix"} chat: pilot://chat/${props.step.sessionId}`}</Text>
		</View>
	);
}

/** One quiet line with its mark. */
function Line(props: {
	testID: string;
	mark: Parameters<typeof Mark>[0]["kind"];
	text: string;
	children?: JSX.Element;
}) {
	return (
		<View testID={props.testID} class="gap-1.5">
			<View class="flex-row items-start gap-2.5">
				<View class="pt-1.5">
					<Mark kind={props.mark} />
				</View>
				<Text class="flex-1 text-sm leading-relaxed text-foreground">{props.text}</Text>
			</View>
			{props.children}
		</View>
	);
}

/** Missions the user can link: the ones Today shows, each once. */
function missionChoices(day: Day): { value: string; title: string }[] {
	const t = day.today();
	const seen = new Set<string>();
	const out: { value: string; title: string }[] = [];
	for (const m of [...t.moving, ...t.notMoving, ...t.unreported])
		if (!seen.has(m.id)) {
			seen.add(m.id);
			out.push({ value: m.id, title: m.title });
		}
	return out;
}

/** The agent's proposal and the one step it suggests. The user may pick another. */
function Proposal(props: {
	day: Day;
	item: FeedbackItem;
	triage: ChatStep;
	value: UserFeedbackProposal;
	digest: string;
	busy: boolean;
	send: (intent: StepIntent) => void;
}) {
	const p = () => props.value;
	const v = () => props.day.feedback?.view();
	/** Saved feedback the agent grouped with this one, as Pilot listed it. */
	const duplicates = () =>
		p()
			.duplicates.map((id) => v()?.items.find((i) => i.id === id))
			.filter((i): i is FeedbackItem => !!i);
	const project = () => v()?.projects?.find((x) => x.projectId === props.triage.projectId) ?? null;
	const steps = () => stepsOf(props.item);
	const fixed = () => {
		const f = steps().fix;
		return f?.kind === "fix" && "proposalDigest" in f && f.proposalDigest === props.digest;
	};
	const linkable = () => missionChoices(props.day);
	const suggested = () => (p().missionId ? (linkable().find((m) => m.value === p().missionId) ?? null) : null);
	const heading = () => {
		switch (p().next) {
			case "fix":
				return "Proposed: a small fix";
			case "existing-mission":
				return suggested() ? `Proposed: add it to “${suggested()!.title}”` : "Proposed: add it to a mission";
			case "new-mission":
				return "Proposed: plan a new mission";
			default:
				return "Proposed: no change";
		}
	};
	const plan = () => {
		// The user asked for this goal: it replaces whatever New holds.
		glide();
		goalDraft.set(missionDraft(props.item, p()));
		closeFeedback();
		openNew();
	};
	return (
		<View testID={`feedback-proposal-${props.item.id}`} class="gap-2.5 rounded-xl bg-muted px-4 py-3">
			<Text class="text-xs font-medium text-muted-foreground">{heading()}</Text>
			<Text class="text-sm leading-relaxed text-foreground">{p().summary}</Text>
			<View selectable>
				<Text class="text-sm leading-relaxed text-muted-foreground">{p().detail}</Text>
			</View>
			<If when={p().next === "new-mission" && p().goal}>
				<Text class="text-sm text-foreground">{`Suggested goal: ${p().goal ?? ""}`}</Text>
			</If>
			<Each of={duplicates()} key={(d) => d.id}>
				{(d) => <Text class="text-xs text-faint">{`Same as: “${clip(d().text)}”`}</Text>}
			</Each>
			<View class="flex-row flex-wrap items-center gap-2">
				<If when={p().next === "existing-mission" && suggested()}>
					<Action
						outline
						label="Link to this mission"
						testID={`feedback-link-suggested-${props.item.id}`}
						disabled={props.busy}
						accessibilityLabel="Link this feedback to the mission. This starts no work."
						onPress={() =>
							props.send({ action: "link", feedbackId: props.item.id, missionId: suggested()!.value })
						}
					/>
				</If>
				<If when={p().next === "new-mission"}>
					<Action
						outline
						label="Plan a new mission"
						testID={`feedback-plan-${props.item.id}`}
						accessibilityLabel="Open New with the suggested goal. Nothing is created until you plan it there."
						onPress={plan}
					/>
				</If>
				<If when={!fixed()}>
					<Action
						outline
						label="Start fix"
						testID={`feedback-fix-${props.item.id}`}
						disabled={props.busy || !project() || running(steps().fix)}
						accessibilityLabel="Start one Build chat that makes this change, tied to no mission, under the project's usual limits."
						onPress={() =>
							props.send({
								action: "fix",
								feedbackId: props.item.id,
								projectId: props.triage.projectId,
								contextDigest: project()?.contextDigest ?? "",
								triageSessionId: props.triage.sessionId,
								proposalDigest: props.digest,
							})
						}
					/>
				</If>
				<If when={!project()}>
					<Text class="text-xs text-faint">Its project is not in your project list.</Text>
				</If>
			</View>
			<If when={linkable().length > 0}>
				<View class="flex-row items-center gap-2.5">
					<Text class="text-xs text-faint">{suggested() ? "Or link another" : "Link a mission"}</Text>
					<Picker
						testID={`feedback-link-${props.item.id}`}
						label="Mission to link this feedback to"
						items={linkable()}
						value={null}
						placeholder="Choose a mission"
						disabled={props.busy}
						searchable={linkable().length > 8}
						onChange={(missionId) => props.send({ action: "link", feedbackId: props.item.id, missionId })}
					/>
				</View>
			</If>
		</View>
	);
}

/**
 * The triage's question, exactly as it asked it, and the user's answer:
 * picked suggestions and their own words. Typing only keeps a draft; Send
 * answer sends it to this triage once. It clarifies; it starts nothing.
 */
function Clarify(props: {
	item: FeedbackItem;
	triage: ChatStep;
	question: UserFeedbackQuestion;
	busy: boolean;
	sending: boolean;
	send: (intent: StepIntent) => Promise<StepResult>;
}) {
	const q = () => props.question;
	const key = answerKey(props.triage, props.question);
	const draft = () => answerDrafts()[key] ?? { picks: [], text: "" };
	const several = () => q().multiSelect === true;
	const message = () => answerMessage(q(), draft().picks, draft().text);
	const tooLong = () => message().length > MAX_ANSWER_LENGTH;
	const canSend = () => message().trim() !== "" && !tooLong() && !props.busy;
	const pick = (n: number) => {
		const picks = draft().picks;
		const on = picks.includes(n);
		setAnswerDraft(key, {
			...draft(),
			picks: on ? picks.filter((p) => p !== n) : several() ? [...picks, n] : [n],
		});
	};
	const send = async () => {
		if (!canSend()) return;
		const sent = answerDrafts()[key];
		const r = await props.send({
			action: "answer",
			feedbackId: props.item.id,
			triageSessionId: props.triage.sessionId,
			questionId: q().id,
			message: message(),
		});
		// Only an accepted answer clears the draft, and only the words that were sent.
		if (r.status === "accepted" && answerDrafts()[key] === sent) setAnswerDraft(key, null);
	};
	const field = keepField(
		`feedback-answer-${key}`,
		() => "feedback",
		() => draft().text,
	);
	const options = () => q().options.map((o, n) => ({ ...o, n }));
	return (
		<View testID={`feedback-question-${props.item.id}`} class="gap-3 rounded-xl bg-muted px-4 py-3">
			<Text class="text-xs font-medium text-muted-foreground">The triage asks</Text>
			<View selectable class="gap-1">
				<Text class="text-sm leading-relaxed text-foreground">{q().question}</Text>
				<If when={q().context}>
					<Text class="text-sm leading-relaxed text-muted-foreground">{q().context ?? ""}</Text>
				</If>
			</View>
			<If when={options().length > 0}>
				<View class="gap-0.5" accessibilityLabel="Suggested answers">
					<Each of={options()} key={(o) => String(o.n)}>
						{(o) => (
							<Toggle
								testID={`feedback-option-${props.item.id}-${o().n + 1}`}
								pressed={draft().picks.includes(o().n)}
								disabled={props.sending}
								accessibilityLabel={o().suggested ? `${o().label}, suggested` : o().label}
								onChange={() => pick(o().n)}
								class="flex-row items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent aria-pressed:bg-selection aria-pressed:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
							>
								<View
									class="mt-1 size-3.5 items-center justify-center border"
									classList={{
										"rounded-full": !several(),
										"rounded-sm": several(),
										"border-primary": draft().picks.includes(o().n),
										"border-input": !draft().picks.includes(o().n),
									}}
								>
									<View
										class="size-1.5"
										classList={{
											"rounded-full": !several(),
											"bg-primary": draft().picks.includes(o().n),
										}}
									/>
								</View>
								<View class="min-w-0 flex-1 gap-0.5">
									<View class="flex-row flex-wrap items-baseline gap-2">
										<Text class="min-w-0 shrink text-sm text-foreground">{o().label}</Text>
										<If when={o().suggested}>
											<Text class="text-xs text-muted-foreground">Suggested</Text>
										</If>
									</View>
									<If when={o().detail}>
										<Text class="text-xs text-muted-foreground">{o().detail ?? ""}</Text>
									</If>
								</View>
							</Toggle>
						)}
					</Each>
				</View>
			</If>
			<Input
				testID={`feedback-answer-${props.item.id}`}
				ref={field.ref}
				multiline
				readonly={props.sending}
				value={draft().text}
				accessibilityLabel={`Your answer to: ${q().question}`}
				placeholder={options().length > 0 ? "Add detail, or answer in your own words" : "Your answer"}
				onChange={({ value }) => setAnswerDraft(key, { ...draft(), text: value })}
				onFocus={field.focus}
				onSelectionChange={field.select}
				class="min-h-16 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary"
			/>
			<If when={tooLong()}>
				<Text class="text-xs text-needs-ink">{`Too long. Keep it under ${MAX_ANSWER_LENGTH} characters.`}</Text>
			</If>
			<View class="flex-row flex-wrap items-center gap-3">
				<Action
					outline
					label={props.sending ? "Sending…" : "Send answer"}
					testID={`feedback-answer-send-${props.item.id}`}
					disabled={!canSend()}
					accessibilityLabel="Send this answer to the triage once. It starts no fix and approves nothing."
					onPress={() => void send()}
				/>
				<Text class="flex-1 text-xs text-faint">
					Goes to this triage only. It starts no fix and approves nothing.
				</Text>
			</View>
		</View>
	);
}

/** One saved piece of feedback with its steps. */
export function FeedbackRow(props: { day: Day; mirror: FeedbackMirror; item: FeedbackItem; when: string }) {
	const v = (): FeedbackView => props.mirror.view();
	const steps = () => stepsOf(props.item);
	const unknown = () => v().unsettledSteps.find((o) => o.feedbackId === props.item.id) ?? null;
	const busy = () => v().stepping !== null || v().unsettledSteps.length > 0;
	const chosen = () => v().projects?.find((p) => p.projectId === feedbackProject()) ?? null;
	const triage = () => steps().triage;
	const proposal = () => (triage() && chatState(triage()!) === "done" ? proposalOf(triage()) : null);
	const question = () => questionOf(triage());
	const send = async (intent: StepIntent): Promise<StepResult> => {
		setStepMessage(props.item.id, "");
		const r = await props.mirror.source.step(intent);
		setStepMessage(props.item.id, r.status === "accepted" || r.status === "unknown" ? "" : r.message);
		if (r.status === "accepted") glide();
		return r;
	};
	const check = async (operationId: string) => {
		const op = v().unsettledSteps.find((o) => o.operationId === operationId);
		const r = await props.mirror.source.checkStep(operationId);
		setStepMessage(props.item.id, r.status === "accepted" ? "Pilot did it." : r.message);
		// A confirmed answer was sent: its unsent copy goes, like after an accepted Send answer.
		const t = triage();
		if (r.status === "accepted" && op?.step === "answer" && t)
			for (const key of Object.keys(answerDrafts()))
				if (key.startsWith(`${t.sessionId}/`)) setAnswerDraft(key, null);
		void props.mirror.source.read();
	};
	/** Triage can start when nothing is triaging it and the user chose a project. */
	const canTriage = () => !steps().resolved && !running(triage()) && !proposal();
	const triageAgain = () => !!triage() && !running(triage()) && !proposal();
	const resolvable = () =>
		!steps().resolved && (!!proposal() || !!steps().fix || !!steps().mission) && !running(steps().fix);
	return (
		<View testID={`feedback-item-${props.item.id}`} class="gap-2.5 border-t border-border py-3">
			<View selectable class="gap-1">
				<Text class="text-sm leading-relaxed text-foreground">{props.item.text}</Text>
				<If when={props.item.attachments?.length}>
					<Text class="text-xs text-faint">{`${props.item.attachments?.length} ${props.item.attachments?.length === 1 ? "image" : "images"} attached · available to the agent`}</Text>
				</If>
				<Text class="text-xs text-faint">{props.when}</Text>
			</View>
			<If when={steps().resolved}>
				<Line testID={`feedback-resolved-${props.item.id}`} mark="done" text="You marked this resolved." />
			</If>
			<Each of={triage() && chatLine(triage()!) ? [triage()!] : []} key={(t) => t.operationId}>
				{(t) => (
					<Line
						testID={`feedback-triage-${props.item.id}`}
						mark={running(t()) ? (chatState(t()) === "question" ? "needs" : "moving") : "unknown"}
						text={chatLine(t())}
					>
						<If when={steps().answer && !question()}>
							<View selectable>
								<Text testID={`feedback-answered-${props.item.id}`} class="text-xs text-muted-foreground">
									{`You answered: “${clip(steps().answer?.text ?? "", 120)}”`}
								</Text>
							</View>
						</If>
						<ChatLink step={t()} />
					</Line>
				)}
			</Each>
			<Each
				of={question() && triage() ? [{ triage: triage()!, question: question()! }] : []}
				key={(x) => answerKey(x.triage, x.question)}
			>
				{(x) => (
					<Clarify
						item={props.item}
						triage={x().triage}
						question={x().question}
						busy={busy()}
						sending={v().stepping === props.item.id}
						send={send}
					/>
				)}
			</Each>
			<Each
				of={!steps().resolved && proposal() && triage() ? [{ triage: triage()!, ...proposal()! }] : []}
				key={(x) => x.digest}
			>
				{(x) => (
					<Proposal
						day={props.day}
						item={props.item}
						triage={x().triage}
						value={x().value}
						digest={x().digest}
						busy={busy()}
						send={(i) => void send(i)}
					/>
				)}
			</Each>
			<Each of={steps().fix ? [steps().fix!] : []} key={(f) => f.operationId}>
				{(f) => (
					<Line
						testID={`feedback-fixing-${props.item.id}`}
						mark={running(f()) ? "moving" : chatState(f()) === "done" ? "ready" : "unknown"}
						text={chatLine(f())}
					>
						<ChatLink step={f()} />
					</Line>
				)}
			</Each>
			<Each of={steps().mission ? [steps().mission!] : []} key={(m) => m.operationId}>
				{(m) => (
					<Line testID={`feedback-mission-${props.item.id}`} mark="still" text={missionLine(m())}>
						<If when={m().mission && props.day.feed.mission(m().missionId)}>
							<View class="flex-row">
								<Action
									label="Open the mission"
									testID={`feedback-open-mission-${props.item.id}`}
									onPress={() => {
										closeFeedback();
										openMission(m().missionId);
									}}
								/>
							</View>
						</If>
					</Line>
				)}
			</Each>
			<Each of={unknown() ? [unknown()!] : []} key={(o) => o.operationId}>
				{(o) => (
					<Line
						testID={`feedback-step-unknown-${props.item.id}`}
						mark="unknown"
						text="Pilot does not know if your last step on this was done. It will not send it again."
					>
						<View class="flex-row">
							<Action
								label={o().state === "checking" ? "Checking…" : "Check"}
								testID={`feedback-step-check-${props.item.id}`}
								disabled={o().state === "checking"}
								onPress={() => void check(o().operationId)}
							/>
						</View>
					</Line>
				)}
			</Each>
			<View class="flex-row flex-wrap items-center gap-2">
				<If when={canTriage()}>
					<Action
						label={triageAgain() ? "Triage again" : "Triage"}
						testID={`feedback-triage-start-${props.item.id}`}
						disabled={busy() || !chosen()}
						accessibilityLabel="Start a read-only agent that proposes what to do. It changes nothing."
						onPress={() =>
							void send({
								action: "triage",
								feedbackId: props.item.id,
								projectId: chosen()?.projectId ?? "",
								contextDigest: chosen()?.contextDigest ?? "",
							})
						}
					/>
				</If>
				<If when={resolvable()}>
					<Action
						label="Mark resolved"
						testID={`feedback-resolve-${props.item.id}`}
						disabled={busy()}
						accessibilityLabel="Mark this feedback resolved after you checked it."
						onPress={() => void send({ action: "resolve", feedbackId: props.item.id })}
					/>
				</If>
				<If when={steps().resolved}>
					<Action
						label="Reopen"
						testID={`feedback-reopen-${props.item.id}`}
						disabled={busy()}
						onPress={() => void send({ action: "reopen", feedbackId: props.item.id })}
					/>
				</If>
				<If when={v().stepping === props.item.id}>
					<Text class="text-xs text-muted-foreground">Sending…</Text>
				</If>
				<If when={stepMessages()[props.item.id]}>
					<Text testID={`feedback-step-message-${props.item.id}`} class="flex-1 text-xs text-muted-foreground">
						{stepMessages()[props.item.id] ?? ""}
					</Text>
				</If>
			</View>
		</View>
	);
}

// One saved piece of feedback and the user's steps on it: the agent's
// triage and proposal, a small fix, a linked mission, and the user's own
// resolved mark. Every command here is one explicit step sent once; none
// follows from another. A proposal is the agent's; nothing in it starts,
// links or resolves anything until the user presses its command.
// A triage that asks the user something shows its exact question here, with
// its suggestions and a field for the user's own words. The answer is kept
// as an unsent draft until the user sends it; it goes to that triage chat
// once and only clarifies: it starts no fix and approves no proposal.
// A triage may propose a prototype first. Start prototype starts one
// read-only chat that makes mockups and asks the user to choose; its
// question shows here with them. The choice comes back as a fix proposal
// with the chosen mockup, and Start fix builds exactly that.
import { type JSX, signal, Text, View } from "nsh";
import { namedFeedbackPaths } from "../../packages/kernel/src/feedback-paths";
import type { ArtifactSource } from "./artifactReads";
import { openChat } from "./chatView";
import type { Day } from "./day";
import { FeedbackQuestion } from "./FeedbackQuestion";
import type {
	FeedbackItem,
	FeedbackMirror,
	FeedbackView,
	StepIntent,
	StepResult,
	UserFeedbackProposal,
} from "./feedbackFeed";
import {
	answerKey,
	answerTo,
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
import { closeFeedback, feedbackProject, setAnswerDraft, setStepMessage, stepMessages } from "./feedbackView";
import { OpenChatAction } from "./OpenChatAction";
import { goalDraft, openNew } from "./planView";
import { QuestionArtifacts } from "./QuestionArtifacts";
import { Action, glide, type Mark, MarkLine, Panel, Picker } from "./ui";
import { openMission } from "./view";

/**
 * The way into a triage, prototype or fix chat, read only. Without a chat page, its
 * address, for the user to open it in Pilot.
 */
function ChatLink(props: { day: Day; item: FeedbackItem; step: ChatStep }) {
	const kind = () => props.step.kind;
	const label = () => `Open ${kind()} chat`;
	return (
		<If
			when={props.day.chat}
			else={
				<View selectable>
					<Text class="text-xs text-faint">{`${{ triage: "Triage", prototype: "Prototype", fix: "Fix" }[kind()]} chat: pilot://chat/${props.step.sessionId}`}</Text>
				</View>
			}
		>
			<View class="flex-row">
				<OpenChatAction
					label={label()}
					testID={`feedback-open-${kind()}-${props.item.id}`}
					accessibilityLabel={`${label()}, read only. Opening it sends nothing.`}
					onPress={() => openChat(props.step.sessionId, "Feedback")}
				/>
			</View>
		</If>
	);
}

/** One quiet line with its mark. */
function Line(props: {
	testID: string;
	mark: Parameters<typeof Mark>[0]["kind"];
	text: string;
	children?: JSX.Element;
	action?: JSX.Element;
}) {
	return (
		<View testID={props.testID} class="gap-1.5">
			<View class="flex-row items-start gap-3">
				<View class="min-w-0 flex-1">
					<MarkLine kind={props.mark}>
						<Text class="text-sm leading-relaxed text-foreground">{props.text}</Text>
					</MarkLine>
				</View>
				{props.action}
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

/** The agent's proposal and the one step it suggests. The user may pick another. A prototype's is the user's choice. */
function Proposal(props: {
	day: Day;
	item: FeedbackItem;
	/** The chat that proposed it: a triage, or a prototype for the fix the user chose. */
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
	const prototyped = () => {
		const p = steps().prototype;
		return p?.kind === "prototype" && "proposalDigest" in p && p.proposalDigest === props.digest;
	};
	const prototype = () => p().next === "prototype";
	const linkable = () => missionChoices(props.day);
	const suggested = () => (p().missionId ? (linkable().find((m) => m.value === p().missionId) ?? null) : null);
	const heading = () => {
		switch (p().next) {
			case "fix":
				return p().mockup ? "Proposed: a small fix, from your choice" : "Proposed: a small fix";
			case "prototype":
				return "Proposed: try a prototype first";
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
		<Panel testID={`feedback-proposal-${props.item.id}`} class="gap-2.5">
			<Text class="text-xs font-medium text-muted-foreground">{heading()}</Text>
			<Text class="text-sm leading-relaxed text-foreground">{p().summary}</Text>
			<View selectable>
				<Text class="text-sm leading-relaxed text-muted-foreground">{p().detail}</Text>
			</View>
			<If when={p().next === "new-mission" && p().goal}>
				<Text class="text-sm text-foreground">{`Suggested goal: ${p().goal ?? ""}`}</Text>
			</If>
			<If when={prototype() && p().directions?.length}>
				<View class="gap-1" testID={`feedback-directions-${props.item.id}`}>
					<Text class="text-xs text-faint">Directions to mock up</Text>
					<Each of={(p().directions ?? []).map((text, n) => ({ n, text }))} key={(d) => String(d.n)}>
						{(d) => <Text class="text-sm text-foreground">{`${d().n + 1}. ${d().text}`}</Text>}
					</Each>
				</View>
			</If>
			<If when={p().mockup && props.day.artifacts}>
				<QuestionArtifacts
					source={props.day.artifacts as ArtifactSource}
					artifacts={p().mockup ? [p().mockup!] : []}
					label="The mockup you chose:"
				/>
			</If>
			<Each of={duplicates()} key={(d) => d.id}>
				{(d) => <Text class="text-xs text-faint">{`Same as: “${clip(d().text)}”`}</Text>}
			</Each>
			<View class="flex-row flex-wrap items-center gap-2">
				<If when={p().next === "existing-mission" && suggested()}>
					<Action
						variant="outline"
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
						variant="outline"
						label="Plan a new mission"
						testID={`feedback-plan-${props.item.id}`}
						accessibilityLabel="Open New with the suggested goal. Nothing is created until you plan it there."
						onPress={plan}
					/>
				</If>
				<If when={prototype() && !prototyped()}>
					<Action
						variant="outline"
						label="Start prototype"
						testID={`feedback-prototype-start-${props.item.id}`}
						disabled={props.busy || !project() || running(steps().prototype)}
						accessibilityLabel="Start one read-only chat that makes mockups to choose from. It writes no code."
						onPress={() =>
							props.send({
								action: "prototype",
								feedbackId: props.item.id,
								projectId: props.triage.projectId,
								contextDigest: project()?.contextDigest ?? "",
								triageSessionId: props.triage.sessionId,
								proposalDigest: props.digest,
							})
						}
					/>
				</If>
				<If when={!fixed()}>
					<Action
						variant={prototype() ? "plain" : "outline"}
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
			<If when={prototype() && !prototyped()}>
				<Text class="text-xs text-faint">A prototype makes mockups to choose from. It writes no code.</Text>
			</If>
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
		</Panel>
	);
}

/** One saved piece of feedback with its steps. */
export function FeedbackRow(props: {
	day: Day;
	mirror: FeedbackMirror;
	item: FeedbackItem;
	when: string;
	keyboardActive?: boolean;
	routeKey?: string;
}) {
	const v = (): FeedbackView => props.mirror.view();
	const steps = () => stepsOf(props.item);
	const unknown = () => v().unsettledSteps.find((o) => o.feedbackId === props.item.id) ?? null;
	const busy = () => v().stepping !== null || unknown() !== null;
	const chosen = () => v().projects?.find((p) => p.projectId === feedbackProject()) ?? null;
	const triage = () => steps().triage;
	const accessOpen = signal(false);
	const readProject = () => v().projects?.find((p) => p.projectId === triage()?.projectId);
	const proposal = () => (triage() && chatState(triage()!) === "done" ? proposalOf(triage()) : null);
	/** A prototype started from the triage's proposal takes its place while it runs or holds the user's choice. */
	const prototypeShown = () => {
		const p = steps().prototype;
		return (
			!!p && p.kind === "prototype" && p.proposalDigest === proposal()?.digest && (running(p) || !!proposalOf(p))
		);
	};
	const question = () => questionOf(triage());
	const unusable = () => {
		const p = triage()?.proposal;
		return p && "problem" in p ? p : null;
	};
	const correctionOpen = signal(false);
	const correctionDigest = () => unusable()?.digest || proposal()?.digest || "";
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
		if (r.status === "accepted" && op?.replyKey) setAnswerDraft(op.replyKey, null);
		void props.mirror.source.read();
	};
	/** Triage can start when nothing is triaging it and the user chose a project. */
	const canTriage = () => !steps().resolved && !triage() && !props.item.investigation;
	const resolvable = () =>
		!steps().resolved && (!!proposal() || !!steps().fix || !!steps().mission) && !running(steps().fix);
	// Remove asks once more in place. Its chats and missions stay.
	const confirming = signal(false);
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
			<If when={triage()}>
				<View class="gap-2">
					<View class="flex-row">
						<Action label="Read access" onPress={() => accessOpen.set(!accessOpen())} />
					</View>
					<If when={accessOpen()}>
						<Text class="text-xs text-muted-foreground">{`Read-only investigation in ${readProject()?.name ?? triage()?.projectId ?? "the selected project"}. Source files in that project's copy${namedFeedbackPaths(props.item.text).length ? `, plus user-named paths: ${namedFeedbackPaths(props.item.text).join(", ")}` : ""}. Named folders include subfolders if available. Whole-home, filesystem root and repository metadata access are excluded. Other projects' context and unrelated files are not included.`}</Text>
					</If>
				</View>
			</If>
			<Each of={triage() && chatLine(triage()!) ? [triage()!] : []} key={(t) => t.operationId}>
				{(t) => (
					<Line
						testID={`feedback-triage-${props.item.id}`}
						mark={running(t()) ? (chatState(t()) === "question" ? "needs" : "moving") : "unknown"}
						text={chatLine(t())}
						action={
							<If when={props.day.chat}>
								<ChatLink day={props.day} item={props.item} step={t()} />
							</If>
						}
					>
						<If when={steps().answer && !question()}>
							<View selectable>
								<Text testID={`feedback-answered-${props.item.id}`} class="text-xs text-muted-foreground">
									{`You answered: “${clip(steps().answer?.text ?? "", 120)}”`}
								</Text>
							</View>
						</If>
						<If when={!props.day.chat}>
							<ChatLink day={props.day} item={props.item} step={t()} />
						</If>
					</Line>
				)}
			</Each>
			<Each
				of={question() && triage() ? [{ triage: triage()!, question: question()! }] : []}
				key={(x) => answerKey(x.triage, x.question)}
			>
				{(x) => (
					<FeedbackQuestion
						item={props.item}
						triage={x().triage}
						question={x().question}
						busy={busy()}
						sending={v().stepping === props.item.id}
						send={send}
						check={check}
						unknown={unknown()}
						keyboardActive={props.keyboardActive}
						routeKey={props.routeKey}
					/>
				)}
			</Each>
			<If when={!steps().resolved && correctionDigest()}>
				<View class="gap-3">
					<If when={unusable()}>
						<View selectable class="gap-2" testID={`feedback-unusable-${props.item.id}`}>
							<Text class="text-sm text-muted-foreground">Original explanation, kept with this feedback</Text>
							<Text class="text-sm text-foreground">
								{unusable()?.raw ??
									"The full explanation stays in the triage chat's saved history. Open the triage chat to read it."}
							</Text>
						</View>
					</If>
					<If when={correctionDigest()}>
						<Action
							label="Correct the investigation"
							testID={`feedback-correct-${props.item.id}`}
							onPress={() => correctionOpen.set(true)}
						/>
						<If when={correctionOpen() || unknown()?.step === "correct"}>
							<Each of={[correctionDigest()]} key={(digest) => digest}>
								{(digest) => (
									<FeedbackQuestion
										item={props.item}
										triage={triage()!}
										correctionDigest={digest()}
										question={{ id: 1, question: "What should the investigation correct?", options: [] }}
										busy={busy()}
										sending={v().stepping === props.item.id}
										send={send}
										check={check}
										unknown={unknown()}
										keyboardActive={props.keyboardActive}
										routeKey={props.routeKey}
									/>
								)}
							</Each>
						</If>
					</If>
				</View>
			</If>
			<Each
				of={
					!steps().resolved && proposal() && triage() && !prototypeShown()
						? [{ triage: triage()!, ...proposal()! }]
						: []
				}
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
			<Each of={steps().prototype ? [steps().prototype!] : []} key={(p) => p.operationId}>
				{(p) => (
					<View class="gap-2.5">
						<Line
							testID={`feedback-prototyping-${props.item.id}`}
							mark={
								running(p())
									? chatState(p()) === "question"
										? "needs"
										: "moving"
									: chatState(p()) === "done"
										? "ready"
										: "unknown"
							}
							text={chatLine(p())}
						>
							<ChatLink day={props.day} item={props.item} step={p()} />
						</Line>
						<Each of={questionOf(p()) ? [questionOf(p())!] : []} key={(q) => `${p().sessionId}/${q.id}`}>
							{(q) => (
								<FeedbackQuestion
									item={props.item}
									triage={p()}
									question={q()}
									artifacts={props.day.artifacts as ArtifactSource | undefined}
									busy={busy()}
									sending={v().stepping === props.item.id}
									send={send}
									check={check}
									unknown={unknown()}
									keyboardActive={props.keyboardActive}
									routeKey={props.routeKey}
								/>
							)}
						</Each>
						<If when={!questionOf(p()) && answerTo(props.item, p().sessionId)}>
							<View selectable>
								<Text
									testID={`feedback-chose-${props.item.id}`}
									class="text-xs text-muted-foreground"
								>{`You answered: “${clip(answerTo(props.item, p().sessionId)?.text ?? "", 120)}”`}</Text>
							</View>
						</If>
						<Each of={!steps().resolved && proposalOf(p()) ? [proposalOf(p())!] : []} key={(x) => x.digest}>
							{(x) => (
								<Proposal
									day={props.day}
									item={props.item}
									triage={p()}
									value={x().value}
									digest={x().digest}
									busy={busy()}
									send={(i) => void send(i)}
								/>
							)}
						</Each>
					</View>
				)}
			</Each>
			<Each of={steps().fix ? [steps().fix!] : []} key={(f) => f.operationId}>
				{(f) => (
					<View class="gap-2.5">
						<Line
							testID={`feedback-fixing-${props.item.id}`}
							mark={
								chatState(f()) === "question"
									? "needs"
									: running(f())
										? "moving"
										: chatState(f()) === "done"
											? "ready"
											: "unknown"
							}
							text={chatLine(f())}
							action={
								<If when={props.day.chat}>
									<ChatLink day={props.day} item={props.item} step={f()} />
								</If>
							}
						>
							<If when={!props.day.chat}>
								<ChatLink day={props.day} item={props.item} step={f()} />
							</If>
						</Line>
						<Each of={questionOf(f()) ? [questionOf(f())!] : []} key={(q) => `${f().sessionId}/${q.id}`}>
							{(q) => (
								<FeedbackQuestion
									item={props.item}
									triage={f()}
									question={q()}
									artifacts={props.day.artifacts as ArtifactSource | undefined}
									busy={busy()}
									sending={v().stepping === props.item.id}
									send={send}
									check={check}
									unknown={unknown()}
									keyboardActive={props.keyboardActive}
									routeKey={props.routeKey}
								/>
							)}
						</Each>
					</View>
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
				<If when={!triage() && props.item.investigation}>
					<Text class="text-xs text-muted-foreground">
						The saved investigation has not started or is not confirmed. Its original project selection stays
						pinned.
					</Text>
					<Action
						label="Check saved investigation"
						disabled={busy()}
						onPress={async () => {
							const r = await props.mirror.source.check(props.item.operationId);
							setStepMessage(props.item.id, r.investigation?.message || r.message);
							void props.mirror.source.read();
						}}
					/>
					<Text class="text-xs text-faint">
						Checks the saved send and carries out its exact never-started investigation. Entered work is never
						sent again.
					</Text>
				</If>
				<If when={canTriage()}>
					<Action
						label="Triage"
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
				<If
					when={confirming()}
					else={
						<Action
							label="Remove"
							testID={`feedback-remove-${props.item.id}`}
							disabled={busy()}
							accessibilityLabel="Remove this feedback. Its chats and missions stay."
							onPress={() => confirming.set(true)}
						/>
					}
				>
					<Text class="text-xs text-muted-foreground">Remove this feedback? Its chats and missions stay.</Text>
					<Action
						variant="outline"
						label="Remove"
						testID={`feedback-remove-confirm-${props.item.id}`}
						disabled={busy()}
						onPress={() => {
							confirming.set(false);
							void send({ action: "remove", feedbackId: props.item.id });
						}}
					/>
					<Action
						label="Keep"
						testID={`feedback-remove-cancel-${props.item.id}`}
						onPress={() => confirming.set(false)}
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

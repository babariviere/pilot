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
import { signal, View } from "nsh";
import { namedFeedbackPaths } from "../../packages/kernel/src/feedback-paths";
import type { ArtifactSource } from "./artifactReads";
import { openChat } from "./chatView";
import type { Day } from "./day";
import { FeedbackQuestion } from "./FeedbackQuestion";
import { fundingAmount } from "./FundingSettings";
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
import { draftLinkedMission } from "./linkedMission";
import { OpenChatAction } from "./OpenChatAction";
import { newBusy } from "./planView";
import { QuestionArtifacts } from "./QuestionArtifacts";
import {
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	Disclosure,
	Fact,
	Facts,
	Field,
	glide,
	MarkedLine,
	Picker,
	Row,
	RowDetail,
} from "./ui";
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
					<Caption tone="faint">{`${{ triage: "Triage", prototype: "Prototype", fix: "Fix" }[kind()]} chat: pilot://chat/${props.step.sessionId}`}</Caption>
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
	/** Whether Start fix is the screen's one commit: on Today, where this feedback is the one thing asked. */
	commit: boolean;
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
		return props.item.work.some(
			(f) => f.kind === "fix" && f.triageSessionId === props.triage.sessionId && f.proposalDigest === props.digest,
		);
	};
	const setup = () => props.triage.fixSetup;
	const allowanceKey = () => `${props.triage.sessionId}/allowance-${props.digest}`;
	const amount = () => answerDrafts()[allowanceKey()]?.text ?? "";
	const chosenAmount = () => fundingAmount(amount()) || undefined;
	const fixReady = () => {
		const s = setup();
		return !!s && (s.allowanceMicros === null ? chosenAmount() !== undefined : s.allowanceMicros !== 0);
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
		draftLinkedMission(props.item, props.triage, { value: p(), digest: props.digest });
	};
	return (
		<View testID={`feedback-proposal-${props.item.id}`} class="gap-2.5">
			<View class="gap-1">
				<BodyStrong>{heading()}</BodyStrong>
				<Body>{p().summary}</Body>
				<View selectable>
					<Body tone="muted">{p().detail}</Body>
				</View>
			</View>
			<If when={p().next === "new-mission" && p().goal}>
				<Body>{`Suggested goal: ${p().goal ?? ""}`}</Body>
			</If>
			<If when={prototype() && p().directions?.length}>
				<View class="gap-1" testID={`feedback-directions-${props.item.id}`}>
					<Caption tone="faint">Directions to mock up</Caption>
					<Each of={(p().directions ?? []).map((text, n) => ({ n, text }))} key={(d) => String(d.n)}>
						{(d) => <Body>{`${d().n + 1}. ${d().text}`}</Body>}
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
				{(d) => <Caption tone="faint">{`Same as: “${clip(d().text)}”`}</Caption>}
			</Each>
			<If when={!fixed() && project()}>
				<If when={setup()} else={<Caption>The fix setup is unavailable.</Caption>}>
					<Facts>
						<Fact label="Project">{project()?.name ?? ""}</Fact>
						<Fact label="Model">{[setup()?.model, setup()?.thinking].filter(Boolean).join(" · ")}</Fact>
						<If when={setup()?.allowanceMicros !== null}>
							<Fact label="Fix allowance">
								{setup()?.allowanceMicros === undefined
									? "Limits off"
									: `$${((setup()?.allowanceMicros ?? 0) / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`}
							</Fact>
						</If>
					</Facts>
					<If when={setup()?.allowanceMicros === null}>
						<Field
							label="Fix allowance (USD)"
							testID={`feedback-fix-allowance-${props.item.id}`}
							value={amount()}
							onChange={(text) => {
								if (text.length <= 32) setAnswerDraft(allowanceKey(), { picks: [], text });
							}}
							placeholder="Choose an amount"
						/>
					</If>
					<If when={setup()?.allowanceMicros === 0}>
						<Caption>Set a positive quick-fix default in Funding.</Caption>
					</If>
				</If>
			</If>
			<Buttons>
				<If when={!fixed()}>
					<Button
						kind={props.commit && !(prototype() && !prototyped()) ? "primary" : "secondary"}
						label="Start fix"
						testID={`feedback-fix-${props.item.id}`}
						disabled={props.busy || !project() || !fixReady() || running(steps().fix)}
						accessibilityLabel="Start one standalone fix chat for this suggestion."
						onPress={() => {
							const choice = setup();
							if (!choice || !fixReady() || !project()) return;
							props.send({
								action: "fix",
								feedbackId: props.item.id,
								projectId: props.triage.projectId,
								contextDigest: project()!.contextDigest,
								triageSessionId: props.triage.sessionId,
								proposalDigest: props.digest,
								fixSetupDigest: choice.digest,
								...(choice.allowanceMicros === null ? { allowanceMicros: chosenAmount() } : {}),
							});
						}}
					/>
				</If>
				<If when={p().next === "existing-mission" && suggested()}>
					<Button
						label="Link to this mission"
						testID={`feedback-link-suggested-${props.item.id}`}
						disabled={props.busy}
						accessibilityLabel="Link this feedback to the mission. This starts no work."
						onPress={() =>
							props.send({ action: "link", feedbackId: props.item.id, missionId: suggested()!.value })
						}
					/>
				</If>
				<If when={["fix", "new-mission", "existing-mission"].includes(p().next)}>
					<Button
						label="Draft a linked mission"
						testID={`feedback-plan-${props.item.id}`}
						disabled={newBusy() || props.busy}
						accessibilityLabel="Draft an editable linked mission goal. Nothing starts until you plan the mission."
						onPress={plan}
					/>
				</If>
				<If when={prototype() && !prototyped()}>
					<Button
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
				<If when={!project()}>
					<Caption tone="faint">Its project is not in your project list.</Caption>
				</If>
			</Buttons>
			<If when={prototype() && !prototyped()}>
				<Caption tone="faint">A prototype makes mockups to choose from. It writes no code.</Caption>
			</If>
			<If when={linkable().length > 0}>
				<Buttons>
					<Caption tone="faint">{suggested() ? "Or link another" : "Link a mission"}</Caption>
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
				</Buttons>
			</If>
		</View>
	);
}

type FeedbackRowProps = {
	day: Day;
	mirror: FeedbackMirror;
	item: FeedbackItem;
	when: string;
	keyboardActive?: boolean;
	routeKey?: string;
};

/** How many images came with the feedback, or "". */
function imagesLine(item: FeedbackItem): string {
	const images = item.attachments?.length ?? 0;
	return images ? `${images} ${images === 1 ? "image" : "images"} attached · available to the agent` : "";
}

/**
 * One saved piece of feedback with its steps, without a frame: Today puts it in its Needs you section, where it is
 * the one thing asked, so its Start fix is the screen's commit.
 */
export function FeedbackRow(props: FeedbackRowProps) {
	return (
		<View testID={`feedback-item-${props.item.id}`} class="gap-3">
			<View selectable class="gap-0.5">
				<Body>{props.item.text}</Body>
				<If when={imagesLine(props.item)}>
					<Caption tone="faint">{imagesLine(props.item)}</Caption>
				</If>
				<Caption tone="faint">{props.when}</Caption>
			</View>
			<FeedbackSteps {...props} commit />
		</View>
	);
}

/**
 * One saved piece of feedback as a row of the Feedback page's list: the words as its title, when it was saved as its
 * meta, and its images and steps under it. The page's commit is Send, so Start fix is a Secondary button here.
 */
export function FeedbackListRow(props: FeedbackRowProps) {
	return (
		<Row
			testID={`feedback-item-${props.item.id}`}
			title={props.item.text}
			meta={props.when}
			wrap
			selectable
			detail={
				<RowDetail>
					<View class="gap-3">
						<If when={imagesLine(props.item)}>
							<Caption tone="faint">{imagesLine(props.item)}</Caption>
						</If>
						<FeedbackSteps {...props} commit={false} />
					</View>
				</RowDetail>
			}
		/>
	);
}

/** A feedback item's steps: its triage, question, proposal, prototype, fix, mission and the user's commands. */
function FeedbackSteps(props: FeedbackRowProps & { commit: boolean }) {
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
		if (r.status === "accepted" && intent.action === "fix")
			setAnswerDraft(`${intent.triageSessionId}/allowance-${intent.proposalDigest}`, null);
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
		<>
			<If when={steps().resolved}>
				<MarkedLine testID={`feedback-resolved-${props.item.id}`} kind="done" text="You marked this resolved." />
			</If>
			<If when={triage()}>
				<Disclosure label="Read access" open={accessOpen()} onToggle={() => accessOpen.set(!accessOpen())}>
					<If when={accessOpen()}>
						<Caption>{`Read-only investigation in ${readProject()?.name ?? triage()?.projectId ?? "the selected project"}. Source files in that project's copy${namedFeedbackPaths(props.item.text).length ? `, plus user-named paths: ${namedFeedbackPaths(props.item.text).join(", ")}` : ""}. Named folders include subfolders if available. Whole-home, filesystem root and repository metadata access are excluded. Other projects' context and unrelated files are not included.`}</Caption>
					</If>
				</Disclosure>
			</If>
			<Each of={triage() && chatLine(triage()!) ? [triage()!] : []} key={(t) => t.operationId}>
				{(t) => (
					<MarkedLine
						testID={`feedback-triage-${props.item.id}`}
						kind={running(t()) ? (chatState(t()) === "question" ? "needs" : "working") : "needs"}
						text={chatLine(t())}
						action={
							<If when={props.day.chat}>
								<ChatLink day={props.day} item={props.item} step={t()} />
							</If>
						}
					>
						<If when={steps().answer && !question()}>
							<View selectable>
								<Caption testID={`feedback-answered-${props.item.id}`}>
									{`You answered: “${clip(steps().answer?.text ?? "", 120)}”`}
								</Caption>
							</View>
						</If>
						<If when={!props.day.chat}>
							<ChatLink day={props.day} item={props.item} step={t()} />
						</If>
					</MarkedLine>
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
						<View selectable class="gap-1" testID={`feedback-unusable-${props.item.id}`}>
							<Caption>Original explanation, kept with this feedback</Caption>
							<Body>
								{unusable()?.raw ??
									"The full explanation stays in the triage chat's saved history. Open the triage chat to read it."}
							</Body>
						</View>
					</If>
					<If when={correctionDigest()}>
						<View class="flex-row">
							<Button
								small
								label="Correct the investigation"
								testID={`feedback-correct-${props.item.id}`}
								onPress={() => correctionOpen.set(true)}
							/>
						</View>
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
						commit={props.commit}
						send={(i) => void send(i)}
					/>
				)}
			</Each>
			<Each of={steps().prototype ? [steps().prototype!] : []} key={(p) => p.operationId}>
				{(p) => (
					<View class="gap-2.5">
						<MarkedLine
							testID={`feedback-prototyping-${props.item.id}`}
							kind={
								running(p())
									? chatState(p()) === "question"
										? "needs"
										: "working"
									: chatState(p()) === "done"
										? "done"
										: "needs"
							}
							text={chatLine(p())}
						>
							<ChatLink day={props.day} item={props.item} step={p()} />
						</MarkedLine>
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
								<Caption testID={`feedback-chose-${props.item.id}`}>
									{`You answered: “${clip(answerTo(props.item, p().sessionId)?.text ?? "", 120)}”`}
								</Caption>
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
									commit={props.commit}
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
						<MarkedLine
							testID={`feedback-fixing-${props.item.id}`}
							kind={
								chatState(f()) === "question"
									? "needs"
									: running(f())
										? "working"
										: chatState(f()) === "done"
											? "done"
											: "needs"
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
						</MarkedLine>
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
					<MarkedLine testID={`feedback-mission-${props.item.id}`} kind="new" text={missionLine(m())}>
						<If when={m().mission && props.day.feed.mission(m().missionId)}>
							<View class="flex-row">
								<Button
									small
									label="Open the mission"
									testID={`feedback-open-mission-${props.item.id}`}
									onPress={() => {
										closeFeedback();
										openMission(m().missionId);
									}}
								/>
							</View>
						</If>
					</MarkedLine>
				)}
			</Each>
			<Each of={unknown() ? [unknown()!] : []} key={(o) => o.operationId}>
				{(o) => (
					<MarkedLine
						testID={`feedback-step-unknown-${props.item.id}`}
						kind="needs"
						text="Pilot does not know if your last step on this was done. It will not send it again."
					>
						<View class="flex-row">
							<Button
								small
								label={o().state === "checking" ? "Checking…" : "Check"}
								testID={`feedback-step-check-${props.item.id}`}
								disabled={o().state === "checking"}
								onPress={() => void check(o().operationId)}
							/>
						</View>
					</MarkedLine>
				)}
			</Each>
			<If when={!triage() && props.item.investigation}>
				<Caption>
					The saved investigation has not started or is not confirmed. Its original project selection stays pinned.
				</Caption>
			</If>
			<Buttons>
				<If when={!triage() && props.item.investigation}>
					<Button
						small
						label="Check saved investigation"
						disabled={busy()}
						onPress={async () => {
							const r = await props.mirror.source.check(props.item.operationId);
							setStepMessage(props.item.id, r.investigation?.message || r.message);
							void props.mirror.source.read();
						}}
					/>
				</If>
				<If when={canTriage()}>
					<Button
						small
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
					<Button
						small
						label="Mark resolved"
						testID={`feedback-resolve-${props.item.id}`}
						disabled={busy()}
						accessibilityLabel="Mark this feedback resolved after you checked it."
						onPress={() => void send({ action: "resolve", feedbackId: props.item.id })}
					/>
				</If>
				<If when={steps().resolved}>
					<Button
						small
						label="Reopen"
						testID={`feedback-reopen-${props.item.id}`}
						disabled={busy()}
						onPress={() => void send({ action: "reopen", feedbackId: props.item.id })}
					/>
				</If>
				<If
					when={confirming()}
					else={
						<Button
							small
							label="Remove"
							testID={`feedback-remove-${props.item.id}`}
							disabled={busy()}
							accessibilityLabel="Remove this feedback. Its chats and missions stay."
							onPress={() => confirming.set(true)}
						/>
					}
				>
					<Caption>Remove this feedback? Its chats and missions stay.</Caption>
					<Button
						small
						kind="destructive"
						label="Remove"
						testID={`feedback-remove-confirm-${props.item.id}`}
						disabled={busy()}
						onPress={() => {
							confirming.set(false);
							void send({ action: "remove", feedbackId: props.item.id });
						}}
					/>
					<Button
						small
						label="Keep"
						testID={`feedback-remove-cancel-${props.item.id}`}
						onPress={() => confirming.set(false)}
					/>
				</If>
				<If when={v().stepping === props.item.id}>
					<Caption>Sending…</Caption>
				</If>
			</Buttons>
			<If when={!triage() && props.item.investigation}>
				<Caption tone="faint">
					Checks the saved send and carries out its exact never-started investigation. Entered work is never sent
					again.
				</Caption>
			</If>
			<If when={stepMessages()[props.item.id]}>
				<Caption testID={`feedback-step-message-${props.item.id}`}>{stepMessages()[props.item.id] ?? ""}</Caption>
			</If>
		</>
	);
}

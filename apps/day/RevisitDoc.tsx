// A mission's Revisit: the agreement now, the new questions for its gaps,
// and the exact revision to review. Three steps stay apart. Submitting the
// Revisit questions completes that round only. Confirming a revision
// changes the goal, agreement, open tasks and decisions as shown. Neither
// starts, resumes or permits work. Finished tasks and earlier decisions
// stay as history, readable here on request.
import { type JSX, View } from "nsh";
import type {
	ChangeKind,
	Correction,
	DecisionChange,
	PlanPage,
	Revision,
	RevisionLine,
	Revisit,
	TaskChange,
	TextChange,
} from "pilot-day/native";
import { askRevisit, checkRevision, confirmRevision, resumeRevision } from "./planCommands";
import type { Plans } from "./planning";
import { drop, put, revisionShown, revisitBusy, revisitMessages, revisitOpen } from "./planView";
import {
	Block,
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	Disclosure,
	EmptyLine,
	glide,
	Mark,
	type MarkKind,
	Notice,
	Num,
	Question,
	Row,
	RowDetail,
	RowGroup,
	Rows,
	Section,
} from "./ui";

/** The words beside a part a revision touches. */
export function changeWord(kind: ChangeKind): string {
	switch (kind) {
		case "stays":
			return "Stays";
		case "changes":
			return "Changes";
		case "drops":
			return "Drops";
		case "adds":
			return "New";
	}
}

/** A part's mark: what changes or is new needs your confirmation; what stays is settled; a drop is quiet. */
function changeMark(kind: ChangeKind): MarkKind {
	switch (kind) {
		case "stays":
			return "done";
		case "changes":
		case "adds":
			return "needs";
		case "drops":
			return "new";
	}
}

/** A disclosure line that opens a quiet part on request. Opening it reads and changes nothing. */
function Fold(props: { missionId: string; part: string; label: string; children?: JSX.Element }) {
	const key = () => `${props.missionId}/${props.part}`;
	const open = () => revisitOpen()[key()] === true;
	return (
		<Disclosure
			testID={`fold-${props.part}`}
			label={props.label}
			open={open()}
			onToggle={() => put(revisitOpen, key(), !open())}
		>
			<View class="gap-2">{props.children}</View>
		</Disclosure>
	);
}

/** A label and its words, inside a fold. */
function Said(props: { label: string; text: string; tone?: "default" | "muted" }) {
	return (
		<View class="gap-0.5">
			<Caption tone="faint">{props.label}</Caption>
			<Body tone={props.tone ?? "default"} measure>
				{props.text}
			</Body>
		</View>
	);
}

/** The agreement now, folded: goal, agreement text and what the mission holds. */
function Now(props: { missionId: string; revisit: Revisit }) {
	const r = () => props.revisit;
	return (
		<Fold missionId={props.missionId} part="now" label="The agreement now">
			<View testID="agreement-now" selectable class="gap-2">
				<Said label="Goal" text={r().goal} />
				<Said label="Agreement" text={r().plan} />
				<Caption>
					{`${r().openTasks} open tasks · ${r().finishedTasks} finished · ${r().decisions} active decisions`}
				</Caption>
			</View>
		</Fold>
	);
}

/** The goal or agreement under a revision: what stays, or the new text with the current one on request. */
function TextPart(props: { missionId: string; title: string; part: string; change: TextChange }) {
	const c = () => props.change;
	return (
		<Row
			testID={`revision-${props.part}`}
			mark={changeMark(c().kind)}
			title={props.title}
			state={changeWord(c().kind)}
			stateTone={c().kind === "stays" ? "quiet" : "needs"}
			selectable
			detail={
				<RowDetail>
					<Body measure>{c().after}</Body>
					<If when={c().kind !== "stays"}>
						<Fold missionId={props.missionId} part={`${props.part}-before`} label="Show it now">
							<Body tone="muted" measure>
								{c().before}
							</Body>
						</Fold>
					</If>
				</RowDetail>
			}
		/>
	);
}

/** One open task: whether it stays, changes or drops, and what changes. A new task shows what it is for and what it waits for. */
function TaskRow(props: { task: TaskChange }) {
	const t = () => props.task;
	return (
		<Row
			testID={`revision-task-${t().id}`}
			mark={changeMark(t().kind)}
			title={t().title}
			state={changeWord(t().kind)}
			stateTone={t().kind === "stays" ? "quiet" : "needs"}
			trailing={
				<If when={t().kind !== "adds"}>
					<Num>{`#${t().number}`}</Num>
				</If>
			}
			detail={
				<If when={t().lines.length > 0 || t().kind === "drops"}>
					<RowDetail>
						<Each of={t().lines} key={(l) => l}>
							{(l) => <Body tone="muted">{l()}</Body>}
						</Each>
						<If when={t().kind === "drops"}>
							<Caption tone="faint">Dropped, not deleted. Its history stays.</Caption>
						</If>
					</RowDetail>
				</If>
			}
		/>
	);
}

/** One decision the revision replaces or withdraws, with Pilot's reason. */
function DecisionRow(props: { change: DecisionChange }) {
	const d = () => props.change;
	return (
		<Row
			testID={`revision-decision-${d().id}`}
			mark="needs"
			title={d().before}
			state={d().action === "replace" ? "Replaced" : "Withdrawn"}
			stateTone="needs"
			trailing={<Num>{`D${d().number}`}</Num>}
			wrap
			selectable
			detail={
				<RowDetail>
					<If when={d().action === "replace"}>
						<Body>{`New: ${d().after}`}</Body>
					</If>
					<Caption>{`Why: ${d().reason}`}</Caption>
				</RowDetail>
			}
		/>
	);
}

function correctionWord(c: Correction): string {
	return c.kind === "instruction" ? "Coordinator instruction" : "Permission";
}

/** How many parts a revision changes, in a few words. */
function changeCount(r: Revision): string {
	const tasks = r.tasks.filter((t) => t.kind !== "stays").length;
	const parts = [
		r.goal.kind !== "stays" ? "the goal" : "",
		r.plan.kind !== "stays" ? "the agreement" : "",
		tasks > 0 ? `${tasks} open ${tasks === 1 ? "task" : "tasks"}` : "",
		r.decisions.length > 0 ? `${r.decisions.length} ${r.decisions.length === 1 ? "decision" : "decisions"}` : "",
	].filter(Boolean);
	if (parts.length === 0) return "nothing";
	return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What confirming does, in plain words. New tasks start by rule like the others, so the line says so. */
function confirmLine(r: Revision): string {
	const count = changeCount(r);
	const added = r.added.length;
	const changes = count === "nothing" && added > 0 ? "" : `It changes ${count} as shown. `;
	const adds = added > 0 ? `It adds ${added} new ${added === 1 ? "task" : "tasks"}. ` : "";
	const history = "Finished tasks, earlier answers and replaced decisions stay as history.";
	return added > 0
		? `${changes}${adds}${history} Each new task starts like the others, once the tasks it waits for are done. It resumes and permits nothing.`
		: `${changes}${history} It starts, resumes and permits nothing.`;
}

/** Why the confirmation cannot be sent now, or nothing. */
function blocked(page: PlanPage, r: Revision): string {
	if (!r.current) return "The mission changed after Pilot proposed this revision. It cannot be confirmed.";
	if (r.pause === "needed" && !r.selectivePause)
		return "Chats still work on this mission. Pause it on its overview first: Pilot applies a revision only while its work is paused.";
	if (!page.fresh) return "This is an older read. Read the page again before you confirm.";
	return "";
}

/** The confirmation: one explicit press, then a second on the exact revision shown. */
function Confirm(props: { plans: Plans; page: PlanPage; revision: Revision; revisitCanAsk: boolean }) {
	const id = () => props.page.missionId;
	const r = () => props.revision;
	const pin = () => revisionShown()[id()];
	const busy = () => revisitBusy()[id()] === true;
	const why = () => blocked(props.page, r());
	// The pin is the revision as the user opened it. Rust refuses it if anything changed.
	const pinned = () => pin()?.revisionId === r().id && pin()?.digest === r().digest;
	const unknown = () => r().confirm === "unknown" || r().confirm === "checking";
	const message = () => revisitMessages()[id()] ?? "";
	const asking = () => !!pin() && !unknown();
	return (
		<View testID="revision-confirm">
			<If when={why()}>
				<Notice placement="section" role="alert" text={why()} />
			</If>
			<If
				when={
					message() ||
					(r().pause === "paused" && !why()) ||
					(r().selectivePause && r().pause === "needed") ||
					unknown()
				}
			>
				<Block>
					<If when={message()}>
						<Body testID="revisit-message" role="alert">
							{message()}
						</Body>
					</If>
					<If when={r().pause === "paused" && !why()}>
						<Caption>
							{r().selectivePause
								? "Affected work is paused. Applying keeps it paused; release it explicitly below when ready."
								: "The mission's work is paused. Confirming keeps it paused; resume it on its overview when you want."}
						</Caption>
					</If>
					<If when={r().selectivePause && r().pause === "needed"}>
						<Body tone="muted">{`Applying pauses ${r().affectedWork} affected agents first. Unaffected work continues. The exact revision applies only after safe pause is confirmed.`}</Body>
						<Each of={r().affectedTasks ?? []} key={(t) => t}>
							{(t) => <Body>{t()}</Body>}
						</Each>
					</If>
					<If when={unknown()}>
						<Body role="alert">
							{r().confirm === "checking"
								? "Checking. This only reads; it sends nothing again."
								: "Pilot sent your confirmation but heard nothing back. It will not send it again until it checks."}
						</Body>
					</If>
				</Block>
			</If>
			<If
				when={asking()}
				else={
					<Block>
						<Buttons>
							<If
								when={unknown()}
								else={
									<Button
										kind="primary"
										testID="confirm-revision"
										label="Confirm revision"
										disabled={!!why() || busy() || r().confirm !== "open"}
										onPress={() => {
											glide();
											put(revisitMessages, id(), "");
											put(revisionShown, id(), { revisionId: r().id, digest: r().digest });
										}}
									/>
								}
							>
								<Button
									kind="primary"
									testID="check-revision"
									label="Check again"
									icon="refresh"
									disabled={busy() || r().confirm === "checking"}
									onPress={() => void checkRevision(props.plans, id(), r().id)}
								/>
							</If>
							<AskAgain plans={props.plans} page={props.page} revision={r()} canAsk={props.revisitCanAsk} />
						</Buttons>
					</Block>
				}
			>
				{/* The second press waits for the user's answer on the exact revision shown. */}
				<Question
					testID="revision-confirm-ask"
					title="Apply exactly this revision?"
					foot={
						<>
							<Button
								kind="primary"
								testID="confirm-revision-now"
								label={
									busy() || r().confirm === "confirming"
										? "Applying…"
										: r().selectivePause && r().pause === "needed"
											? "Pause affected work and apply"
											: "Confirm"
								}
								disabled={!!why() || busy() || !pinned()}
								onPress={() => void confirmRevision(props.plans, id())}
							/>
							<Button
								label="Cancel"
								disabled={busy()}
								onPress={() => {
									glide();
									drop(revisionShown, id());
								}}
							/>
							<AskAgain plans={props.plans} page={props.page} revision={r()} canAsk={props.revisitCanAsk} />
						</>
					}
				>
					<Caption>{confirmLine(r())}</Caption>
					<If when={!pinned()}>
						<Caption tone="needs">
							The revision changed after you opened this. Read it again and confirm again.
						</Caption>
					</If>
				</Question>
			</If>
		</View>
	);
}

/** Ask for a new revision, once this one no longer fits the mission. */
function AskAgain(props: { plans: Plans; page: PlanPage; revision: Revision; canAsk: boolean }) {
	const id = () => props.page.missionId;
	const busy = () => revisitBusy()[id()] === true;
	return (
		// Kept in place while Revisit is briefly unavailable (a read refreshing, the planner working), so it does not flicker.
		<If when={!props.revision.current && !!props.plans.feed.revisit}>
			<Button
				testID="ask-again"
				label="Ask for a new revision"
				disabled={busy() || !props.canAsk}
				onPress={() => void askRevisit(props.plans, id())}
			/>
		</If>
	);
}

/** A proposed revision in full: what stays, changes and drops, what it leaves alone, and the confirmation. */
function RevisionView(props: { plans: Plans; page: PlanPage; revisit: Revisit; revision: Revision }) {
	const r = () => props.revision;
	const id = () => props.page.missionId;
	const instructions = () => r().corrections.filter((c) => c.kind === "instruction");
	const permissions = () => r().corrections.filter((c) => c.kind === "permission");
	return (
		<Section testID="revision" title="Proposed revision">
			<Block selectable>
				<Body measure>{r().summary}</Body>
				<Caption>Pilot proposed this from your answers. Read it in full. Nothing has changed yet.</Caption>
				<If when={r().waiting > 0}>
					<Caption testID="revision-waiting">
						{r().waiting === 1
							? "1 more proposed revision waits after this one."
							: `${r().waiting} more proposed revisions wait after this one.`}
					</Caption>
				</If>
			</Block>
			<Rows>
				<TextPart missionId={id()} title="Goal" part="goal" change={r().goal} />
				<TextPart missionId={id()} title="Agreement" part="plan" change={r().plan} />
			</Rows>
			<RowGroup label={`Open tasks · ${r().tasks.length}`} />
			<Rows testID="revision-tasks">
				<Each of={r().tasks} key={(t) => t.id}>
					{(t) => <TaskRow task={t()} />}
				</Each>
			</Rows>
			<EmptyLine
				text={
					r().finished === 1
						? "1 finished task stays as it is, with its history."
						: `${r().finished} finished tasks stay as they are, with their history.`
				}
			/>
			<If when={r().added.length > 0}>
				<RowGroup label={`New tasks · ${r().added.length}`} />
				<Rows testID="revision-added">
					<Each of={r().added} key={(t) => t.id}>
						{(t) => <TaskRow task={t()} />}
					</Each>
				</Rows>
				<EmptyLine text="Confirming adds them to the plan. Each starts when the tasks it waits for are done, like the others." />
			</If>
			<RowGroup label="Decisions" />
			<Rows testID="revision-decisions">
				<Each of={r().decisions} key={(d) => d.id}>
					{(d) => <DecisionRow change={d()} />}
				</Each>
			</Rows>
			<EmptyLine
				text={`${r().keptDecisions} other active ${r().keptDecisions === 1 ? "decision stays" : "decisions stay"}. Replaced and withdrawn decisions stay as history, with their reasons.`}
			/>
			<If when={r().corrections.length > 0}>
				<Block testID="revision-corrections" selectable>
					<BodyStrong>Not part of this revision</BodyStrong>
					<Caption>Pilot also suggests these. Confirming applies neither; each has its own setting.</Caption>
					<Each of={[...instructions(), ...permissions()]} key={(c) => `${c.kind}:${c.text}`}>
						{(c) => <Said label={correctionWord(c())} text={c().text} />}
					</Each>
				</Block>
			</If>
			<Confirm plans={props.plans} page={props.page} revision={r()} revisitCanAsk={props.revisit.canAsk} />
		</Section>
	);
}

/** Confirmed revisions, newest first. The agreement each one replaced opens only on request. */
function History(props: { missionId: string; lines: RevisionLine[] }) {
	return (
		<If when={props.lines.length > 0}>
			<Block>
				<Fold missionId={props.missionId} part="history" label={`Earlier revisions · ${props.lines.length}`}>
					<Caption>History, not guidance. Pilot works from the agreement now.</Caption>
					<Rows>
						<Each of={props.lines} key={(l) => l.id}>
							{(l) => (
								<Row
									testID={`revision-history-${l().id}`}
									title={l().summary}
									meta={l().line}
									wrap
									selectable
									detail={
										<RowDetail>
											<Each of={l().retired} key={(x) => x}>
												{(x) => <Caption>{x()}</Caption>}
											</Each>
											<Fold
												missionId={props.missionId}
												part={`earlier-${l().id}`}
												label="The agreement before it"
											>
												<Said label="Goal" text={l().earlierGoal} tone="muted" />
												<Said label="Agreement" text={l().earlierPlan} tone="muted" />
											</Fold>
										</RowDetail>
									}
								/>
							)}
						</Each>
					</Rows>
				</Fold>
			</Block>
		</If>
	);
}

/** Where the Revisit is, in a sentence, for the stages without their own view. */
function stageLine(page: PlanPage, revisit: Revisit): string {
	switch (revisit.stage) {
		case "preparing":
			return "Pilot compares the mission with what you agreed. Nothing is asked or changed yet.";
		case "questions":
			return page.interview?.kind === "revisit"
				? `Pilot asks ${page.interview.questions.length} new questions above, about the gaps only. Submitting them completes that round. Nothing changes yet.`
				: "Pilot asks new questions about the gaps only.";
		case "proposing":
			return "Your answers are submitted. Pilot prepares a revision from them. Nothing has changed.";
		case "confirmed":
			return "Revision confirmed. The agreement and open tasks changed as shown. No work started or resumed, and no permission changed.";
		default:
			return "";
	}
}

/** The Revisit section of a mission's planning page, then the proposed revision in its own section. */
export function RevisitSection(props: { plans: Plans; page: PlanPage; revisit: Revisit }) {
	const r = () => props.revisit;
	const id = () => props.page.missionId;
	const busy = () => revisitBusy()[id()] === true;
	const message = () => revisitMessages()[id()] ?? "";
	const canAsk = () => r().available && r().canAsk && !!props.plans.feed.revisit && props.page.fresh;
	return (
		<>
			<Section testID="revisit" title="Revisit">
				<If when={r().pausedWork}>
					<Notice
						placement="section"
						text={`Revisit holds ${r().pausedWork?.members ?? 0} work participants. Other holds remain separate.`}
						action={
							<If
								when={r().pausedWork?.state === "paused" && props.plans.feed.resumeRevision}
								else={
									<Button
										small
										label="Check status"
										disabled={busy()}
										onPress={() => void checkRevision(props.plans, id(), "")}
									/>
								}
							>
								<Button
									small
									label="Release affected work"
									testID="release-revision-work"
									disabled={busy() || !props.page.fresh}
									onPress={() => void resumeRevision(props.plans, id(), r().pausedWork?.operationId ?? "")}
								/>
							</If>
						}
					/>
				</If>
				<If
					when={r().available}
					else={<Notice testID="revisit-unavailable" placement="section" text={r().reason} />}
				>
					<Block gap={3}>
						<If when={r().stage === "idle" || r().stage === "confirmed"}>
							<Body tone="muted" measure>
								Check the goal, agreement and open tasks against what you want now. Pilot asks only about gaps,
								then shows exactly what would change. Nothing changes until you confirm.
							</Body>
						</If>
						<If when={stageLine(props.page, r())}>
							{/* LIBRARY GAP: Row cannot put a test ID on its title, and tests read this line by its own ID.
							    This mark-and-words line uses layout classes only until Row offers it. */}
							<View class="flex-row items-start gap-2.5">
								<Mark kind={r().stage === "confirmed" ? "done" : "working"} />
								<Body testID="revisit-stage" grow>
									{stageLine(props.page, r())}
								</Body>
							</View>
						</If>
						<Now missionId={id()} revisit={r()} />
						{/* With a revision shown, its confirmation shows the message, next to the button that sent it. */}
						<If when={message() && !r().revision}>
							<Body testID="revisit-message" role="alert" tone="muted">
								{message()}
							</Body>
						</If>
						<If
							when={
								(props.page.stage === "unknown" && !r().revision) ||
								r().stage === "idle" ||
								r().stage === "confirmed"
							}
						>
							<Buttons>
								<If when={props.page.stage === "unknown" && !r().revision}>
									<Button
										testID="check-revisit"
										label="Check again"
										icon="refresh"
										disabled={busy()}
										onPress={() => void checkRevision(props.plans, id(), "")}
									/>
								</If>
								<If when={r().stage === "idle" || r().stage === "confirmed"}>
									<Button
										kind={r().stage === "idle" ? "primary" : "secondary"}
										testID="ask-revisit"
										label={busy() ? "Asking…" : "Revisit mission"}
										accessibilityLabel="Revisit mission: Pilot compares it with what you agreed and asks about gaps. Nothing changes until you confirm."
										disabled={!canAsk() || busy()}
										onPress={() => void askRevisit(props.plans, id())}
									/>
								</If>
							</Buttons>
						</If>
					</Block>
					<History missionId={id()} lines={r().history} />
				</If>
			</Section>
			<If when={r().available && r().revision}>
				<Each of={r().revision ? [r().revision as Revision] : []} key={(x) => x.id}>
					{(x) => <RevisionView plans={props.plans} page={props.page} revisit={r()} revision={x()} />}
				</Each>
			</If>
		</>
	);
}

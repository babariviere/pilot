// A mission's Revisit: the agreement now, the new questions for its gaps,
// and the exact revision to review. Three steps stay apart. Submitting the
// Revisit questions completes that round only. Confirming a revision
// changes the goal, agreement, open tasks and decisions as shown. Neither
// starts, resumes or permits work. Finished tasks and earlier decisions
// stay as history, readable here on request.
import { type JSX, Text, View } from "nsh";
import { Collapsible } from "nsh/base";
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
import { glide } from "./motion";
import { askRevisit, checkRevision, confirmRevision } from "./planCommands";
import type { Plans } from "./planning";
import { drop, put, revisionShown, revisitBusy, revisitMessages, revisitOpen } from "./planView";
import { Action, Mark, type MarkKind, SectionTitle } from "./ui";

/** The words beside a part a revision touches. */
export function changeWord(kind: ChangeKind): string {
	switch (kind) {
		case "stays":
			return "Stays";
		case "changes":
			return "Changes";
		case "drops":
			return "Drops";
	}
}

function changeMark(kind: ChangeKind): MarkKind {
	switch (kind) {
		case "stays":
			return "still";
		case "changes":
			return "needs";
		case "drops":
			return "unreported";
	}
}

/** A disclosure line that opens a quiet part on request. Opening it reads and changes nothing. */
function Fold(props: { missionId: string; part: string; label: string; children?: JSX.Element }) {
	const key = () => `${props.missionId}/${props.part}`;
	const open = () => revisitOpen()[key()] === true;
	return (
		<Collapsible open={open()} class="gap-1" content={<View class="gap-2 pl-4 pt-2">{props.children}</View>}>
			<View
				testID={`fold-${props.part}`}
				role="button"
				accessibilityState={{ expanded: open() }}
				onPress={() => put(revisitOpen, key(), !open())}
				class="flex-row items-baseline gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring/40"
			>
				<Text class="text-sm text-muted-foreground">{open() ? "▾" : "▸"}</Text>
				<Text class="text-sm text-muted-foreground">{props.label}</Text>
			</View>
		</Collapsible>
	);
}

/** The agreement now, folded: goal, agreement text and what the mission holds. */
function Now(props: { missionId: string; revisit: Revisit }) {
	const r = () => props.revisit;
	return (
		<Fold missionId={props.missionId} part="now" label="The agreement now">
			<View testID="agreement-now" selectable class="gap-2">
				<Text class="text-xs text-faint">Goal</Text>
				<Text class="text-sm leading-relaxed text-foreground">{r().goal}</Text>
				<Text class="text-xs text-faint">Agreement</Text>
				<Text class="text-sm leading-relaxed text-foreground">{r().plan}</Text>
				<Text class="text-xs text-muted-foreground">
					{`${r().openTasks} open tasks · ${r().finishedTasks} finished · ${r().decisions} active decisions`}
				</Text>
			</View>
		</Fold>
	);
}

/** The goal or agreement under a revision: what stays, or the new text with the current one on request. */
function TextPart(props: { missionId: string; title: string; part: string; change: TextChange }) {
	const c = () => props.change;
	return (
		<View testID={`revision-${props.part}`} selectable class="gap-1.5">
			<View class="flex-row items-center gap-2">
				<Mark kind={changeMark(c().kind)} />
				<Text class="text-sm font-medium text-foreground">{props.title}</Text>
				<Text class="text-xs text-muted-foreground">{changeWord(c().kind)}</Text>
			</View>
			<Text class="pl-4 text-sm leading-relaxed text-foreground">{c().after}</Text>
			<If when={c().kind !== "stays"}>
				<View class="pl-4">
					<Fold missionId={props.missionId} part={`${props.part}-before`} label="Show it now">
						<Text class="text-sm leading-relaxed text-muted-foreground">{c().before}</Text>
					</Fold>
				</View>
			</If>
		</View>
	);
}

/** One open task: whether it stays, changes or drops, and what changes. */
function TaskRow(props: { task: TaskChange }) {
	const t = () => props.task;
	return (
		<View testID={`revision-task-${t().id}`} class="gap-1 border-t border-border py-2.5">
			<View class="flex-row items-baseline gap-3">
				<Text class="w-7 text-xs text-faint">{`#${t().number}`}</Text>
				<Text class="flex-1 text-sm text-foreground">{t().title}</Text>
				<View class="flex-row items-center gap-1.5">
					<Mark kind={changeMark(t().kind)} />
					<Text
						class="text-xs"
						classList={{
							"text-needs-ink": t().kind !== "stays",
							"text-muted-foreground": t().kind === "stays",
						}}
					>
						{changeWord(t().kind)}
					</Text>
				</View>
			</View>
			<Each of={t().lines} key={(l) => l}>
				{(l) => <Text class="pl-10 text-sm leading-relaxed text-muted-foreground">{l()}</Text>}
			</Each>
			<If when={t().kind === "drops"}>
				<Text class="pl-10 text-xs text-faint">Dropped, not deleted. Its history stays.</Text>
			</If>
		</View>
	);
}

/** One decision the revision replaces or withdraws, with Pilot's reason. */
function DecisionRow(props: { change: DecisionChange }) {
	const d = () => props.change;
	return (
		<View testID={`revision-decision-${d().id}`} selectable class="gap-1 border-t border-border py-2.5">
			<View class="flex-row items-baseline gap-3">
				<Text class="w-7 text-xs text-faint">{`D${d().number}`}</Text>
				<Text class="flex-1 text-sm text-muted-foreground">{d().before}</Text>
				<Text class="text-xs text-needs-ink">{d().action === "replace" ? "Replaced" : "Withdrawn"}</Text>
			</View>
			<If when={d().action === "replace"}>
				<Text class="pl-10 text-sm text-foreground">{`New: ${d().after}`}</Text>
			</If>
			<Text class="pl-10 text-xs text-muted-foreground">{`Why: ${d().reason}`}</Text>
		</View>
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

/** Why the confirmation cannot be sent now, or nothing. */
function blocked(page: PlanPage, r: Revision): string {
	if (!r.current) return "The mission changed after Pilot proposed this revision. It cannot be confirmed.";
	if (r.pause === "needed")
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
	return (
		<View testID="revision-confirm" class="gap-3 rounded-xl bg-muted px-4 py-3.5">
			<If when={why()}>
				<View class="flex-row items-start gap-2.5">
					<View class="pt-1.5">
						<Mark kind="unknown" />
					</View>
					<Text role="alert" class="flex-1 text-sm text-foreground">
						{why()}
					</Text>
				</View>
			</If>
			<If when={r().pause === "paused" && !why()}>
				<Text class="text-xs text-muted-foreground">
					The mission's work is paused. Confirming keeps it paused; resume it on its overview when you want.
				</Text>
			</If>
			<If when={unknown()}>
				<Text role="alert" class="text-sm text-foreground">
					{r().confirm === "checking"
						? "Checking. This only reads; it sends nothing again."
						: "Pilot sent your confirmation but heard nothing back. It will not send it again until it checks."}
				</Text>
			</If>
			<If when={pin() && !unknown()}>
				<View testID="revision-confirm-ask" class="gap-2">
					<Text class="text-sm font-medium text-foreground">Apply exactly this revision?</Text>
					<Text class="text-xs leading-relaxed text-muted-foreground">
						{`It changes ${changeCount(r())} as shown. Finished tasks, earlier answers and replaced decisions stay as history. It starts, resumes and permits nothing.`}
					</Text>
					<If when={!pinned()}>
						<Text class="text-xs text-needs-ink">
							The revision changed after you opened this. Read it again and confirm again.
						</Text>
					</If>
				</View>
			</If>
			<View class="flex-row flex-wrap items-center gap-2">
				<If
					when={unknown()}
					else={
						<If
							when={pin()}
							else={
								<Action
									primary
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
							<Action
								primary
								testID="confirm-revision-now"
								label={busy() || r().confirm === "confirming" ? "Confirming…" : "Confirm"}
								disabled={!!why() || busy() || !pinned()}
								onPress={() => void confirmRevision(props.plans, id())}
							/>
							<Action
								label="Cancel"
								disabled={busy()}
								onPress={() => {
									glide();
									drop(revisionShown, id());
								}}
							/>
						</If>
					}
				>
					<Action
						primary
						testID="check-revision"
						label="Check again"
						icon="refresh"
						disabled={busy() || r().confirm === "checking"}
						onPress={() => void checkRevision(props.plans, id(), r().id)}
					/>
				</If>
				<If when={!r().current && props.revisitCanAsk}>
					<Action
						testID="ask-again"
						label="Ask for a new revision"
						disabled={busy()}
						onPress={() => void askRevisit(props.plans, id())}
					/>
				</If>
			</View>
		</View>
	);
}

/** A proposed revision in full: what stays, changes and drops, what it leaves alone, and the confirmation. */
function RevisionView(props: { plans: Plans; page: PlanPage; revisit: Revisit; revision: Revision }) {
	const r = () => props.revision;
	const id = () => props.page.missionId;
	const instructions = () => r().corrections.filter((c) => c.kind === "instruction");
	const permissions = () => r().corrections.filter((c) => c.kind === "permission");
	return (
		<View testID="revision" class="gap-6">
			<View class="gap-1.5">
				<Text class="text-xs text-faint">Proposed revision</Text>
				<View selectable>
					<Text class="text-base leading-relaxed text-foreground">{r().summary}</Text>
				</View>
				<Text class="text-xs text-muted-foreground">
					Pilot proposed this from your answers. Read it in full. Nothing has changed yet.
				</Text>
			</View>
			<TextPart missionId={id()} title="Goal" part="goal" change={r().goal} />
			<TextPart missionId={id()} title="Agreement" part="plan" change={r().plan} />
			<View testID="revision-tasks" class="gap-0">
				<Text class="pb-1 text-sm font-medium text-foreground">{`Open tasks · ${r().tasks.length}`}</Text>
				<Each of={r().tasks} key={(t) => t.id}>
					{(t) => <TaskRow task={t()} />}
				</Each>
				<Text class="pt-2 text-xs text-faint">
					{r().finished === 1
						? "1 finished task stays as it is, with its history."
						: `${r().finished} finished tasks stay as they are, with their history.`}
				</Text>
			</View>
			<View testID="revision-decisions" class="gap-0">
				<Text class="pb-1 text-sm font-medium text-foreground">Decisions</Text>
				<Each of={r().decisions} key={(d) => d.id}>
					{(d) => <DecisionRow change={d()} />}
				</Each>
				<Text class="pt-2 text-xs text-faint">
					{`${r().keptDecisions} other active ${r().keptDecisions === 1 ? "decision stays" : "decisions stay"}. Replaced and withdrawn decisions stay as history, with their reasons.`}
				</Text>
			</View>
			<If when={r().corrections.length > 0}>
				<View testID="revision-corrections" class="gap-1.5">
					<Text class="text-sm font-medium text-foreground">Not part of this revision</Text>
					<Text class="text-xs leading-relaxed text-muted-foreground">
						Pilot also suggests these. Confirming applies neither; each has its own setting.
					</Text>
					<Each of={[...instructions(), ...permissions()]} key={(c) => `${c.kind}:${c.text}`}>
						{(c) => (
							<View class="gap-0.5 pl-4">
								<Text class="text-xs text-faint">{correctionWord(c())}</Text>
								<Text class="text-sm text-foreground">{c().text}</Text>
							</View>
						)}
					</Each>
				</View>
			</If>
			<Confirm plans={props.plans} page={props.page} revision={r()} revisitCanAsk={props.revisit.canAsk} />
		</View>
	);
}

/** Confirmed revisions, newest first. The agreement each one replaced opens only on request. */
function History(props: { missionId: string; lines: RevisionLine[] }) {
	return (
		<If when={props.lines.length > 0}>
			<Fold missionId={props.missionId} part="history" label={`Earlier revisions · ${props.lines.length}`}>
				<Text class="text-xs leading-relaxed text-muted-foreground">
					History, not guidance. Pilot works from the agreement now.
				</Text>
				<Each of={props.lines} key={(l) => l.id}>
					{(l) => (
						<View testID={`revision-history-${l().id}`} selectable class="gap-1.5 border-t border-border py-2.5">
							<Text class="text-sm text-foreground">{l().summary}</Text>
							<Text class="text-xs text-faint">{l().line}</Text>
							<Each of={l().retired} key={(x) => x}>
								{(x) => <Text class="text-xs text-muted-foreground">{x()}</Text>}
							</Each>
							<Fold missionId={props.missionId} part={`earlier-${l().id}`} label="The agreement before it">
								<Text class="text-xs text-faint">Goal</Text>
								<Text class="text-sm text-muted-foreground">{l().earlierGoal}</Text>
								<Text class="text-xs text-faint">Agreement</Text>
								<Text class="text-sm text-muted-foreground">{l().earlierPlan}</Text>
							</Fold>
						</View>
					)}
				</Each>
			</Fold>
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

/** The Revisit section of a mission's planning page. */
export function RevisitSection(props: { plans: Plans; page: PlanPage; revisit: Revisit }) {
	const r = () => props.revisit;
	const id = () => props.page.missionId;
	const busy = () => revisitBusy()[id()] === true;
	const message = () => revisitMessages()[id()] ?? "";
	const canAsk = () => r().available && r().canAsk && !!props.plans.feed.revisit && props.page.fresh;
	return (
		<View testID="revisit" class="gap-4">
			<SectionTitle title="Revisit" />
			<If
				when={r().available}
				else={
					<View testID="revisit-unavailable" class="flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
						<Mark kind="unknown" />
						<Text class="flex-1 text-sm text-foreground">{r().reason}</Text>
					</View>
				}
			>
				<If when={r().stage === "idle" || r().stage === "confirmed"}>
					<Text class="text-sm leading-relaxed text-muted-foreground">
						Check the goal, agreement and open tasks against what you want now. Pilot asks only about gaps, then
						shows exactly what would change. Nothing changes until you confirm.
					</Text>
				</If>
				<If when={stageLine(props.page, r())}>
					<View class="flex-row items-start gap-2.5">
						<View class="pt-1.5">
							<Mark kind={r().stage === "confirmed" ? "done" : "moving"} />
						</View>
						<Text testID="revisit-stage" class="flex-1 text-sm leading-relaxed text-foreground">
							{stageLine(props.page, r())}
						</Text>
					</View>
				</If>
				<Now missionId={id()} revisit={r()} />
				<If when={r().revision}>
					<Each of={r().revision ? [r().revision as Revision] : []} key={(x) => x.id}>
						{(x) => <RevisionView plans={props.plans} page={props.page} revisit={r()} revision={x()} />}
					</Each>
				</If>
				<If when={message()}>
					<Text testID="revisit-message" role="alert" class="text-sm text-muted-foreground">
						{message()}
					</Text>
				</If>
				<If when={r().stage === "idle" || r().stage === "confirmed"}>
					<View class="flex-row">
						<Action
							primary={r().stage === "idle"}
							testID="ask-revisit"
							label={busy() ? "Asking…" : "Revisit mission"}
							accessibilityLabel="Revisit mission: Pilot compares it with what you agreed and asks about gaps. Nothing changes until you confirm."
							disabled={!canAsk() || busy()}
							onPress={() => void askRevisit(props.plans, id())}
						/>
					</View>
				</If>
				<History missionId={id()} lines={r().history} />
			</If>
		</View>
	);
}

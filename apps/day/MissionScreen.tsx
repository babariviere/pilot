// One mission in full, work first, as one panel under the page's head. The
// head names the mission, its state and its commands (Rename, Pause,
// Archive, the coordinator's chat). The panel's main column holds what needs
// the user (a confirmation, Pause's state, problems), then the work on it
// now and next (MissionWork.tsx), results to check, the service's wait, and
// rows that open in place for the goal and spec, every task, discussions,
// results and evidence, and the map, interview and plan. Its side column
// holds the blockers, the progress, the latest report and where the mission
// came from. The coordinator's chat, a task's chat and a working chat open
// read only. Reports are agent words, never verified progress.
// Pause and Resume are intents: Rust builds and fences the command; this
// screen names only the mission, the revision it showed and, for Resume, the
// Pause it showed.
import { computed, effect, type JSX, keymap, Scroll, type ScrollRef, signal, View, type ViewRef } from "nsh";
import type { MissionPage, MissionRow, PlanPage, PlanRow, ReportLine, TaskLine } from "pilot-day/native";
import { createShelf, MissionArtifacts, type Shelf } from "./ArtifactShelf";
import { dropChoice } from "./chatCommands";
import { type ContentAnchor, createContentAnchor } from "./contentAnchor";
import type { Day } from "./day";
import { openDelivery } from "./deliveryView";
import { openFeedback } from "./feedbackView";
import { todayWarning } from "./freshness";
import { findingWork } from "./insightsWork";
import { keepScroll, restoreScroll, scrollOf } from "./kept";
import { LinearPublisher } from "./LinearPublisher";
import { MigrationControls } from "./MigrationControls";
import {
	forgetWorkFocus,
	limited,
	MissionBlockers,
	MissionNext,
	MissionNow,
	MoreRows,
	openMemberChat,
	taskMark,
} from "./MissionWork";
import { OpenChatAction } from "./OpenChatAction";
import { pageScroll, scrolled } from "./onScreen";
import { mapSummary, stageMark, stageWord } from "./PlanScreen";
import { PreviousMission } from "./PreviousMission";
import { Problems } from "./Problems";
import { askRevisit } from "./planCommands";
import type { Plans } from "./planning";
import { goalDraft, linkedMission, openNew, openPlan, replacesDraft, requestDraft } from "./planView";
import { MissionThreadsSection } from "./ThreadScreen";
import { ToCheck } from "./ToCheck";
import { FreshnessNote } from "./TodayScreen";
import { naming } from "./threadView";
import {
	Block,
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	Columns,
	EmptyLine,
	EvidenceList,
	ExpandableRow,
	glide,
	Icon,
	Link,
	Notice,
	Option,
	Options,
	Page,
	PageHead,
	Panel,
	Progress,
	Question,
	Row,
	RowDetail,
	Rows,
	Section,
	State,
	TextField,
} from "./ui";
import {
	archiving,
	closeMission,
	confirming,
	controlMessages,
	type Lifecycle,
	lifecycles,
	openMission,
	renames,
	setFor,
	setRename,
} from "./view";
import {
	controlLine,
	memberWord,
	nextLine,
	provenance,
	rowLine,
	stateMark,
	stateOf,
	stateWord,
	taskWord,
	workWord,
} from "./words";

function total(row: MissionRow): number {
	const p = row.progress;
	return p.done + p.review + p.active + p.blocked + p.todo;
}

/** Worker delivery facts from the canonical report, not task completion. Not moving, they are partial work. */
function ReportedOutput(props: { report: ReportLine }) {
	return (
		<If when={props.report.delivery}>
			<View selectable class="gap-1">
				<Caption tone="faint">
					{props.report.movement === "notMoving"
						? "Partial delivery. Not ready for your check until the work moves again."
						: "Worker delivery claim. Task completion and your check remain separate."}
				</Caption>
				<Body tone="muted">
					{props.report.delivery?.commit ? `Reported commit: ${props.report.delivery.commit}` : "No code changed."}
				</Body>
				<Body tone="muted">{`Reported checks: ${props.report.delivery?.checks ?? ""}`}</Body>
				<If when={props.report.delivery?.issues}>
					<Body tone="muted">{`Open issues: ${props.report.delivery?.issues}`}</Body>
				</If>
			</View>
		</If>
	);
}

/** An agent's report: its words, next step and what it named. */
function Report(props: { report: ReportLine }) {
	const meta = () =>
		props.report.evidence.length > 0
			? `${provenance(props.report)} · references not checked by Pilot`
			: provenance(props.report);
	return (
		<Block>
			<Body measure>{props.report.summary}</Body>
			<If when={props.report.nextStep}>
				<Body tone="muted">{nextLine(props.report)}</Body>
			</If>
			<ReportedOutput report={props.report} />
			<EvidenceList items={props.report.evidence} testID="report-evidence" />
			<Caption tone="faint">{meta()}</Caption>
		</Block>
	);
}

/** Pause, in the page's head while the mission can be paused. It only asks; the Pause section confirms. */
function PauseButton(props: { page: MissionPage }) {
	const row = () => props.page.row;
	return (
		<If when={row().control.canPause && confirming() !== row().id}>
			<Button
				label="Pause"
				accessibilityLabel="Pause mission"
				icon="pause"
				onPress={() => {
					glide();
					confirming.set(row().id);
				}}
			/>
		</If>
	);
}

function setLifecycle(id: string, life: Lifecycle | null) {
	lifecycles.update((all) => {
		const next = { ...all };
		if (life) next[id] = life;
		else delete next[id];
		return next;
	});
}

/**
 * Archive or Reopen once, or with `check` only read the status again after a
 * lost answer. A refusal keeps the page as it was, with the service's words.
 */
async function changeLifecycle(day: Day, id: string, title: string, action: Lifecycle["action"], check: boolean) {
	setLifecycle(id, { title, state: "busy", action, message: "" });
	const intent = { missionId: id, check };
	const outcome = await (action === "archive" ? day.feed.archive(intent) : day.feed.reopen(intent));
	if (outcome.status === "unknown") {
		setLifecycle(id, { title, state: "unknown", action, message: outcome.message });
	} else if (outcome.status === "accepted") {
		if (action === "archive") setLifecycle(id, { title, state: "archived", action, message: "" });
		else {
			setLifecycle(id, { title, state: "active", action, message: "Reopened. It is active again." });
			void day.feed.openMission({ missionId: id });
		}
	} else {
		// Nothing changed: archive leaves it active, reopen leaves it archived.
		const state = action === "archive" ? "active" : "archived";
		setLifecycle(id, { title, state, action, message: outcome.message });
	}
}

/** Archive, beside Pause: asks first. Only an active mission has it. */
function ArchiveButton(props: { page: MissionPage }) {
	const row = () => props.page.row;
	const life = () => lifecycles()[row().id];
	return (
		<If when={archiving() !== row().id && (!life() || life()?.state === "active")}>
			<Button
				label="Archive"
				accessibilityLabel="Archive mission"
				icon="archive"
				testID="mission-archive"
				onPress={() => {
					glide();
					confirming.set(null);
					archiving.set(row().id);
				}}
			/>
		</If>
	);
}

/**
 * The Archive confirmation, as a Question. Archive is passive: chats that are
 * working keep working and nothing is stopped. The service stops waking the
 * coordinator and archives the coordinator chat once it is idle. A refusal's
 * words show as a notice.
 */
function ArchiveConfirm(props: { day: Day; page: MissionPage }) {
	const row = () => props.page.row;
	const message = () => {
		const life = lifecycles()[row().id];
		return life?.state === "active" ? life.message : "";
	};
	const archive = () => {
		archiving.set(null);
		void changeLifecycle(props.day, row().id, row().title, "archive", false);
	};
	return (
		<If when={message() || archiving() === row().id}>
			<Section title="Archive">
				<If when={message()}>
					<Notice testID="mission-lifecycle-message" placement="section" role="alert" text={message()} />
				</If>
				<If when={archiving() === row().id}>
					<Question
						testID="mission-archive-confirm"
						title={`Archive “${row().title}”?`}
						foot={
							<>
								<Button
									kind="primary"
									label="Archive"
									icon="archive"
									testID="mission-archive-yes"
									onPress={archive}
								/>
								<Button label="Cancel" testID="mission-archive-cancel" onPress={() => archiving.set(null)} />
							</>
						}
					>
						<Body tone="muted" measure>
							It leaves Today. Its history, tasks, decisions and chats stay. Chats that are working keep working:
							nothing is stopped. Pilot stops waking its coordinator and archives the coordinator chat once it is
							idle. You can reopen it.
						</Body>
					</Question>
				</If>
			</Section>
		</If>
	);
}

/**
 * Rename once with the words in the field, or with `check` only read the
 * title again after a lost answer. Rust trims the words and refuses an empty
 * or too long title with a short message; a refusal keeps the field open.
 */
async function rename(day: Day, id: string, shown: string, check: boolean) {
	const r = renames()[id];
	if (!r || r.state === "busy" || (r.state === "unknown") !== check) return;
	const title = r.draft.trim();
	if (!check && title === shown) {
		// Nothing to change, so nothing is sent.
		setRename(id, null);
		return;
	}
	setRename(id, { ...r, state: "busy", message: "" });
	const outcome = await day.feed.rename({ missionId: id, title, check });
	if (outcome.status === "accepted") setRename(id, null);
	else if (outcome.status === "unknown") setRename(id, { ...r, state: "unknown", message: outcome.message });
	else setRename(id, { ...r, state: "editing", message: outcome.message });
}

/** Rename, beside Pause and Archive. It opens the title for editing and sends nothing. */
function RenameButton(props: { page: MissionPage }) {
	const row = () => props.page.row;
	return (
		<If when={!renames()[row().id]}>
			<Button
				label="Rename"
				accessibilityLabel="Rename mission"
				icon="rename"
				testID="mission-rename"
				onPress={() => {
					glide();
					forgetWorkFocus();
					confirming.set(null);
					archiving.set(null);
					setRename(row().id, { draft: row().title, state: "editing", message: "" });
				}}
			/>
		</If>
	);
}

/** After a lost rename answer, only Check is offered, and it only reads the mission again. */
function RenameCheck(props: { day: Day; page: MissionPage }) {
	const row = () => props.page.row;
	const r = () => renames()[row().id];
	return (
		<If when={r()?.state === "unknown"}>
			<Notice
				testID="mission-rename-message"
				role="alert"
				text={r()?.message ?? ""}
				action={
					<Link
						label="Check"
						testID="mission-rename-check"
						accessibilityLabel="Read the mission's title again. This sends nothing."
						onPress={() => void rename(props.day, row().id, row().title, true)}
					/>
				}
			/>
		</If>
	);
}

/**
 * The field that renames the mission, as a Question at the top of the panel. Enter saves and Escape cancels.
 * Save sends once; a refusal keeps the field open with the service's words.
 */
function RenameQuestion(props: { day: Day; page: MissionPage }) {
	const row = () => props.page.row;
	const r = () => renames()[row().id];
	const editing = () => r()?.state === "editing" || r()?.state === "busy";
	const busy = () => r()?.state === "busy";
	const save = () => void rename(props.day, row().id, row().title, false);
	return (
		<If when={editing()}>
			<Section title="Rename">
				<Question
					title="A new title for this mission"
					foot={
						<>
							<Button
								kind="primary"
								label={busy() ? "Saving…" : "Save"}
								testID="mission-rename-save"
								disabled={busy()}
								onPress={save}
							/>
							<Button
								label="Cancel"
								testID="mission-rename-cancel"
								disabled={busy()}
								accessibilityLabel="Keep the title as it is. Nothing is sent."
								onPress={() => setRename(row().id, null)}
							/>
						</>
					}
				>
					<TextField
						variant="title"
						testID="mission-title"
						autoFocus
						readonly={busy()}
						value={r()?.draft ?? ""}
						accessibilityLabel="Mission title"
						onChange={({ value }) => {
							const now = r();
							if (now?.state === "editing") setRename(row().id, { ...now, draft: value });
						}}
						onSubmit={save}
					/>
				</Question>
				<If when={r()?.message}>
					<Notice testID="mission-rename-message" placement="section" role="alert" text={r()?.message ?? ""} />
				</If>
			</Section>
		</If>
	);
}

/** An archived mission as this window archived it: Reopen, or Check after a lost answer. */
function Archived(props: { day: Day; missionId: string; life: Lifecycle; readNote: string }) {
	const busy = () => props.life.state === "busy";
	const run = (action: Lifecycle["action"], check: boolean) =>
		void changeLifecycle(props.day, props.missionId, props.life.title, action, check);
	const text = () => {
		if (busy()) return props.life.action === "archive" ? "Archiving…" : "Reopening…";
		if (props.life.state === "archived")
			return "Today drops it on its next read. Its history, tasks, decisions and chats stay.";
		return "";
	};
	return (
		<PageHead
			testID="mission-archived"
			title={props.life.title}
			state={
				<If when={props.life.state === "archived"}>
					<State kind="done" label="Archived" />
				</If>
			}
			text={text()}
			actions={
				<>
					<If when={props.life.state === "archived"}>
						<Button label="Reopen" testID="mission-reopen" onPress={() => run("reopen", false)} />
					</If>
					<If when={props.life.state === "unknown"}>
						<Button label="Check" testID="mission-lifecycle-check" onPress={() => run(props.life.action, true)} />
					</If>
				</>
			}
		>
			<If when={props.life.message}>
				<Notice role="alert" text={props.life.message} />
			</If>
			<ReadNote text={props.readNote} />
		</PageHead>
	);
}

/** Why the mission's detail could not be read again, when it could not. */
function ReadNote(props: { text: string }) {
	return (
		<If when={props.text}>
			<Notice role="alert" text={props.text} />
		</If>
	);
}

/**
 * The mission's Pause or Resume as it stands: the confirmation (a Question),
 * where each chat is, what needs a look, and Resume or Check again. Hidden
 * while the mission runs normally and nothing is asked: the Pause button says
 * enough.
 */
function Control(props: { day: Day; page: MissionPage }) {
	const row = () => props.page.row;
	const control = () => row().control;
	const id = () => row().id;
	const say = (message: string) => setFor(controlMessages, id(), message);
	const live = () => props.page.freshness.state === "live";
	const asking = () => confirming() === id();
	const shown = () =>
		asking() ||
		!!controlLine(control()) ||
		control().members.length > 0 ||
		control().issues.length > 0 ||
		!!controlMessages()[id()] ||
		control().canResume ||
		control().delivery === "unknown" ||
		control().delivery === "checking" ||
		!live();

	const pause = async () => {
		const now = row();
		confirming.set(null);
		say("");
		const outcome = await props.day.feed.pause({ missionId: now.id, revision: now.control.revision });
		say(outcome.message);
	};
	const resume = async () => {
		const now = row();
		say("");
		const outcome = await props.day.feed.resume({
			missionId: now.id,
			revision: now.control.revision,
			pauseOperationId: now.control.pauseOperationId ?? "",
		});
		say(outcome.message);
	};
	const check = async () => {
		const now = row();
		say("");
		const outcome = await props.day.feed.checkControl({ missionId: now.id });
		say(outcome.message);
	};

	return (
		<If when={shown()}>
			<Section testID="pause" title="Pause and resume">
				<If when={asking()}>
					<Question
						title={`Pause all work in ${row().title}?`}
						foot={
							<>
								<Button kind="primary" label="Pause" icon="pause" onPress={pause} />
								<Button label="Cancel" onPress={() => confirming.set(null)} />
							</>
						}
					>
						<Body tone="muted" measure>
							Every agent, schedule and job in it stops at a safe point. Pilot shows Pausing until every one has
							stopped. You can resume it later.
						</Body>
					</Question>
				</If>
				<If when={controlLine(control())}>
					<Block>
						<Body measure>{controlLine(control())}</Body>
					</Block>
				</If>
				<Rows>
					<Each of={control().members} key={(m) => m.title}>
						{(m) => (
							<Row
								mark={m().state === "unknown" ? "unconfirmed" : "paused"}
								title={m().title}
								meta={m().reason ?? undefined}
								state={memberWord(m().state)}
								stateTone="quiet"
								wrap
							/>
						)}
					</Each>
				</Rows>
				<Each of={control().issues} key={(issue) => issue}>
					{(issue) => <Notice placement="section" text={issue()} />}
				</Each>
				<If when={controlMessages()[id()]}>
					<Notice placement="section" role="alert" text={controlMessages()[id()] ?? ""} />
				</If>
				<If when={control().canResume || control().delivery === "unknown" || control().delivery === "checking"}>
					<Block>
						<Buttons>
							<If when={control().canResume}>
								<Button kind="primary" label="Resume" icon="play" onPress={resume} />
							</If>
							<If when={control().delivery === "unknown" || control().delivery === "checking"}>
								<Button
									label="Check again"
									icon="refresh"
									disabled={control().delivery === "checking"}
									onPress={check}
								/>
							</If>
						</Buttons>
					</Block>
				</If>
				<If when={!live()}>
					<EmptyLine text="Pause and Resume need a fresh read." />
				</If>
			</Section>
		</If>
	);
}

/**
 * One task. A task its agent finished or put in review offers its result
 * to check; opening that page reads it and records nothing. `place` names
 * the row's section, so the same task in Results has its own test IDs.
 */
function Task(props: { day: Day; page: MissionPage; task: TaskLine; place?: "result" }) {
	const id = (what: string) => (props.place ? `${props.place}-${what}` : what);
	const project = () => props.day.delivery?.view().projectId ?? "";
	const checkable = () => !!project() && (props.task.status === "done" || props.task.status === "inReview");
	// A done task folds its report and outputs: the list stays short, and Show brings them back.
	const open = signal(false);
	const folded = () => props.task.status === "done" && !open();
	const foldable = () => props.task.status === "done" && (!!props.task.report || props.task.outputs.length > 0);
	// The native read's work state when it has one, else the status the mission records.
	const word = () => (stateOf(props.task) === "unknown" ? taskWord(props.task.status) : workWord(stateOf(props.task)));
	const check = () => {
		const missionId = props.page.row.id;
		// Coming back keeps this page where it was.
		restoreScroll(`mission/${missionId}`, scrollOf(`mission/${missionId}`));
		openDelivery(
			{ kind: "task", projectId: project(), missionId, taskId: props.task.id },
			`#${props.task.number} ${props.task.title}`,
		);
	};
	return (
		<Row
			mark={props.task.status === "done" ? "done" : taskMark(stateOf(props.task))}
			title={props.task.title}
			meta={`#${props.task.number}`}
			state={word()}
			trailing={
				<If when={props.task.sessionId && props.day.chat}>
					<OpenChatAction
						label="Open agent chat"
						testID={id(`task-chat-${props.task.id}`)}
						accessibilityLabel={`Open agent chat for #${props.task.number} ${props.task.title}, read only. Opening it sends nothing.`}
						onPress={() => openMemberChat(props.page, props.task.sessionId ?? "")}
					/>
				</If>
			}
			detail={
				<If
					when={
						(props.task.report && !folded()) ||
						(props.task.outputs.length > 0 && !folded()) ||
						checkable() ||
						foldable()
					}
				>
					<RowDetail>
						<If when={props.task.report && !folded()}>
							<View selectable class="gap-0.5">
								<Body tone="muted">{props.task.report?.summary ?? ""}</Body>
								<If when={props.task.report?.nextStep}>
									<Body tone="muted">{props.task.report ? nextLine(props.task.report) : ""}</Body>
								</If>
								<EvidenceList
									items={props.task.report?.evidence ?? []}
									testID={id(`task-evidence-${props.task.id}`)}
								/>
								<Caption tone="faint">{props.task.report ? provenance(props.task.report) : ""}</Caption>
								<Caption tone="faint">Agent assessment, not verified progress or acceptance.</Caption>
								<ReportedOutput report={props.task.report as ReportLine} />
							</View>
						</If>
						<If when={props.task.outputs.length > 0 && !folded()}>
							<View testID={id(`outputs-${props.task.id}`)} class="gap-1">
								<Caption tone="faint">Outputs, as linked by its agents</Caption>
								<Each of={props.task.outputs} key={(o) => o.id}>
									{(o) => (
										<View selectable>
											<Body>{o().label}</Body>
											<Caption>{o().state}</Caption>
											<If when={o().link}>
												<Caption>{o().link}</Caption>
											</If>
										</View>
									)}
								</Each>
								<If when={props.task.outputs.some((o) => o.merged)}>
									<Caption tone="faint">Merged is not released. Pilot does not track releases.</Caption>
								</If>
							</View>
						</If>
						<If when={checkable() || foldable()}>
							<Buttons>
								<If when={checkable()}>
									<Button
										small
										testID={id(`check-result-${props.task.id}`)}
										label="Check the result"
										accessibilityLabel={`Check the result of #${props.task.number} ${props.task.title}. Opening it records nothing.`}
										onPress={check}
									/>
								</If>
								<If when={foldable()}>
									<Link
										testID={id(`task-more-${props.task.id}`)}
										label={open() ? "Hide report" : "Show report"}
										accessibilityLabel={`${open() ? "Hide" : "Show"} the report and outputs of #${props.task.number} ${props.task.title}.`}
										onPress={() => open.set(!open())}
									/>
								</If>
							</Buttons>
						</If>
					</RowDetail>
				</If>
			}
		/>
	);
}

/**
 * An old mission (started before planning interviews) cannot be revisited.
 * Re-planning opens New with a draft goal from this mission. It sends,
 * changes and archives nothing; the user edits the draft and plans there.
 * Once planned, the page names the new mission until the user stops
 * re-planning. Neither state needs the user.
 */
function Replan(props: { day: Day; page: MissionPage }) {
	const note = signal("");
	const busy = signal(false);
	const preparing = signal(false);
	const omitted = signal<string[]>([]);
	const context = () => props.page.replanContext ?? [];
	const draft = () =>
		context().length
			? Array.from(
					context()
						.filter((c) => !omitted().includes(c.title))
						.map((c) => (c.title ? `\n${c.title}\n${c.text}` : c.text))
						.join(""),
				)
					.slice(0, 4000)
					.join("")
			: props.page.replanDraft;
	const start = () => {
		preparing.set(true);
	};
	// Replacing an existing draft is an explicit choice. Its old project and
	// request association cannot silently move to this replacement goal.
	const useDraft = () => {
		// A linked draft from Feedback keeps New, and the other draft it holds aside: nothing replaces either.
		if (linkedMission()) {
			note.set("New has a linked mission draft from Feedback. Plan or discard it there first. Nothing changed.");
			return;
		}
		if (findingWork()) {
			note.set("New has a draft from Insights. Finish or discard it there first. Nothing changed.");
			return;
		}
		glide();
		dropChoice();
		requestDraft.set(null);
		goalDraft.set(draft());
		replacesDraft.set({ missionId: props.page.row.id, title: props.page.row.title });
		openNew();
	};
	const next = () => props.page.replanningAs;
	const stop = async () => {
		const successorId = next()?.missionId;
		if (!successorId || busy()) return;
		busy.set(true);
		note.set("");
		try {
			const outcome = await props.day.feed.stopReplanning({ missionId: props.page.row.id, successorId });
			note.set(outcome.message);
		} finally {
			busy.set(false);
		}
	};
	return (
		<Section testID="mission-replan" title="Plan">
			<If
				when={next()}
				else={
					<>
						<Block>
							<Body tone="muted" measure>
								{props.page.canReplan
									? "This mission started before planning interviews, so it cannot be revisited. Re-plan it as a new mission: New opens with a draft from this mission. Plan it in this mission's project. This mission does not change."
									: "This mission started before planning interviews, so it cannot be revisited."}
							</Body>
							<If when={props.page.canReplan}>
								<Buttons>
									<Button
										label="Re-plan as a new mission"
										testID="mission-replan-start"
										accessibilityLabel="Open New with a draft goal from this mission. Nothing is sent."
										onPress={start}
									/>
								</Buttons>
							</If>
						</Block>
						<If when={preparing()}>
							<Question
								testID="replan-carryover"
								title="Choose what to bring into planning"
								meta={
									<Caption>
										Context only, not approval or permission. Everything stays in the old mission's history,
										including what you leave out.
									</Caption>
								}
								foot={
									<>
										<Button
											kind="primary"
											label={goalDraft().trim() ? "Replace New draft" : "Open planning draft"}
											testID="replan-use-draft"
											onPress={useDraft}
										/>
										<If when={goalDraft().trim()}>
											<Button label="Keep existing draft" testID="replan-keep-draft" onPress={openNew} />
										</If>
										<Button label="Cancel" onPress={() => preparing.set(false)} />
									</>
								}
							>
								<Options multiple>
									<Each of={context().filter((c) => c.title)} key={(c) => c.title}>
										{(c) => (
											<Option
												multiple
												title={c().title}
												hint={c().text}
												checked={!omitted().includes(c().title)}
												onChange={() =>
													omitted.set(
														omitted().includes(c().title)
															? omitted().filter((t) => t !== c().title)
															: [...omitted(), c().title],
													)
												}
											/>
										)}
									</Each>
								</Options>
								<If when={goalDraft().trim()}>
									<Body testID="replan-existing-draft" tone="needs">
										New already has a draft. Keep it, or explicitly replace its words and project choice.
									</Body>
								</If>
							</Question>
						</If>
					</>
				}
			>
				<Rows>
					<Row
						testID="mission-replanning"
						title={`Re-planning as “${next()?.title || "a new mission"}”`}
						meta="This mission stays as it is while the new one is planned."
						accessibilityLabel="Open the new mission that re-plans this one."
						onPress={() => openMission(next()?.missionId ?? "")}
					/>
				</Rows>
				<MigrationControls
					source={props.day.feed}
					missionId={props.page.row.id}
					successorId={next()?.missionId ?? ""}
				/>
				<Block>
					<Buttons>
						<Button
							label="Stop re-planning"
							testID="mission-replan-stop"
							disabled={busy()}
							accessibilityLabel="Stop re-planning. Both missions stay; only the link between them ends."
							onPress={() => void stop()}
						/>
					</Buttons>
				</Block>
			</If>
			<If when={note()}>
				<Notice placement="section" role="alert" text={note()} />
			</If>
		</Section>
	);
}

/**
 * A published plan whose next task can start. It uses only the planning page
 * already read (no new read), and opens that page, where Start is on top.
 */
function ReadyToStart(props: { plans?: Plans; missionId: string }) {
	const work = () => {
		props.plans?.planning();
		const w = props.plans?.feed.page(props.missionId)?.work;
		return w?.canStart ? w : null;
	};
	return (
		<If when={work()}>
			<Rows>
				<Row
					testID="mission-ready"
					mark="new"
					title={`Ready to start: “${work()?.title ?? ""}”`}
					trailing={
						<Button
							small
							testID="mission-open-start"
							label="Open Start"
							accessibilityLabel="Open the plan at Start work. Opening it starts nothing."
							onPress={() => {
								// Back from the plan comes to this page where it was.
								restoreScroll(`mission/${props.missionId}`, scrollOf(`mission/${props.missionId}`));
								openPlan(props.missionId);
							}}
						/>
					}
				/>
			</Rows>
		</If>
	);
}

function PlanLink(props: { plans: Plans; missionId: string; linearPlanReview: string[] }) {
	const row = (): PlanRow | null => props.plans.planning().plans.find((p) => p.missionId === props.missionId) ?? null;
	const page = () => {
		props.plans.planning();
		const p = props.plans.feed.page(props.missionId);
		return p?.available && p.route === "wayfinder" ? p : null;
	};
	// An older mission can be revisited: one explicit press asks Pilot to
	// compare it with what was agreed, and opens its planning to follow.
	const revisit = () => {
		props.plans.planning();
		const r = props.plans.feed.page(props.missionId)?.revisit;
		return r?.available && r.canAsk && props.plans.feed.revisit ? r : null;
	};
	// Reading the saved plan answers, saves and starts nothing.
	if (row()) void props.plans.feed.open(props.missionId);
	const stage = () => {
		const r = row();
		return r ? stageWord(r.stage) : "";
	};
	const title = () => (page() ? "Map, interview and plan" : "Interview and plan");
	const open = () => {
		// Back from the plan comes to this page where it was.
		restoreScroll(`mission/${props.missionId}`, scrollOf(`mission/${props.missionId}`));
		openPlan(props.missionId);
	};
	return (
		<View testID="mission-plan">
			<If when={props.linearPlanReview.length > 0}>
				<Notice
					placement="section"
					text={`Review work linked to ${props.linearPlanReview.join(", ")}`}
					detail="Linear canceled or marked an issue as duplicate. The affected work is held. No tasks were dropped or transferred."
				/>
			</If>
			<Rows>
				<Row
					testID="open-plan"
					mark={row() ? stageMark(row()?.stage ?? "planning") : undefined}
					title={title()}
					meta={row()?.line || "What you answered, the plan Pilot proposed and the tasks it became."}
					state={stage() || undefined}
					stateTone={row()?.needsYou ? "needs" : "quiet"}
					wrap
					accessibilityLabel={stage() ? `${title()}, ${stage()}. Open it.` : `${title()}. Open it.`}
					onPress={open}
				/>
			</Rows>
			<If when={page() || revisit()}>
				<Block>
					<If when={page()}>
						<Caption testID="mission-map">{page() ? `Map: ${mapSummary(page() as PlanPage)}` : ""}</Caption>
					</If>
					<If when={revisit()}>
						<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
							<Button
								small
								testID="mission-revisit"
								label={props.linearPlanReview.length ? "Review proposed plan change" : "Revisit mission"}
								accessibilityLabel="Revisit mission: Pilot compares it with what you agreed and asks about gaps. Nothing changes until you confirm."
								onPress={() => {
									open();
									void askRevisit(props.plans, props.missionId);
								}}
							/>
							<Caption tone="faint">
								Check it against what you want now. Nothing changes until you confirm.
							</Caption>
						</View>
					</If>
				</Block>
			</If>
		</View>
	);
}

// The overview reads only `MissionPage`. Work comes first (MissionWork.tsx);
// the mission's other parts are rows that open in place, kept open across
// updates and Back. Later mission detail adds a field to `MissionPage` in
// Rust and a row here.
type Part = "goal" | "tasks" | "discussions" | "results" | "map";

/** Task rows shown in Tasks and in Results before "Show more": a large plan never mounts every row at once. */
const TASKS_SHOWN = 50;

/** Which rows of each mission are open. Opening one only shows what is already read. */
const openSections = signal<Record<string, Partial<Record<Part, boolean>>>>({});

function toggleSection(missionId: string, section: Part) {
	glide();
	forgetWorkFocus();
	openSections.update((all) => {
		const mine = all[missionId] ?? {};
		return { ...all, [missionId]: { ...mine, [section]: !mine[section] } };
	});
}

/** One row of "In this mission": its title, then what it holds while open. */
function PartRow(props: { missionId: string; section: Part; title: string; content: JSX.Element }) {
	const open = () => !!openSections()[props.missionId]?.[props.section];
	let row: ViewRef | null = null;
	return (
		<ExpandableRow
			open={open()}
			anchor={(node) => {
				row = node;
			}}
			testID={`mission-section-${props.section}`}
			accessibilityLabel={`${props.title}. ${open() ? "Hide" : "Show"} it.`}
			onToggle={() => {
				toggleSection(props.missionId, props.section);
				// A press gives the row the keyboard focus, so Space and Return work on it next.
				row?.focus();
			}}
			content={<View class="gap-3">{props.content}</View>}
		>
			<Icon name={open() ? "chevron" : "right"} tint="tint-muted-foreground" />
			<BodyStrong grow>{props.title}</BodyStrong>
			<Caption>{open() ? "Hide" : "Show"}</Caption>
		</ExpandableRow>
	);
}

/** What the mission is for, its spec and the decisions it agreed. Agreement here is never approval to act. */
function GoalAndSpec(props: { page: MissionPage }) {
	return (
		<Block testID="mission-goal" selectable gap={4}>
			<Body measure>{props.page.goal || "This read records no goal for the mission."}</Body>
			<If when={props.page.brief ?? ""}>
				<View class="gap-1">
					<Caption>Spec</Caption>
					<Body testID="mission-brief" measure>
						{props.page.brief ?? ""}
					</Body>
				</View>
			</If>
			<If when={(props.page.decisions ?? []).length > 0}>
				<View testID="mission-decisions" class="gap-1">
					<Caption>Agreed decisions</Caption>
					<Each of={props.page.decisions ?? []} key="index">
						{(d) => <Body>{`· ${d()}`}</Body>}
					</Each>
					<Caption tone="faint">What the mission agreed. They guide the work and approve nothing.</Caption>
				</View>
			</If>
		</Block>
	);
}

/** The mission's tasks, done and not, as the read lists them. */
function Tasks(props: { day: Day; page: MissionPage }) {
	const id = () => props.page.row.id;
	return (
		<View>
			<If when={!props.page.tasksKnown}>
				<EmptyLine text="The task list is not available here yet." />
			</If>
			<If when={props.page.tasksKnown && props.page.tasks.length === 0}>
				<EmptyLine text="No tasks yet." />
			</If>
			<Rows>
				<Each of={limited(`${id()}/tasks`, props.page.tasks, TASKS_SHOWN)} key={(t) => t.id}>
					{(t) => <Task day={props.day} page={props.page} task={t()} />}
				</Each>
			</Rows>
			<MoreRows
				listKey={`${id()}/tasks`}
				total={props.page.tasks.length}
				first={TASKS_SHOWN}
				step={TASKS_SHOWN}
				testID="tasks-limit"
			/>
		</View>
	);
}

/** Finished tasks with their results, and the mission's artifacts. */
function Results(props: { day: Day; page: MissionPage; shelf: Shelf; finished: TaskLine[] }) {
	const id = () => props.page.row.id;
	return (
		<View class="gap-4">
			<View>
				<If when={props.finished.length === 0}>
					<EmptyLine text="No task has finished yet." />
				</If>
				<Rows>
					<Each of={limited(`${id()}/results`, props.finished, TASKS_SHOWN)} key={(t) => t.id}>
						{(t) => <Task day={props.day} page={props.page} task={t()} place="result" />}
					</Each>
				</Rows>
				<MoreRows
					listKey={`${id()}/results`}
					total={props.finished.length}
					first={TASKS_SHOWN}
					step={TASKS_SHOWN}
					testID="results-limit"
				/>
			</View>
			<If when={props.day.artifacts}>
				<MissionArtifacts
					source={props.day.artifacts as NonNullable<Day["artifacts"]>}
					shelf={props.shelf}
					missionId={id()}
				/>
			</If>
		</View>
	);
}

/** Where the mission came from: the old mission it re-plans, open, or its history once the replacement finished. */
function Replaces(props: { day: Day; page: MissionPage }) {
	const r = () => props.page.replaces;
	return (
		<If when={r()}>
			<Section title="Replaces">
				<If
					when={r()?.state === "finished"}
					else={
						<Rows>
							<Row
								testID="mission-replaces"
								title={`Replaces “${r()?.title || "an old mission"}”`}
								accessibilityLabel="Open the old mission this one re-plans."
								onPress={() => openMission(r()?.missionId ?? "")}
							/>
						</Rows>
					}
				>
					<PreviousMission
						source={props.day.feed}
						oldId={r()?.missionId ?? ""}
						successorId={props.page.row.id}
						canReadChats={!!props.day.chat}
					/>
				</If>
			</Section>
		</If>
	);
}

/** The service's execution wait: tasks it holds until something else is done. Waiting starts nothing. */
function ExecutionQueue(props: { page: MissionPage }) {
	const queue = () => props.page.executionQueue ?? [];
	return (
		<If when={queue().length > 0}>
			<Section
				testID="execution-queue"
				title="Waiting"
				count={props.page.executionWaiting ?? queue().length}
				footnote={
					(props.page.executionWaiting ?? 0) > queue().length
						? `${props.page.executionWaiting} tasks waiting. Showing the first 40.`
						: undefined
				}
			>
				<Rows>
					<Each of={queue()} key={(w) => w.taskId}>
						{(w) => <Row mark="new" title={w().title} meta={w().reason} wrap />}
					</Each>
				</Rows>
			</Section>
		</If>
	);
}

function MissionBody(props: {
	day: Day;
	plans?: Plans;
	page: MissionPage;
	shelf: Shelf;
	anchor: ContentAnchor;
	readNote: string;
}) {
	// Views that keep what the user reads in place when a live update changes the work above it.
	const report = props.anchor.part("report");
	const sections = props.anchor.part("sections");
	const row = () => props.page.row;
	const finished = () => props.page.tasks.filter((t) => stateOf(t) === "completed" || t.status === "done");
	const planned = () => !props.page.replanDraft;
	return (
		<View ref={props.anchor.root}>
			<PageHead
				title={row().title}
				state={<State kind={stateMark(row())} label={stateWord(row())} />}
				actions={
					<>
						<RenameButton page={props.page} />
						<PauseButton page={props.page} />
						<ArchiveButton page={props.page} />
						<If when={props.page.coordinatorSessionId && props.day.chat}>
							<Button
								label="Open coordinator chat"
								icon="chat"
								testID="mission-coordinator-chat"
								accessibilityLabel="Open coordinator chat, read only. Opening it sends nothing."
								onPress={() => openMemberChat(props.page, props.page.coordinatorSessionId ?? "")}
							/>
						</If>
					</>
				}
			>
				<If when={row().stage || props.page.replanDraft}>
					<View class="flex-row flex-wrap gap-x-1.5">
						<If when={row().stage}>
							<Caption tone="faint">{row().stage}</Caption>
						</If>
						<If when={props.page.replanDraft}>
							<Caption testID="mission-old-plan" tone="faint">
								· Old plan
							</Caption>
						</If>
					</View>
				</If>
				<RenameCheck day={props.day} page={props.page} />
				<ReadNote text={props.readNote} />
			</PageHead>
			<Panel testID="mission-panel" notice={<FreshnessNote day={props.day} placement="panel" />}>
				<Columns
					testID="mission-work"
					main={
						<>
							<RenameQuestion day={props.day} page={props.page} />
							<Control day={props.day} page={props.page} />
							<ArchiveConfirm day={props.day} page={props.page} />
							<Problems
								rows={props.page.problems}
								known={props.day.today().problemsKnown}
								inMission
								earlier={todayWarning(props.day.freshness, props.page.freshness) !== ""}
								chat={props.day.chat?.source}
								openChat={props.day.chat ? (sessionId) => openMemberChat(props.page, sessionId) : undefined}
							/>
							<MissionNow day={props.day} page={props.page} anchor={props.anchor} />
							<MissionNext
								day={props.day}
								page={props.page}
								anchor={props.anchor}
								lead={<ReadyToStart plans={props.plans} missionId={row().id} />}
							/>
							<ToCheck day={props.day} missionId={row().id} />
							<ExecutionQueue page={props.page} />
							<If when={!planned()}>
								<Replan day={props.day} page={props.page} />
							</If>
							<View ref={sections.ref} onLayout={sections.onLayout}>
								<Section testID="mission-sections" title="In this mission">
									<PartRow
										missionId={row().id}
										section="goal"
										title="Goal and spec"
										content={<GoalAndSpec page={props.page} />}
									/>
									<PartRow
										missionId={row().id}
										section="tasks"
										title={props.page.tasksKnown ? `Tasks · ${props.page.tasks.length}` : "Tasks"}
										content={<Tasks day={props.day} page={props.page} />}
									/>
									<If when={planned() && props.day.threads}>
										<PartRow
											missionId={row().id}
											section="discussions"
											title="Discussions"
											content={
												<MissionThreadsSection day={props.day} missionId={row().id} heading={false} />
											}
										/>
									</If>
									<PartRow
										missionId={row().id}
										section="results"
										title={`Results and evidence · ${finished().length}`}
										content={
											<Results day={props.day} page={props.page} shelf={props.shelf} finished={finished()} />
										}
									/>
									<If when={planned() && props.plans}>
										<PartRow
											missionId={row().id}
											section="map"
											title="Map, interview and plan"
											content={
												<PlanLink
													plans={props.plans as Plans}
													missionId={row().id}
													linearPlanReview={props.page.linearPlanReview ?? []}
												/>
											}
										/>
									</If>
									<If when={planned() && props.day.linear}>
										<Block>
											<LinearPublisher missionId={row().id} />
										</Block>
									</If>
								</Section>
							</View>
						</>
					}
					side={
						<>
							<MissionBlockers day={props.day} page={props.page} />
							<Section title="Progress">
								<Rows>
									<Row
										title={`${row().progress.done} of ${total(row())} tasks done`}
										trailing={<Progress counts={row().progress} />}
									/>
								</Rows>
							</Section>
							<View ref={report.ref} onLayout={report.onLayout}>
								<Section title="Latest report">
									<If when={row().report} else={<EmptyLine text={rowLine(row())} />}>
										<Report report={row().report as ReportLine} />
									</If>
								</Section>
							</View>
							<Replaces day={props.day} page={props.page} />
							<If when={props.day.feedback}>
								<Section title="Feedback">
									<Rows>
										<Row
											title="Something about this mission Pilot should know?"
											wrap
											trailing={
												<Button
													small
													label="Send feedback"
													icon="notes"
													testID="mission-feedback"
													accessibilityLabel="Send feedback about this mission. This opens a page; nothing is sent yet."
													onPress={() => openFeedback({ kind: "mission", missionId: row().id })}
												/>
											}
										/>
									</Rows>
								</Section>
							</If>
						</>
					}
				/>
			</Panel>
		</View>
	);
}

/**
 * The overview of mission `props.missionId`, read again on every change.
 * Opening it asks Rust to read the mission's detail again; that read sends,
 * pauses and settles nothing.
 */
export function MissionScreen(props: { day: Day; plans?: Plans; missionId: string; onBackFromJump?: () => boolean }) {
	const page = computed(() => {
		props.day.today();
		return props.day.feed.mission(props.missionId) ?? null;
	});
	const readNote = signal("");
	const reading = signal(true);
	// Archive, Reopen and their Check replace the page; a refusal keeps it.
	const archived = () => {
		const life = lifecycles()[props.missionId];
		return life && life.state !== "active" ? life : null;
	};
	const shelf = createShelf();
	void props.day.feed.openMission({ missionId: props.missionId }).then((outcome) => {
		reading.set(false);
		readNote.set(outcome.status === "accepted" ? "" : outcome.message);
	});
	// Escape puts away what is open first: a confirmation, then the title
	// being renamed (nothing is sent), then the new thread's title (its words
	// stay, as Cancel keeps them), then the artifact source or preview opened
	// last, then the page. It works from the title fields too.
	keymap.bind(
		"escape",
		() => {
			if (confirming()) confirming.set(null);
			else if (archiving()) archiving.set(null);
			else if (renames()[props.missionId]?.state === "editing") setRename(props.missionId, null);
			else if (props.day.threads && naming()[props.missionId]) {
				glide();
				naming.update((all) => ({ ...all, [props.missionId]: false }));
			} else if (!shelf.hideLast() && !props.onBackFromJump?.()) closeMission();
		},
		{ when: "always" },
	);
	// Which project this window's results belong to, for Check the result. Passive.
	if (props.day.delivery && !props.day.delivery.view().projectId) void props.day.delivery.source.readSaved();
	const scroll = keepScroll(`mission/${props.missionId}`);
	const anchor = createContentAnchor(scroll.contentOffset.y);
	effect(() => () => anchor.dispose());
	return (
		<Scroll
			testID="mission-page"
			class="flex-1"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			ref={(node: ScrollRef) => {
				pageScroll(node);
				anchor.scroll(node);
			}}
			onScrollDragStart={(e) => anchor.dragged(e.offset.y)}
			onScroll={(e) => {
				scroll.onScroll(e);
				anchor.scrolled(e.offset.y);
				scrolled();
			}}
		>
			<Page>
				<If
					when={archived()}
					else={
						<If
							when={page()}
							else={
								<PageHead
									title={reading() ? "Reading this mission…" : "This mission is not in the latest read."}
									text={reading() ? undefined : "It may have finished or been archived."}
								>
									<ReadNote text={readNote()} />
								</PageHead>
							}
						>
							<Each of={page() ? [page() as MissionPage] : []} key={(p) => p.row.id}>
								{(p) => (
									<MissionBody
										day={props.day}
										plans={props.plans}
										page={p()}
										shelf={shelf}
										anchor={anchor}
										readNote={readNote()}
									/>
								)}
							</Each>
						</If>
					}
				>
					<Archived
						day={props.day}
						missionId={props.missionId}
						life={archived() as Lifecycle}
						readNote={readNote()}
					/>
				</If>
			</Page>
		</Scroll>
	);
}

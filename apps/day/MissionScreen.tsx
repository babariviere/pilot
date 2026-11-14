// One mission in full. The top says what it is, how it stands and what it
// waits for; then what its agents report, its interview and plan, its tasks
// and the chats working on it now. Chats are supporting detail. Reports are
// agent words, never verified progress. Pause and Resume are intents: Rust
// builds and fences the command; this screen names only the mission, the
// revision it showed and, for Resume, the Pause it showed.
import { computed, keymap, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { Decision, MissionPage, MissionRow, PlanPage, PlanRow, ReportLine, TaskLine } from "pilot-day/native";
import { createShelf, MissionArtifacts, type Shelf } from "./ArtifactShelf";
import { decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import { openDelivery } from "./deliveryView";
import { openFeedback } from "./feedbackView";
import { keepScroll, restoreScroll, scrollOf } from "./kept";
import { glide } from "./motion";
import { goHome } from "./nav";
import { pageScroll, scrolled } from "./onScreen";
import { mapSummary, stageMark, stageWord } from "./PlanScreen";
import { Problems } from "./Problems";
import { askRevisit } from "./planCommands";
import type { Plans } from "./planning";
import { goalDraft, openNew, openPlan, replacesDraft } from "./planView";
import { MissionThreadsSection } from "./ThreadScreen";
import { FreshnessNote, MissionStatus } from "./TodayScreen";
import { naming } from "./threadView";
import { Action, EvidenceChip, Mark, RowLink, SectionTitle, Track } from "./ui";
import {
	archiving,
	closeMission,
	confirming,
	controlMessages,
	focused,
	focusFront,
	type Lifecycle,
	lifecycles,
	openMission,
	renames,
	setFor,
	setRename,
	todayPlace,
} from "./view";
import { controlLine, memberWord, provenance, rowLine, taskWord } from "./words";

function total(row: MissionRow): number {
	const p = row.progress;
	return p.done + p.review + p.active + p.blocked + p.todo;
}

/** Worker delivery facts from the canonical report, not task completion. */
function ReportedOutput(props: { report: ReportLine }) {
	return (
		<If when={props.report.delivery}>
			<View selectable class="gap-1">
				<Text class="text-xs text-faint">
					Worker delivery claim. Task completion and your check remain separate.
				</Text>
				<Text class="text-sm text-muted-foreground">{`Reported commit: ${props.report.delivery?.commit ?? ""}`}</Text>
				<Text class="text-sm text-muted-foreground">{`Reported checks: ${props.report.delivery?.checks ?? ""}`}</Text>
				<If when={props.report.delivery?.issues}>
					<Text class="text-sm text-muted-foreground">{`Open issues: ${props.report.delivery?.issues}`}</Text>
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
		<View class="gap-2">
			<Text class="text-base leading-relaxed text-foreground">{props.report.summary}</Text>
			<If when={props.report.nextStep}>
				<Text class="text-sm text-muted-foreground">{`Next: ${props.report.nextStep}`}</Text>
			</If>
			<ReportedOutput report={props.report} />
			<View class="flex-row flex-wrap items-center gap-1.5">
				<Each of={props.report.evidence} key={(e) => e}>
					{(e) => <EvidenceChip evidence={{ label: e(), tone: "neutral" }} />}
				</Each>
				<Text class="text-xs text-faint">{meta()}</Text>
			</View>
		</View>
	);
}

/**
 * Pause, as a quiet icon at the top of the page while the mission can be
 * paused. Its name is in the tooltip and for screen readers. It only asks;
 * the panel below confirms.
 */
function PauseButton(props: { page: MissionPage }) {
	const row = () => props.page.row;
	return (
		<If when={row().control.canPause && confirming() !== row().id}>
			<Action
				label="Pause mission"
				icon="pause"
				iconOnly
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

/** Archive, beside Pause: quiet, and asks first. Only an active mission has it. */
function ArchiveButton(props: { page: MissionPage }) {
	const row = () => props.page.row;
	const life = () => lifecycles()[row().id];
	return (
		<If when={archiving() !== row().id && (!life() || life()?.state === "active")}>
			<Action
				label="Archive mission"
				icon="archive"
				iconOnly
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
 * The Archive confirmation. Archive is passive: chats that are working keep
 * working and nothing is stopped. The service stops waking the coordinator
 * and archives the coordinator chat once it is idle.
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
		<View class="gap-3">
			<If when={message()}>
				<Text testID="mission-lifecycle-message" role="alert" class="text-sm text-needs-ink">
					{message()}
				</Text>
			</If>
			<If when={archiving() === row().id}>
				<View testID="mission-archive-confirm" class="gap-2 rounded-xl bg-muted px-4 py-3.5">
					<Text class="text-sm text-foreground">{`Archive “${row().title}”?`}</Text>
					<Text class="text-xs text-muted-foreground">
						It leaves Today. Its history, tasks, decisions and chats stay. Chats that are working keep working:
						nothing is stopped. Pilot stops waking its coordinator and archives the coordinator chat once it is
						idle. You can reopen it.
					</Text>
					<View class="flex-row flex-wrap items-center gap-2 pt-1">
						<Action primary label="Archive" icon="archive" testID="mission-archive-yes" onPress={archive} />
						<Action label="Cancel" testID="mission-archive-cancel" onPress={() => archiving.set(null)} />
					</View>
				</View>
			</If>
		</View>
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

/** Rename, beside Pause and Archive: quiet. It opens the title for editing and sends nothing. */
function RenameButton(props: { page: MissionPage }) {
	const row = () => props.page.row;
	return (
		<If when={!renames()[row().id]}>
			<Action
				label="Rename mission"
				icon="rename"
				iconOnly
				testID="mission-rename"
				onPress={() => {
					glide();
					confirming.set(null);
					archiving.set(null);
					setRename(row().id, { draft: row().title, state: "editing", message: "" });
				}}
			/>
		</If>
	);
}

/**
 * The mission's title, or the field that renames it. Enter saves and Escape
 * cancels. Save sends once; after a lost answer only Check is offered, and it
 * only reads the mission again.
 */
function MissionTitle(props: { day: Day; page: MissionPage }) {
	const row = () => props.page.row;
	const r = () => renames()[row().id];
	const editing = () => r()?.state === "editing" || r()?.state === "busy";
	const busy = () => r()?.state === "busy";
	const save = () => void rename(props.day, row().id, row().title, false);
	return (
		<If
			when={editing()}
			else={
				<View class="gap-2">
					<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
						{row().title}
					</Text>
					<If when={r()?.state === "unknown"}>
						<Text testID="mission-rename-message" role="alert" class="text-sm text-needs-ink">
							{r()?.message ?? ""}
						</Text>
						<View class="flex-row">
							<Action
								label="Check"
								testID="mission-rename-check"
								accessibilityLabel="Read the mission's title again. This sends nothing."
								onPress={() => void rename(props.day, row().id, row().title, true)}
							/>
						</View>
					</If>
				</View>
			}
		>
			<View class="gap-2">
				<Input
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
					class="min-h-11 rounded-lg border border-input bg-background px-3 py-1.5 text-2xl font-semibold tracking-tight text-foreground focus:border-primary"
				/>
				<If when={r()?.message}>
					<Text testID="mission-rename-message" role="alert" class="text-sm text-needs-ink">
						{r()?.message ?? ""}
					</Text>
				</If>
				<View class="flex-row flex-wrap items-center gap-2">
					<Action
						primary
						label={busy() ? "Saving…" : "Save"}
						testID="mission-rename-save"
						disabled={busy()}
						onPress={save}
					/>
					<Action
						label="Cancel"
						testID="mission-rename-cancel"
						disabled={busy()}
						accessibilityLabel="Keep the title as it is. Nothing is sent."
						onPress={() => setRename(row().id, null)}
					/>
				</View>
			</View>
		</If>
	);
}

/** An archived mission as this window archived it: Reopen, or Check after a lost answer. */
function Archived(props: { day: Day; missionId: string; life: Lifecycle }) {
	const busy = () => props.life.state === "busy";
	const run = (action: Lifecycle["action"], check: boolean) =>
		void changeLifecycle(props.day, props.missionId, props.life.title, action, check);
	return (
		<View testID="mission-archived" class="gap-3">
			<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
				{props.life.title}
			</Text>
			<If when={props.life.state === "archived"}>
				<Text class="text-sm font-medium text-foreground">Archived</Text>
				<Text class="text-sm text-muted-foreground">
					Today drops it on its next read. Its history, tasks, decisions and chats stay.
				</Text>
			</If>
			<If when={busy()}>
				<Text class="text-sm text-muted-foreground">
					{props.life.action === "archive" ? "Archiving…" : "Reopening…"}
				</Text>
			</If>
			<If when={props.life.message}>
				<Text role="alert" class="text-sm text-needs-ink">
					{props.life.message}
				</Text>
			</If>
			<View class="flex-row flex-wrap items-center gap-2">
				<If when={props.life.state === "archived"}>
					<Action label="Reopen" testID="mission-reopen" onPress={() => run("reopen", false)} />
				</If>
				<If when={props.life.state === "unknown"}>
					<Action label="Check" testID="mission-lifecycle-check" onPress={() => run(props.life.action, true)} />
				</If>
			</View>
		</View>
	);
}

/**
 * The mission's Pause or Resume as it stands: the confirmation, where each
 * chat is, what needs a look, and Resume or Check again. Hidden while the
 * mission runs normally and nothing is asked: the Pause button says enough.
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
			<View testID="pause" class="gap-3 rounded-xl bg-muted px-4 py-3.5">
				<If when={controlLine(control())}>
					<Text class="text-sm leading-relaxed text-foreground">{controlLine(control())}</Text>
				</If>
				<If when={control().members.length > 0}>
					<View class="gap-0.5">
						<Each of={control().members} key={(m) => m.title}>
							{(m) => (
								<View class="flex-row flex-wrap items-baseline gap-x-2 py-1">
									<Mark kind={m().state === "unknown" ? "unknown" : "paused"} />
									<Text class="text-sm text-foreground">{m().title}</Text>
									<Text
										class="text-xs"
										classList={{
											"text-needs-ink": m().state === "unknown",
											"text-muted-foreground": m().state !== "unknown",
										}}
									>
										{memberWord(m().state)}
									</Text>
									<If when={m().reason}>
										<Text class="w-full pl-4 text-xs text-muted-foreground">{m().reason ?? ""}</Text>
									</If>
								</View>
							)}
						</Each>
					</View>
				</If>
				<Each of={control().issues} key={(issue) => issue}>
					{(issue) => <Text class="text-xs text-needs-ink">{issue()}</Text>}
				</Each>
				<If when={controlMessages()[id()]}>
					<Text role="alert" class="text-sm text-needs-ink">
						{controlMessages()[id()] ?? ""}
					</Text>
				</If>
				<If when={asking()}>
					<View class="gap-2">
						<Text class="text-sm text-foreground">{`Pause all work in ${row().title}?`}</Text>
						<Text class="text-xs text-muted-foreground">
							Every agent, schedule and job in it stops at a safe point. Pilot shows Pausing until every one has
							stopped. You can resume it later.
						</Text>
						<View class="flex-row flex-wrap items-center gap-2 pt-1">
							<Action primary label="Pause" icon="pause" onPress={pause} />
							<Action label="Cancel" onPress={() => confirming.set(null)} />
						</View>
					</View>
				</If>
				<View class="flex-row flex-wrap items-center gap-2">
					<If when={control().canResume}>
						<Action primary label="Resume" icon="play" onPress={resume} />
					</If>
					<If when={control().delivery === "unknown" || control().delivery === "checking"}>
						<Action
							primary
							label="Check again"
							icon="refresh"
							disabled={control().delivery === "checking"}
							onPress={check}
						/>
					</If>
				</View>
				<If when={!live()}>
					<Text class="text-xs text-muted-foreground">Pause and Resume need a fresh read.</Text>
				</If>
			</View>
		</If>
	);
}

/** What the mission waits for from the user, and the one way to it: its card on Today. */
function Waiting(props: { day: Day; row: MissionRow }) {
	const decision = (): Decision | undefined => props.day.today().decisions.find((d) => d.id === props.row.decisionId);
	const verb = (d: Decision) => {
		if (d.kind === "review") return "Review it on Today";
		if (d.kind === "unknown" || d.delivery === "unknown") return "Check it on Today";
		return "Decide on Today";
	};
	return (
		<Each of={decision() ? [decision() as Decision] : []} key={(d) => d.id}>
			{(d) => (
				<View
					testID="mission-waiting"
					class="flex-row flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-muted px-4 py-3"
				>
					<Mark kind={decisionMark(d())} />
					<View class="min-w-48 flex-1 gap-0.5">
						<Text class="text-xs text-needs-ink">Waiting for you</Text>
						<Text class="text-sm font-medium text-foreground">{d().title}</Text>
					</View>
					<Action
						primary
						label={verb(d())}
						accessibilityLabel={`${verb(d())}: ${d().title}`}
						onPress={() => {
							// The card takes the keyboard focus on Today, not the mission's row.
							todayPlace.row = null;
							focused.set(d().id);
							focusFront.set(true);
							goHome();
						}}
					/>
				</View>
			)}
		</Each>
	);
}

/**
 * One task. A task its agent finished or put in review offers its result
 * to check; opening that page reads it and records nothing.
 */
function Task(props: { day: Day; page: MissionPage; task: TaskLine }) {
	const project = () => props.day.delivery?.view().projectId ?? "";
	const checkable = () => !!project() && (props.task.status === "done" || props.task.status === "inReview");
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
		<View class="gap-1 border-t border-border py-3">
			<View class="flex-row items-baseline gap-3">
				<Text class="w-7 text-xs text-faint">{`#${props.task.number}`}</Text>
				<Text class="flex-1 text-sm text-foreground">{props.task.title}</Text>
				<Text class="text-xs text-muted-foreground">{taskWord(props.task.status)}</Text>
			</View>
			<If when={props.task.report}>
				<View selectable class="gap-0.5 pl-10">
					<Text class="text-sm text-muted-foreground">{props.task.report?.summary ?? ""}</Text>
					<If when={props.task.report?.nextStep}>
						<Text class="text-sm text-muted-foreground">{`Next: ${props.task.report?.nextStep}`}</Text>
					</If>
					<Each of={props.task.report?.evidence ?? []} key={(e) => e}>
						{(e) => <Text class="text-xs text-muted-foreground">{e()}</Text>}
					</Each>
					<Text class="text-xs text-faint">{props.task.report ? provenance(props.task.report) : ""}</Text>
					<Text class="text-xs text-faint">Agent assessment, not verified progress or acceptance.</Text>
					<ReportedOutput report={props.task.report as ReportLine} />
				</View>
			</If>
			<If when={props.task.outputs.length > 0}>
				<View testID={`outputs-${props.task.id}`} class="gap-1 pl-10 pt-1">
					<Text class="text-xs text-faint">Outputs, as linked by its agents</Text>
					<Each of={props.task.outputs} key={(o) => o.id}>
						{(o) => (
							<View selectable class="gap-1">
								<Text class="flex-1 text-sm text-foreground">{o().label}</Text>
								<Text class="text-xs text-muted-foreground">{o().state}</Text>
								<If when={o().link}>
									<Text class="text-xs text-muted-foreground">{o().link}</Text>
								</If>
							</View>
						)}
					</Each>
					<If when={props.task.outputs.some((o) => o.merged)}>
						<Text class="text-xs text-faint">Merged is not released. Pilot does not track releases.</Text>
					</If>
				</View>
			</If>
			<If when={checkable()}>
				<View class="flex-row pl-8">
					<Action
						testID={`check-result-${props.task.id}`}
						label="Check the result"
						accessibilityLabel={`Check the result of #${props.task.number} ${props.task.title}. Opening it records nothing.`}
						onPress={check}
					/>
				</View>
			</If>
		</View>
	);
}

/**
 * Where the mission's agreement lives: its saved interview, the plan it
 * agreed and the tasks it became. A link, not a copy: the planning page
 * says what it can read, including a mission that has no saved interview.
 * A Wayfinder mission also shows its map in one line, from the same read.
 */
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
	// The user asked for this draft: it replaces whatever New holds.
	const start = () => {
		glide();
		goalDraft.set(props.page.replanDraft);
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
		<View testID="mission-replan" class="gap-2">
			<SectionTitle title="Plan" />
			<If
				when={next()}
				else={
					<View class="gap-2">
						<Text class="text-sm text-muted-foreground">
							{props.page.canReplan
								? "This mission started before planning interviews, so it cannot be revisited. Re-plan it as a new mission: New opens with a draft from this mission. Plan it in this mission's project. This mission does not change."
								: "This mission started before planning interviews, so it cannot be revisited."}
						</Text>
						<If when={props.page.canReplan}>
							<View class="flex-row">
								<Action
									label="Re-plan as a new mission"
									testID="mission-replan-start"
									accessibilityLabel="Open New with a draft goal from this mission. Nothing is sent."
									onPress={start}
								/>
							</View>
						</If>
					</View>
				}
			>
				<RowLink
					testID="mission-replanning"
					title={`Re-planning as “${next()?.title || "a new mission"}”`}
					accessibilityLabel="Open the new mission that re-plans this one."
					onPress={() => openMission(next()?.missionId ?? "")}
				/>
				<Text class="text-sm text-muted-foreground">This mission stays as it is while the new one is planned.</Text>
				<View class="flex-row">
					<Action
						label="Stop re-planning"
						testID="mission-replan-stop"
						disabled={busy()}
						accessibilityLabel="Stop re-planning. Both missions stay; only the link between them ends."
						onPress={() => void stop()}
					/>
				</View>
			</If>
			<If when={note()}>
				<Text role="alert" class="text-sm text-needs-ink">
					{note()}
				</Text>
			</If>
		</View>
	);
}

function PlanLink(props: { plans: Plans; missionId: string }) {
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
		<View testID="mission-plan" class="gap-2">
			<SectionTitle title="Plan" />
			<RowLink
				testID="open-plan"
				title={title()}
				accessibilityLabel={stage() ? `${title()}, ${stage()}. Open it.` : `${title()}. Open it.`}
				onPress={open}
			>
				<If when={row()}>
					<View class="flex-row items-center gap-1.5">
						<Mark kind={stageMark(row()?.stage ?? "planning")} />
						<Text class={row()?.needsYou ? "text-xs text-needs-ink" : "text-xs text-muted-foreground"}>
							{stage()}
						</Text>
					</View>
				</If>
			</RowLink>
			<Text class="text-sm text-muted-foreground">
				{row()?.line || "What you answered, the plan Pilot proposed and the tasks it became."}
			</Text>
			<If when={page()}>
				<Text testID="mission-map" class="text-sm text-muted-foreground">
					{page() ? `Map: ${mapSummary(page() as PlanPage)}` : ""}
				</Text>
			</If>
			<If when={revisit()}>
				<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1 pt-1">
					<Action
						testID="mission-revisit"
						label="Revisit mission"
						accessibilityLabel="Revisit mission: Pilot compares it with what you agreed and asks about gaps. Nothing changes until you confirm."
						onPress={() => {
							open();
							void askRevisit(props.plans, props.missionId);
						}}
					/>
					<Text class="text-xs text-faint">
						Check it against what you want now. Nothing changes until you confirm.
					</Text>
				</View>
			</If>
		</View>
	);
}

// The overview is a column of independent sections, each reading only
// `MissionPage`. Later mission detail (planning, Fog of war) adds a field to
// `MissionPage` in Rust and its own section here; nothing else changes.
function Body(props: { day: Day; plans?: Plans; page: MissionPage; shelf: Shelf }) {
	const row = () => props.page.row;
	return (
		<View class="gap-10">
			<View class="gap-3">
				<View class="flex-row items-start gap-4">
					<View class="flex-1 gap-2">
						<MissionTitle day={props.day} page={props.page} />
						<View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
							<MissionStatus row={row()} />
							<If when={row().stage}>
								<Text class="text-xs text-faint">{`· ${row().stage}`}</Text>
							</If>
							<If when={props.page.replanDraft}>
								<Text testID="mission-old-plan" class="text-xs text-faint">
									· Old plan
								</Text>
							</If>
						</View>
					</View>
					<View class="flex-row items-center gap-1 pt-1">
						<RenameButton page={props.page} />
						<PauseButton page={props.page} />
						<ArchiveButton page={props.page} />
					</View>
				</View>
				<If when={props.page.goal}>
					<Text class="text-base leading-relaxed text-muted-foreground">{props.page.goal}</Text>
				</If>
				<If when={props.page.replaces}>
					<RowLink
						testID="mission-replaces"
						title={`Replaces “${props.page.replaces?.title || "an old mission"}”`}
						accessibilityLabel="Open the old mission this one re-plans."
						onPress={() => openMission(props.page.replaces?.missionId ?? "")}
					/>
				</If>
				<FreshnessNote day={props.day} />
				<Control day={props.day} page={props.page} />
				<ArchiveConfirm day={props.day} page={props.page} />
				<Waiting day={props.day} row={row()} />
			</View>

			<Problems
				rows={props.page.problems}
				known={props.day.today().problemsKnown}
				inMission
				earlier={props.page.freshness.state !== "live"}
			/>

			<View class="gap-3">
				<SectionTitle title="Latest report" />
				<If when={row().report} else={<Text class="text-sm text-muted-foreground">{rowLine(row())}</Text>}>
					<Report report={row().report as ReportLine} />
				</If>
				<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1 pt-1">
					<Track progress={row().progress} />
					<Text class="text-xs text-faint">{`${row().progress.done} of ${total(row())} tasks done`}</Text>
				</View>
			</View>

			<If
				when={props.page.replanDraft}
				else={
					<View class="gap-10">
						<If when={props.plans}>
							<PlanLink plans={props.plans as Plans} missionId={row().id} />
						</If>
						<If when={props.day.threads}>
							<MissionThreadsSection day={props.day} missionId={row().id} />
						</If>
					</View>
				}
			>
				<Replan day={props.day} page={props.page} />
			</If>

			<View class="gap-1">
				<View class="pb-2">
					<SectionTitle title="Tasks" count={props.page.tasks.length} />
				</View>
				<If when={!props.page.tasksKnown}>
					<Text class="text-sm text-muted-foreground">The task list is not available here yet.</Text>
				</If>
				<Each of={props.page.tasks} key={(t) => t.id}>
					{(t) => <Task day={props.day} page={props.page} task={t()} />}
				</Each>
			</View>

			<If when={props.day.artifacts}>
				<MissionArtifacts
					source={props.day.artifacts as NonNullable<Day["artifacts"]>}
					shelf={props.shelf}
					missionId={row().id}
				/>
			</If>

			<If when={props.page.chats.length > 0}>
				<View class="gap-1">
					<View class="pb-2">
						<SectionTitle title="Working now" count={props.page.chats.length} />
					</View>
					<Each of={props.page.chats} key={(c) => c.id}>
						{(c) => (
							<View class="flex-row items-baseline gap-3 py-1.5">
								<Text class="flex-1 text-sm text-foreground">{c().title}</Text>
								<Text class="text-xs text-faint">{`since ${c().since}`}</Text>
							</View>
						)}
					</Each>
				</View>
			</If>

			<If when={props.day.feedback}>
				<View class="flex-row items-center gap-3 border-t border-border pt-4">
					<Text class="flex-1 text-sm text-muted-foreground">Something about this mission Pilot should know?</Text>
					<Action
						label="Send feedback"
						icon="notes"
						testID="mission-feedback"
						accessibilityLabel="Send feedback about this mission. This opens a page; nothing is sent yet."
						onPress={() => openFeedback({ kind: "mission", missionId: row().id })}
					/>
				</View>
			</If>
		</View>
	);
}

/**
 * The overview of mission `props.missionId`, read again on every change.
 * Opening it asks Rust to read the mission's detail again; that read sends,
 * pauses and settles nothing.
 */
export function MissionScreen(props: { day: Day; plans?: Plans; missionId: string }) {
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
			} else if (!shelf.hideLast()) closeMission();
		},
		{ when: "always" },
	);
	// Which project this window's results belong to, for Check the result. Passive.
	if (props.day.delivery && !props.day.delivery.view().projectId) void props.day.delivery.source.readSaved();
	const scroll = keepScroll(`mission/${props.missionId}`);
	return (
		<Scroll
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			ref={pageScroll}
			onScroll={(e) => {
				scroll.onScroll(e);
				scrolled();
			}}
		>
			<View class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-10">
				<If when={readNote()}>
					<Text role="alert" class="text-sm text-muted-foreground">
						{readNote()}
					</Text>
				</If>
				<If
					when={archived()}
					else={
						<If
							when={page()}
							else={
								<Text class="text-base text-muted-foreground">
									{reading()
										? "Reading this mission…"
										: "This mission is not in the latest read. It may have finished or been archived."}
								</Text>
							}
						>
							<Each of={page() ? [page() as MissionPage] : []} key={(p) => p.row.id}>
								{(p) => <Body day={props.day} plans={props.plans} page={p()} shelf={shelf} />}
							</Each>
						</If>
					}
				>
					<Archived day={props.day} missionId={props.missionId} life={archived() as Lifecycle} />
				</If>
			</View>
		</Scroll>
	);
}

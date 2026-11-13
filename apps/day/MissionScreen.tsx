// One mission in full. The top says what it is, how it stands and what it
// waits for; then what its agents report, its interview and plan, its tasks
// and the chats working on it now. Chats are supporting detail. Reports are
// agent words, never verified progress. Pause and Resume are intents: Rust
// builds and fences the command; this screen names only the mission, the
// revision it showed and, for Resume, the Pause it showed.
import { computed, keymap, Scroll, signal, Text, View } from "nsh";
import type { Decision, MissionPage, MissionRow, PlanPage, PlanRow, ReportLine, TaskLine } from "pilot-day/native";
import { decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import { openDelivery } from "./deliveryView";
import { keepScroll, restoreScroll, scrollOf } from "./kept";
import { glide } from "./motion";
import { goHome } from "./nav";
import { mapSummary, stageMark, stageWord } from "./PlanScreen";
import { Problems } from "./Problems";
import type { Plans } from "./planning";
import { openPlan } from "./planView";
import { FreshnessNote, MissionStatus } from "./TodayScreen";
import { Action, EvidenceChip, Mark, RowLink, SectionTitle, Track } from "./ui";
import { closeMission, confirming, controlMessages, focused, focusFront, setFor, todayPlace } from "./view";
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
function PlanLink(props: { plans: Plans; missionId: string }) {
	const row = (): PlanRow | null => props.plans.planning().plans.find((p) => p.missionId === props.missionId) ?? null;
	const page = () => {
		props.plans.planning();
		const p = props.plans.feed.page(props.missionId);
		return p?.available && p.route === "wayfinder" ? p : null;
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
		</View>
	);
}

// The overview is a column of independent sections, each reading only
// `MissionPage`. Later mission detail (planning, Fog of war) adds a field to
// `MissionPage` in Rust and its own section here; nothing else changes.
function Body(props: { day: Day; plans?: Plans; page: MissionPage }) {
	const row = () => props.page.row;
	return (
		<View class="gap-10">
			<View class="gap-3">
				<View class="flex-row items-start gap-4">
					<View class="flex-1 gap-2">
						<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
							{row().title}
						</Text>
						<View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
							<MissionStatus row={row()} />
							<If when={row().stage}>
								<Text class="text-xs text-faint">{`· ${row().stage}`}</Text>
							</If>
						</View>
					</View>
					<View class="pt-1">
						<PauseButton page={props.page} />
					</View>
				</View>
				<If when={props.page.goal}>
					<Text class="text-base leading-relaxed text-muted-foreground">{props.page.goal}</Text>
				</If>
				<FreshnessNote day={props.day} />
				<Control day={props.day} page={props.page} />
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

			<If when={props.plans}>
				<PlanLink plans={props.plans as Plans} missionId={row().id} />
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
	void props.day.feed.openMission({ missionId: props.missionId }).then((outcome) => {
		reading.set(false);
		readNote.set(outcome.status === "accepted" ? "" : outcome.message);
	});
	keymap.bind("escape", () => {
		if (confirming()) confirming.set(null);
		else closeMission();
	});
	// Which project this window's results belong to, for Check the result. Passive.
	if (props.day.delivery && !props.day.delivery.view().projectId) void props.day.delivery.source.readSaved();
	const scroll = keepScroll(`mission/${props.missionId}`);
	return (
		<Scroll
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={scroll.onScroll}
		>
			<View class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-10">
				<If when={readNote()}>
					<Text role="alert" class="text-sm text-muted-foreground">
						{readNote()}
					</Text>
				</If>
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
						{(p) => <Body day={props.day} plans={props.plans} page={p()} />}
					</Each>
				</If>
			</View>
		</Scroll>
	);
}

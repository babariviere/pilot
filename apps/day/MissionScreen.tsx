// One mission in full: what its agents report, its tasks, its Pause
// control and the chats working on it now. Chats are supporting detail.
// Reports are agent words, never verified progress. Pause and Resume are
// intents: Rust builds and fences the command; this screen names only the
// mission, the revision it showed and, for Resume, the Pause it showed.
import { computed, keymap, Scroll, signal, Text, View } from "nsh";
import type { MissionPage, MissionRow, PlanPage, PlanRow, ReportLine, TaskLine } from "pilot-day/native";
import type { Day } from "./day";
import { keepScroll } from "./kept";
import { glide } from "./motion";
import { mapSummary, stageMark, stageWord } from "./PlanScreen";
import type { Plans } from "./planning";
import { openPlan } from "./planView";
import { FreshnessNote, MissionStatus, TopBar } from "./TodayScreen";
import { Action, EvidenceChip, Mark, RowLink, SectionTitle, Track } from "./ui";
import { closeMission, confirming, controlMessages, setFor } from "./view";
import { controlLine, memberWord, provenance, rowLine, taskWord } from "./words";

function total(row: MissionRow): number {
	const p = row.progress;
	return p.done + p.review + p.active + p.blocked + p.todo;
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
			<View class="flex-row flex-wrap items-center gap-1.5">
				<Each of={props.report.evidence} key={(e) => e}>
					{(e) => <EvidenceChip evidence={{ label: e(), tone: "neutral" }} />}
				</Each>
				<Text class="text-xs text-faint">{meta()}</Text>
			</View>
		</View>
	);
}

function Pause(props: { day: Day; page: MissionPage }) {
	const row = () => props.page.row;
	const control = () => row().control;
	const id = () => row().id;
	const say = (message: string) => setFor(controlMessages, id(), message);
	const live = () => props.page.freshness.state === "live";
	const asking = () => confirming() === id();

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
	const status = () =>
		controlLine(control()) ||
		"Running. Pause stops every agent, schedule and job in this mission at a safe point. You can resume it later.";

	return (
		<View testID="pause" class="gap-3">
			<SectionTitle title="Pause" />
			<Text class="text-sm leading-relaxed text-foreground">{status()}</Text>
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
				<View class="gap-2 rounded-xl bg-muted px-4 py-3">
					<Text class="text-sm text-foreground">{`Pause all work in ${row().title}?`}</Text>
					<Text class="text-xs text-muted-foreground">
						Agents stop at safe points. Pilot shows Pausing until every one has stopped.
					</Text>
					<View class="flex-row flex-wrap items-center gap-2 pt-1">
						<Action primary label="Pause" onPress={pause} />
						<Action label="Cancel" onPress={() => confirming.set(null)} />
					</View>
				</View>
			</If>
			<View class="flex-row flex-wrap items-center gap-2">
				<If when={control().canPause && !asking()}>
					<Action
						label="Pause mission"
						onPress={() => {
							glide();
							confirming.set(id());
						}}
					/>
				</If>
				<If when={control().canResume}>
					<Action primary label="Resume" onPress={resume} />
				</If>
				<If when={control().delivery === "unknown" || control().delivery === "checking"}>
					<Action primary label="Check again" disabled={control().delivery === "checking"} onPress={check} />
				</If>
			</View>
			<If when={!live()}>
				<Text class="text-xs text-muted-foreground">Pause and Resume need a fresh read.</Text>
			</If>
		</View>
	);
}

function Task(props: { task: TaskLine }) {
	return (
		<View class="gap-1 border-t border-border py-3">
			<View class="flex-row items-baseline gap-3">
				<Text class="w-7 text-xs text-faint">{`#${props.task.number}`}</Text>
				<Text class="flex-1 text-sm text-foreground">{props.task.title}</Text>
				<Text class="text-xs text-muted-foreground">{taskWord(props.task.status)}</Text>
			</View>
			<If when={props.task.report}>
				<View class="gap-0.5 pl-10">
					<Text class="text-sm text-muted-foreground">{props.task.report?.summary ?? ""}</Text>
					<Text class="text-xs text-faint">{props.task.report ? provenance(props.task.report) : ""}</Text>
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
	return (
		<View testID="mission-plan" class="gap-2">
			<SectionTitle title="Plan" />
			<RowLink
				testID="open-plan"
				title={title()}
				accessibilityLabel={stage() ? `${title()}, ${stage()}. Open it.` : `${title()}. Open it.`}
				onPress={() => openPlan(props.missionId)}
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
			<View class="gap-2">
				<Text role="header" class="text-2xl font-semibold leading-tight tracking-tight text-foreground">
					{row().title}
				</Text>
				<MissionStatus row={row()} />
				<If when={props.page.goal}>
					<Text class="text-base leading-relaxed text-muted-foreground">{props.page.goal}</Text>
				</If>
				<FreshnessNote day={props.day} />
			</View>

			<View class="gap-3">
				<SectionTitle title="Latest report" />
				<If when={row().report} else={<Text class="text-sm text-muted-foreground">{rowLine(row())}</Text>}>
					<Report report={row().report as ReportLine} />
				</If>
				<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1 pt-1">
					<Track progress={row().progress} />
					<Text class="flex-1 text-xs text-faint">{row().stage}</Text>
					<Text class="text-xs text-faint">{`${row().progress.done} of ${total(row())} done`}</Text>
				</View>
			</View>

			<If when={props.plans}>
				<PlanLink plans={props.plans as Plans} missionId={row().id} />
			</If>

			<Pause day={props.day} page={props.page} />

			<View class="gap-1">
				<View class="pb-2">
					<SectionTitle title="Tasks" count={props.page.tasks.length} />
				</View>
				<If when={!props.page.tasksKnown}>
					<Text class="text-sm text-muted-foreground">The task list is not available here yet.</Text>
				</If>
				<Each of={props.page.tasks} key={(t) => t.id}>
					{(t) => <Task task={t()} />}
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
	const scroll = keepScroll(`mission/${props.missionId}`);
	return (
		<Scroll
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={scroll.onScroll}
		>
			<View class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-6">
				<TopBar />
				<View class="flex-row">
					<Action label="‹ Today" accessibilityLabel="Back to Today" onPress={closeMission} />
				</View>
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
